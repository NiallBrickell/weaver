/**
 * The virtual clock — a scheduler feature, not a continuity shortcut.
 *
 * Demos need "five days later" without waiting five days. The clock stores a
 * persistent offset; wakes compare their dueAt against virtual now. Nothing
 * stays resident: advancing the clock only changes stored data, and the next
 * tick discovers what became due.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Wake, WorkstreamDoc } from './types.js';

function clockPath(): string {
  const home = process.env.WEAVER_HOME ?? path.resolve(process.cwd(), 'state');
  return path.join(home, 'clock.json');
}

interface ClockState {
  offsetMs: number;
}

function readClock(): ClockState {
  try {
    return JSON.parse(fs.readFileSync(clockPath(), 'utf8')) as ClockState;
  } catch {
    return { offsetMs: 0 };
  }
}

export function virtualNow(): Date {
  return new Date(Date.now() + readClock().offsetMs);
}

/** Parse durations like "5d", "3h", "45m", "90s". */
export function parseDuration(spec: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m|s)$/.exec(spec.trim());
  if (!m) throw new Error(`bad duration '${spec}' — use e.g. 5d, 3h, 45m, 90s`);
  const n = Number(m[1]);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[m[2] as 'd' | 'h' | 'm' | 's'];
  return n * unit;
}

export function advanceClock(spec: string): Date {
  const state = readClock();
  state.offsetMs += parseDuration(spec);
  fs.mkdirSync(path.dirname(clockPath()), { recursive: true });
  fs.writeFileSync(clockPath(), JSON.stringify(state, null, 2) + '\n');
  return virtualNow();
}

export function inVirtual(msFromNow: number): Date {
  return new Date(virtualNow().getTime() + msFromNow);
}

/** Linked ordinary future checks are the only wakes a coordinator may retire.
 * Infrastructure recovery, execution-safety guards, immediate arrivals, and
 * wall-clock containment belong to the harness and cannot be retired
 * individually here. */
export function isCoordinatorCancellableWake(
  wake: Wake,
  nowVirtual = virtualNow().toISOString(),
): wake is Wake & {
  status: 'pending';
  condition: Extract<Wake['condition'], { type: 'time' }>;
} {
  return wake.status === 'pending' &&
    wake.condition.type === 'time' &&
    wake.condition.dueAtVirtual > nowVirtual &&
    wake.infrastructure === undefined &&
    wake.executionSafety === undefined &&
    wake.organizationalCourseId !== undefined;
}

export interface CancellableWakePage {
  total: number;
  wakes: Array<{ id: string; dueAtVirtual: string; reason: string; organizationalCourseId: string }>;
  nextAfterWakeId?: string;
}

/** Stable exact-id pagination over live organizational wakes. The cursor is a
 * retained Wake id from the full collection, so cancelling an earlier page
 * cannot make the next page unreachable. */
export function coordinatorCancellableWakePage(
  doc: WorkstreamDoc,
  options: { afterWakeId?: string; limit: number; nowVirtual?: string },
): CancellableWakePage {
  const nowVirtual = options.nowVirtual ?? virtualNow().toISOString();
  let start = 0;
  if (options.afterWakeId) {
    const cursor = doc.wakes.findIndex((wake) => wake.id === options.afterWakeId);
    if (cursor < 0) throw new Error(`no wake cursor ${options.afterWakeId}`);
    start = cursor + 1;
  }
  const all = doc.wakes.filter((wake) => isCoordinatorCancellableWake(wake, nowVirtual));
  const afterCursor = doc.wakes
    .slice(start)
    .filter((wake) => isCoordinatorCancellableWake(wake, nowVirtual));
  const page = afterCursor.slice(0, options.limit);
  const hasMore = afterCursor.length > page.length;
  return {
    total: all.length,
    wakes: page.map((wake) => ({
      id: wake.id,
      dueAtVirtual: wake.condition.dueAtVirtual,
      reason: wake.reason,
      organizationalCourseId: wake.organizationalCourseId!,
    })),
    ...(hasMore && page.length ? { nextAfterWakeId: page.at(-1)!.id } : {}),
  };
}

/** A newly scheduled organizational wake must name one currently live course. */
export function organizationalWakeCourseLabel(doc: WorkstreamDoc, courseId: string): string {
  const decision = doc.decisions.find((candidate) =>
    candidate.id === courseId && candidate.status === 'standing',
  );
  if (decision) return `${courseId}: standing decision`;
  const assignment = doc.assignments.find((candidate) =>
    candidate.id === courseId && !['completed', 'failed', 'cancelled'].includes(candidate.state),
  );
  if (assignment) return `${courseId}: live assignment`;
  const interaction = doc.interactions.find((candidate) =>
    candidate.id === courseId && candidate.status !== 'rejected',
  );
  if (interaction) return `${courseId}: active interaction`;
  const attention = doc.attention.find((candidate) =>
    candidate.id === courseId && candidate.status === 'open',
  );
  if (attention) return `${courseId}: open attention item`;
  throw new Error(
    `${courseId} is not a standing decision, live assignment, active interaction, or open attention item`,
  );
}

/** Resolve facts that directly close or supersede this wake's exact course.
 * Free-text reason and unrelated durable facts are never evidence. */
export function wakeCancellationBasisLabels(
  doc: WorkstreamDoc,
  wake: Wake,
  basisIds: string[],
): string[] {
  if (!basisIds.length) throw new Error('wake cancellation requires at least one typed basis id');
  if (new Set(basisIds).size !== basisIds.length) {
    throw new Error('wake cancellation basis ids must be unique');
  }
  const courseId = wake.organizationalCourseId;
  if (!courseId) throw new Error(`${wake.id} has no typed organizational course`);
  const courseDecision = doc.decisions.find((candidate) => candidate.id === courseId);
  const courseAssignment = doc.assignments.find((candidate) => candidate.id === courseId);
  const courseInteraction = doc.interactions.find((candidate) => candidate.id === courseId);
  const courseAttention = doc.attention.find((candidate) => candidate.id === courseId);
  if (!courseDecision && !courseAssignment && !courseInteraction && !courseAttention) {
    throw new Error(`${wake.id} names missing organizational course ${courseId}`);
  }
  return basisIds.map((id) => {
    if (courseDecision) {
      if (id === courseDecision.id && courseDecision.status === 'closed') {
        return `${id}: the scheduled decision course is closed`;
      }
      const successor = doc.decisions.find((candidate) =>
        candidate.id === id &&
        candidate.status === 'standing' &&
        candidate.supersedes === courseDecision.id &&
        courseDecision.status === 'superseded' &&
        courseDecision.supersededBy === candidate.id,
      );
      if (successor) return `${id}: supersedes scheduled decision ${courseDecision.id}`;
    }
    if (courseAssignment) {
      if (
        id === courseAssignment.id &&
        (courseAssignment.state === 'failed' ||
          courseAssignment.state === 'cancelled' ||
          (courseAssignment.state === 'completed' && courseAssignment.adoption.state === 'accepted'))
      ) {
        return `${id}: scheduled assignment settled ${courseAssignment.state}/${courseAssignment.adoption.state}`;
      }
      const deliverable = doc.deliverables.find((candidate) =>
        candidate.id === id &&
        candidate.producedByAssignment === courseAssignment.id &&
        candidate.adopted,
      );
      if (deliverable) {
        return `${id}: adopted result of scheduled assignment ${courseAssignment.id}`;
      }
    }
    if (courseInteraction) {
      if (id === courseInteraction.id && courseInteraction.status === 'rejected') {
        return `${id}: scheduled interaction was rejected`;
      }
      const reply = courseInteraction.replies.find((candidate) =>
        candidate.id === id && candidate.evaluation,
      );
      if (reply) return `${id}: evaluated reply on scheduled interaction ${courseInteraction.id}`;
    }
    if (courseAttention && id === courseAttention.id && courseAttention.status === 'resolved') {
      return `${id}: scheduled attention item is resolved`;
    }
    throw new Error(`${id} does not close or supersede wake ${wake.id}'s course ${courseId}`);
  });
}
