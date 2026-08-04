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

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { runCoordinatorPass } from './coordinator.js';
import { loadSecrets, redactSecrets } from './secrets.js';
import { runWorker } from './worker.js';
import { providerLookup, providerSend, SendCrashedAfterEgress } from './world.js';
import { arrive, load, newId, readArtifact, verifyArtifact, workstreamDir, writeArtifact } from './store.js';
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

/**
 * Deterministic readback for an action assignment: run its declared verify
 * command with NO model involved. Exit 0 confirms the real-world effect; the
 * result is recorded on the assignment so adoption can require it. This is
 * the same principle as email readback — after an act (or a crash), truth
 * comes from re-inspecting the world, never from re-doing the act.
 */
export function verifyAction(slug: string, assignmentId: string): boolean {
  const doc = load(slug);
  const asg = doc.assignments.find((a) => a.id === assignmentId);
  if (!asg?.exec) throw new Error(`${assignmentId} is not an action assignment`);
  const secrets = loadSecrets(slug);
  let ok = false;
  let output = '';
  try {
    output = execSync(asg.exec.verify, {
      cwd: asg.exec.cwd,
      timeout: 60_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...secrets },
    });
    ok = true;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
  }
  output = redactSecrets(output, secrets);
  arrive(slug, (d, event) => {
    const a2 = d.assignments.find((x) => x.id === assignmentId)!;
    a2.exec!.verified = { ok, output: output.slice(0, 2000), at: new Date().toISOString() };
    event(
      ok ? 'action.verified' : 'action.verify_failed',
      `${assignmentId} readback ${ok ? 'CONFIRMED' : 'FAILED'}: ${output.trim().slice(0, 200) || '(no output)'}`,
      [assignmentId],
    );
  });
  return ok;
}

/**
 * Deterministic execution of human-authored actions: when a human both
 * decided and spelled out the exact command (exec.run), the engine executes
 * it directly — no model in the loop to refuse, drift, or embellish. Exactly
 * one execution attempt is recorded before running (a crash mid-run leaves a
 * dangling attempt that action crash-recovery resolves by readback, never by
 * re-running). The result is submitted for coordinator review like any other
 * action, and only the verify readback can call the effect real.
 */
function executeHumanActions(slug: string): number {
  const doc = load(slug);
  let executed = 0;
  const due = doc.assignments.filter(
    (a) => a.kind === 'action' && a.state === 'queued' && a.exec?.run && a.exec.approval,
  );
  for (const asg of due) {
    const runId = newId('run');
    arrive(slug, (d, event) => {
      const a2 = d.assignments.find((x) => x.id === asg.id)!;
      a2.state = 'running';
      a2.attempts.push({ runId, model: 'engine', startedAt: new Date().toISOString() });
      event('action.engine_started', `${asg.id} engine executing human-authored command`, [asg.id]);
    });
    mkdirSync(asg.exec!.cwd, { recursive: true });
    const secrets = loadSecrets(slug);
    let ok = false;
    let output = '';
    try {
      output = execSync(asg.exec!.run!, {
        cwd: asg.exec!.cwd,
        timeout: 120_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...secrets },
      });
      ok = true;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    }
    output = redactSecrets(output, secrets);
    const report = [
      `# Engine execution of ${asg.id}`,
      ``,
      `Command (human-authored, executed verbatim by the engine — no model):`,
      '```',
      redactSecrets(asg.exec!.run!, secrets),
      '```',
      ``,
      `Exit: ${ok ? '0' : 'non-zero'}`,
      ``,
      `Output:`,
      '```',
      output.slice(0, 8000) || '(none)',
      '```',
    ].join('\n');
    const { relPath, hash } = writeArtifact(slug, `${asg.id}-engine-execution.md`, report);
    arrive(slug, (d, event) => {
      const a2 = d.assignments.find((x) => x.id === asg.id)!;
      const delId = newId('del');
      d.deliverables.push({
        id: delId,
        title: `Engine execution record: ${asg.objective.slice(0, 60)}`,
        kind: 'execution_record',
        path: relPath,
        contentHash: hash,
        producedByAssignment: asg.id,
        createdAtVirtual: virtualNow().toISOString(),
      });
      a2.submission = { summary: `Engine executed the human-authored command (exit ${ok ? '0' : 'non-zero'}); readback is the arbiter.`, deliverableId: delId };
      a2.state = 'awaiting_review';
      a2.adoption = { state: 'proposed' };
      const attempt = a2.attempts.find((t) => t.runId === runId);
      if (attempt) {
        attempt.endedAt = new Date().toISOString();
        attempt.terminalReason = ok ? 'executed' : 'command_failed';
      }
      d.wakes.push({
        id: newId('wake'),
        reason: `human-authored action ${asg.id} was executed by the engine and awaits review`,
        condition: { type: 'immediate' },
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      event('action.engine_executed', `${asg.id} command exited ${ok ? '0' : 'non-zero'} → ${delId}`, [asg.id, delId]);
    });
    executed++;
  }
  return executed;
}

/**
 * Crash recovery: an assignment stuck in 'running' whose latest attempt never
 * ended and is older than the staleness window was orphaned by a dead worker
 * process. Record the crash on the attempt and re-queue the assignment — the
 * attempt lineage keeps the failure inspectable.
 *
 * EXCEPT actions: a crashed action may or may not have already changed the
 * world, so it is never blindly re-queued. The verify readback runs instead,
 * and a coordinator (or human) decides from that evidence.
 */
function recoverCrashedAttempts(slug: string): number {
  // Long research/synthesis workers legitimately run 20+ minutes; recovering
  // a live worker as "crashed" forks the work, so the horizon errs long.
  const staleMs = Number(process.env.WEAVER_ATTEMPT_STALE_MS ?? 45 * 60_000);
  const doc = load(slug);
  let recovered = 0;
  for (const asg of doc.assignments.filter((a) => a.state === 'running')) {
    const attempt = asg.attempts[asg.attempts.length - 1];
    if (!attempt || attempt.endedAt) continue;
    if (Date.now() - new Date(attempt.startedAt).getTime() < staleMs) continue;
    const isAction = asg.kind === 'action';
    arrive(slug, (d, event) => {
      const a2 = d.assignments.find((x) => x.id === asg.id)!;
      const t2 = a2.attempts.find((t) => t.runId === attempt.runId);
      if (t2 && !t2.endedAt) {
        t2.endedAt = new Date().toISOString();
        t2.terminalReason = 'crashed';
      }
      if (a2.state === 'running') a2.state = isAction ? 'failed' : 'queued';
      if (isAction) {
        d.attention.push({
          id: newId('att'),
          kind: 'blocker',
          summary: `Action ${asg.id} crashed mid-run — world state unknown; readback has run, review its result before any redo`,
          refId: asg.id,
          status: 'open',
          createdAt: new Date().toISOString(),
        });
      }
      event(
        'worker.crash_recovered',
        `${asg.id} attempt ${attempt.runId} presumed crashed (stale ${Math.round(staleMs / 1000)}s); ${isAction ? 'action NOT re-queued — readback decides' : 're-queued'}`,
        [asg.id],
      );
    });
    if (isAction) {
      try {
        verifyAction(slug, asg.id);
      } catch (e) {
        process.stderr.write(`readback for crashed action ${asg.id} failed to run: ${e instanceof Error ? e.message : e}\n`);
      }
    }
    recovered++;
  }
  return recovered;
}

function runnableAssignments(doc: WorkstreamDoc): string[] {
  return doc.assignments
    .filter((a) => a.state === 'queued')
    // exec.run actions belong to the engine, never to a model worker
    .filter((a) => !a.exec?.run)
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
  /** Set when the tick did nothing because another process holds the lock. */
  skipped?: string;
}

/**
 * Cross-PROCESS tick exclusion (the doc's revision check guards logical
 * conflicts, not two OS processes dispatching the same real-world act in the
 * same instant — e.g. `weaver run` resident plus a manual `weaver tick`).
 * mkdir is atomic on every platform; a lock whose recorded pid is dead is
 * stale and reclaimed.
 */
function acquireTickLock(slug: string): (() => void) | null {
  const dir = pathJoin(workstreamDir(slug), '.tick.lock');
  const pidFile = pathJoin(dir, 'pid');
  try {
    mkdirSync(dir);
    writeFileSync(pidFile, String(process.pid));
    return () => rmSync(dir, { recursive: true, force: true });
  } catch {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      process.kill(pid, 0); // throws if the holder is dead
      return null; // a live process holds the lock
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return acquireTickLock(slug);
    }
  }
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
  const releaseTick = acquireTickLock(slug);
  if (!releaseTick) return { ...report, skipped: 'another process is ticking this workstream' };
  try {
    return await tickLocked(slug, maxPasses, report);
  } finally {
    releaseTick();
  }
}

async function tickLocked(slug: string, maxPasses: number, report: TickReport): Promise<TickReport> {

  for (let cycle = 0; cycle < 12; cycle++) {
    report.cycles = cycle + 1;
    let progressed = false;

    if (recoverCrashedAttempts(slug) > 0) progressed = true;
    report.unknownsResolved += resolveUnknownSends(slug);
    const sent = executeApprovedSends(slug);
    report.sendsExecuted += sent;
    if (sent > 0) progressed = true;

    // Human-authored commands: engine executes, then readback judges.
    const engineActs = load(slug).assignments
      .filter((a) => a.kind === 'action' && a.state === 'queued' && a.exec?.run && a.exec.approval)
      .map((a) => a.id);
    if (executeHumanActions(slug) > 0) {
      for (const id of engineActs) {
        const ok = verifyAction(slug, id);
        process.stderr.write(`[tick] engine action ${id} readback: ${ok ? 'CONFIRMED' : 'FAILED'}\n`);
      }
      progressed = true;
    }

    // Budget gates WORKERS, not just coordinator passes — a long research run
    // must not be able to sail past maxCostUsd. Over budget: launch nothing,
    // tell the human once, and let them top up or wind down.
    const docBudget = load(slug);
    if (docBudget.spend.totalCostUsd >= docBudget.workstream.budget.maxCostUsd) {
      const hasOpen = docBudget.attention.some((a) => a.kind === 'budget' && a.status === 'open');
      if (!hasOpen) {
        arrive(slug, (d, event) => {
          d.attention.push({
            id: newId('att'),
            kind: 'budget',
            summary: `Budget exhausted ($${d.spend.totalCostUsd.toFixed(2)} of $${d.workstream.budget.maxCostUsd}) — nothing more will run. Top up with: weaver budget ${slug} --max-cost <usd>, or pause the workstream.`,
            status: 'open',
            createdAt: new Date().toISOString(),
          });
          event('budget.exhausted', `spend $${d.spend.totalCostUsd.toFixed(2)} ≥ cap $${d.workstream.budget.maxCostUsd}; workers gated`);
        });
      }
    } else {
    const runnable = runnableAssignments(load(slug));
    for (const id of runnable) {
      process.stderr.write(`[tick] running worker for ${id}…\n`);
      await runWorker(slug, id);
      report.workersRun.push(id);
      // Action assignments: the worker's claim settles nothing — run the
      // deterministic readback now so the reviewing pass sees verified truth.
      const after = load(slug).assignments.find((a) => a.id === id);
      if (after?.kind === 'action' && after.exec) {
        const ok = verifyAction(slug, id);
        process.stderr.write(`[tick] action ${id} readback: ${ok ? 'CONFIRMED' : 'FAILED'}\n`);
      }
      progressed = true;
    }
    }

    const preDoc = load(slug);
    const due = dueWakes(preDoc);
    // A live lease means no pass can start: leave the wakes PENDING for the
    // next tick rather than burning them against a pass that cannot run.
    const leaseLive = preDoc.lease && new Date(preDoc.lease.expiresAt).getTime() > Date.now();
    if (due.length > 0 && !leaseLive && report.passes.length < maxPasses) {
      const reasons = [...new Set(due.map((w) => w.reason))];
      // Mark fired BEFORE the pass (coalesced, at-least-once): a crash mid-pass
      // loses the wake but the projection's arrivals still carry the facts,
      // and reconciliation repairs the rest.
      // Event/log lines truncate long wake reasons (coordinators write rich
      // handoff notes into them); the pass itself still receives them in full.
      const brief = reasons.map((r) => (r.length > 160 ? `${r.slice(0, 157)}…` : r));
      arrive(slug, (d, event) => {
        for (const w of d.wakes) {
          if (due.some((x) => x.id === w.id)) w.status = 'fired';
        }
        event('wakes.fired', `${due.length} wake(s) coalesced into one pass: ${brief.join('; ')}`);
      });
      process.stderr.write(`[tick] coordinator pass (${brief.join('; ').slice(0, 200)})…\n`);
      try {
        const outcome = await runCoordinatorPass(slug, reasons);
        report.passes.push(outcome);
      } catch (e) {
        // The pass never started (lease race, budget ceiling): restore the
        // wakes so the arrival is not silently lost.
        arrive(slug, (d, event) => {
          for (const w of d.wakes) {
            if (due.some((x) => x.id === w.id) && w.status === 'fired' && !w.firedInPass) {
              w.status = 'pending';
            }
          }
          event('wakes.restored', `pass could not start (${e instanceof Error ? e.message.slice(0, 120) : e}); ${due.length} wake(s) restored to pending`);
        });
        throw e;
      }
      progressed = true;
    }

    if (!progressed) break;
  }
  return report;
}
