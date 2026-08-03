/**
 * The reconciliation engine: `tick` drives everything that is due, then exits.
 * No resident process — the wake condition is stored data, and a tick simply
 * discovers what became due (possibly after the virtual clock advanced).
 *
 * One tick cycles until quiescent (bounded):
 *   1. Execute approved sends (authority revalidated at egress) and resolve
 *      unknown sends by provider readback — never by re-sending.
 *   2. Run queued worker assignments whose dependencies are settled.
 *   3. If wakes are due, fire them (coalesced) into one coordinator pass.
 */

import { runCoordinatorPass } from './coordinator.js';
import { runWorker } from './worker.js';
import { providerLookup, providerSend, SendCrashedAfterEgress } from './world.js';
import { arrive, load, readArtifact, verifyArtifact } from './store.js';
import { virtualNow } from './clock.js';
import type { WorkstreamDoc } from './types.js';

function dueWakes(doc: WorkstreamDoc): typeof doc.wakes {
  const now = virtualNow().toISOString();
  return doc.wakes.filter(
    (w) =>
      w.status === 'pending' &&
      (w.condition.type === 'immediate' || w.condition.dueAtVirtual <= now),
  );
}

/** Step 1a: execute approved sends. Authority is revalidated here, at egress. */
function executeApprovedSends(slug: string): number {
  const doc = load(slug);
  let executed = 0;
  for (const int of doc.interactions.filter((i) => i.status === 'approved')) {
    // Revalidate at egress: approval present, pinned content intact, budget alive.
    const del = doc.deliverables.find((d) => d.id === int.deliverableId);
    if (!del || !int.pinnedHash || del.adopted?.contentHash !== int.pinnedHash) {
      arrive(slug, (d, event) => {
        const i2 = d.interactions.find((x) => x.id === int.id)!;
        i2.status = 'rejected';
        event('send.refused', `${int.id} refused at egress: pinned content missing or drifted`, [int.id]);
      });
      continue;
    }
    if (!verifyArtifact(slug, del.path, int.pinnedHash)) {
      arrive(slug, (d, event) => {
        const i2 = d.interactions.find((x) => x.id === int.id)!;
        i2.status = 'rejected';
        event('send.refused', `${int.id} refused at egress: artifact integrity failure`, [int.id]);
      });
      continue;
    }
    const body = readArtifact(slug, del.path);
    try {
      const rec = providerSend(slug, int.id, { to: int.to, subject: int.subject, body });
      arrive(slug, (d, event) => {
        const i2 = d.interactions.find((x) => x.id === int.id)!;
        i2.status = 'sent';
        i2.externalRef = rec.ref;
        i2.sentAtVirtual = virtualNow().toISOString();
        event('send.executed', `${int.id} sent to ${int.to} (${rec.ref})`, [int.id]);
      });
    } catch (e) {
      if (e instanceof SendCrashedAfterEgress) {
        arrive(slug, (d, event) => {
          const i2 = d.interactions.find((x) => x.id === int.id)!;
          i2.status = 'unknown';
          event('send.unknown', `${int.id} result UNKNOWN (crash after egress) — readback required, no re-send`, [int.id]);
        });
      } else {
        throw e;
      }
    }
    executed++;
  }
  return executed;
}

/** Step 1b: resolve unknown sends by provider readback — never a second send. */
function resolveUnknownSends(slug: string): number {
  const doc = load(slug);
  let resolved = 0;
  for (const int of doc.interactions.filter((i) => i.status === 'unknown')) {
    const rec = providerLookup(slug, int.id);
    arrive(slug, (d, event) => {
      const i2 = d.interactions.find((x) => x.id === int.id)!;
      if (rec) {
        i2.status = 'confirmed';
        i2.externalRef = rec.ref;
        i2.sentAtVirtual = i2.sentAtVirtual ?? virtualNow().toISOString();
        event('send.confirmed', `${int.id} confirmed by provider readback (${rec.ref}) — nothing left to do`, [int.id]);
      } else {
        // Provider has no record: the send never landed; safe to re-attempt.
        i2.status = 'approved';
        event('send.not_found', `${int.id} not found at provider — send did not land; re-queued as approved`, [int.id]);
      }
    });
    resolved++;
  }
  return resolved;
}

function runnableAssignments(doc: WorkstreamDoc): string[] {
  return doc.assignments
    .filter((a) => a.state === 'queued')
    .filter((a) =>
      a.dependsOn.every((dep) => {
        const d = doc.assignments.find((x) => x.id === dep);
        return d ? ['completed', 'cancelled'].includes(d.state) : true;
      }),
    )
    .map((a) => a.id);
}

export interface TickReport {
  cycles: number;
  sendsExecuted: number;
  unknownsResolved: number;
  workersRun: string[];
  passes: { passId: string; outcome: string; costUsd: number; summary?: string }[];
}

export async function tick(
  slug: string,
  opts: { maxPasses?: number } = {},
): Promise<TickReport> {
  const maxPasses = opts.maxPasses ?? 3;
  const report: TickReport = {
    cycles: 0,
    sendsExecuted: 0,
    unknownsResolved: 0,
    workersRun: [],
    passes: [],
  };

  for (let cycle = 0; cycle < 12; cycle++) {
    report.cycles = cycle + 1;
    let progressed = false;

    report.unknownsResolved += resolveUnknownSends(slug);
    const sent = executeApprovedSends(slug);
    report.sendsExecuted += sent;
    if (sent > 0) progressed = true;

    const runnable = runnableAssignments(load(slug));
    for (const id of runnable) {
      process.stderr.write(`[tick] running worker for ${id}…\n`);
      await runWorker(slug, id);
      report.workersRun.push(id);
      progressed = true;
    }

    const due = dueWakes(load(slug));
    if (due.length > 0 && report.passes.length < maxPasses) {
      const reasons = [...new Set(due.map((w) => w.reason))];
      // Mark fired BEFORE the pass (coalesced, at-least-once): a crash mid-pass
      // loses the wake but the projection's arrivals still carry the facts,
      // and reconciliation repairs the rest.
      arrive(slug, (d, event) => {
        for (const w of d.wakes) {
          if (due.some((x) => x.id === w.id)) w.status = 'fired';
        }
        event('wakes.fired', `${due.length} wake(s) coalesced into one pass: ${reasons.join('; ')}`);
      });
      process.stderr.write(`[tick] coordinator pass (${reasons.join('; ')})…\n`);
      const outcome = await runCoordinatorPass(slug, reasons);
      report.passes.push(outcome);
      progressed = true;
    }

    if (!progressed) break;
  }
  return report;
}
