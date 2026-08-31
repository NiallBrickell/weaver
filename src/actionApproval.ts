import type { Assignment, AttentionItem, WorkstreamDoc } from './types.js';
import { isLegacyDollarBudgetAttention } from './executionSafety.js';

/** A routine action that is still waiting for Pilot is not a human decision. */
export function actionAwaitingPilot(asg: Assignment): boolean {
  return asg.kind === 'action'
    && asg.state === 'gated'
    && asg.exec?.approvalMode !== 'human-only'
    && !asg.exec?.pilotVerdict;
}

/** A Pilot-owned action is a current wait only while its Workstream may advance. */
export function actionIsLivePilotWait(doc: WorkstreamDoc, asg: Assignment): boolean {
  return doc.workstream.status === 'active' && actionAwaitingPilot(asg);
}

/** A current fleet outage requires an active Workstream that can actually retry. */
export function actionHasLivePilotOutage(doc: WorkstreamDoc, asg: Assignment): boolean {
  return !!asg.exec?.pilotUnavailableSince && actionIsLivePilotWait(doc, asg);
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

/**
 * Compatibility projection for timeout cards written by older engines while
 * Pilot was unreachable. The action is still owned by Pilot: no verdict exists,
 * no authority has changed, and the typed outage marker is the fleet-level fact
 * operators need. Rendering every legacy card as a human decision recreates one
 * shared dependency incident once per gated action.
 */
export function isPilotUnavailableApprovalAttention(
  doc: WorkstreamDoc,
  attention: AttentionItem,
): boolean {
  if (attention.kind !== 'approval' || attention.status !== 'open' || !attention.refId) return false;
  const assignment = doc.assignments.find((candidate) => candidate.id === attention.refId);
  return !!assignment?.exec?.pilotUnavailableSince && actionAwaitingPilot(assignment);
}

/** The one current-state boundary for typed attention that needs a person. */
export function humanAttention(doc: WorkstreamDoc): AttentionItem[] {
  return doc.attention.filter((attention) =>
    attention.status === 'open'
    && !isLegacyDollarBudgetAttention(attention)
    && !isPilotUnavailableApprovalAttention(doc, attention)
  );
}

/**
 * Pausing is the operator's explicit deferral of one Workstream. Its open
 * attention remains durable and visible inside that Workstream, but it must
 * not keep interrupting the fleet-wide Needs-you queue until the Workstream
 * is resumed. Done Workstreams are different: an unresolved consequence can
 * still require a person after the underlying implementation concluded.
 */
export function humanAttentionCanInterrupt(doc: WorkstreamDoc): boolean {
  return doc.workstream.status !== 'paused';
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
