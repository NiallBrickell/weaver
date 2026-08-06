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
import { mkdirSync } from 'node:fs';
import { runCoordinatorPass } from './coordinator.js';
import { loadSecrets, redactSecrets } from './secrets.js';
import { runWorker } from './worker.js';
import { providerLookup, providerSend, SendCrashedAfterEgress } from './world.js';
import { arrive, load, newId, readArtifact, tryTickLock, verifyArtifact, writeArtifact } from './store.js';
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
async function executeApprovedSends(slug: string): Promise<number> {
  const doc = await load(slug);
  let executed = 0;
  for (const int of doc.interactions.filter((i) => i.status === 'approved')) {
    // Revalidate at egress: approval present, pinned content intact, budget alive.
    const del = doc.deliverables.find((d) => d.id === int.deliverableId);
    if (!del || !int.pinnedHash || del.adopted?.contentHash !== int.pinnedHash) {
      await arrive(slug, (d, event) => {
        const i2 = d.interactions.find((x) => x.id === int.id)!;
        i2.status = 'rejected';
        event('send.refused', `${int.id} refused at egress: pinned content missing or drifted`, [int.id]);
      });
      continue;
    }
    if (!(await verifyArtifact(slug, del.path, int.pinnedHash))) {
      await arrive(slug, (d, event) => {
        const i2 = d.interactions.find((x) => x.id === int.id)!;
        i2.status = 'rejected';
        event('send.refused', `${int.id} refused at egress: artifact integrity failure`, [int.id]);
      });
      continue;
    }
    const body = await readArtifact(slug, del.path);
    try {
      const rec = providerSend(slug, int.id, { to: int.to, subject: int.subject, body });
      await arrive(slug, (d, event) => {
        const i2 = d.interactions.find((x) => x.id === int.id)!;
        i2.status = 'sent';
        i2.externalRef = rec.ref;
        i2.sentAtVirtual = virtualNow().toISOString();
        event('send.executed', `${int.id} sent to ${int.to} (${rec.ref})`, [int.id]);
      });
    } catch (e) {
      if (e instanceof SendCrashedAfterEgress) {
        await arrive(slug, (d, event) => {
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
async function resolveUnknownSends(slug: string): Promise<number> {
  const doc = await load(slug);
  let resolved = 0;
  for (const int of doc.interactions.filter((i) => i.status === 'unknown')) {
    const rec = providerLookup(slug, int.id);
    await arrive(slug, (d, event) => {
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
 * Route gated actions through the operator's PILOT daemon — their existing,
 * human-owned approval policy engine (settings replay → deterministic rules →
 * small-model evaluator). Every command the action declares (exec.run, or the
 * briefing's fenced blocks, plus the verify readback) is evaluated; only if
 * ALL are approved does the action auto-approve, recorded as by:'pilot'.
 * Anything else — a deny, an unreachable daemon, a briefing with no explicit
 * commands to evaluate — FAILS CLOSED to the human queue. Pilot can only
 * narrow the human's involvement, never widen what may run.
 */
async function pilotApproveGatedActions(slug: string): Promise<number> {
  const base = process.env.WEAVER_PILOT_URL ?? 'http://127.0.0.1:9721';
  const doc = await load(slug);
  let approved = 0;
  const gated = doc.assignments.filter(
    (a) => a.kind === 'action' && a.state === 'gated' && a.exec && !a.exec.approval && !a.exec.pilotVerdict,
  );
  for (const asg of gated) {
    let verdict: { decision: string; reason: string } | null = null;
    try {
      if (asg.exec!.run) {
        // Engine-executed command: evaluated up front — the engine runs it
        // verbatim with no supervisor in the loop, so the whole judgment
        // happens here.
        const commands = [asg.exec!.run, asg.exec!.verify].filter(Boolean);
        for (const command of commands) {
          const res = await fetch(`${base}/internal/evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runtime: 'claude',
              tool_name: 'Bash',
              tool_input: JSON.stringify({ command }),
              cwd: asg.exec!.cwd,
              session_id: `weaver-${slug}`,
            }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`pilot HTTP ${res.status}`);
          const body = (await res.json()) as { decision?: string; reason?: string; source?: string };
          if (body.decision !== 'approve') {
            verdict = { decision: body.decision ?? 'unknown', reason: `${body.reason ?? ''} (${command.slice(0, 60)})` };
            break;
          }
          verdict = { decision: 'approve', reason: body.source ?? '' };
        }
      } else {
        // Worker action: the worker's EVERY tool call is judged live by pilot
        // at execution time (canUseTool supervisor) — so the gate only needs
        // pilot to be alive. Pre-approving a plan would be weaker than this.
        const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`pilot HTTP ${res.status}`);
        verdict = { decision: 'approve', reason: 'live per-command pilot supervision' };
      }
    } catch {
      // Daemon unreachable/slow: leave gated for the human, and leave
      // pilotVerdict unset so a recovered daemon gets another chance.
      continue;
    }
    if (!verdict) continue;
    await arrive(slug, (d, event) => {
      const a2 = d.assignments.find((x) => x.id === asg.id)!;
      if (!a2.exec || a2.state !== 'gated') return;
      a2.exec.pilotVerdict = { ...verdict!, at: new Date().toISOString() };
      if (verdict!.decision === 'approve') {
        a2.state = 'queued';
        a2.exec.approval = { by: 'pilot', at: new Date().toISOString(), note: verdict!.reason };
        for (const att of d.attention) {
          if (att.refId === asg.id && att.status === 'open') {
            att.status = 'resolved';
            att.resolvedAt = new Date().toISOString();
            att.resolvedBy = 'pilot'; // system actor — never a human intervention
          }
        }
        event('action.auto_approved', `${asg.id} auto-approved via pilot — ${verdict!.reason}`, [asg.id]);
      } else {
        event('action.pilot_escalated', `${asg.id} stays gated for the human — pilot said ${verdict!.decision}: ${verdict!.reason.slice(0, 120)}`, [asg.id]);
      }
    });
    if (verdict.decision === 'approve') approved++;
  }
  return approved;
}

/**
 * Deterministic readback for an action assignment: run its declared verify
 * command with NO model involved. Exit 0 confirms the real-world effect; the
 * result is recorded on the assignment so adoption can require it. This is
 * the same principle as email readback — after an act (or a crash), truth
 * comes from re-inspecting the world, never from re-doing the act.
 */
export async function verifyAction(slug: string, assignmentId: string): Promise<boolean> {
  const doc = await load(slug);
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
  await arrive(slug, (d, event) => {
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
async function executeHumanActions(slug: string): Promise<number> {
  const doc = await load(slug);
  let executed = 0;
  const due = doc.assignments.filter(
    (a) => a.kind === 'action' && a.state === 'queued' && a.exec?.run && a.exec.approval,
  );
  for (const asg of due) {
    const runId = newId('run');
    await arrive(slug, (d, event) => {
      const a2 = d.assignments.find((x) => x.id === asg.id)!;
      a2.state = 'running';
      a2.attempts.push({ runId, model: 'engine', runnerPid: process.pid, startedAt: new Date().toISOString() });
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
    const { relPath, hash } = await writeArtifact(slug, `${asg.id}-engine-execution.md`, report);
    await arrive(slug, (d, event) => {
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
async function recoverCrashedAttempts(slug: string): Promise<number> {
  // Long research/synthesis workers legitimately run 20+ minutes; recovering
  // a live worker as "crashed" forks the work, so the horizon errs long.
  const staleMs = Number(process.env.WEAVER_ATTEMPT_STALE_MS ?? 45 * 60_000);
  const doc = await load(slug);
  let recovered = 0;
  for (const asg of doc.assignments.filter((a) => a.state === 'running')) {
    const attempt = asg.attempts[asg.attempts.length - 1];
    if (!attempt || attempt.endedAt) continue;
    // A dead driver process means the attempt is orphaned RIGHT NOW — no need
    // to wait out the horizon (the silent-fleet failure mode after restarts).
    let driverDead = false;
    if (attempt.runnerPid && attempt.runnerPid !== process.pid) {
      try {
        process.kill(attempt.runnerPid, 0);
      } catch {
        driverDead = true;
      }
    }
    if (!driverDead && Date.now() - new Date(attempt.startedAt).getTime() < staleMs) continue;
    const isAction = asg.kind === 'action';
    await arrive(slug, (d, event) => {
      const a2 = d.assignments.find((x) => x.id === asg.id)!;
      const t2 = a2.attempts.find((t) => t.runId === attempt.runId);
      if (t2 && !t2.endedAt) {
        t2.endedAt = new Date().toISOString();
        t2.terminalReason = 'crashed';
      }
      if (a2.state === 'running') a2.state = isAction ? 'failed' : 'queued';
      event(
        'worker.crash_recovered',
        `${asg.id} attempt ${attempt.runId} presumed crashed (stale ${Math.round(staleMs / 1000)}s); ${isAction ? 'action held for readback' : 're-queued'}`,
        [asg.id],
      );
    });
    if (isAction) {
      // Readback decides, and its verdicts are machine-decidable:
      //   effect LANDED  → submit for coordinator review (nothing to redo);
      //   effect ABSENT  → the human-approved, idempotent-by-design act simply
      //                    didn't happen — re-queue it (approval attaches to
      //                    the ACT, not the attempt), bounded by MAX_ATTEMPTS.
      // Only repeated failure escalates to a human.
      const MAX_ACTION_ATTEMPTS = 3;
      let landed = false;
      try {
        landed = await verifyAction(slug, asg.id);
      } catch (e) {
        process.stderr.write(`readback for crashed action ${asg.id} failed to run: ${e instanceof Error ? e.message : e}\n`);
      }
      await arrive(slug, (d, event) => {
        const a2 = d.assignments.find((x) => x.id === asg.id)!;
        if (landed) {
          a2.state = 'awaiting_review';
          a2.submission = a2.submission ?? {
            summary: 'Worker crashed mid-run but readback CONFIRMED the effect landed; submitted by crash recovery for review.',
          };
          event('action.crash_effect_landed', `${asg.id} readback confirmed despite crash — awaiting review`, [asg.id]);
        } else if (a2.exec?.approval && a2.attempts.length < MAX_ACTION_ATTEMPTS) {
          a2.state = 'queued';
          event('action.requeued_after_crash', `${asg.id} readback shows no effect — re-running the approved idempotent act (attempt ${a2.attempts.length + 1}/${MAX_ACTION_ATTEMPTS})`, [asg.id]);
        } else {
          d.attention.push({
            id: newId('att'),
            kind: 'blocker',
            summary: `Action ${asg.id} crashed ${a2.attempts.length}× and readback still shows no effect — needs your judgment before any further redo`,
            refId: asg.id,
            status: 'open',
            createdAt: new Date().toISOString(),
          });
        }
      });
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
  // Cross-process tick exclusion lives behind the store (fs impl: mkdir lock,
  // dead holders reclaimed) — the doc's revision check guards logical
  // conflicts, not two OS processes dispatching the same act in one instant.
  const releaseTick = await tryTickLock(slug);
  if (!releaseTick) return { ...report, skipped: 'another process is ticking this workstream' };
  try {
    return await tickLocked(slug, maxPasses, report);
  } finally {
    await releaseTick();
  }
}

async function tickLocked(slug: string, maxPasses: number, report: TickReport): Promise<TickReport> {

  for (let cycle = 0; cycle < 12; cycle++) {
    report.cycles = cycle + 1;
    let progressed = false;

    if ((await recoverCrashedAttempts(slug)) > 0) progressed = true;
    if ((await pilotApproveGatedActions(slug)) > 0) progressed = true;
    report.unknownsResolved += await resolveUnknownSends(slug);
    const sent = await executeApprovedSends(slug);
    report.sendsExecuted += sent;
    if (sent > 0) progressed = true;

    // Human-authored commands: engine executes, then readback judges.
    const engineActs = (await load(slug)).assignments
      .filter((a) => a.kind === 'action' && a.state === 'queued' && a.exec?.run && a.exec.approval)
      .map((a) => a.id);
    if ((await executeHumanActions(slug)) > 0) {
      for (const id of engineActs) {
        const ok = await verifyAction(slug, id);
        process.stderr.write(`[tick] engine action ${id} readback: ${ok ? 'CONFIRMED' : 'FAILED'}\n`);
      }
      progressed = true;
    }

    // Budget gates WORKERS, not just coordinator passes — a long research run
    // must not be able to sail past maxCostUsd. Over budget: launch nothing,
    // tell the human once, and let them top up or wind down.
    const docBudget = await load(slug);
    if (docBudget.spend.totalCostUsd >= docBudget.workstream.budget.maxCostUsd) {
      const hasOpen = docBudget.attention.some((a) => a.kind === 'budget' && a.status === 'open');
      if (!hasOpen) {
        await arrive(slug, (d, event) => {
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
    const runnable = runnableAssignments(await load(slug));
    for (const id of runnable) {
      process.stderr.write(`[tick] running worker for ${id}…\n`);
      await runWorker(slug, id);
      report.workersRun.push(id);
      // Action assignments: the worker's claim settles nothing — run the
      // deterministic readback now so the reviewing pass sees verified truth.
      const after = (await load(slug)).assignments.find((a) => a.id === id);
      if (after?.kind === 'action' && after.exec) {
        const ok = await verifyAction(slug, id);
        process.stderr.write(`[tick] action ${id} readback: ${ok ? 'CONFIRMED' : 'FAILED'}\n`);
      }
      progressed = true;
    }
    }

    // Pass-crash recovery: an EXPIRED lease whose pass record never reached a
    // terminal outcome means the coordinator process died mid-pass. The wakes
    // it consumed are gone, so a stream with nothing else pending would sleep
    // forever looking innocently idle. Restore the loop: clear the lease, mark
    // the pass crashed, and re-fire its reasons as a fresh immediate wake.
    {
      const d0 = await load(slug);
      if (d0.lease && new Date(d0.lease.expiresAt).getTime() <= Date.now()) {
        const deadPassId = d0.lease.passId;
        await arrive(slug, (d, event) => {
          const rec = d.passes.find((p) => p.id === deadPassId);
          if (rec && rec.outcome === 'running') {
            rec.outcome = 'error';
            rec.endedAt = rec.endedAt ?? new Date().toISOString();
            rec.summary = 'coordinator process died mid-pass (lease expired); wakes restored';
            d.wakes.push({
              id: newId('wake'),
              reason: `pass ${deadPassId} crashed mid-run — re-reconcile (original reasons: ${rec.wakeReasons.join('; ').slice(0, 200)})`,
              condition: { type: 'immediate' },
              status: 'pending',
              createdAt: new Date().toISOString(),
            });
            event('pass.crash_recovered', `${deadPassId} lease expired with no outcome — wakes restored`, [deadPassId]);
          }
          if (d.lease?.passId === deadPassId) d.lease = null;
        });
        progressed = true;
      }
    }

    const preDoc = await load(slug);
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
      await arrive(slug, (d, event) => {
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
        await arrive(slug, (d, event) => {
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
