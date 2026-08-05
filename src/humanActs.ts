/**
 * First-class human mutations, shared by the CLI and the interactive TUI so
 * the two write paths can never drift. Every act increments
 * humanInterventions — the numerator of the metric the learning loop
 * optimizes — and wakes the workstream where the coordinator must react.
 */

import { userInfo } from 'node:os';
import { virtualNow } from './clock.js';
import { arrive, newId } from './store.js';

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

export function addSteering(
  slug: string,
  body: string,
  opts: { resolvesAttentionId?: string } = {},
): void {
  arrive(slug, (d, event) => {
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

export function approveSend(slug: string, intId: string): void {
  arrive(slug, (d, event) => {
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

export function rejectSend(slug: string, intId: string): void {
  arrive(slug, (d, event) => {
    const int = d.interactions.find((i) => i.id === intId);
    if (!int) throw new Error(`no interaction ${intId}`);
    int.status = 'rejected';
    int.rejectedBy = actor();
    int.rejectedAt = new Date().toISOString();
    resolveRefAttention(d, intId);
    wake(d, `human rejected send ${intId}`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('send.rejected', `${intId} rejected by ${actor()}`, [intId]);
  });
}

export function approveAction(slug: string, asgId: string): void {
  arrive(slug, (d, event) => {
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

export function rejectAction(slug: string, asgId: string, reason = 'rejected by human'): void {
  arrive(slug, (d, event) => {
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

export function resolveAttention(slug: string, attId: string, note = ''): void {
  arrive(slug, (d, event) => {
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
  });
}

/**
 * Human adoption override. For ACTION assignments the override still cannot
 * outrank physics: only the engine's deterministic readback can call a
 * real-world effect real, so an action without a passing `exec.verified` is
 * refused here exactly as it is in the coordinator's adopt_submission tool.
 */
export function adoptSubmission(slug: string, asgId: string, reason = 'adopted by human'): void {
  arrive(slug, (d, event) => {
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

export function setPaused(slug: string, paused: boolean): void {
  arrive(slug, (d, event) => {
    d.workstream.status = paused ? 'paused' : 'active';
    event(paused ? 'workstream.paused' : 'workstream.resumed', `${actor()} ${paused ? 'paused' : 'resumed'} the workstream`);
  });
}
