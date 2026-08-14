/**
 * First-class human mutations, shared by the CLI and the interactive TUI so
 * the two write paths can never drift. Every act increments
 * humanInterventions — the numerator of the metric the learning loop
 * optimizes — and wakes the workstream where the coordinator must react.
 */

import { userInfo } from 'node:os';
import { virtualNow } from './clock.js';
import { arrive, listWorkstreams, load, mutate, newId, RevisionConflictError } from './store.js';
import type { WorkstreamCore } from './types.js';

/**
 * Who is performing this human act. Defaults to the OS user (the founder at
 * their keyboard); agent sessions operating on the founder's behalf must set
 * WEAVER_ACTOR (e.g. "claude-session") so attribution — and the intervention
 * metric the learning loop optimizes — stays honest.
 */
export function actor(): string {
  return process.env.WEAVER_ACTOR ?? userInfo().username;
}

function wake(d: { wakes: { push: (w: object) => void }[] } | any, reason: string): void {
  d.wakes.push({
    id: newId('wake'),
    reason,
    condition: { type: 'immediate' },
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
}

function resolveRefAttention(d: any, refId: string): void {
  for (const a of d.attention) {
    if (a.refId === refId && a.status === 'open') {
      a.status = 'resolved';
      a.resolvedAt = new Date().toISOString();
      a.resolvedBy = actor();
    }
  }
}

/**
 * Withdraw steering the coordinator has not read yet.
 *
 * Steering is the fastest way to change a stream's course, which makes it the
 * fastest way to send the wrong one — a message written against a stale
 * picture, or one phrased for a fleet when a workstream can only ever see
 * itself. Without a way back, the only remedy was a second steer explaining
 * the first, which leaves the coordinator reconciling two instructions instead
 * of following one.
 *
 * The withdrawn message stays on the record and the event log keeps both acts:
 * what a human tried to say is history. Only unconsumed steering can be
 * withdrawn — once a pass has acted on it the effect is already in the
 * decisions, and pretending otherwise would make the record lie.
 */
export async function revokeSteering(
  slug: string,
  steerId?: string,
): Promise<{ id: string; body: string }> {
  let revoked: { id: string; body: string } | undefined;
  await arrive(slug, (d, event) => {
    const pending = d.steering.filter((s) => !s.consumedByPass && !s.revokedAt);
    const target = steerId
      ? d.steering.find((s) => s.id === steerId)
      : pending.at(-1); // no id given: the last thing you said, the usual regret
    if (!target) {
      throw new Error(
        steerId
          ? `no steering '${steerId}' in ${slug}`
          : `${slug} has no unread steering to withdraw`,
      );
    }
    if (target.consumedByPass) {
      throw new Error(
        `${target.id} was already read by pass ${target.consumedByPass} — steer again to change course`,
      );
    }
    if (target.revokedAt) throw new Error(`${target.id} is already withdrawn`);
    target.revokedAt = new Date().toISOString();
    target.revokedBy = actor();
    revoked = { id: target.id, body: target.body };
    event('steering.revoked', `[by ${actor()}] withdrew ${target.id} before any pass read it: "${target.body.slice(0, 80)}"`, [target.id]);
  });
  return revoked!;
}

export async function addSteering(
  slug: string,
  body: string,
  opts: { resolvesAttentionId?: string } = {},
): Promise<void> {
  await arrive(slug, (d, event) => {
    const id = newId('steer');
    d.steering.push({ id, body, by: actor(), at: new Date().toISOString() });
    // Steering FROM an attention card is the answer TO it — one act, so the
    // card leaves the queue the moment the human replies, never lingering
    // until a later pass gets around to it.
    if (opts.resolvesAttentionId) {
      const att = d.attention.find((a) => a.id === opts.resolvesAttentionId && a.status === 'open');
      if (att) {
        // The answer settles word-for-word twins too (see resolveAttention).
        const twins = d.attention.filter((a) => a.status === 'open' && a.summary === att.summary);
        for (const t of twins) {
          t.status = 'resolved';
          t.resolvedAt = new Date().toISOString();
          t.resolvedBy = actor();
        }
        event('attention.resolved', `${actor()} answered ${twins.map((t) => t.id).join(', ')} via steering ${id}`, [...twins.map((t) => t.id), id]);
      }
    }
    wake(d, `human steering arrived: "${body.slice(0, 80)}"`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('steering.arrived', `[by ${actor()}] ${body}`, [id]);
  });
}

export async function approveSend(slug: string, intId: string): Promise<void> {
  await arrive(slug, (d, event) => {
    const int = d.interactions.find((i) => i.id === intId);
    if (!int) throw new Error(`no interaction ${intId}`);
    if (int.status !== 'awaiting_approval') throw new Error(`${intId} is ${int.status}, not awaiting_approval`);
    int.status = 'approved';
    int.approvedBy = 'human';
    int.approvedAt = new Date().toISOString();
    int.approvedByActor = actor();
    resolveRefAttention(d, intId);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('send.approved', `${intId} approved by ${actor()}`, [intId]);
  });
}

export async function rejectSend(slug: string, intId: string): Promise<void> {
  await arrive(slug, (d, event) => {
    const int = d.interactions.find((i) => i.id === intId);
    if (!int) throw new Error(`no interaction ${intId}`);
    // A rejection is only meaningful while the send is still stoppable. Once
    // egress is claimed ('sending') or has happened ('sent'/'unknown'/
    // 'confirmed'), the rejection LOST the race: refuse it rather than
    // overwrite a real external effect with 'rejected' and lie that it was
    // stopped. This is the mirror of the atomic egress claim in the engine.
    if (int.status !== 'awaiting_approval' && int.status !== 'approved') {
      throw new Error(`${intId} can no longer be rejected: it is ${int.status} (egress already claimed or executed)`);
    }
    int.status = 'rejected';
    int.rejectedBy = actor();
    int.rejectedAt = new Date().toISOString();
    resolveRefAttention(d, intId);
    wake(d, `human rejected send ${intId}`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('send.rejected', `${intId} rejected by ${actor()}`, [intId]);
  });
}

export async function approveAction(slug: string, asgId: string): Promise<void> {
  await arrive(slug, (d, event) => {
    const asg = d.assignments.find((a) => a.id === asgId);
    if (!asg) throw new Error(`no assignment ${asgId}`);
    if (asg.kind !== 'action' || !asg.exec) throw new Error(`${asgId} is not an action assignment`);
    if (asg.state !== 'gated') throw new Error(`${asgId} is ${asg.state}, not gated`);
    asg.state = 'queued';
    asg.exec.approval = { by: 'human', at: new Date().toISOString(), actor: actor() };
    resolveRefAttention(d, asgId);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('action.approved', `${asgId} approved by ${actor()} — queued to run`, [asgId]);
  });
}

export async function rejectAction(slug: string, asgId: string, reason = 'rejected by human'): Promise<void> {
  await arrive(slug, (d, event) => {
    const asg = d.assignments.find((a) => a.id === asgId);
    if (!asg) throw new Error(`no assignment ${asgId}`);
    if (asg.state !== 'gated') throw new Error(`${asgId} is ${asg.state}, not gated`);
    asg.state = 'cancelled';
    if (asg.exec) asg.exec.rejection = { actor: actor(), at: new Date().toISOString(), reason };
    resolveRefAttention(d, asgId);
    wake(d, `human rejected action ${asgId}: ${reason}`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('action.rejected', `${asgId} rejected by ${actor()}: ${reason}`, [asgId]);
  });
}

export async function resolveAttention(slug: string, attId: string, note = ''): Promise<void> {
  await arrive(slug, (d, event) => {
    const att = d.attention.find((a) => a.id === attId && a.status === 'open');
    if (!att) throw new Error(`no open attention ${attId}`);
    // One human answer settles every word-for-word twin (repeated strike
    // triples from one outage raise identical cards; the TUI shows only the
    // first, so resolving it must not leave invisible open twins behind).
    const twins = d.attention.filter((a) => a.status === 'open' && a.summary === att.summary);
    for (const t of twins) {
      t.status = 'resolved';
      t.resolvedAt = new Date().toISOString();
      t.resolvedBy = actor();
    }
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    const ids = twins.map((t) => t.id);
    event('attention.resolved', `${actor()} resolved ${ids.join(', ')}${note ? `: ${note}` : ''}`, ids);
    // For blocker/budget cards the resolution IS the unblock signal, and it
    // may be the stream's only remaining lifeline: a strike-tripled stream has
    // no pending wakes, and its open card suppresses the quiescence backstop —
    // resolving without waking would strand it forever. Approval/review/
    // capacity cards are settled by acts that already wake (approve, reject,
    // steer, capacity retry), so they stay wake-free here.
    if (att.kind === 'blocker' || att.kind === 'budget') {
      wake(d, `${att.kind} ${attId} resolved by ${actor()}${note ? `: ${note.slice(0, 120)}` : ''} — reconcile`);
    }
  });
}

/**
 * Human adoption override. For ACTION assignments the override still cannot
 * outrank physics: only the engine's deterministic readback can call a
 * real-world effect real, so an action without a passing `exec.verified` is
 * refused here exactly as it is in the coordinator's adopt_submission tool.
 */
export async function adoptSubmission(slug: string, asgId: string, reason = 'adopted by human'): Promise<void> {
  await arrive(slug, (d, event) => {
    const asg = d.assignments.find((x) => x.id === asgId);
    if (!asg) throw new Error(`no assignment ${asgId}`);
    if (asg.state !== 'awaiting_review' || !asg.submission) throw new Error(`${asgId} has no submission awaiting review`);
    if (asg.kind === 'action') {
      if (!asg.exec?.verified) throw new Error(`${asgId} is an ACTION whose readback has not run — its effect is unconfirmed and cannot be adopted (by anyone)`);
      if (!asg.exec.verified.ok) throw new Error(`${asgId} is an ACTION whose readback FAILED: ${asg.exec.verified.output.trim().slice(0, 120)} — fix the world or reject; adoption cannot overrule readback`);
    }
    const del = asg.submission.deliverableId
      ? d.deliverables.find((x) => x.id === asg.submission!.deliverableId)
      : undefined;
    if (del) {
      del.adopted = {
        contentHash: del.contentHash,
        passId: 'human',
        atVirtual: virtualNow().toISOString(),
      };
    }
    asg.adoption = { state: 'accepted', passId: 'human', reason, at: new Date().toISOString(), actor: actor() };
    asg.state = 'completed';
    wake(d, `human adopted ${asgId}`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('submission.adopted', `${asgId} adopted by ${actor()}${del ? ` (pinned ${del.contentHash.slice(0, 8)})` : ''}: ${reason}`, [asgId]);
  });
}

type WorkstreamStatus = WorkstreamCore['status'];

export interface SetPausedResult {
  slug: string;
  requestedStatus: 'active' | 'paused';
  previousStatus: WorkstreamStatus;
  status: WorkstreamStatus;
  changed: boolean;
  outcome: 'paused' | 'resumed' | 'reopened' | 'already-paused' | 'already-active' | 'done';
}

export interface PauseWorkstreamFailure {
  slug: string;
  error: string;
}

export interface PauseAllWorkstreamsResult {
  paused: string[];
  alreadyPaused: string[];
  done: string[];
  failures: PauseWorkstreamFailure[];
}

/**
 * Revision-checked human pause/resume transition. A repeated request is a
 * read-only no-op. Pausing a concluded workstream preserves its outcome;
 * explicitly resuming one reopens it, retains the old conclusion in event
 * lineage, and wakes a fresh coordinator to reconcile the new position.
 */
/**
 * Rank a workstream against the rest of the fleet for the runner's scarce
 * slots. A human act on purpose: a coordinator sees only its own workstream,
 * so nothing inside one can judge what it should outrank — and a stream that
 * could raise itself would.
 */
export async function setPriority(
  slug: string,
  priority: 'high' | 'normal' | 'low',
): Promise<{ slug: string; previous: string; priority: string; changed: boolean }> {
  const before = (await load(slug)).workstream.priority ?? 'normal';
  if (before === priority) return { slug, previous: before, priority, changed: false };
  await arrive(slug, (d, event) => {
    // 'normal' is the absence of a preference, so it is stored as absence —
    // a doc carrying an explicit default would imply someone chose it.
    if (priority === 'normal') delete d.workstream.priority;
    else d.workstream.priority = priority;
    event('workstream.priority_set', `${actor()} set priority ${before} → ${priority}`);
  });
  return { slug, previous: before, priority, changed: true };
}

export async function setPaused(slug: string, paused: boolean): Promise<SetPausedResult> {
  const requestedStatus = paused ? 'paused' : 'active';
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Re-read after every conflict: a concurrent conclusion must be preserved,
    // while an unrelated arrival should not make a human pause disappear.
    const current = await load(slug);
    const previousStatus = current.workstream.status;

    if (previousStatus === 'done' && paused) {
      return { slug, requestedStatus, previousStatus, status: 'done', changed: false, outcome: 'done' };
    }
    if (previousStatus === requestedStatus) {
      return {
        slug,
        requestedStatus,
        previousStatus,
        status: previousStatus,
        changed: false,
        outcome: paused ? 'already-paused' : 'already-active',
      };
    }

    try {
      const updated = await mutate(slug, current.revision, (d, event) => {
        if (previousStatus === 'done') {
          const prior = d.workstream.conclusion;
          delete d.workstream.conclusion;
          d.workstream.status = 'active';
          wake(d, `human reopened the concluded workstream`);
          event(
            'workstream.reopened',
            `${actor()} reopened the concluded workstream${prior ? ` (prior conclusion from ${prior.passId}: ${prior.summary.slice(0, 120)})` : ''}`,
            prior?.evidenceIds,
          );
          return;
        }
        d.workstream.status = requestedStatus;
        event(paused ? 'workstream.paused' : 'workstream.resumed', `${actor()} ${paused ? 'paused' : 'resumed'} the workstream`);
      });
      return {
        slug,
        requestedStatus,
        previousStatus,
        status: updated.workstream.status,
        changed: true,
        outcome: previousStatus === 'done' ? 'reopened' : paused ? 'paused' : 'resumed',
      };
    } catch (error) {
      if (!(error instanceof RevisionConflictError) || attempt === attempts) throw error;
    }
  }
  throw new Error(`failed to ${paused ? 'pause' : 'resume'} '${slug}' after ${attempts} revision conflicts`);
}

/** Pause every readable active workstream while reporting every other slug. */
export async function pauseAllWorkstreams(): Promise<PauseAllWorkstreamsResult> {
  const result: PauseAllWorkstreamsResult = {
    paused: [],
    alreadyPaused: [],
    done: [],
    failures: [],
  };

  for (const slug of (await listWorkstreams()).sort()) {
    try {
      const transition = await setPaused(slug, true);
      if (transition.outcome === 'paused') result.paused.push(slug);
      else if (transition.outcome === 'already-paused') result.alreadyPaused.push(slug);
      else if (transition.outcome === 'done') result.done.push(slug);
      else throw new Error(`unexpected pause outcome '${transition.outcome}'`);
    } catch (error) {
      result.failures.push({ slug, error: error instanceof Error ? error.message : String(error) });
    }
  }

  result.paused.sort();
  result.alreadyPaused.sort();
  result.done.sort();
  result.failures.sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  return result;
}
