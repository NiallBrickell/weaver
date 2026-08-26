import { actionAwaitingPilot, actionNeedsHuman, humanAttention } from './actionApproval.js';
import type { WorkstreamDoc } from './types.js';

export const FLEET_ATTENTION_STEWARD_SOURCE_KEY = 'weaver:fleet-attention-steward:v1';
export const FLEET_EVIDENCE_FILE = '.weaver-fleet-evidence.json';

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

interface FleetHumanNeed {
  source: 'attention' | 'assignment' | 'interaction';
  id: string;
  kind: string;
  summary: string;
  refId?: string;
  createdAt?: string;
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

/**
 * The minimum model-free input the built-in attention steward needs. This is
 * deliberately NOT a general fleet export: objectives, decisions, artifacts,
 * event history, and unrelated assignments never cross the worker boundary.
 * Every included ask carries its source Workstream revision or typed id, and
 * no prose here can mutate another Workstream's course or authority.
 */
export function fleetAttentionEvidence(
  docs: WorkstreamDoc[],
  unreadable: string[] = [],
  wallNow = new Date(),
) {
  const workstreams = [...docs]
    .sort((a, b) => a.workstream.slug.localeCompare(b.workstream.slug))
    .map((doc) => {
      const represented = new Set<string>();
      const needs: FleetHumanNeed[] = humanAttention(doc).map((attention) => {
        if (attention.refId) represented.add(attention.refId);
        return {
          source: 'attention' as const,
          id: attention.id,
          kind: attention.kind,
          summary: attention.summary,
          refId: attention.refId,
          createdAt: attention.createdAt,
        };
      });
      for (const assignment of doc.assignments.filter(actionNeedsHuman)) {
        if (represented.has(assignment.id)) continue;
        represented.add(assignment.id);
        needs.push({
          source: 'assignment',
          id: assignment.id,
          kind: 'action',
          summary: assignment.exec?.ask ?? assignment.objective,
          refId: assignment.id,
          createdAt: assignment.createdAtVirtual,
        });
      }
      for (const interaction of doc.interactions.filter((candidate) => candidate.status === 'awaiting_approval')) {
        if (represented.has(interaction.id)) continue;
        represented.add(interaction.id);
        needs.push({
          source: 'interaction',
          id: interaction.id,
          kind: 'approval',
          summary: `Send to ${interaction.to}: ${interaction.subject}`,
          refId: interaction.id,
        });
      }
      return {
        slug: doc.workstream.slug,
        revision: doc.revision,
        status: doc.workstream.status,
        humanNeeds: needs,
        approvalServiceWaits: doc.assignments
          .filter((assignment) => actionAwaitingPilot(assignment) && assignment.exec?.pilotUnavailableSince)
          .map((assignment) => ({
            assignmentId: assignment.id,
            unavailableSince: assignment.exec!.pilotUnavailableSince!,
          })),
      };
    })
    .filter(({ humanNeeds, approvalServiceWaits }) => humanNeeds.length || approvalServiceWaits.length);

  return {
    schemaVersion: 1,
    generatedAt: wallNow.toISOString(),
    scope: 'Open human asks and approval-service waits only. Unrelated Workstream content is deliberately omitted.',
    authority: 'Read-only evidence. Worker conclusions are proposals and cannot approve, resolve, adopt, send, merge, deploy, push, or spend.',
    unreadableWorkstreams: [...unreadable].sort(),
    incidents: fleetIncidents(docs),
    totals: {
      workstreams: docs.length,
      activeWorkstreams: docs.filter((doc) => doc.workstream.status === 'active').length,
      openHumanNeeds: workstreams.reduce((total, doc) => total + doc.humanNeeds.length, 0),
      approvalServiceWaits: workstreams.reduce((total, doc) => total + doc.approvalServiceWaits.length, 0),
    },
    workstreams,
  };
}
