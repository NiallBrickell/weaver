/**
 * Pure Assignment-board projection for one Workstream.
 *
 * Assignments are the durable intended-work cards. Attempts stay nested as
 * execution facts; they never become cards of their own. Likewise, a worker
 * finishing does not put work in Accepted: only completed + accepted adoption
 * does that.
 */

import type {
  ActionPreflightMode,
  Assignment,
  AssignmentExecutionRequirements,
  AssignmentKind,
  Attempt,
  WorkstreamDoc,
} from './types.js';

export type AssignmentBoardLane = 'planned' | 'working' | 'review' | 'accepted';
export type AssignmentState = Assignment['state'];
export type AdoptionState = Assignment['adoption']['state'];

export interface AssignmentBoardDependency {
  id: string;
  /** Human-recognizable intended work; the id is provenance, not the label. */
  objective?: string;
  accepted: boolean;
}

export interface AssignmentBoardAttempt {
  runId: string;
  startedAt: string;
  endedAt?: string;
  model?: string;
  executor?: string;
  provider?: string;
  terminalReason?: string;
}

export interface AssignmentBoardSubmission {
  summary: string;
  deliverableId?: string;
}

export interface AssignmentBoardAction {
  /** A gated card is a human decision waiting in Review, not planned work. */
  awaitingApproval: boolean;
  approved: boolean;
  approvalBy?: 'human' | 'pilot';
  approvalAt?: string;
  approvalActor?: string;
  ask?: string;
  run?: string;
  preflightMode: ActionPreflightMode;
  verify: string;
  rejection?: { actor: string; at: string; reason: string };
  readback: 'pending' | 'confirmed' | 'failed';
  readbackAt?: string;
  readbackOutput?: string;
}

export interface AssignmentBoardAdoption {
  state: AdoptionState;
  passId?: string;
  reason?: string;
  at?: string;
  actor?: string;
}

export interface AssignmentBoardCard {
  id: string;
  objective: string;
  kind: AssignmentKind;
  executionRequirements?: AssignmentExecutionRequirements;
  acceptanceCriteria: string[];
  assignmentState: AssignmentState;
  adoptionState: AdoptionState;
  adoption: AssignmentBoardAdoption;
  dependencies: AssignmentBoardDependency[];
  attempts: AssignmentBoardAttempt[];
  attemptCount: number;
  latestAttempt?: AssignmentBoardAttempt;
  submission?: AssignmentBoardSubmission;
  action?: AssignmentBoardAction;
}

export interface AssignmentBoardArchive {
  total: number;
  byState: Record<AssignmentState, number>;
  byAdoption: Record<AdoptionState, number>;
  /** Settled history remains inspectable under the renderer's disclosure. */
  cards: AssignmentBoardCard[];
}

export interface AssignmentBoardView {
  lanes: Record<AssignmentBoardLane, AssignmentBoardCard[]>;
  archive: AssignmentBoardArchive;
}

const ASSIGNMENT_STATES: AssignmentState[] = [
  'gated',
  'queued',
  'running',
  'awaiting_review',
  'completed',
  'failed',
  'cancelled',
];

const ADOPTION_STATES: AdoptionState[] = ['none', 'proposed', 'accepted', 'rejected', 'superseded'];

function zeroCounts<T extends string>(keys: T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function isAccepted(assignment: Assignment | undefined): boolean {
  return assignment?.state === 'completed' && assignment.adoption.state === 'accepted';
}

function attemptView(attempt: Attempt): AssignmentBoardAttempt {
  return {
    runId: attempt.runId,
    startedAt: attempt.startedAt,
    ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
    ...(attempt.model ? { model: attempt.model } : {}),
    ...(attempt.executor ? { executor: attempt.executor } : {}),
    ...(attempt.provider ? { provider: attempt.provider } : {}),
    ...(attempt.terminalReason ? { terminalReason: attempt.terminalReason } : {}),
  };
}

function latestAttempt(attempts: Attempt[]): AssignmentBoardAttempt | undefined {
  const attempt = attempts.at(-1);
  return attempt ? attemptView(attempt) : undefined;
}

function actionFacts(assignment: Assignment): AssignmentBoardAction | undefined {
  if (assignment.kind !== 'action') return undefined;
  const approval = assignment.exec?.approval;
  const verified = assignment.exec?.verified;
  return {
    awaitingApproval: assignment.state === 'gated',
    approved: approval !== undefined,
    ...(approval ? { approvalBy: approval.by } : {}),
    ...(approval ? { approvalAt: approval.at } : {}),
    ...(approval?.actor ? { approvalActor: approval.actor } : {}),
    ...(assignment.exec?.ask ? { ask: assignment.exec.ask } : {}),
    ...(assignment.exec?.run ? { run: assignment.exec.run } : {}),
    preflightMode: assignment.exec?.preflightMode ?? 'postcondition',
    verify: assignment.exec?.verify ?? '',
    ...(assignment.exec?.rejection ? { rejection: { ...assignment.exec.rejection } } : {}),
    readback: verified ? (verified.ok ? 'confirmed' : 'failed') : 'pending',
    ...(verified ? { readbackAt: verified.at, readbackOutput: verified.output } : {}),
  };
}

function card(assignment: Assignment, assignmentsById: Map<string, Assignment>): AssignmentBoardCard {
  const attempt = latestAttempt(assignment.attempts);
  const action = actionFacts(assignment);
  return {
    id: assignment.id,
    objective: assignment.objective,
    kind: assignment.kind,
    ...(assignment.executionRequirements
      ? { executionRequirements: assignment.executionRequirements }
      : {}),
    acceptanceCriteria: [...assignment.acceptanceCriteria],
    assignmentState: assignment.state,
    adoptionState: assignment.adoption.state,
    adoption: { ...assignment.adoption },
    dependencies: assignment.dependsOn.map((id) => ({
      id,
      ...(assignmentsById.get(id)?.objective ? { objective: assignmentsById.get(id)!.objective } : {}),
      accepted: isAccepted(assignmentsById.get(id)),
    })),
    attempts: assignment.attempts.map(attemptView),
    attemptCount: assignment.attempts.length,
    ...(attempt ? { latestAttempt: attempt } : {}),
    ...(assignment.submission ? { submission: { ...assignment.submission } } : {}),
    ...(action ? { action } : {}),
  };
}

function laneFor(assignment: Assignment): AssignmentBoardLane | undefined {
  // Rejected and superseded candidates are history even if a malformed or
  // legacy document retained a nominally live assignment state.
  if (assignment.adoption.state === 'rejected' || assignment.adoption.state === 'superseded') {
    return undefined;
  }
  if (assignment.state === 'completed') {
    return assignment.adoption.state === 'accepted' ? 'accepted' : undefined;
  }
  if (assignment.state === 'queued') return 'planned';
  if (assignment.state === 'running') return 'working';
  if (assignment.state === 'awaiting_review' || assignment.state === 'gated') return 'review';
  return undefined;
}

function compareCreatedOldestFirst(a: Assignment, b: Assignment): number {
  return a.createdAtVirtual.localeCompare(b.createdAtVirtual) || a.id.localeCompare(b.id);
}

function compareCreatedNewestFirst(a: Assignment, b: Assignment): number {
  return b.createdAtVirtual.localeCompare(a.createdAtVirtual) || a.id.localeCompare(b.id);
}

/** Build the complete, renderer-agnostic Assignment board for one Workstream. */
export function assignmentBoard(doc: Pick<WorkstreamDoc, 'assignments'>): AssignmentBoardView {
  const assignmentsById = new Map(doc.assignments.map((assignment) => [assignment.id, assignment]));
  const grouped: Record<AssignmentBoardLane, Assignment[]> = {
    planned: [],
    working: [],
    review: [],
    accepted: [],
  };
  const archive: AssignmentBoardArchive = {
    total: 0,
    byState: zeroCounts(ASSIGNMENT_STATES),
    byAdoption: zeroCounts(ADOPTION_STATES),
    cards: [],
  };
  const archivedAssignments: Assignment[] = [];

  for (const assignment of doc.assignments) {
    const lane = laneFor(assignment);
    if (lane) {
      grouped[lane].push(assignment);
      continue;
    }
    archive.total += 1;
    archive.byState[assignment.state] += 1;
    archive.byAdoption[assignment.adoption.state] += 1;
    archivedAssignments.push(assignment);
  }

  for (const lane of ['planned', 'working', 'review'] as const) {
    grouped[lane].sort(compareCreatedOldestFirst);
  }
  grouped.accepted.sort(compareCreatedNewestFirst);
  archivedAssignments.sort(compareCreatedNewestFirst);
  archive.cards = archivedAssignments.map((assignment) => card(assignment, assignmentsById));

  return {
    lanes: {
      planned: grouped.planned.map((assignment) => card(assignment, assignmentsById)),
      working: grouped.working.map((assignment) => card(assignment, assignmentsById)),
      review: grouped.review.map((assignment) => card(assignment, assignmentsById)),
      accepted: grouped.accepted.map((assignment) => card(assignment, assignmentsById)),
    },
    archive,
  };
}
