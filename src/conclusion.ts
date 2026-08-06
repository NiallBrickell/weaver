/** Closed evidence gate for durable workstream conclusions. */

import type { WorkstreamDoc } from './types.js';

export function conclusionEvidenceLabels(doc: WorkstreamDoc, evidenceIds: string[]): string[] {
  if (!evidenceIds.length) throw new Error('conclusion requires at least one typed evidence id');
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('conclusion evidence ids must be unique');
  return evidenceIds.map((id) => {
    const deliverable = doc.deliverables.find((candidate) => candidate.id === id && candidate.adopted);
    if (deliverable) return `${id}: adopted deliverable pinned ${deliverable.adopted!.contentHash}`;
    const action = doc.assignments.find((candidate) => candidate.id === id && candidate.kind === 'action' && candidate.exec?.verified?.ok);
    if (action) return `${id}: readback-confirmed external action`;
    const decision = doc.decisions.find((candidate) => candidate.id === id && candidate.status === 'standing');
    if (decision) return `${id}: standing closure decision`;
    throw new Error(`${id} is not an adopted deliverable, readback-confirmed action, or standing decision`);
  });
}
