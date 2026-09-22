/** Closed evidence gates: durable workstream conclusions and course progress. */

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
    const verified = verifiedResultLabel(doc, id);
    if (verified) return verified;
    const steering = doc.steering.find((candidate) => candidate.id === id);
    if (steering) return `${id}: human steering directive (authority: the human)`;
    throw new Error(`${id} is not an adopted deliverable, readback-confirmed action, or human steering directive — a coordinator-authored decision cannot self-certify a conclusion`);
  });
}

/** A produced result the coordinator could not simply author: an adopted
 * (pinned) deliverable or a readback-confirmed external action. */
function verifiedResultLabel(doc: WorkstreamDoc, id: string): string | undefined {
  const deliverable = doc.deliverables.find((candidate) => candidate.id === id && candidate.adopted);
  if (deliverable) return `${id}: adopted deliverable pinned ${deliverable.adopted!.contentHash}`;
  const action = doc.assignments.find((candidate) => candidate.id === id && candidate.kind === 'action' && candidate.exec?.verified?.ok);
  if (action) return `${id}: readback-confirmed external action`;
  return undefined;
}

/**
 * The closed basis vocabulary for a course's recorded progress: the same
 * produced results a conclusion accepts, plus evaluated results (an
 * observation or reply a coordinator has already judged). Progress is a
 * position, not a success claim, so a judged result is enough to say "step 3
 * rests on this"; an unevaluated arrival is untrusted input and is refused,
 * and so is any decision — a course cannot cite itself as its own basis.
 */
export function progressBasisLabels(doc: WorkstreamDoc, basisIds: string[]): string[] {
  if (new Set(basisIds).size !== basisIds.length) throw new Error('progress basis ids must be unique');
  return basisIds.map((id) => {
    const verified = verifiedResultLabel(doc, id);
    if (verified) return verified;
    const observation = doc.observations.find((candidate) => candidate.id === id && candidate.evaluation);
    if (observation) return `${id}: evaluated observation`;
    for (const interaction of doc.interactions) {
      if (interaction.replies.some((reply) => reply.id === id && reply.evaluation)) {
        return `${id}: evaluated reply on ${interaction.id}`;
      }
    }
    throw new Error(`${id} is not an adopted deliverable, readback-confirmed action, or evaluated observation/reply — progress may rest only on results, never on prose or an unjudged arrival`);
  });
}
