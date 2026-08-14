import { compactAge } from '../../activity.js';
import { assignmentBoard, type AssignmentBoardView } from '../../assignmentBoard.js';
import { virtualNow } from '../../clock.js';
import { isLegacyDollarBudgetAttention } from '../../executionSafety.js';
import { isDoctrine, type PolicyRecord } from '../../policies.js';
import type { WorkstreamDoc } from '../../types.js';

export interface ManagedWorkstreamLink {
  slug: string;
  status: string;
}

export type FleetNeedKind = 'blocker' | 'approval' | 'review' | 'budget' | 'capacity' | 'action' | 'send';

export interface FleetNeed {
  slug: string;
  kind: FleetNeedKind;
  at?: string;
  summary: string;
}

export type WorkstreamLane = 'needs-you' | 'moving' | 'waiting' | 'ready';

export interface LatestFact {
  label: string;
  summary: string;
  atVirtual: string;
  age: string;
  recent: boolean;
}

export interface WorkstreamCardView {
  slug: string;
  title: string;
  objective: string;
  status: WorkstreamDoc['workstream']['status'];
  priority: WorkstreamDoc['workstream']['priority'];
  tags: string[];
  managedBy?: string;
  manages: ManagedWorkstreamLink[];
  lane: WorkstreamLane;
  state: string;
  next: string;
  needCount: number;
  openAssignmentCount: number;
  acceptedAssignmentCount: number;
  adoptedDeliverableCount: number;
  latestFact?: LatestFact;
  integrityWarnings: string[];
}

export interface DoneWorkstreamView {
  slug: string;
  title: string;
  outcome: string;
  concludedAt: string;
  adoptedDeliverableCount: number;
}

export interface FleetBoardView {
  lanes: Record<WorkstreamLane, WorkstreamCardView[]>;
  needs: FleetNeed[];
  done: DoneWorkstreamView[];
  unreadable: string[];
  policyCount: number;
}

export interface WorkstreamPageView {
  doc: WorkstreamDoc;
  managed: ManagedWorkstreamLink[];
  policies: PolicyRecord[];
  assignments: AssignmentBoardView;
  position: WorkstreamCardView;
  needs: FleetNeed[];
  integrityWarnings: string[];
}

const NEED_RANK: Record<FleetNeedKind, number> = {
  blocker: 0,
  action: 1,
  approval: 1,
  send: 1,
  review: 2,
  budget: 3,
  capacity: 3,
};

const RECENT_MOVEMENT_MS = 24 * 60 * 60_000;

export function firstLine(value: string, max = 160): string {
  const line = value.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function passIntegrityWarnings(doc: WorkstreamDoc): string[] {
  return doc.passes.flatMap((pass) =>
    pass.outcome === 'completed' && !pass.summary
      ? [`${pass.id}: completed without a summary — a clean finish always records one`]
      : [],
  );
}

export function policiesForWorkstream(policies: PolicyRecord[], doc: WorkstreamDoc): PolicyRecord[] {
  const slug = doc.workstream.slug;
  const applied = new Set(doc.decisions.flatMap((decision) => decision.appliedPolicyIds ?? []));
  return policies.filter(
    (policy) =>
      ('workstreamSlug' in policy.provenance && policy.provenance.workstreamSlug === slug) ||
      policy.evidence.some((evidence) => evidence.workstreamSlug === slug) ||
      applied.has(policy.id),
  );
}

export function fleetNeeds(docs: WorkstreamDoc[]): FleetNeed[] {
  const needs: FleetNeed[] = [];
  for (const doc of docs) {
    const slug = doc.workstream.slug;
    const representedRefs = new Set<string>();
    for (const attention of doc.attention) {
      if (attention.status === 'open' && !isLegacyDollarBudgetAttention(attention)) {
        if (attention.refId && representedRefs.has(attention.refId)) continue;
        const action = attention.refId
          ? doc.assignments.find((assignment) => assignment.id === attention.refId && assignment.state === 'gated')
          : undefined;
        const send = attention.refId
          ? doc.interactions.find((interaction) => interaction.id === attention.refId && interaction.status === 'awaiting_approval')
          : undefined;
        needs.push({
          slug,
          kind: action ? 'action' : send ? 'send' : attention.kind,
          at: attention.createdAt,
          summary: action
            ? action.exec?.ask ?? action.objective
            : send
              ? `Send to ${send.to}: ${send.subject}`
              : attention.summary,
        });
        if (attention.refId) representedRefs.add(attention.refId);
      }
    }
    for (const assignment of doc.assignments) {
      if (assignment.state !== 'gated' || assignment.exec?.pilotVerdict?.decision === 'approve') continue;
      if (representedRefs.has(assignment.id)) continue;
      needs.push({
        slug,
        kind: 'action',
        at: assignment.createdAtVirtual,
        summary: assignment.exec?.ask ?? assignment.objective,
      });
      representedRefs.add(assignment.id);
    }
    for (const interaction of doc.interactions) {
      if (interaction.status === 'awaiting_approval') {
        if (representedRefs.has(interaction.id)) continue;
        needs.push({
          slug,
          kind: 'send',
          summary: `Send to ${interaction.to}: ${interaction.subject}`,
        });
        representedRefs.add(interaction.id);
      }
    }
  }
  return needs.sort(
    (a, b) =>
      NEED_RANK[a.kind] - NEED_RANK[b.kind] ||
      (a.at ? (b.at ? a.at.localeCompare(b.at) : -1) : b.at ? 1 : 0) ||
      a.slug.localeCompare(b.slug),
  );
}

function soonestWake(
  doc: WorkstreamDoc,
  wallNow: Date,
  organizationalNow: Date,
): { remaining: number; reason: string; blocking: boolean } | undefined {
  let soonest: { remaining: number; reason: string; blocking: boolean } | undefined;
  for (const wake of doc.wakes) {
    if (wake.status !== 'pending') continue;
    const remaining =
      wake.condition.type === 'time'
        ? Date.parse(wake.condition.dueAtVirtual) - organizationalNow.getTime()
        : wake.condition.type === 'wall_time'
          ? Date.parse(wake.condition.dueAt) - wallNow.getTime()
          : 0;
    if (!Number.isFinite(remaining)) continue;
    if (!soonest || remaining < soonest.remaining) {
      soonest = {
        remaining,
        reason: wake.reason,
        blocking: wake.infrastructure !== undefined || wake.executionSafety !== undefined,
      };
    }
  }
  return soonest;
}

function dueLabel(milliseconds: number): string {
  if (milliseconds <= 0) return 'now';
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)}h`;
  return `in ${Math.round(minutes / (24 * 60))}d`;
}

/**
 * Most recent durable organizational fact with an organizational timestamp.
 * Event prose and disposable sessions are deliberately excluded.
 */
function latestFact(doc: WorkstreamDoc, organizationalNow: Date): LatestFact | undefined {
  const facts: { label: string; summary: string; atVirtual: string }[] = [];
  for (const decision of doc.decisions) {
    facts.push({ label: 'Direction', summary: decision.title, atVirtual: decision.decidedAtVirtual });
  }
  for (const assignment of doc.assignments) {
    facts.push({ label: 'Work opened', summary: assignment.objective, atVirtual: assignment.createdAtVirtual });
  }
  for (const deliverable of doc.deliverables) {
    facts.push({
      label: deliverable.adopted ? 'Adopted' : 'Candidate',
      summary: deliverable.title,
      atVirtual: deliverable.adopted?.atVirtual ?? deliverable.createdAtVirtual,
    });
  }
  for (const interaction of doc.interactions) {
    if (interaction.sentAtVirtual) {
      facts.push({ label: 'Sent', summary: interaction.subject, atVirtual: interaction.sentAtVirtual });
    }
    for (const reply of interaction.replies) {
      facts.push({ label: 'Reply', summary: reply.body, atVirtual: reply.receivedAtVirtual });
    }
  }
  for (const observation of doc.observations) {
    facts.push({ label: 'Observed', summary: observation.summary, atVirtual: observation.atVirtual });
  }
  for (const direction of doc.managerDirections ?? []) {
    facts.push({ label: 'Direction received', summary: direction.body, atVirtual: direction.atVirtual });
  }
  for (const notice of doc.managerNotices ?? []) {
    facts.push({ label: 'Managed work', summary: notice.summary, atVirtual: notice.receivedAtVirtual });
  }
  if (doc.workstream.conclusion) {
    facts.push({
      label: 'Concluded',
      summary: doc.workstream.conclusion.summary,
      atVirtual: doc.workstream.conclusion.atVirtual,
    });
  }
  const fact = facts
    .filter((candidate) => Number.isFinite(Date.parse(candidate.atVirtual)))
    .sort((a, b) => b.atVirtual.localeCompare(a.atVirtual))[0];
  if (!fact) return undefined;
  const elapsed = organizationalNow.getTime() - Date.parse(fact.atVirtual);
  return {
    ...fact,
    summary: firstLine(fact.summary, 140),
    age: compactAge(fact.atVirtual, organizationalNow),
    recent: Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= RECENT_MOVEMENT_MS,
  };
}

function concludedAt(doc: WorkstreamDoc): string {
  return doc.workstream.conclusion?.atVirtual ?? doc.workstream.createdAt;
}

function cardFor(
  doc: WorkstreamDoc,
  allNeeds: FleetNeed[],
  managed: ManagedWorkstreamLink[],
  wallNow: Date,
  organizationalNow: Date,
): WorkstreamCardView {
  const needs = allNeeds.filter((need) => need.slug === doc.workstream.slug);
  const running = doc.assignments.find((assignment) => assignment.state === 'running');
  const review = doc.assignments.find((assignment) => assignment.state === 'awaiting_review');
  const queued = doc.assignments.find((assignment) => assignment.state === 'queued');
  const pilotApproved = doc.assignments.find(
    (assignment) => assignment.state === 'gated' && assignment.exec?.pilotVerdict?.decision === 'approve',
  );
  const wake = soonestWake(doc, wallNow, organizationalNow);
  const standing = [...doc.decisions].reverse().find((decision) => decision.status === 'standing');
  const hasLease = !!doc.lease && Date.parse(doc.lease.expiresAt) > wallNow.getTime();
  let lane: WorkstreamLane;
  let state: string;
  let next: string;

  if (needs.length) {
    lane = 'needs-you';
    state = needs[0]!.kind;
    next = needs[0]!.summary;
  } else if (running || review || pilotApproved || hasLease) {
    lane = 'moving';
    state = running || hasLease ? 'working' : review ? 'review' : 'dispatching';
    next = running?.objective ?? review?.objective ?? pilotApproved?.objective ?? 'Coordinator pass in flight';
  } else if (
    doc.workstream.status === 'paused' ||
    (wake && wake.remaining > 0 && (wake.blocking || !queued))
  ) {
    lane = 'waiting';
    state = doc.workstream.status === 'paused' ? 'paused' : wake?.blocking ? 'blocked' : 'scheduled';
    next = doc.workstream.status === 'paused'
      ? 'Paused by the human'
      : `${wake!.reason}${wake!.remaining > 0 ? ` · ${dueLabel(wake!.remaining)}` : ''}`;
  } else {
    lane = 'ready';
    state = queued || wake ? 'planned' : 'unscheduled';
    next = queued?.objective ?? wake?.reason ?? standing?.title ?? 'No next move scheduled';
  }

  return {
    slug: doc.workstream.slug,
    title: doc.workstream.title,
    objective: doc.workstream.objective,
    status: doc.workstream.status,
    priority: doc.workstream.priority,
    tags: doc.workstream.tags,
    ...(doc.workstream.managedBy ? { managedBy: doc.workstream.managedBy.slug } : {}),
    manages: managed,
    lane,
    state,
    next: firstLine(next),
    needCount: needs.length,
    openAssignmentCount: doc.assignments.filter(
      (assignment) => !['completed', 'failed', 'cancelled'].includes(assignment.state),
    ).length,
    acceptedAssignmentCount: doc.assignments.filter(
      (assignment) => assignment.state === 'completed' && assignment.adoption.state === 'accepted',
    ).length,
    adoptedDeliverableCount: doc.deliverables.filter((deliverable) => deliverable.adopted).length,
    latestFact: latestFact(doc, organizationalNow),
    integrityWarnings: passIntegrityWarnings(doc),
  };
}

export function fleetBoard(
  docs: WorkstreamDoc[],
  policies: PolicyRecord[],
  managedBySlug: Map<string, ManagedWorkstreamLink[]>,
  unreadable: string[] = [],
  wallNow = new Date(),
  organizationalNow = virtualNow(),
): FleetBoardView {
  const needs = fleetNeeds(docs);
  const slugsNeedingHuman = new Set(needs.map((need) => need.slug));
  const cards = docs
    .filter((doc) => doc.workstream.status !== 'done' || slugsNeedingHuman.has(doc.workstream.slug))
    .map((doc) => cardFor(doc, needs, managedBySlug.get(doc.workstream.slug) ?? [], wallNow, organizationalNow));
  const lanes: Record<WorkstreamLane, WorkstreamCardView[]> = {
    'needs-you': [],
    moving: [],
    waiting: [],
    ready: [],
  };
  for (const card of cards) lanes[card.lane].push(card);
  const needOrder = new Map<string, number>();
  for (const [index, need] of needs.entries()) {
    if (!needOrder.has(need.slug)) needOrder.set(need.slug, index);
  }
  for (const [laneName, lane] of Object.entries(lanes) as [WorkstreamLane, WorkstreamCardView[]][]) {
    lane.sort(
      (a, b) =>
        (laneName === 'needs-you'
          ? (needOrder.get(a.slug) ?? Number.MAX_SAFE_INTEGER) - (needOrder.get(b.slug) ?? Number.MAX_SAFE_INTEGER)
          : (a.priority === 'high' ? 0 : a.priority === 'low' ? 2 : 1) -
            (b.priority === 'high' ? 0 : b.priority === 'low' ? 2 : 1)) ||
        a.title.localeCompare(b.title),
    );
  }
  const done = docs
    .filter((doc) => doc.workstream.status === 'done' && !slugsNeedingHuman.has(doc.workstream.slug))
    .sort((a, b) => concludedAt(b).localeCompare(concludedAt(a)))
    .map((doc) => ({
      slug: doc.workstream.slug,
      title: doc.workstream.title,
      outcome: doc.workstream.conclusion?.summary ?? doc.workstream.objective,
      concludedAt: concludedAt(doc),
      adoptedDeliverableCount: doc.deliverables.filter((deliverable) => deliverable.adopted).length,
    }));
  return { lanes, needs, done, unreadable, policyCount: policies.length };
}

export function workstreamPage(
  doc: WorkstreamDoc,
  allPolicies: PolicyRecord[],
  managed: ManagedWorkstreamLink[] = [],
): WorkstreamPageView {
  const needs = fleetNeeds([doc]);
  return {
    doc,
    managed,
    policies: policiesForWorkstream(allPolicies, doc),
    assignments: assignmentBoard(doc),
    position: cardFor(doc, needs, managed, new Date(), virtualNow()),
    needs,
    integrityWarnings: passIntegrityWarnings(doc),
  };
}

export interface LearnedGroups {
  doctrine: PolicyRecord[];
  active: PolicyRecord[];
  contested: PolicyRecord[];
  shadowProven: PolicyRecord[];
  shadowUnproven: PolicyRecord[];
  superseded: PolicyRecord[];
}

export function learnedGroups(policies: PolicyRecord[]): LearnedGroups {
  const live = policies.filter((policy) => policy.status !== 'superseded');
  const doctrine = live.filter(isDoctrine);
  const learned = live.filter((policy) => !isDoctrine(policy));
  const contested = learned.filter((policy) => policy.contested);
  const rest = learned.filter((policy) => !policy.contested);
  const sort = (items: PolicyRecord[]) =>
    [...items].sort(
      (a, b) => b.evidence.length - a.evidence.length || b.createdAt.localeCompare(a.createdAt),
    );
  return {
    doctrine: sort(doctrine),
    active: sort(rest.filter((policy) => policy.status === 'active')),
    contested: sort(contested),
    shadowProven: sort(rest.filter((policy) => policy.status === 'shadow' && policy.evidence.length > 0)),
    shadowUnproven: sort(rest.filter((policy) => policy.status === 'shadow' && policy.evidence.length === 0)),
    superseded: sort(policies.filter((policy) => policy.status === 'superseded')),
  };
}
