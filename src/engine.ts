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
import {
  CoordinatorRunnerIneligibleError,
  pickCoordinatorTarget,
  pickCoordinatorTargetForExecutors,
  runCoordinatorPass,
} from './coordinator.js';
import type { CoordinatorExecutor } from './executor/coordinator.js';
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
import { arrive, listRunnerPresence, load, mutate, newId, readArtifact, RevisionConflictError, tryTickLock, verifyArtifact, writeArtifact } from './store.js';
import { virtualNow } from './clock.js';
import { pidIsLive } from './processLock.js';
import {
  checkStrandedPush,
  collisionKey,
  isRepoEgressAction,
  liveStrandedPushIO,
  repoEgressCollisions,
  strandedPushGuidance,
  strandedPushKey,
  type StrandedPushIO,
} from './deconflict.js';
import {
  assignmentCannotBecomeAccepted,
  assignmentDependenciesSatisfied,
  capacityBackoffFor,
  isTransientInfrastructureText,
  selectWorkerCapacityTarget,
} from './capacity.js';
import { runnerExecutorCapabilities } from './modelRouting.js';
import type { Assignment, WorkstreamDoc } from './types.js';
import { ensureActionApprovalAttention, isPilotUnavailableApprovalAttention } from './actionApproval.js';
import { pilotFetch, readPilotVerdict } from './pilot.js';
import {
  actionUsesGitHub,
  GitHubAppPreparationError,
  githubAppEnvironment,
  type GitHubAppAccess,
} from './githubApp.js';
import {
  assignmentMatchesRunner,
  runnerClaimIdentity,
  RunnerPlacementMismatchError,
  type RunnerClaimIdentity,
} from './runnerIdentity.js';
import { coordinatorRunnerEligibility } from './coordinatorRunner.js';

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

function actionHasMatchingApproval(asg: Assignment): boolean {
  const approval = asg.exec?.approval;
  return !!approval
    && (asg.exec?.approvalMode !== 'human-only' || approval.by === 'human');
}

/** Ephemeral repository credentials join an approved action only for the
 * lifecycle that needs them. The App key itself never leaves the controller. */
async function actionExecutionSecrets(
  slug: string,
  asg: Assignment,
  access: GitHubAppAccess,
): Promise<{ secrets: Record<string, string>; redactionSecrets: Record<string, string> }> {
  const githubAccess: GitHubAppAccess = access === 'write' && isRepoEgressAction(asg)
    ? 'write'
    : 'read';
  const githubEnvironment = actionUsesGitHub(asg) && asg.exec
    ? await githubAppEnvironment(asg.exec.cwd, githubAccess)
    : {};
  const secrets = { ...loadSecrets(slug), ...githubEnvironment };
  return {
    secrets,
    redactionSecrets: { ...loadRedactionSecrets(slug), ...secrets },
  };
}

/** A known credential/configuration failure before the one-shot claim cannot
 * have changed the world. Settle it as failed with zero attempts, wake the
 * coordinator once to repair the assignment, and keep it out of Needs You. */
async function settleActionPreparationFailure(
  slug: string,
  assignmentId: string,
  error: GitHubAppPreparationError,
): Promise<boolean> {
  const detail = redactSecrets(error.message, loadRedactionSecrets(slug)).slice(0, 500);
  let settled = false;
  await arrive(slug, (d, event) => {
    const asg = d.assignments.find((candidate) => candidate.id === assignmentId);
    if (!asg || asg.kind !== 'action' || asg.state !== 'queued' || asg.attempts.length > 0) return;
    asg.state = 'failed';
    d.wakes.push({
      id: newId('wake'),
      reason: `Action ${assignmentId} could not start because its credential or execution configuration failed before the one-shot claim (${detail}). It made zero execution attempts and no external effect. Reconcile the durable assignment from this known failure; do not retry this action in place.`,
      condition: { type: 'immediate' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    event(
      'action.preparation_failed',
      `${assignmentId} failed before its one-shot claim with zero attempts and no external effect: ${detail}`,
      [assignmentId],
    );
    settled = true;
  });
  return settled;
}

/** A non-confirming action readback proves neither that the effect landed nor
 * that it is absent. Hold the one-shot action and surface exactly one durable
 * reconciliation decision; a retry must be a new, separately approved act. */
function holdActionForUnknownReadback(
  doc: WorkstreamDoc,
  assignmentId: string,
  detail: string,
): boolean {
  const asg = doc.assignments.find((a) => a.id === assignmentId);
  if (!asg) return false;
  asg.state = 'failed';
  const alreadyOpen = doc.attention.some(
    (att) =>
      att.kind === 'blocker' &&
      att.status === 'open' &&
      att.refId === assignmentId &&
      att.summary.includes('readback did not confirm'),
  );
  if (alreadyOpen) return false;
  doc.attention.push({
    id: newId('att'),
    kind: 'blocker',
    summary: `Action ${assignmentId} may already have changed the outside world, but readback did not confirm it (${detail}). It remains failed and will not run again automatically; reconcile with the provider or a human, then create and separately approve a new action if another attempt is needed.`,
    refId: assignmentId,
    status: 'open',
    createdAt: new Date().toISOString(),
  });
  return true;
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
 * A deny/ask fails closed to the human queue. An unreachable daemon remains a
 * typed operational wait and never manufactures human authority; a briefing
 * with no explicit engine command is supervised live by Pilot in the worker.
 */
async function pilotApproveGatedActions(slug: string): Promise<number> {
  const doc = await load(slug);
  if (doc.workstream.status !== 'active') return 0;
  let approved = 0;
  const wallNow = new Date();
  const wallNowIso = wallNow.toISOString();
  const gated = doc.assignments.filter(
    (a) => a.kind === 'action'
      && a.state === 'gated'
      && a.exec
      && a.exec.approvalMode !== 'human-only'
      && !a.exec.approval
      && !a.exec.pilotVerdict
      && (!a.exec.pilotRetryAt || a.exec.pilotRetryAt <= wallNowIso),
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
          const res = await pilotFetch('/internal/evaluate', {
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
          const body = await readPilotVerdict(res);
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
        // pilot's ruleset ever runs. A package release reached npm that way
        // way with no human in the loop: the action pushed a version tag,
        // CI did the publishing, and every individual command looked
        // ordinary. So ask pilot about the ACT as well: the objective is
        // what a human would have read on the card, and pilot's rules are
        // written about effects — publishing a package, deleting hosted
        // resources — which is exactly the level a single command hides.
        const res = await pilotFetch('/internal/evaluate', {
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
        const body = await readPilotVerdict(res);
        if (body.decision === 'deny' || body.decision === 'ask') {
          verdict = { decision: body.decision, reason: `${body.reason ?? ''} (action: ${asg.objective.slice(0, 70)})` };
        } else {
          // Approve or passthrough: live per-command supervision still applies
          // to everything the worker then does.
          verdict = { decision: 'approve', reason: 'live per-command pilot supervision' };
        }
      }
    } catch {
      // An unavailable Pilot is one fleet dependency incident, never one human
      // decision per gated action. Persist the typed first-failure marker and
      // a bounded physical retry rather than probing it every runner poll. The
      // fleet projection groups every affected action while the authority
      // firewall keeps each one safely gated with no verdict.
      const current = await load(slug);
      const retryAt = new Date(wallNow.getTime() + 60_000).toISOString();
      try {
        await mutate(slug, current.revision, (d, event) => {
          const a2 = d.assignments.find((x) => x.id === asg.id);
          if (!a2?.exec || a2.state !== 'gated' || a2.exec.approval || a2.exec.pilotVerdict) return;
          if (a2.exec.pilotRetryAt && a2.exec.pilotRetryAt > wallNowIso) return;
          const firstFailure = !a2.exec.pilotUnavailableSince;
          a2.exec.pilotUnavailableSince ??= wallNowIso;
          a2.exec.pilotRetryAt = retryAt;
          event(
            firstFailure ? 'action.pilot_unavailable' : 'action.pilot_retry_scheduled',
            `${a2.id} remains safely gated — Pilot is unavailable; retry at ${retryAt}`,
            [a2.id],
          );
        });
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
      }
      continue;
    }
    if (!verdict) continue;
    const current = await load(slug);
    if (current.workstream.status !== 'active') break;
    try {
      await mutate(slug, current.revision, (d, event) => {
        const a2 = d.assignments.find((x) => x.id === asg.id);
        if (!a2?.exec || a2.state !== 'gated' || a2.exec.approval || a2.exec.pilotVerdict) return;
        const legacyOutageAttention = new Set(
          d.attention
            .filter((attention) => isPilotUnavailableApprovalAttention(d, attention) && attention.refId === a2.id)
            .map((attention) => attention.id),
        );
        a2.exec.pilotVerdict = { ...verdict!, at: new Date().toISOString() };
        delete a2.exec.pilotUnavailableSince;
        delete a2.exec.pilotRetryAt;
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
          for (const attention of d.attention) {
            if (!legacyOutageAttention.has(attention.id)) continue;
            attention.status = 'resolved';
            attention.resolvedAt = new Date().toISOString();
            attention.resolvedBy = 'pilot';
          }
          const decision = verdict!.decision === 'deny' ? 'denied this action' : 'requires your judgment';
          ensureActionApprovalAttention(
            d,
            a2,
            () => newId('att'),
            `Pilot ${decision}: ${verdict!.reason}. Decide whether to approve: "${a2.exec.ask ?? a2.objective}"`,
          );
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
/** The one place a verifier command actually runs. A verifier that fails on
 * transient provider infrastructure (a GitHub 503, a DNS blip) says nothing
 * about the action's effect — and a false UNKNOWN files a
 * may-have-changed-the-world card a human must reconcile by hand (two filed
 * on one day of GitHub 503s). Retry those shapes with a pause before
 * concluding; any other failure is a real verdict, once. */
async function execActionVerifier(
  verify: string,
  cwd: string,
  secrets: Record<string, string>,
  redactionSecrets: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  let ok = false;
  let output = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      output = execSync(verify, {
        cwd,
        shell: actionShell(),
        timeout: 60_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...secrets },
      });
      ok = true;
      break;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
      if (attempt < 3 && isTransientInfrastructureText(output)) {
        await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
        continue;
      }
      break;
    }
  }
  return { ok, output: redactSecrets(output, redactionSecrets) };
}

/**
 * PRE-EXECUTION POSTCONDITION CHECK. An approved action's verifier is the
 * machine-checkable statement of the world it intends to create. When that
 * statement already holds BEFORE the action runs — a human merged the PR by
 * hand, an orphaned earlier attempt landed, a sibling stream got there first —
 * executing would at best no-op and at worst double-fire an irreversible act
 * (observed: two approvals executed against already-merged PRs in one day).
 * Confirm the existing effect and hand it to review instead of running.
 *
 * Authority: this runs model-authored shell, so it carries exactly the
 * verifyAction eligibility gate — a matching approval is REQUIRED. A gated,
 * unapproved action's verifier never runs here (see the boundary comment on
 * verifyAction); staleness of gated actions stays a human-visible fact.
 */
export async function preflightApprovedAction(slug: string, assignmentId: string): Promise<boolean> {
  const doc = await load(slug);
  const asg = doc.assignments.find((a) => a.id === assignmentId);
  if (!asg?.exec || asg.kind !== 'action') return false;
  if (asg.state !== 'queued' || asg.attempts.length > 0 || !actionHasMatchingApproval(asg)) return false;
  // Observation-shaped deterministic commands need to run to produce their
  // current result. Their verifier still judges the result AFTER the one-shot
  // execution; it is simply not meaningful as an already-done check. Return
  // before credential preparation and before executing the verifier so this
  // opt-out cannot become a second observational shell call in disguise.
  if (asg.exec.preflightMode === 'always-execute' && asg.exec.run?.trim()) return false;
  const { secrets, redactionSecrets } = await actionExecutionSecrets(slug, asg, 'read');
  const { ok, output } = await execActionVerifier(asg.exec.verify, asg.exec.cwd, secrets, redactionSecrets);
  // Not satisfied is the normal case — proceed to execution with no ceremony.
  // A transient verifier failure lands here too, which is safe: the action
  // simply executes as approved and the ordinary readback follows it.
  if (!ok) return false;
  let satisfied = false;
  await arrive(slug, (d, event) => {
    const a2 = d.assignments.find((x) => x.id === assignmentId);
    if (!a2?.exec || a2.state !== 'queued' || a2.attempts.length > 0 || !actionHasMatchingApproval(a2)) return;
    a2.state = 'awaiting_review';
    a2.exec.verified = { ok: true, output: output.slice(0, 2000), at: new Date().toISOString() };
    a2.submission = a2.submission ?? {
      summary:
        'Postcondition already holds: the approved action was never executed because its own verifier confirmed the intended effect already exists in the world. Review the readback output and adopt the existing effect or dispatch different work; never re-run this action.',
    };
    event(
      'action.already_satisfied',
      `${assignmentId} postcondition already holds — execution skipped, existing effect submitted for review: ${output.trim().slice(0, 160) || '(no output)'}`,
      [assignmentId],
    );
    satisfied = true;
  });
  return satisfied;
}

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
  if (!actionHasMatchingApproval(asg)) {
    throw new Error(`${assignmentId} verify refused: action is not approved by the required authority (state ${asg.state}) — readback runs only after a correctly approved act`);
  }
  if (asg.attempts.length === 0) {
    throw new Error(`${assignmentId} verify refused: no execution attempt to read back`);
  }
  const { secrets, redactionSecrets } = await actionExecutionSecrets(slug, asg, 'read');


  const { ok, output } = await execActionVerifier(asg.exec.verify, asg.exec.cwd, secrets, redactionSecrets);
  await arrive(slug, (d, event) => {
    const a2 = d.assignments.find((x) => x.id === assignmentId)!;
    a2.exec!.verified = { ok, output: output.slice(0, 2000), at: new Date().toISOString() };
    event(
      ok ? 'action.verified' : 'action.verify_failed',
      `${assignmentId} readback ${ok ? 'CONFIRMED' : 'UNKNOWN (verifier did not confirm)'}: ${output.trim().slice(0, 200) || '(no output)'}`,
      [assignmentId],
    );
  });
  return ok;
}

/**
 * REPO-EGRESS DECONFLICTION GATE — invariant 8 extended across the git-repo
 * seam. Before an action performs an irreversible repo egress (opening a PR,
 * merging a PR, pushing a branch), Weaver looks at the shared external state
 * the egress is about to write into. Two different facts, two postures:
 *
 *   1. Another OPEN PR editing the same files — REPORTED, never blocked. Two
 *      branches touching one file is ordinary parallel development; git merges
 *      them and a real textual conflict surfaces at merge time (deconflict.ts).
 *   2. The push target's own PR has already MERGED or CLOSED — HELD. This is
 *      not a conflict git can settle: the commits are in the trunk and the PR
 *      is done, so a push lands work no PR carries and no reviewer sees. The
 *      workstream is woken with the instruction the case calls for (fresh
 *      branch, new PR), and the action stays queued rather than pushing.
 *
 * Returns true when it is safe to proceed (no settled branch, this is not a
 * repo egress, or a check was unavailable — both checks fail OPEN on tooling
 * failure), false when it HELD the action.
 *
 * "RECONCILE, DON'T RE-WRITE" (invariants 7 & 8): a held action is NOT failed
 * and NOT counted as progress — it stays queued+approved. This mirrors
 * invariant 7's send posture (an unknown/blocked egress triggers
 * reconciliation, never a blind second send) and invariant 8's write posture (a
 * conflicting arrival forces reconciliation from newer state). A merged PR
 * never reopens, so unlike a file overlap this hold does not clear on its own —
 * the wake is what moves it, by getting the work re-homed onto a branch that
 * can still be reviewed.
 */
export async function guardRepoEgress(
  slug: string,
  asg: Assignment,
  strandedIO: StrandedPushIO = liveStrandedPushIO,
): Promise<boolean> {
  if (!isRepoEgressAction(asg) || !asg.exec) return true;

  // A settled PR on the push target is the one repo-egress fact that loses
  // work outright, so it is judged first and it blocks.
  const command = [asg.exec.run ?? '', asg.exec.verify ?? ''].join('\n');
  let githubEnvironment: Record<string, string>;
  try {
    githubEnvironment = await githubAppEnvironment(asg.exec.cwd, 'read');
  } catch (error) {
    // Authentication/cwd preparation is not a deconfliction verdict. Abstain
    // here and let the action's own preflight durably settle the known failure
    // before any one-shot attempt is recorded.
    const message = error instanceof Error ? error.message : 'unknown GitHub authentication failure';
    const detail = redactSecrets(message, loadRedactionSecrets(slug)).slice(0, 300);
    process.stderr.write(`[tick] ${asg.id} repo-egress check abstained: ${detail} — action preflight will decide\n`);
    return true;
  }
  const stranded = await checkStrandedPush(asg.exec.cwd, command, strandedIO, githubEnvironment);
  if (stranded.verdict === 'unknown') {
    // Abstention, not a clean bill of health: the egress proceeds (a dead gh
    // must not wedge the fleet) but the gap is on the record.
    process.stderr.write(`[tick] ${asg.id} settled-branch check abstained: ${stranded.reason} — egress proceeds\n`);
  } else if (stranded.verdict === 'stranded') {
    const token = strandedPushKey(asg.id, stranded.branch, stranded.prNumber);
    const guidance = strandedPushGuidance(stranded);
    await arrive(slug, (d, event) => {
      if (d.events.some((e) => e.type === 'action.repo_egress_settled_branch' && e.summary.includes(token))) {
        return;
      }
      event('action.repo_egress_settled_branch', `${asg.id} held: ${guidance} ${token}`, [asg.id]);
      d.wakes.push({
        id: newId('wake'),
        reason: `Repo egress for ${asg.id} is held: ${guidance} Supersede or re-scope the held action so the work egresses on the new branch; it will not push while it targets a settled one.`,
        condition: { type: 'immediate' },
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    });
    return false;
  }

  const collisions = await repoEgressCollisions(asg.exec.cwd, githubEnvironment);
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
async function executeHumanActions(
  slug: string,
  runner: RunnerClaimIdentity,
  allowed?: Set<string>,
): Promise<number> {
  const doc = await load(slug);
  if (doc.workstream.status !== 'active') return 0;
  let executed = 0;
  const due = doc.assignments.filter(
    (a) =>
      a.kind === 'action' &&
      a.state === 'queued' &&
      a.exec?.run &&
      a.attempts.length === 0 &&
      actionHasMatchingApproval(a) &&
      assignmentMatchesRunner(a, runner) &&
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
    const currentAssignment = current.assignments.find((candidate) => candidate.id === asg.id);
    if (!currentAssignment || !assignmentMatchesRunner(currentAssignment, runner)) continue;
    // Postcondition already true: confirm the existing effect, never re-run
    // the human-authored command against a world that has moved on.
    try {
      if (await preflightApprovedAction(slug, asg.id)) {
        executed++;
        continue;
      }
    } catch (error) {
      if (!(error instanceof GitHubAppPreparationError)) throw error;
      if (await settleActionPreparationFailure(slug, asg.id, error)) executed++;
      continue;
    }
    // Mint before recording the one-shot attempt. Authentication is still
    // after approval and immediately before the CAS, but a failed mint cannot
    // manufacture a false may-have-egressed attempt that readback must hold.
    let executionSecrets: Awaited<ReturnType<typeof actionExecutionSecrets>>;
    try {
      executionSecrets = await actionExecutionSecrets(slug, asg, 'write');
    } catch (error) {
      if (!(error instanceof GitHubAppPreparationError)) throw error;
      if (await settleActionPreparationFailure(slug, asg.id, error)) executed++;
      continue;
    }
    const { secrets, redactionSecrets } = executionSecrets;
    const runId = newId('run');
    try {
      await mutate(slug, current.revision, (d, event) => {
        const a2 = d.assignments.find((x) => x.id === asg.id);
        if (!a2 || a2.state !== 'queued' || !a2.exec?.run || a2.attempts.length > 0 || !actionHasMatchingApproval(a2)) {
          throw new Error(`${asg.id} is no longer an approved queued engine action`);
        }
        if (!assignmentMatchesRunner(a2, runner)) {
          throw new RunnerPlacementMismatchError(asg.id, a2.runnerId ?? '(explicit placement required)', runner.id);
        }
        a2.state = 'running';
        a2.attempts.push({
          runId,
          model: 'engine',
          runnerPid: process.pid,
          runnerId: runner.id,
          startedAt: new Date().toISOString(),
        });
        event('action.engine_started', `${asg.id} engine executing human-authored command`, [asg.id]);
      });
    } catch (error) {
      if (error instanceof RevisionConflictError) break;
      if (error instanceof RunnerPlacementMismatchError) continue;
      throw error;
    }
    let ok = false;
    let output = '';
    try {
      // Working-directory preparation is part of the one-shot command
      // execution. The attempt is already durably claimed above, so a mkdir
      // failure must settle exactly like a spawn/exit failure; letting it
      // escape would strand the action as running and invite crash recovery
      // to treat a known pre-execution failure as an unknown external result.
      mkdirSync(asg.exec!.cwd, { recursive: true });
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
async function recoverCrashedAttempts(
  slug: string,
  runner: RunnerClaimIdentity,
  actionsOnly = false,
): Promise<number> {
  // Long research/synthesis workers legitimately run 20+ minutes; recovering
  // a live worker as "crashed" forks the work, so the horizon errs long.
  const staleMs = Number(process.env.WEAVER_ATTEMPT_STALE_MS ?? 45 * 60_000);
  const doc = await load(slug);
  let recovered = 0;
  for (const asg of doc.assignments.filter(
    (a) => a.state === 'running' && (!actionsOnly || (a.kind === 'action' && assignmentMatchesRunner(a, runner))),
  )) {
    const attempt = asg.attempts[asg.attempts.length - 1];
    if (!attempt || attempt.endedAt) continue;
    // A runner id is durable cross-host ownership. Another machine cannot
    // infer whether that process is alive from its local PID namespace OR from
    // elapsed wall time, so only the owning runner may reconcile this attempt.
    // Legacy attempts have no runnerId and retain the former stale/PID repair.
    if (attempt.runnerId !== undefined && attempt.runnerId !== runner.id) continue;
    // A dead driver process means the attempt is orphaned RIGHT NOW — no need
    // to wait out the horizon (the silent-fleet failure mode after restarts).
    let driverDead = false;
    if (
      attempt.runnerPid &&
      attempt.runnerPid !== process.pid
    ) {
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
      // Readback can confirm that the effect landed. A non-zero or un-runnable
      // verifier cannot prove absence: it leaves the external result UNKNOWN,
      // keeps this one-shot action failed, and requires reconciliation.
      let landed = false;
      let readbackDetail = 'verifier returned non-zero';
      try {
        landed = await verifyAction(slug, asg.id);
      } catch (e) {
        readbackDetail = `verifier could not run: ${e instanceof Error ? e.message : e}`;
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
        } else {
          if (holdActionForUnknownReadback(d, asg.id, readbackDetail)) {
            event('action.crash_readback_unknown', `${asg.id} readback did not confirm after crash — held failed for provider/human reconciliation`, [asg.id]);
          }
        }
      });
    }
    recovered++;
  }
  return recovered;
}

/** Compatibility repair for actions persisted by the former bounded-retry
 * policy. Dispatch filters refuse them, but leaving them queued would make the
 * workstream look runnable while it can never advance. Materialize the real
 * state once: the prior attempt's external result needs reconciliation. */
async function holdLegacyQueuedActionRetries(slug: string, runner: RunnerClaimIdentity): Promise<number> {
  const doc = await load(slug);
  let held = 0;
  for (const asg of doc.assignments.filter(
    (a) => a.kind === 'action' && a.state === 'queued' && a.attempts.length > 0 &&
      assignmentMatchesRunner(a, runner),
  )) {
    await arrive(slug, (d, event) => {
      const current = d.assignments.find((a) => a.id === asg.id);
      if (!current || current.state !== 'queued' || current.attempts.length === 0) return;
      if (!assignmentMatchesRunner(current, runner)) return;
      if (holdActionForUnknownReadback(d, asg.id, 'legacy queued state contains a prior action attempt')) {
        event(
          'action.legacy_retry_held',
          `${asg.id} had a prior attempt but was still queued — held failed for provider/human reconciliation`,
          [asg.id],
        );
      }
      held++;
    });
  }
  return held;
}

export function runnableAssignments(
  doc: WorkstreamDoc,
  executorCapabilities?: ReadonlySet<string>,
  runner: RunnerClaimIdentity = runnerClaimIdentity(),
): string[] {
  if (doc.workstream.status !== 'active') return [];
  const now = virtualNow().toISOString();
  return doc.assignments
    .filter((a) => a.state === 'queued')
    .filter((a) => assignmentMatchesRunner(a, runner))
    // A persisted human-only gate cannot be satisfied by a stale/corrupt Pilot
    // approval. Re-check at scheduling, not only when the gate was cleared.
    .filter((a) => a.kind !== 'action' || actionHasMatchingApproval(a))
    // Every action is one-shot. Legacy state may have a failed/crashed attempt
    // re-queued under the old bounded-retry policy; never replay it under the
    // same assignment and approval.
    .filter((a) => a.kind !== 'action' || a.attempts.length === 0)
    // A provider outage never erases intended work, but it must defer the
    // next disposable attempt on that exact target. A reviewed fallback is
    // selected only when earlier pools are backed off; host capability then
    // gates that selected target without silently changing preference.
    .filter((a) => {
      const target = selectWorkerCapacityTarget(doc, a, now, executorCapabilities);
      if (!target) return false;
      const wait = a.attempts.at(-1)?.infrastructure;
      return !wait ||
        wait.model !== target.model ||
        wait.executor !== target.executor ||
        wait.provider !== target.provider ||
        wait.retryAt <= now;
    })
    // exec.run actions belong to the engine, never to a model worker
    .filter((a) => !a.exec?.run)
    .filter((a) => assignmentDependenciesSatisfied(doc, a))
    .map((a) => a.id);
}

/**
 * Raise a single, deduped integrity signal for every queued assignment whose
 * dependency can never become accepted: either its id is missing or the known
 * assignment settled as failed, cancelled, rejected, or superseded. Without
 * this, runnableAssignments correctly blocks the work but it sits queued
 * forever, invisible. Returns the number of fresh signals raised.
 */
export async function flagImpossibleDependencies(slug: string): Promise<number> {
  const doc = await load(slug);
  const byId = new Map(doc.assignments.map((a) => [a.id, a]));
  const candidates = doc.assignments.filter(
    (a) =>
      a.state === 'queued' &&
      a.dependsOn.some((dep) => {
        const dependency = byId.get(dep);
        return !dependency || assignmentCannotBecomeAccepted(dependency);
      }) &&
      !doc.attention.some((att) => att.kind === 'blocker' && att.status === 'open' && att.refId === a.id),
  );
  if (candidates.length === 0) return 0;
  let raised = 0;
  await arrive(slug, (d, event) => {
    const currentById = new Map(d.assignments.map((a) => [a.id, a]));
    for (const candidate of candidates) {
      // Re-derive against the doc the write sees: a concurrent arrival may have
      // added the missing assignment, changed the state, or raised the signal.
      const asg = d.assignments.find((x) => x.id === candidate.id);
      if (!asg || asg.state !== 'queued') continue;
      const impossible = asg.dependsOn.flatMap((dep) => {
        const dependency = currentById.get(dep);
        if (!dependency) return [`${dep} (missing)`];
        return assignmentCannotBecomeAccepted(dependency)
          ? [`${dep} (${dependency.state}/${dependency.adoption.state})`]
          : [];
      });
      if (impossible.length === 0) continue;
      if (d.attention.some((att) => att.kind === 'blocker' && att.status === 'open' && att.refId === asg.id)) continue;
      d.attention.push({
        id: newId('att'),
        kind: 'blocker',
        summary: `Assignment ${asg.id} depends on ${impossible.join(', ')}, which can never become accepted — cancel or re-point the dependency before retrying.`,
        refId: asg.id,
        status: 'open',
        createdAt: new Date().toISOString(),
      });
      event('assignment.impossible_dependency', `${asg.id} blocked on impossible dependency ${impossible.join(', ')}`, [asg.id]);
      raised++;
    }
  });
  return raised;
}

export function coordinatorBackoffActive(
  doc: WorkstreamDoc,
  executorCapabilities?: ReadonlySet<string>,
): boolean {
  const now = virtualNow().toISOString();
  const selectedTarget = executorCapabilities
    ? pickCoordinatorTargetForExecutors(doc, now, executorCapabilities)
    : pickCoordinatorTarget(doc, now);
  if (!selectedTarget) return false;
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

/**
 * One deterministic-action lane shared by a normal reconciliation tick and
 * the narrow machine-local engine-only tick. Candidate derivation, repo
 * deconfliction, one-shot execution, and readback therefore cannot drift.
 */
async function executeDeterministicActionLane(
  slug: string,
  runner: RunnerClaimIdentity,
): Promise<number> {
  const candidates = (await load(slug)).assignments.filter(
    (a) => a.kind === 'action' && a.state === 'queued' && a.exec?.run && a.attempts.length === 0 &&
      actionHasMatchingApproval(a) && assignmentMatchesRunner(a, runner),
  );
  const allowed: string[] = [];
  for (const assignment of candidates) {
    if (await guardRepoEgress(slug, assignment)) allowed.push(assignment.id);
  }
  if (allowed.length === 0) return 0;
  const count = await executeHumanActions(slug, runner, new Set(allowed));
  if (count === 0) return 0;

  // Read back only actions with a recorded attempt. A preflight-satisfied
  // action never ran and has no attempt for verifyAction to authorize.
  const executed = (await load(slug)).assignments.filter(
    (a) => allowed.includes(a.id) && a.attempts.length > 0 && !a.exec?.verified,
  );
  for (const assignment of executed) {
    const ok = await verifyAction(slug, assignment.id);
    process.stderr.write(`[tick] engine action ${assignment.id} readback: ${ok ? 'CONFIRMED' : 'UNKNOWN'}\n`);
  }
  return count;
}

async function tickEngineOnlyLocked(
  slug: string,
  runner: RunnerClaimIdentity,
  report: TickReport,
): Promise<TickReport> {
  report.cycles = 1;
  // These are the only compatibility transitions allowed in the narrow lane:
  // reconcile a crashed/prior one-shot ACTION before considering a new exact
  // command. Model work, sends, Pilot, manager delivery, and coordinator state
  // are deliberately outside this function.
  await recoverCrashedAttempts(slug, runner, true);
  await holdLegacyQueuedActionRetries(slug, runner);
  await executeDeterministicActionLane(slug, runner);
  return report;
}

export async function tick(
  slug: string,
  opts: {
    maxPasses?: number;
    /** Narrow machine-scheduler lane: matching placed deterministic actions
     * and their readback only. Requires placement-only runner config. */
    engineOnly?: boolean;
    executorCapabilities?: ReadonlySet<string>;
    /** Test seam: a stub coordinator executor (real tools, no model). The
     * production path picks the executor from the pinned target; passing one
     * here is the same injection runCoordinatorPass already supports, so a
     * deterministic test can drive a FULL tick — including coordinator
     * mutations — without a model call. */
    coordinatorExecutor?: CoordinatorExecutor;
  } = {},
): Promise<TickReport> {
  const runner = runnerClaimIdentity();
  const maxPasses = opts.maxPasses ?? 3;
  if (opts.engineOnly && !runner.placementOnly) {
    throw new Error('`weaver tick --engine-only` requires WEAVER_RUNNER_PLACEMENT_ONLY=1 and an explicit WEAVER_RUNNER_ID');
  }
  if (!opts.engineOnly && runner.placementOnly) {
    throw new Error('WEAVER_RUNNER_PLACEMENT_ONLY=1 requires `weaver tick <slug> --engine-only`; a normal tick could enter sends, Pilot, or model lanes');
  }
  const executorCapabilities = opts.engineOnly
    ? undefined
    : (opts.executorCapabilities ?? runnerExecutorCapabilities());
  const coordinatorExecutor = opts.coordinatorExecutor;
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
    if (status !== 'active') {
      // A concluded stream is never ticked again by the runner, but its
      // 'finished' notice must still be deliverable by any later tick: a
      // crash between the conclude write and the same-tick delivery step
      // otherwise strands the parent notice until a human resumes the child.
      // Candidates are re-derived from durable facts and deduped, so this is
      // a free, idempotent repair — and the paused state is left untouched
      // (pausing never concludes anything).
      if (status === 'done' && !opts.engineOnly) await deliverManagerNotices(slug);
      return { ...report, skipped: `workstream is ${status}` };
    }
    if (opts.engineOnly) return await tickEngineOnlyLocked(slug, runner, report);
    return await tickLocked(slug, maxPasses, report, executorCapabilities, runner, coordinatorExecutor);
  } finally {
    await releaseTick();
  }
}

async function tickLocked(
  slug: string,
  maxPasses: number,
  report: TickReport,
  executorCapabilities?: ReadonlySet<string>,
  runner: RunnerClaimIdentity = runnerClaimIdentity(),
  coordinatorExecutor?: CoordinatorExecutor,
): Promise<TickReport> {

  cycles: for (let cycle = 0; cycle < 12; cycle++) {
    const cycleStatus = await workstreamStatus(slug);
    if (cycleStatus !== 'active') {
      if (cycleStatus === 'paused') report.skipped = 'workstream became paused during this tick';
      else {
        // A conclude inside this tick's own pass flips status to 'done' AFTER
        // this cycle's delivery step already ran — and a done stream is never
        // ticked again, so without this the 'finished' notice would strand
        // forever. Deliver once more before exiting: candidates are re-derived
        // from durable facts, so this is idempotent and free when nothing is
        // new. (Proved by the deterministic same-tick notice test in
        // managedWorkstream.test.ts, which drives a real tick.)
        await deliverManagerNotices(slug);
      }
      break;
    }
    report.cycles = cycle + 1;
    let progressed = false;

    if ((await recoverCrashedAttempts(slug, runner)) > 0) progressed = true;
    if ((await holdLegacyQueuedActionRetries(slug, runner)) > 0) progressed = true;
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
      else await deliverManagerNotices(slug);
      break;
    }

    // Human-authored commands: engine executes, then readback judges. Repo
    // egresses (push/merge/PR-open) pass the deconfliction gate first — an
    // overlap with another open PR is recorded and ships, while a push target
    // whose own PR has already merged is held rather than stranding the commit
    // on a settled branch (invariant 8 across the seam).
    const engineActCount = await executeDeterministicActionLane(slug, runner);
    if (engineActCount > 0) {
      progressed = true;
    }

    const afterEngineActionStatus = await workstreamStatus(slug);
    if (afterEngineActionStatus !== 'active') {
      if (afterEngineActionStatus === 'paused') report.skipped = 'workstream became paused during this tick';
      break;
    }

    // Surface queued work whose dependency is missing or has settled without
    // acceptance. Raising the signal is deliberately NOT progress: dedup keeps
    // it from re-raising, so it must not spin the cycle loop.
    await flagImpossibleDependencies(slug);

    const runnable = runnableAssignments(await load(slug), executorCapabilities, runner);
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
      if (!runnableAssignments(beforeWorkerDoc, executorCapabilities, runner).includes(id)) continue;
      // Repo-egress deconfliction gate: hold an action worker whose egress
      // (push/PR-open) targets a branch whose own PR has already merged or
      // closed, rather than launching a worker to strand a commit no PR
      // carries. Held actions stay queued+approved and the stream is woken to
      // re-home the work; skip past this id without counting it as progress.
      const runnableAsg = (await load(slug)).assignments.find((a) => a.id === id);
      if (runnableAsg && !(await guardRepoEgress(slug, runnableAsg))) continue;
      // Approved action whose postcondition already holds: confirm the
      // existing effect instead of launching a worker to re-create it. The
      // same typed pre-claim configuration failure settlement applies here as
      // in the deterministic engine lane; executor choice cannot change truth.
      if (runnableAsg?.kind === 'action' && runnableAsg.attempts.length === 0) {
        try {
          if (await preflightApprovedAction(slug, id)) {
            process.stderr.write(`[tick] action ${id} postcondition already holds — execution skipped\n`);
            progressed = true;
            continue;
          }
        } catch (error) {
          if (!(error instanceof GitHubAppPreparationError)) throw error;
          if (await settleActionPreparationFailure(slug, id, error)) progressed = true;
          continue;
        }
      }
      process.stderr.write(`[tick] running worker for ${id}…\n`);
      const started = await runWorker(slug, id, undefined, executorCapabilities);
      if (!started) break cycles;
      report.workersRun.push(id);
      // Action assignments: the worker's claim settles nothing — run the
      // deterministic readback now so the reviewing pass sees verified truth.
      const after = (await load(slug)).assignments.find((a) => a.id === id);
      if (after?.kind === 'action' && after.exec) {
        const wait = after.attempts.at(-1)?.infrastructure;
        let ok = false;
        let readbackDetail = 'verifier returned non-zero';
        try {
          ok = await verifyAction(slug, id);
        } catch (error) {
          readbackDetail = `verifier could not run: ${error instanceof Error ? error.message : error}`;
          process.stderr.write(`[tick] action ${id} readback could not run: ${error instanceof Error ? error.message : error}\n`);
        }
        process.stderr.write(`[tick] action ${id} readback: ${ok ? 'CONFIRMED' : 'UNKNOWN'}\n`);
        // An action worker can lose model capacity after touching the world.
        // Passing readback means the effect landed: stop before any retry and
        // submit the verified fact for adoption. Any other readback is UNKNOWN,
        // so the already-failed one-shot action stays held for reconciliation.
        if (wait) {
          await arrive(slug, (d, event) => {
            const a2 = d.assignments.find((a) => a.id === id)!;
            if (ok) {
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
            } else if (holdActionForUnknownReadback(d, id, readbackDetail)) {
              event('action.infrastructure_readback_unknown', `${id} readback did not confirm after ${wait.kind} — held failed for provider/human reconciliation`, [id]);
            }
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
    const coordinatorTarget = executorCapabilities
      ? pickCoordinatorTargetForExecutors(preDoc, virtualNow().toISOString(), executorCapabilities)
      : pickCoordinatorTarget(preDoc, virtualNow().toISOString());
    const coordinatorRunnerEligible = !preDoc.workstream.executionPolicy?.coordinatorRunnerOrder ||
      coordinatorRunnerEligibility(preDoc, runner.id, await listRunnerPresence()).eligible;
    // A live lease means no pass can start: leave the wakes PENDING for the
    // next tick rather than burning them against a pass that cannot run.
    const leaseLive = preDoc.lease && new Date(preDoc.lease.expiresAt).getTime() > Date.now();
    if (
      preDoc.workstream.status === 'active' &&
      due.length > 0 &&
      coordinatorTarget !== null &&
      coordinatorRunnerEligible &&
      !coordinatorBackoffActive(preDoc, executorCapabilities) &&
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
        const outcome = await runCoordinatorPass(slug, reasons, coordinatorExecutor, executorCapabilities);
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
        if (e instanceof CoordinatorRunnerIneligibleError) break cycles;
        throw e;
      }
      progressed = true;
    }

    if (!progressed) break;
  }
  return report;
}
