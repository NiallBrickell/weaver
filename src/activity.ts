/** Honest compact activity from durable timestamps, never transcript/tail data.
 * Elapsed execution uses physical time; decision age uses the virtual clock
 * because decisions are recorded on the organizational timeline. */

import { virtualNow } from './clock.js';
import type { WorkstreamDoc } from './types.js';

export function compactAge(from: string, now: Date): string {
  const parsed = Date.parse(from);
  if (!Number.isFinite(parsed)) return 'unknown';
  const seconds = Math.max(0, Math.floor((now.getTime() - parsed) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d`;
}

export function activitySummary(
  doc: WorkstreamDoc,
  wallNow = new Date(),
  organizationalNow = virtualNow(),
): string {
  const inFlight = doc.assignments.flatMap((assignment) => {
    if (assignment.state !== 'running') return [];
    const attempt = assignment.attempts.at(-1);
    return attempt && !attempt.endedAt ? [attempt.startedAt] : [];
  });
  if (doc.lease && Date.parse(doc.lease.expiresAt) > wallNow.getTime()) {
    inFlight.push(doc.lease.acquiredAt);
  }
  const validStarts = inFlight.filter((startedAt) => Number.isFinite(Date.parse(startedAt)));
  const oldest = validStarts.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const execution = oldest
    ? validStarts.length === 1
      ? `${compactAge(oldest, wallNow)} in flight`
      : `${validStarts.length} in flight · oldest ${compactAge(oldest, wallNow)}`
    : undefined;

  const latestDecision = [...doc.decisions]
    .filter((decision) => Number.isFinite(Date.parse(decision.decidedAtVirtual)))
    .sort((a, b) => b.decidedAtVirtual.localeCompare(a.decidedAtVirtual))[0];
  const decision = latestDecision
    ? `decision ${compactAge(latestDecision.decidedAtVirtual, organizationalNow)} ago`
    : undefined;
  return [execution, decision].filter(Boolean).join(' · ');
}
