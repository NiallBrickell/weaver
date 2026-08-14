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
import { existsSync, mkdirSync } from 'node:fs';
import { pickCoordinatorTarget, runCoordinatorPass } from './coordinator.js';
import {
  ExecutionSafetyLimitedError,
  isLegacyDollarBudgetAttention,
  isWakeDue,
  parkIfExecutionLimited,
  retireLegacyDollarBudgetCard,
} from './executionSafety.js';
import { loadRedactionSecrets, loadSecrets, redactSecrets } from './secrets.js';
import { runWorker } from './worker.js';
import { providerLookup, providerSend, SendCrashedAfterEgress } from './world.js';
import { arrive, load, mutate, newId, readArtifact, RevisionConflictError, tryTickLock, verifyArtifact, writeArtifact } from './store.js';
import { virtualNow } from './clock.js';
import { pidIsLive } from './processLock.js';
import { collisionKey, isRepoEgressAction, repoEgressCollisions } from './deconflict.js';
import { capacityBackoffFor } from './capacity.js';
import { workerTargetForAssignment } from './modelRouting.js';
import type { Assignment, WorkstreamDoc } from './types.js';

/**
 * The shell a declared action's `run`/`verify` command is executed with.
 *
 * execSync defaults to /bin/sh, but a coordinator writes the shell everyone
 * writes — `diff <(a) <(b)`, `[[ ]]`, arrays — and under /bin/sh those die with
 * "syntax error near unexpected token `('". The command is then blamed for the
 * action: a NoBe page deploy that had actually succeeded was rejected because
 * its readback used process substitution, costing a full re-file cycle. Asking
 * the model to remember POSIX is the wrong half to fix — the shell a human
 * would get is bash, so use it when the machine has it and fall back to the
 * default only where it does not.
 */
function actionShell(): string | undefined {
  return existsSync('/bin/bash') ? '/bin/bash' : undefined;
}


function dueWakes(doc: WorkstreamDoc): typeof doc.wakes {
  const wallNow = new Date();
  const virtual = virtualNow();
  return doc.wakes.filter((wake) => wake.status === 'pending' && isWakeDue(wake.condition, wallNow, virtual));
}

/** Pause is typed lifecycle state, not merely a runner filter. Every
 * dispatch/egress boundary re-reads it so a tick that was already in flight
 * cannot start another bounded step after the operator pauses the stream. */
async function workstreamStatus(slug: string): Promise<WorkstreamDoc['workstream']['status']> {
  return (await load(slug)).workstream.status;
}

/** Step 1a: execute approved sends. Authority is revalidated here, at egress. */
async function executeApprovedSends(slug: string): Promise<number> {
  const doc = await load(slug);
  if (doc.workstream.status !== 'active') return 0;
  let executed = 0;
  for (const int of doc.interactions.filter((i) => i.status === 'approved')) {
    // Revalidate at egress: approval present and pinned content intact.
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
    // Revalidate pause immediately before egress. The tick may have started
    // while active and received a human pause during artifact verification.
    if ((await workstreamStatus(slug)) !== 'active') break;
    // ATOMIC EGRESS CLAIM. Draft/send/reject are separate facts, and a human
    // rejection can land at any instant. This revision-checked write is the
    // single linearization point between "approved" and "rejected": it flips
    // the interaction out of the rejectable 'approved' state into 'sending'
    // and re-verifies the pin under the write lock. A rejection that crosses
    // FIRST leaves status !== 'approved' and we make no call; a rejection that
    // crosses AFTER finds 'sending' and is refused (see rejectSend). Once
    // 'sending' is durable, a crash before/around providerSend is resolved by
    // readback (resolveUnknownSends), never by a blind re-send.
    let claimed = false;
    await arrive(slug, (d, event) => {
      const i2 = d.interactions.find((x) => x.id === int.id)!;
      if (i2.status !== 'approved') return; // lost the race to a rejection or another claim
      if (!i2.pinnedHash || d.deliverables.find((x) => x.id === i2.deliverableId)?.adopted?.contentHash !== i2.pinnedHash) {
        i2.status = 'rejected';
        event('send.refused', `${int.id} refused at egress claim: pinned content drifted`, [int.id]);
        return;
      }
      i2.status = 'sending';
      claimed = true;
      event('send.claimed', `${int.id} claimed for egress (linearized against rejection)`, [int.id]);
    });
    if (!claimed) continue;
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

/** Step 1b: resolve unknown/stuck sends by provider readback — never a second
 * send. 'unknown' is a known crash-after-egress; a 'sending' seen at the top of
 * a tick is a claim from a PRIOR crashed tick (tick is single-flight per slug,
 * so no live claim is ever in this set) — both are resolved the same way: ask
 * the provider whether the effect exists. Confirmed → done; absent → the send
 * never landed, requeue as approved. Neither path ever re-sends blindly. */
async function resolveUnknownSends(slug: string): Promise<number> {
  const doc = await load(slug);
  let resolved = 0;
  for (const int of doc.interactions.filter((i) => i.status === 'unknown' || i.status === 'sending')) {
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
 * Deliver notices to this workstream's manager (if any), unconditionally,
 * every tick cycle — never gated on this workstream's own status, so a
 * conclude that flips status to 'done' still gets its 'finished' notice
 * delivered within the SAME tick. Candidates are re-derived from durable
 * facts (conclusion, open blocker/budget attention) on every call rather than
 * consumed from a queue, so a crash between conclude and delivery is repaired
 * by any later tick — the same shape as `recoverCrashedAttempts` and the
 * coordinator's quiescence backstop, reused rather than reinvented.
 *
 * 'review'/'approval'/'capacity' attention is excluded on purpose: those are
 * the managed stream's own gate (or self-resolving), not the manager's
 * business — including them would wake-storm the manager on routine noise.
 *
 * A missing or unreadable manager doc is a no-op that never blocks the
 * managed stream: management is a one-way pointer, not a dependency.
 */
export async function deliverManagerNotices(slug: string): Promise<number> {
  const doc = await load(slug);
  const managedBy = doc.workstream.managedBy;
  if (!managedBy) return 0;
  let managerDoc: WorkstreamDoc;
  try {
    managerDoc = await load(managedBy.slug);
  } catch {
    return 0;
  }
  const existingKeys = new Set((managerDoc.managerNotices ?? []).map((n) => n.dedupKey));
  const candidates: { dedupKey: string; kind: 'finished' | 'needs_attention'; summary: string; refId?: string }[] = [];
  if (doc.workstream.conclusion) {
    const dedupKey = `finished:${doc.workstream.conclusion.passId}`;
    if (!existingKeys.has(dedupKey)) {
      candidates.push({
        dedupKey,
        kind: 'finished',
        summary: `${slug} concluded: ${doc.workstream.conclusion.summary.slice(0, 200)}`,
        refId: doc.workstream.conclusion.passId,
      });
    }
  }
  for (const att of doc.attention) {
    if (
      att.status !== 'open' ||
      isLegacyDollarBudgetAttention(att) ||
      (att.kind !== 'blocker' && att.kind !== 'budget')
    ) continue;
    const dedupKey = `attention:${att.id}`;
    if (existingKeys.has(dedupKey)) continue;
    candidates.push({
      dedupKey,
      kind: 'needs_attention',
      summary: `${slug} needs attention [${att.kind}]: ${att.summary.slice(0, 200)}`,
      refId: att.id,
    });
  }
  if (!candidates.length) return 0;
  let delivered = 0;
  await arrive(managedBy.slug, (d, event) => {
    d.managerNotices = d.managerNotices ?? [];
    // Re-check under the write lock: a concurrent delivery (or a repeat call
    // within the same bounded tick loop) must not double-insert.
    const already = new Set(d.managerNotices.map((n) => n.dedupKey));
    for (const c of candidates) {
      if (already.has(c.dedupKey)) continue;
      d.managerNotices.push({
        id: newId('note'),
        dedupKey: c.dedupKey,
        kind: c.kind,
        fromWorkstreamSlug: slug,
        summary: c.summary,
        ...(c.refId ? { refId: c.refId } : {}),
        receivedAtVirtual: virtualNow().toISOString(),
      });
      delivered++;
    }
    if (!delivered) return;
    d.wakes.push({
      id: newId('wake'),
      reason: `notice(s) received from managed workstream ${slug}`,
      condition: { type: 'immediate' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    event('manager.notice_received', `${delivered} notice(s) from ${slug}`, []);
  });
  return delivered;
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
  if (doc.workstream.status !== 'active') return 0;
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
          // 'passthrough' is pilot reporting the operator's own Claude Code
          // settings ALLOW this exact command (settings deny/ask arrive as
          // 'deny'). Same authority source as a pilot rule — the operator
          // wrote it — so it approves here exactly as it does in the worker
          // supervisor; escalating it sent settings-allowed read-only
          // readbacks to the human queue.
          if (body.decision !== 'approve' && body.decision !== 'passthrough') {
            verdict = { decision: body.decision ?? 'unknown', reason: `${body.reason ?? ''} (${command.slice(0, 60)})` };
            break;
          }
          verdict = { decision: 'approve', reason: body.decision === 'passthrough' ? 'operator Claude Code settings allow' : body.source ?? '' };
        }
      } else {
        // Worker action: its every tool call is judged live by pilot at
        // execution time, so this gate used to check only that pilot was
        // ALIVE. That leaned on per-command supervision catching anything
        // serious — and it does not always, because the operator's own
        // Claude Code settings can pass a command straight through before
        // pilot's ruleset ever runs. An @erdoai/ui release reached npm that
        // way with no human in the loop: the action pushed a version tag,
        // CI did the publishing, and every individual command looked
        // ordinary. So ask pilot about the ACT as well: the objective is
        // what a human would have read on the card, and pilot's rules are
        // written about effects — publishing a package, deleting hosted
        // resources — which is exactly the level a single command hides.
        const res = await fetch(`${base}/internal/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runtime: 'claude',
            tool_name: 'WeaverAction',
            tool_input: JSON.stringify({ objective: asg.objective, cwd: asg.exec!.cwd }),
            cwd: asg.exec!.cwd,
            session_id: `weaver-${slug}`,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`pilot HTTP ${res.status}`);
        const body = (await res.json()) as { decision?: string; reason?: string; source?: string };
        if (body.decision === 'deny' || body.decision === 'ask') {
          verdict = { decision: body.decision, reason: `${body.reason ?? ''} (action: ${asg.objective.slice(0, 70)})` };
        } else {
          // Approve or passthrough: live per-command supervision still applies
          // to everything the worker then does.
          verdict = { decision: 'approve', reason: 'live per-command pilot supervision' };
        }
      }
    } catch {
      // Daemon unreachable/slow: leave gated for the human, and leave
      // pilotVerdict unset so a recovered daemon gets another chance.
      continue;
    }
    if (!verdict) continue;
    const current = await load(slug);
    if (current.workstream.status !== 'active') break;
    try {
      await mutate(slug, current.revision, (d, event) => {
        const a2 = d.assignments.find((x) => x.id === asg.id);
        if (!a2?.exec || a2.state !== 'gated' || a2.exec.approval || a2.exec.pilotVerdict) return;
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
    } catch (error) {
      if (error instanceof RevisionConflictError) continue;
      throw error;
    }
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
  // ELIGIBILITY GATE. Readback observes the world AFTER an approved act; it is
  // not a free-standing way to run model-authored shell with the workstream's
  // secrets. Refuse unless the action was actually approved (human or pilot)
  // AND has a recorded execution attempt that legitimately needs reading back.
  // Without this, a gated/unapproved action's `exec.verify` — arbitrary shell —
  // could run with credentials and masquerade as deterministic observation.
  // (Making that shell UNABLE to create the fact it observes needs a read-only
  // execution substrate; that belongs to the WorkerExecutor seam. Until then
  // this gate + the post-approval-only invariant is the documented boundary —
  // see docs/harness.md.)
  if (!asg.exec.approval) {
    throw new Error(`${assignmentId} verify refused: action is not approved (state ${asg.state}) — readback runs only after an approved act`);
  }
  if (asg.attempts.length === 0) {
    throw new Error(`${assignmentId} verify refused: no execution attempt to read back`);
  }
  const secrets = loadSecrets(slug);
  const redactionSecrets = loadRedactionSecrets(slug);


  let ok = false;
  let output = '';
  try {
    output = execSync(asg.exec.verify, {
      cwd: asg.exec.cwd,
      shell: actionShell(),
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
  output = redactSecrets(output, redactionSecrets);
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
 * REPO-EGRESS DECONFLICTION GATE — invariant 8 extended across the git-repo
 * seam. Before an action performs an irreversible repo egress (opening a PR,
 * merging a PR, pushing a branch), check whether another OPEN PR is
 * concurrently editing the same files. A colliding open PR is a "conflicting
 * arrival" on shared EXTERNAL state, exactly as a concurrent steer/reply is on
 * internal state: at egress we fail CLOSED to the human to reconcile — never a
 * second competing write into the same files.
 *
 * Returns true when it is safe to proceed (no live collision, or this is not a
 * repo egress, or the detector is unavailable — the detector fails OPEN on
 * tooling failure, see repoEgressCollisions), false when it HELD the action.
 *
 * "RECONCILE, DON'T RE-WRITE" (invariants 7 & 8): a held action is NOT failed
 * and NOT counted as progress — it stays queued+approved. A later tick
 * re-checks and proceeds automatically once the collision clears (the other PR
 * merges/closes). This mirrors invariant 7's send posture (an unknown/blocked
 * egress triggers reconciliation, never a blind second send) and invariant 8's
 * write posture (a conflicting arrival forces reconciliation from newer state).
 * The attention item is deduped on the action id + the sorted colliding PR
 * numbers so it is raised once per distinct collision, not every tick.
 */
async function guardRepoEgress(slug: string, asg: Assignment): Promise<boolean> {
  if (!isRepoEgressAction(asg) || !asg.exec) return true;
  const collisions = await repoEgressCollisions(asg.exec.cwd);
  if (collisions.length === 0) return true;
  // Report, never block — see deconflict.ts. Recorded once per distinct set of
  // contended files so a long-lived action does not re-log the same overlap on
  // every tick; a collision reaching a new file is new information and is.
  const dedupToken = collisionKey(asg.id, collisions.flatMap((c) => c.files));
  const detail = collisions
    .map((c) => `#${c.number} (@${c.author}, ${c.headRefName}) — overlaps ${c.files.join(', ')}`)
    .join('; ');
  await arrive(slug, (d, event) => {
    if (d.events.some((e) => e.type === 'action.repo_egress_parallel' && e.summary.includes(dedupToken))) {
      return;
    }
    event(
      'action.repo_egress_parallel',
      `${asg.id} shares files with open PR(s) ${collisions.map((c) => `#${c.number}`).join(', ')} — proceeding; git settles any real conflict at merge time, and --force-with-lease catches a moved remote. ${detail} ${dedupToken}`,
      [asg.id],
    );
  });
  return true;
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
async function executeHumanActions(slug: string, allowed?: Set<string>): Promise<number> {
  const doc = await load(slug);
  if (doc.workstream.status !== 'active') return 0;
  let executed = 0;
  const due = doc.assignments.filter(
    (a) =>
      a.kind === 'action' &&
      a.state === 'queued' &&
      a.exec?.run &&
      a.exec.approval &&
      // Actions the repo-egress deconfliction gate held are excluded here so
      // this function's own re-derived due list cannot execute what the gate
      // blocked in tickLocked.
      (!allowed || allowed.has(a.id)),
  );
  for (const asg of due) {
    // The command is an external act. Pause is re-read at the last async
    // boundary before execution, not trusted from the tick's initial load.
    const current = await load(slug);
    if (current.workstream.status !== 'active') break;
    const runId = newId('run');
    try {
      await mutate(slug, current.revision, (d, event) => {
        const a2 = d.assignments.find((x) => x.id === asg.id);
        if (!a2 || a2.state !== 'queued' || !a2.exec?.run || !a2.exec.approval) {
          throw new Error(`${asg.id} is no longer an approved queued engine action`);
        }
        a2.state = 'running';
        a2.attempts.push({ runId, model: 'engine', runnerPid: process.pid, startedAt: new Date().toISOString() });
        event('action.engine_started', `${asg.id} engine executing human-authored command`, [asg.id]);
      });
    } catch (error) {
      if (error instanceof RevisionConflictError) break;
      throw error;
    }
    mkdirSync(asg.exec!.cwd, { recursive: true });
    const secrets = loadSecrets(slug);
    const redactionSecrets = loadRedactionSecrets(slug);
    let ok = false;
    let output = '';
    try {
      output = execSync(asg.exec!.run!, {
        cwd: asg.exec!.cwd,
        shell: actionShell(),
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
    output = redactSecrets(output, redactionSecrets);
    const report = [
      `# Engine execution of ${asg.id}`,
      ``,
      `Command (human-authored, executed verbatim by the engine — no model):`,
      '```',
      redactSecrets(asg.exec!.run!, redactionSecrets),
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
      driverDead = !pidIsLive(attempt.runnerPid);
    }
    const ageMs = Date.now() - new Date(attempt.startedAt).getTime();
    if (!driverDead && ageMs < staleMs) continue;
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
        // WHICH check fired, and how long the attempt actually ran. Reporting
        // the staleness CONSTANT for both made every restart-orphaned attempt
        // read as a 45-minute stall in the log, which is the opposite of what
        // happened: a dead driver is detected immediately, and the difference
        // between "ran 45 minutes and hung" and "died 5 minutes in when its
        // runner was replaced" is the whole diagnosis.
        `${asg.id} attempt ${attempt.runId} ${driverDead
          ? `orphaned — its runner (pid ${attempt.runnerPid}) is gone, ${Math.round(ageMs / 1000)}s in`
          : `presumed crashed — no result after ${Math.round(ageMs / 1000)}s (limit ${Math.round(staleMs / 1000)}s)`}; ${isAction ? 'action held for readback' : 're-queued'}`,
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

export function runnableAssignments(doc: WorkstreamDoc): string[] {
  if (doc.workstream.status !== 'active') return [];
  const now = virtualNow().toISOString();
  return doc.assignments
    .filter((a) => a.state === 'queued')
    // Capacity belongs to an exact executor/provider/model pool. A limited
    // preferred route must not park independent work whose fallback is live.
    .filter((a) => {
      const target = workerTargetForAssignment(a);
      const retryAt = capacityBackoffFor(doc, target)?.wait.retryAt;
      return !retryAt || retryAt <= now;
    })
    // A provider outage never erases intended work, but it must defer the
    // next disposable attempt. Without this typed guard, one credit failure
    // becomes a tight worker retry loop before its wake is due.
    .filter((a) => {
      const target = workerTargetForAssignment(a);
      const wait = a.attempts.at(-1)?.infrastructure;
      return !wait ||
        wait.model !== target.model ||
        wait.executor !== target.executor ||
        wait.provider !== target.provider ||
        wait.retryAt <= now;
    })
    // exec.run actions belong to the engine, never to a model worker
    .filter((a) => !a.exec?.run)
    .filter((a) =>
      a.dependsOn.every((dep) => {
        const d = doc.assignments.find((x) => x.id === dep);
        // A dependency is satisfied ONLY by an upstream that both reached
        // 'completed' AND was ADOPTED ('accepted'). Adoption is what pins the
        // artifact a worker actually receives (worker.ts injects accepted
        // deliverables only), so the scheduler's satisfaction rule and the
        // injection rule now agree: a runnable assignment receives every
        // dependency artifact it expects.
        //
        // A rejected upstream is ALSO 'completed' (reject_submission sets
        // completed+rejected) but produced no accepted artifact, and a
        // cancelled upstream produced none either — so neither auto-satisfies
        // anymore. If a downstream genuinely needs no accepted input, that is
        // the coordinator's explicit act: it cancels or re-points the
        // dependency. The scheduler never infers "settled without input" from a
        // rejection or cancellation. An UNKNOWN dep id (no matching assignment)
        // can never be satisfied — it blocks here, and flagDanglingDependencies
        // raises the integrity signal so the stuck work is not silent.
        return d ? d.state === 'completed' && d.adoption.state === 'accepted' : false;
      }),
    )
    .map((a) => a.id);
}

/**
 * Raise a single, deduped integrity signal for every queued assignment that
 * depends on an id no assignment carries — a dangling dependency the scheduler
 * can never satisfy (runnableAssignments blocks it), so without this the work
 * would sit queued forever, invisible. Mirrors the budget attention: it checks
 * for an existing open signal before pushing, so a stuck assignment is
 * surfaced once, not on every tick. A dangling id is an integrity fault, not
 * routine work, so it reaches the human as a 'blocker'. Returns the number of
 * fresh signals raised.
 */
export async function flagDanglingDependencies(slug: string): Promise<number> {
  const doc = await load(slug);
  const known = new Set(doc.assignments.map((a) => a.id));
  const candidates = doc.assignments.filter(
    (a) =>
      a.state === 'queued' &&
      a.dependsOn.some((dep) => !known.has(dep)) &&
      !doc.attention.some((att) => att.kind === 'blocker' && att.status === 'open' && att.refId === a.id),
  );
  if (candidates.length === 0) return 0;
  let raised = 0;
  await arrive(slug, (d, event) => {
    const knownIds = new Set(d.assignments.map((a) => a.id));
    for (const candidate of candidates) {
      // Re-derive against the doc the write sees: a concurrent arrival may have
      // added the missing assignment, changed the state, or raised the signal.
      const asg = d.assignments.find((x) => x.id === candidate.id);
      if (!asg || asg.state !== 'queued') continue;
      const missing = asg.dependsOn.filter((dep) => !knownIds.has(dep));
      if (missing.length === 0) continue;
      if (d.attention.some((att) => att.kind === 'blocker' && att.status === 'open' && att.refId === asg.id)) continue;
      d.attention.push({
        id: newId('att'),
        kind: 'blocker',
        summary: `Assignment ${asg.id} depends on ${missing.join(', ')}, which no assignment provides — it can never become runnable until you cancel or re-point the dependency.`,
        refId: asg.id,
        status: 'open',
        createdAt: new Date().toISOString(),
      });
      event('assignment.dangling_dependency', `${asg.id} blocked on unknown dependency ${missing.join(', ')}`, [asg.id]);
      raised++;
    }
  });
  return raised;
}

export function coordinatorBackoffActive(doc: WorkstreamDoc): boolean {
  const now = virtualNow().toISOString();
  const selectedTarget = pickCoordinatorTarget(doc, now);
  const retryAt = capacityBackoffFor(doc, selectedTarget)?.wait.retryAt;
  return retryAt ? retryAt > now : false;
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
  // Cross-process tick exclusion lives behind the store (fs: ownership-marked
  // process lock; Postgres: session advisory lock) — the doc's revision check
  // guards logical conflicts, not two OS processes dispatching the same act
  // in one instant.
  const releaseTick = await tryTickLock(slug);
  if (!releaseTick) return { ...report, skipped: 'another process is ticking this workstream' };
  try {
    const status = (await load(slug)).workstream.status;
    if (status !== 'active') return { ...report, skipped: `workstream is ${status}` };
    return await tickLocked(slug, maxPasses, report);
  } finally {
    await releaseTick();
  }
}

async function tickLocked(slug: string, maxPasses: number, report: TickReport): Promise<TickReport> {

  cycles: for (let cycle = 0; cycle < 12; cycle++) {
    const cycleStatus = await workstreamStatus(slug);
    if (cycleStatus !== 'active') {
      if (cycleStatus === 'paused') report.skipped = 'workstream became paused during this tick';
      break;
    }
    report.cycles = cycle + 1;
    let progressed = false;

    if ((await recoverCrashedAttempts(slug)) > 0) progressed = true;
    // Compatibility repair happens before attention/manager delivery so an
    // old lifetime-dollar card cannot remain a false human blocker.
    if (await retireLegacyDollarBudgetCard(slug)) progressed = true;
    if ((await pilotApproveGatedActions(slug)) > 0) progressed = true;
    if ((await deliverManagerNotices(slug)) > 0) progressed = true;
    report.unknownsResolved += await resolveUnknownSends(slug);
    const sent = await executeApprovedSends(slug);
    report.sendsExecuted += sent;
    if (sent > 0) progressed = true;

    const afterEgressStatus = await workstreamStatus(slug);
    if (afterEgressStatus !== 'active') {
      if (afterEgressStatus === 'paused') report.skipped = 'workstream became paused during this tick';
      break;
    }

    // Human-authored commands: engine executes, then readback judges. Repo
    // egresses (push/merge/PR-open) pass the deconfliction gate first — a live
    // colliding open PR holds the action for the human rather than executing a
    // second competing write into the same files (invariant 8 across the seam).
    const engineActCandidates = (await load(slug)).assignments.filter(
      (a) => a.kind === 'action' && a.state === 'queued' && a.exec?.run && a.exec.approval,
    );
    const engineActs: string[] = [];
    for (const a of engineActCandidates) {
      if (await guardRepoEgress(slug, a)) engineActs.push(a.id);
    }
    const engineActCount = engineActs.length ? await executeHumanActions(slug, new Set(engineActs)) : 0;
    if (engineActCount > 0) {
      for (const id of engineActs.slice(0, engineActCount)) {
        const ok = await verifyAction(slug, id);
        process.stderr.write(`[tick] engine action ${id} readback: ${ok ? 'CONFIRMED' : 'FAILED'}\n`);
      }
      progressed = true;
    }

    const afterEngineActionStatus = await workstreamStatus(slug);
    if (afterEngineActionStatus !== 'active') {
      if (afterEngineActionStatus === 'paused') report.skipped = 'workstream became paused during this tick';
      break;
    }

    // Surface any queued assignment stuck on a dependency id no assignment
    // provides. Raising the signal is deliberately NOT progress: dedup keeps it
    // from re-raising, so it must not spin the cycle loop.
    await flagDanglingDependencies(slug);

    const runnable = runnableAssignments(await load(slug));
    for (const id of runnable) {
      // Recheck before every model-backed assignment: each successful claim
      // changes the rolling position. Engine-authored deterministic actions
      // run above and are intentionally outside this model-start guard.
      if (await parkIfExecutionLimited(slug)) break cycles;
      const beforeWorkerDoc = await load(slug);
      if (beforeWorkerDoc.workstream.status !== 'active') {
        if (beforeWorkerDoc.workstream.status === 'paused') report.skipped = 'workstream became paused during this tick';
        break cycles;
      }
      // The batch was computed before earlier workers ran. Re-evaluate this
      // assignment now so a new exact-target backoff suppresses only its
      // siblings while other routed pools can continue.
      if (!runnableAssignments(beforeWorkerDoc).includes(id)) continue;
      // Repo-egress deconfliction gate: hold an action worker whose egress
      // (push/merge/PR-open) would collide with another OPEN PR editing the
      // same files, rather than launching a second competing write. Held
      // actions stay queued+approved and re-run automatically once the
      // collision clears; skip past this id without counting it as progress.
      const runnableAsg = (await load(slug)).assignments.find((a) => a.id === id);
      if (runnableAsg && !(await guardRepoEgress(slug, runnableAsg))) continue;
      process.stderr.write(`[tick] running worker for ${id}…\n`);
      const started = await runWorker(slug, id);
      if (!started) break cycles;
      report.workersRun.push(id);
      // Action assignments: the worker's claim settles nothing — run the
      // deterministic readback now so the reviewing pass sees verified truth.
      const after = (await load(slug)).assignments.find((a) => a.id === id);
      if (after?.kind === 'action' && after.exec) {
        const ok = await verifyAction(slug, id);
        process.stderr.write(`[tick] action ${id} readback: ${ok ? 'CONFIRMED' : 'FAILED'}\n`);
        const latest = (await load(slug)).assignments.find((a) => a.id === id);
        const wait = latest?.attempts.at(-1)?.infrastructure;
        // An action worker can lose model capacity after touching the world.
        // Passing readback means the effect landed: stop before any retry and
        // submit the verified fact for adoption. Failed readback leaves the
        // approved idempotent act deferred until the typed retry boundary.
        if (ok && wait && latest?.state === 'queued') {
          await arrive(slug, (d, event) => {
            const a2 = d.assignments.find((a) => a.id === id)!;
            a2.state = 'awaiting_review';
            a2.submission = {
              summary: 'The worker lost provider capacity after execution; deterministic readback confirmed the external effect landed.',
            };
            a2.adoption = { state: 'proposed' };
            d.wakes.push({
              id: newId('wake'),
              reason: `action ${id} readback confirmed its effect after worker infrastructure backoff`,
              condition: { type: 'immediate' },
              status: 'pending',
              createdAt: new Date().toISOString(),
            });
            event('action.recovered_by_readback', `${id} effect confirmed after ${wait.kind}; no retry`, [id]);
          });
        }
      }
      progressed = true;
      // Infrastructure belongs to this exact route. The next iteration's
      // fresh runnable check skips its siblings without suppressing other
      // providers/models in the same precomputed batch.
      const afterWorkerStatus = await workstreamStatus(slug);
      if (afterWorkerStatus !== 'active') {
        if (afterWorkerStatus === 'paused') report.skipped = 'workstream became paused during this tick';
        break cycles;
      }
    }

    const beforeCoordinatorStatus = await workstreamStatus(slug);
    if (beforeCoordinatorStatus !== 'active') {
      if (beforeCoordinatorStatus === 'paused') report.skipped = 'workstream became paused during this tick';
      break;
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

    // Orphan running-pass sweep, INDEPENDENT of the stored lease. The recovery
    // above only repairs a pass its own expired lease still names. A pass left
    // 'running' with no LIVE lease naming it — lease already cleared, or never
    // matched — would otherwise keep false 'running' provenance forever. Tick
    // is single-flight per slug, so any 'running' pass seen here whose lease is
    // not live has no driver: mark it no_finish and restore a wake so the
    // stream cannot silently sleep.
    {
      const d0 = await load(slug);
      const liveLeasePass =
        d0.lease && new Date(d0.lease.expiresAt).getTime() > Date.now() ? d0.lease.passId : undefined;
      const orphans = d0.passes.filter((p) => p.outcome === 'running' && p.id !== liveLeasePass);
      if (orphans.length) {
        await arrive(slug, (d, event) => {
          for (const p of d.passes) {
            if (p.outcome !== 'running' || p.id === liveLeasePass) continue;
            p.outcome = 'no_finish';
            p.endedAt = p.endedAt ?? new Date().toISOString();
            p.summary = p.summary ?? 'orphaned running pass (no live lease) — swept by recovery';
            event('pass.orphan_swept', `${p.id} was 'running' with no live lease — marked no_finish`, [p.id]);
          }
          if (d.workstream.status === 'active' && !d.wakes.some((w) => w.status === 'pending')) {
            d.wakes.push({
              id: newId('wake'),
              reason: 'orphaned running pass swept — reconcile from current state',
              condition: { type: 'immediate' },
              status: 'pending',
              createdAt: new Date().toISOString(),
            });
          }
        });
        progressed = true;
      }
    }

    const preDoc = await load(slug);
    const due = dueWakes(preDoc);
    // A live lease means no pass can start: leave the wakes PENDING for the
    // next tick rather than burning them against a pass that cannot run.
    const leaseLive = preDoc.lease && new Date(preDoc.lease.expiresAt).getTime() > Date.now();
    if (
      preDoc.workstream.status === 'active' &&
      due.length > 0 &&
      !coordinatorBackoffActive(preDoc) &&
      !leaseLive &&
      report.passes.length < maxPasses
    ) {
      // Leave every due organizational wake pending while the physical-time
      // guard is closed. Its own typed wall wake will resume automatically.
      if (await parkIfExecutionLimited(slug)) break cycles;
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
        // The pass never started (lease race or concurrent guard claim): restore the
        // wakes so the arrival is not silently lost.
        await arrive(slug, (d, event) => {
          for (const w of d.wakes) {
            if (due.some((x) => x.id === w.id) && w.status === 'fired' && !w.firedInPass) {
              w.status = 'pending';
            }
          }
          event('wakes.restored', `pass could not start (${e instanceof Error ? e.message.slice(0, 120) : e}); ${due.length} wake(s) restored to pending`);
        });
        const stoppedStatus = await workstreamStatus(slug);
        if (stoppedStatus !== 'active') {
          if (stoppedStatus === 'paused') report.skipped = 'workstream became paused during this tick';
          break cycles;
        }
        // A concurrent model claim can close the rolling window after the
        // engine's precheck. The atomic claim parked its typed recovery wake;
        // this tick is safely quiescent, not failed.
        if (e instanceof ExecutionSafetyLimitedError) break cycles;
        throw e;
      }
      progressed = true;
    }

    if (!progressed) break;
  }
  return report;
}
