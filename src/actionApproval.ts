import type { Assignment, WorkstreamDoc } from './types.js';

/** A routine action that is still waiting for Pilot is not a human decision. */
export function actionAwaitingPilot(asg: Assignment): boolean {
  return asg.kind === 'action'
    && asg.state === 'gated'
    && asg.exec?.approvalMode !== 'human-only'
    && !asg.exec?.pilotVerdict;
}

/** Gated actions enter the human queue only by explicit reservation or escalation. */
export function actionNeedsHuman(asg: Assignment): boolean {
  return asg.kind === 'action'
    && asg.state === 'gated'
    && (
      asg.exec?.approvalMode === 'human-only'
      || (!!asg.exec?.pilotVerdict && asg.exec.pilotVerdict.decision !== 'approve')
    );
}

/** Idempotently materialise the durable needs-you item for an action. */
export function ensureActionApprovalAttention(
  doc: WorkstreamDoc,
  asg: Assignment,
  id: () => string,
  reason?: string,
): boolean {
  if (doc.attention.some((attention) =>
    attention.kind === 'approval' && attention.refId === asg.id && attention.status === 'open'
  )) return false;
  doc.attention.push({
    id: id(),
    kind: 'approval',
    summary: reason ?? `Action ${asg.id} awaits your approval: "${asg.objective}" (cwd ${asg.exec?.cwd ?? '?'}) — approve with \`weaver approve-action\``,
    refId: asg.id,
    status: 'open',
    createdAt: new Date().toISOString(),
  });
  return true;
}
