/**
 * First-class human mutations, shared by the CLI and the interactive TUI so
 * the two write paths can never drift. Every act increments
 * humanInterventions — the numerator of the metric the learning loop
 * optimizes — and wakes the workstream where the coordinator must react.
 */

import { virtualNow } from './clock.js';
import { arrive, newId } from './store.js';

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
    }
  }
}

export function addSteering(slug: string, body: string): void {
  arrive(slug, (d, event) => {
    const id = newId('steer');
    d.steering.push({ id, body, at: new Date().toISOString() });
    wake(d, `human steering arrived: "${body.slice(0, 80)}"`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('steering.arrived', body, [id]);
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
    resolveRefAttention(d, intId);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('send.approved', `${intId} approved by human`, [intId]);
  });
}

export function rejectSend(slug: string, intId: string): void {
  arrive(slug, (d, event) => {
    const int = d.interactions.find((i) => i.id === intId);
    if (!int) throw new Error(`no interaction ${intId}`);
    int.status = 'rejected';
    resolveRefAttention(d, intId);
    wake(d, `human rejected send ${intId}`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('send.rejected', `${intId} rejected by human`, [intId]);
  });
}

export function approveAction(slug: string, asgId: string): void {
  arrive(slug, (d, event) => {
    const asg = d.assignments.find((a) => a.id === asgId);
    if (!asg) throw new Error(`no assignment ${asgId}`);
    if (asg.kind !== 'action' || !asg.exec) throw new Error(`${asgId} is not an action assignment`);
    if (asg.state !== 'gated') throw new Error(`${asgId} is ${asg.state}, not gated`);
    asg.state = 'queued';
    asg.exec.approval = { by: 'human', at: new Date().toISOString() };
    resolveRefAttention(d, asgId);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('action.approved', `${asgId} approved by human — queued to run`, [asgId]);
  });
}

export function rejectAction(slug: string, asgId: string, reason = 'rejected by human'): void {
  arrive(slug, (d, event) => {
    const asg = d.assignments.find((a) => a.id === asgId);
    if (!asg) throw new Error(`no assignment ${asgId}`);
    if (asg.state !== 'gated') throw new Error(`${asgId} is ${asg.state}, not gated`);
    asg.state = 'cancelled';
    resolveRefAttention(d, asgId);
    wake(d, `human rejected action ${asgId}: ${reason}`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('action.rejected', `${asgId} rejected by human: ${reason}`, [asgId]);
  });
}

export function resolveAttention(slug: string, attId: string, note = ''): void {
  arrive(slug, (d, event) => {
    const att = d.attention.find((a) => a.id === attId && a.status === 'open');
    if (!att) throw new Error(`no open attention ${attId}`);
    att.status = 'resolved';
    att.resolvedAt = new Date().toISOString();
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('attention.resolved', `human resolved ${attId}${note ? `: ${note}` : ''}`, [attId]);
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
    asg.adoption = { state: 'accepted', passId: 'human', reason };
    asg.state = 'completed';
    wake(d, `human adopted ${asgId}`);
    d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
    event('submission.adopted', `${asgId} adopted by HUMAN${del ? ` (pinned ${del.contentHash.slice(0, 8)})` : ''}: ${reason}`, [asgId]);
  });
}

export function setPaused(slug: string, paused: boolean): void {
  arrive(slug, (d, event) => {
    d.workstream.status = paused ? 'paused' : 'active';
    event(paused ? 'workstream.paused' : 'workstream.resumed', `human ${paused ? 'paused' : 'resumed'} the workstream`);
  });
}
