import { actionHasLivePilotOutage, actionNeedsHuman, humanAttention } from './actionApproval.js';
import { virtualNow } from './clock.js';
import { isWakeDue } from './executionSafety.js';
import type { InfrastructureWait, WorkstreamDoc } from './types.js';

export const FLEET_ATTENTION_STEWARD_SOURCE_KEY = 'weaver:fleet-attention-steward:v1';
export const FLEET_ATTENTION_STEWARD_SLUG = 'fleet-attention-steward';

/** A reserved source key alone was historically caller-supplied. Requiring the
 * built-in slug as well makes old spoofed holders fail closed after upgrade. */
export function isFleetAttentionSteward(doc: WorkstreamDoc): boolean {
  return doc.workstream.sourceKey === FLEET_ATTENTION_STEWARD_SOURCE_KEY &&
    doc.workstream.slug === FLEET_ATTENTION_STEWARD_SLUG;
}
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

type FleetReferencedEntity =
  | { kind: 'assignment'; state: WorkstreamDoc['assignments'][number]['state'] }
  | { kind: 'interaction'; state: WorkstreamDoc['interactions'][number]['status'] }
  | { kind: 'wake'; state: WorkstreamDoc['wakes'][number]['status'] }
  | { kind: 'decision'; state: WorkstreamDoc['decisions'][number]['status'] }
  | { kind: 'attention'; state: WorkstreamDoc['attention'][number]['status'] };

interface FleetHumanNeed {
  source: 'attention' | 'assignment' | 'interaction';
  id: string;
  kind: string;
  summary: string;
  workstreamStatus: WorkstreamDoc['workstream']['status'];
  refId?: string;
  referencedEntity?: FleetReferencedEntity;
  createdAt?: string;
}

// A resident runner normally consumes a due wake in seconds. Fifteen minutes
// tolerates deployment/restart jitter without teaching the steward that normal
// dispatch latency is an incident; one hour gives a submitted result a full
// coordinator cycle before "awaiting review" becomes health evidence.
const ROUTINE_WAKE_GRACE_MS = 15 * 60_000;
const ROUTINE_REVIEW_GRACE_MS = 60 * 60_000;

function referencedEntity(
  doc: WorkstreamDoc,
  refId: string | undefined,
): FleetHumanNeed['referencedEntity'] {
  if (!refId) return undefined;
  const assignment = doc.assignments.find((candidate) => candidate.id === refId);
  if (assignment) return { kind: 'assignment', state: assignment.state };
  const interaction = doc.interactions.find((candidate) => candidate.id === refId);
  if (interaction) return { kind: 'interaction', state: interaction.status };
  const wake = doc.wakes.find((candidate) => candidate.id === refId);
  if (wake) return { kind: 'wake', state: wake.status };
  const decision = doc.decisions.find((candidate) => candidate.id === refId);
  if (decision) return { kind: 'decision', state: decision.status };
  const attention = doc.attention.find((candidate) => candidate.id === refId);
  return attention ? { kind: 'attention', state: attention.status } : undefined;
}

function isPastGrace(boundary: string, now: Date, graceMs: number): boolean {
  const boundaryMs = Date.parse(boundary);
  return Number.isFinite(boundaryMs) && now.getTime() >= boundaryMs + graceMs;
}

function wakePastGrace(
  wake: WorkstreamDoc['wakes'][number],
  wallNow: Date,
  nowVirtual: Date,
): boolean {
  if (wake.condition.type === 'time') {
    return isPastGrace(wake.condition.dueAtVirtual, nowVirtual, ROUTINE_WAKE_GRACE_MS);
  }
  if (wake.condition.type === 'wall_time') {
    return isPastGrace(wake.condition.dueAt, wallNow, ROUTINE_WAKE_GRACE_MS);
  }
  return isPastGrace(wake.createdAt, wallNow, ROUTINE_WAKE_GRACE_MS);
}

function capacityReportableEntity(doc: WorkstreamDoc, wait: InfrastructureWait) {
  if (wait.source === 'worker') {
    const assignment = doc.assignments.find((candidate) =>
      candidate.attempts.some((attempt) => attempt.runId === wait.sourceId),
    );
    return assignment
      ? { kind: 'assignment' as const, id: assignment.id, state: assignment.state }
      : undefined;
  }
  const wake = doc.wakes.find((candidate) =>
    candidate.infrastructure?.source === wait.source &&
    candidate.infrastructure.sourceId === wait.sourceId,
  );
  return wake ? { kind: 'wake' as const, id: wake.id, state: wake.status } : undefined;
}

function routineHealth(doc: WorkstreamDoc, wallNow: Date, nowVirtual: Date) {
  if (doc.workstream.status !== 'active' || !doc.workstream.tags.includes('routine')) return undefined;
  const pendingWakes = doc.wakes.filter((wake) => wake.status === 'pending');
  const liveAssignments = doc.assignments.filter((assignment) =>
    ['gated', 'queued', 'running', 'awaiting_review'].includes(assignment.state),
  );
  const coordinating = !!doc.lease && new Date(doc.lease.expiresAt).getTime() > wallNow.getTime();
  const overdueWakes = coordinating ? [] : pendingWakes
    .filter((wake) => wakePastGrace(wake, wallNow, nowVirtual))
    .map((wake) => ({
      id: wake.id,
      condition: wake.condition.type,
      ...(
        wake.condition.type === 'time'
          ? { dueAt: wake.condition.dueAtVirtual }
          : wake.condition.type === 'wall_time'
            ? { dueAt: wake.condition.dueAt }
            : {}
      ),
    }));
  const hasDueReconciliationWake = pendingWakes.some((wake) =>
    isWakeDue(wake.condition, wallNow, nowVirtual),
  );
  const awaitingReviewAssignmentIds = coordinating || hasDueReconciliationWake ? [] : liveAssignments
    .filter((assignment) => {
      if (assignment.state !== 'awaiting_review') return false;
      // Worker completion is the only precise persisted timestamp for when a
      // submission became reviewable. Missing legacy timing stays unknown
      // rather than being guessed from the assignment's much older creation.
      const endedAt = assignment.attempts.at(-1)?.endedAt;
      return !!endedAt && isPastGrace(endedAt, wallNow, ROUTINE_REVIEW_GRACE_MS);
    })
    .map((assignment) => assignment.id);
  return {
    dormant: !pendingWakes.length && !liveAssignments.length && !coordinating,
    overdueWakes,
    awaitingReviewAssignmentIds,
  };
}

/**
 * Shared-dependency failures are fleet facts, not N human decisions. This pure
 * projection is deliberately model-free: it still explains the outage when no
 * coordinator or worker can start, and recovery follows typed markers rather
 * than a generated summary.
 */
export function fleetIncidents(docs: WorkstreamDoc[]): FleetIncident[] {
  const affected = docs.flatMap((doc) => doc.assignments
    .filter((assignment) => actionHasLivePilotOutage(doc, assignment))
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
  nowVirtual = virtualNow(),
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
          workstreamStatus: doc.workstream.status,
          refId: attention.refId,
          referencedEntity: referencedEntity(doc, attention.refId),
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
          workstreamStatus: doc.workstream.status,
          refId: assignment.id,
          referencedEntity: referencedEntity(doc, assignment.id),
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
          workstreamStatus: doc.workstream.status,
          refId: interaction.id,
          referencedEntity: referencedEntity(doc, interaction.id),
        });
      }
      const health = routineHealth(doc, wallNow, nowVirtual);
      return {
        workstreamId: doc.workstream.id,
        slug: doc.workstream.slug,
        revision: doc.revision,
        status: doc.workstream.status,
        humanNeeds: needs,
        approvalServiceWaits: doc.assignments
          .filter((assignment) => actionHasLivePilotOutage(doc, assignment))
          .map((assignment) => ({
            assignmentId: assignment.id,
            unavailableSince: assignment.exec!.pilotUnavailableSince!,
          })),
        activeCapacityBackoffs: doc.workstream.status === 'active'
          ? Object.values(doc.capacity?.byModel ?? {})
            .filter((backoff) => backoff.wait.retryAt > nowVirtual.toISOString())
            .map((backoff) => ({
              source: backoff.wait.source,
              sourceId: backoff.wait.sourceId,
              sourceEntityKind: backoff.wait.source === 'coordinator' ? 'pass' as const : 'attempt' as const,
              reportableEntity: capacityReportableEntity(doc, backoff.wait),
              kind: backoff.wait.kind,
              recovery: backoff.wait.recovery,
              model: backoff.wait.model,
              executor: backoff.wait.executor,
              provider: backoff.wait.provider,
              retryAt: backoff.wait.retryAt,
              resetAt: backoff.wait.resetAt,
              consecutiveBackoffs: backoff.consecutiveBackoffs,
            }))
            .sort((a, b) => a.retryAt.localeCompare(b.retryAt) || a.sourceId.localeCompare(b.sourceId))
          : [],
        ...(health ? { routineHealth: health } : {}),
      };
    })
    .filter(({ humanNeeds, approvalServiceWaits, activeCapacityBackoffs, routineHealth: health }) =>
      humanNeeds.length || approvalServiceWaits.length || activeCapacityBackoffs.length ||
      !!health?.dormant || !!health?.overdueWakes.length || !!health?.awaitingReviewAssignmentIds.length
    );

  return {
    schemaVersion: 2,
    generatedAt: wallNow.toISOString(),
    scope: 'Open human asks, approval-service waits, active capacity backoffs, and unhealthy routine state only. Unrelated Workstream content is deliberately omitted.',
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
