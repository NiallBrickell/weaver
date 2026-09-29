/** Closed evidence gates: durable workstream conclusions and course progress. */

import type { ConclusionDisposition, WorkstreamConclusion, WorkstreamDoc } from './types.js';

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
    const steering = liveSteering(doc, id);
    if (steering) return `${id}: human steering directive (authority: the human)`;
    throw new Error(`${id} is not an adopted deliverable, readback-confirmed action, or human steering directive — a coordinator-authored decision cannot self-certify a conclusion`);
  });
}

/** A steering record that carries the human's authority: present in this
 * workstream and not withdrawn. A withdrawn steer never reached a pass — what
 * the human tried to say stays on the record, but it directs nothing. */
function liveSteering(doc: WorkstreamDoc, id: string) {
  return doc.steering.find((candidate) => candidate.id === id && !candidate.revokedAt);
}

export const CONCLUSION_DISPOSITIONS = [
  'delivered',
  'no_change_needed',
  'not_worth_doing',
  'duplicate',
  'directed_closed',
] as const satisfies readonly ConclusionDisposition[];

/** Dispositions that count as a successful outcome. A legacy conclusion with
 * no disposition also counts (see isSuccessfulConclusion). */
const SUCCESS_DISPOSITIONS: ReadonlySet<ConclusionDisposition> = new Set(['delivered', 'no_change_needed']);

export interface ConclusionClaim {
  disposition: ConclusionDisposition;
  evidenceIds: string[];
  duplicateOf?: string;
  directedBy?: string;
}

/**
 * The write-time gate for a conclusion's disposition, run inside the same
 * revision-checked mutation that records it. Every disposition rests on a fact
 * the coordinator could not author:
 *   - delivered / no_change_needed / not_worth_doing: the closed evidence
 *     vocabulary above. "Not worth doing" is a value judgment, so it needs the
 *     same footing as "done" — an adopted deliverable (e.g. a research report
 *     that measured the impact), a verified action, or the human's steering.
 *     Without that gate a coordinator could shed any hard objective by calling
 *     it pointless.
 *   - duplicate: `duplicateOf` names another workstream that exists. Existence
 *     is a store fact, resolved by the caller at the StateStore seam (never a
 *     fleet-wide load) and passed in, because this mutator must stay
 *     synchronous.
 *   - directed_closed: `directedBy` is a live steering record in THIS
 *     workstream — the human's own direction.
 * Fields that belong to another disposition are refused, not silently dropped,
 * so a stored conclusion never carries a claim nothing validated.
 */
export function conclusionDispositionLabels(
  doc: WorkstreamDoc,
  claim: ConclusionClaim,
  duplicateExists: boolean,
): string[] {
  const { disposition } = claim;
  if (!(CONCLUSION_DISPOSITIONS as readonly string[]).includes(disposition)) {
    throw new Error(`conclusion requires a disposition: one of ${CONCLUSION_DISPOSITIONS.join(', ')}`);
  }
  if (claim.duplicateOf !== undefined && disposition !== 'duplicate') {
    throw new Error(`duplicate_of applies only to disposition 'duplicate', not '${disposition}'`);
  }
  if (claim.directedBy !== undefined && disposition !== 'directed_closed') {
    throw new Error(`directed_by applies only to disposition 'directed_closed', not '${disposition}'`);
  }
  switch (disposition) {
    case 'delivered':
    case 'no_change_needed':
    case 'not_worth_doing':
      return conclusionEvidenceLabels(doc, claim.evidenceIds);
    case 'duplicate': {
      const target = claim.duplicateOf?.trim();
      if (!target) throw new Error(`disposition 'duplicate' requires duplicate_of: the slug of the workstream this one repeats`);
      if (target === doc.workstream.slug) throw new Error(`a workstream cannot be a duplicate of itself (${target})`);
      if (!duplicateExists) throw new Error(`duplicate_of '${target}' names no existing workstream`);
      const cited = claim.evidenceIds.length ? conclusionEvidenceLabels(doc, claim.evidenceIds) : [];
      return [`duplicate of workstream '${target}' (exists in the store)`, ...cited];
    }
    case 'directed_closed': {
      const id = claim.directedBy;
      if (!id) throw new Error(`disposition 'directed_closed' requires directed_by: the id of the human steering that closed it`);
      if (!liveSteering(doc, id)) throw new Error(`directed_by ${id} is not a (non-withdrawn) steering record in this workstream — only the human's own direction closes a workstream this way`);
      const rest = claim.evidenceIds.filter((e) => e !== id);
      return [`${id}: human steering directive (authority: the human)`, ...(rest.length ? conclusionEvidenceLabels(doc, rest) : [])];
    }
  }
}

/** The disposition a stored conclusion carries; a conclusion recorded before
 * dispositions existed reads as `unclassified` — never guessed. */
export function dispositionOf(conclusion: Pick<WorkstreamConclusion, 'disposition'>): ConclusionDisposition | 'unclassified' {
  const d = conclusion.disposition;
  return d && (CONCLUSION_DISPOSITIONS as readonly string[]).includes(d) ? d : 'unclassified';
}

/** A successful outcome: delivered, no change needed, or a legacy
 * unclassified conclusion (kept so the intervention curve has no break at the
 * point dispositions were introduced). */
export function isSuccessfulConclusion(conclusion: Pick<WorkstreamConclusion, 'disposition'>): boolean {
  const d = dispositionOf(conclusion);
  return d === 'unclassified' || SUCCESS_DISPOSITIONS.has(d);
}

/** One human-readable phrase for a conclusion's disposition, for every
 * surface that renders a conclusion. */
export function dispositionLabel(conclusion: Pick<WorkstreamConclusion, 'disposition' | 'duplicateOf' | 'directedBy'>): string {
  switch (dispositionOf(conclusion)) {
    case 'delivered': return 'delivered';
    case 'no_change_needed': return 'no change needed';
    case 'not_worth_doing': return 'not worth doing';
    case 'duplicate': return `duplicate of ${conclusion.duplicateOf ?? '?'}`;
    case 'directed_closed': return `closed by human direction${conclusion.directedBy ? ` (${conclusion.directedBy})` : ''}`;
    case 'unclassified': return 'unclassified (concluded before dispositions)';
  }
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
