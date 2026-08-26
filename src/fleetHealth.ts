import { actionAwaitingPilot } from './actionApproval.js';
import type { WorkstreamDoc } from './types.js';

export interface FleetIncident {
  key: 'approval-service-unavailable';
  tone: 'warning';
  title: string;
  detail: string;
  recovery: string;
  firstObservedAt: string;
  affectedActions: number;
  affectedWorkstreams: string[];
}

/**
 * Shared-dependency failures are fleet facts, not N human decisions. This pure
 * projection is deliberately model-free: it still explains the outage when no
 * coordinator or worker can start, and recovery follows typed markers rather
 * than a generated summary.
 */
export function fleetIncidents(docs: WorkstreamDoc[]): FleetIncident[] {
  const affected = docs.flatMap((doc) => doc.assignments
    .filter((assignment) =>
      actionAwaitingPilot(assignment) && !!assignment.exec?.pilotUnavailableSince
    )
    .map((assignment) => ({
      slug: doc.workstream.slug,
      at: assignment.exec!.pilotUnavailableSince!,
    })));
  if (!affected.length) return [];

  const affectedWorkstreams = [...new Set(affected.map(({ slug }) => slug))].sort();
  const affectedActions = affected.length;
  return [{
    key: 'approval-service-unavailable',
    tone: 'warning',
    title: 'Approval service unavailable',
    detail: `${affectedActions} gated action${affectedActions === 1 ? '' : 's'} across ${affectedWorkstreams.length} job${affectedWorkstreams.length === 1 ? '' : 's'} remain safe and waiting. This is one operational incident, not a separate decision for every action.`,
    recovery: 'Recovery is proven when the approval service responds and each waiting action receives a fresh verdict.',
    firstObservedAt: affected.map(({ at }) => at).sort()[0]!,
    affectedActions,
    affectedWorkstreams,
  }];
}
