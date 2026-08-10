/** Closed evidence gate for durable workstream conclusions. */

import type { WorkstreamDoc } from './types.js';

/**
 * The closed evidence vocabulary for concluding a workstream. A conclusion is a
 * success claim, so its evidence must be a fact the coordinator could NOT
 * simply author:
 *   - an adopted deliverable (a produced work product, pinned), or
 *   - a readback-confirmed external action (a verified real-world effect), or
 *   - a human steering directive (the human's own authority to stop/close).
 *
 * A generic standing DECISION is deliberately NOT sufficient: production
 * `record_decision` always makes coordinator-authored decisions, so accepting
 * one would let a coordinator write a decision and immediately cite it to
 * "conclude" its own workstream — self-certified success. A legitimate
 * non-action closure (the human said don't act) is represented by citing the
 * human steering that authorized it, which carries real authority provenance.
 *
 * (Criterion-by-criterion typed evaluation against successCriteria is the
 * stronger form and is a deliberate follow-up; this gate closes the concrete
 * self-certification hole.)
 */
export function conclusionEvidenceLabels(doc: WorkstreamDoc, evidenceIds: string[]): string[] {
  if (!evidenceIds.length) throw new Error('conclusion requires at least one typed evidence id');
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('conclusion evidence ids must be unique');
  return evidenceIds.map((id) => {
    const deliverable = doc.deliverables.find((candidate) => candidate.id === id && candidate.adopted);
    if (deliverable) return `${id}: adopted deliverable pinned ${deliverable.adopted!.contentHash}`;
    const action = doc.assignments.find((candidate) => candidate.id === id && candidate.kind === 'action' && candidate.exec?.verified?.ok);
    if (action) return `${id}: readback-confirmed external action`;
    const steering = doc.steering.find((candidate) => candidate.id === id);
    if (steering) return `${id}: human steering directive (authority: the human)`;
    throw new Error(`${id} is not an adopted deliverable, readback-confirmed action, or human steering directive — a coordinator-authored decision cannot self-certify a conclusion`);
  });
}
