import type { ReactNode } from 'react';

import { RETRY_RULE, type TimelineAssignment, type TimelineEntry, type WorkstreamTimeline } from '../../timeline.js';
import { Badge, cn, type BadgeVariant } from '../components/index.js';
import { formatTimestamp } from '../inspect/model.js';

// The shared timeline: the workstream page's default tab and the overview's
// worked example render the same model (src/timeline.ts) through this one
// component. Server-rendered only; expansion is plain <details>.

const DOT = {
  accepted: 'border-emerald-400 bg-emerald-400',
  rejected: 'border-rose-400 bg-zinc-950',
  pending: 'border-zinc-500 bg-zinc-950',
  decision: 'border-violet-400 bg-violet-400',
  human: 'border-sky-400 bg-sky-400',
  concluded: 'border-amber-400 bg-amber-400',
} as const;

function assignmentTone(a: TimelineAssignment): keyof typeof DOT {
  if (a.adoption === 'accepted' || (a.kind === 'action' && a.state === 'completed')) return 'accepted';
  if (a.adoption === 'rejected' || a.state === 'failed' || a.state === 'cancelled') return 'rejected';
  return 'pending';
}

function outcomeClass(a: TimelineAssignment): string {
  const tone = assignmentTone(a);
  return tone === 'accepted' ? 'text-emerald-300' : tone === 'rejected' ? 'text-rose-300' : 'text-zinc-500';
}

function kindLabel(kind: string): string {
  return kind.replaceAll('_', ' ');
}

function targetLabel(a: TimelineAssignment): string | undefined {
  const t = a.lastTarget;
  if (!t) return undefined;
  const where = [t.executor, t.provider].filter(Boolean).join('/');
  return [where, t.model].filter(Boolean).join(' · ');
}

function Expandable({ summary, full, truncated }: { summary: string; full: string; truncated: boolean }) {
  if (!truncated) return <>{summary}</>;
  return (
    <details className="group inline">
      <summary className="inline cursor-pointer list-none marker:hidden [&::-webkit-details-marker]:hidden">
        {summary} <span className="text-xs text-violet-300 group-open:hidden">more</span>
      </summary>
      <span className="mt-1 block whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">{full}</span>
    </details>
  );
}

function Row({ dot, at, badge, children, testId, muted = false }: {
  dot?: keyof typeof DOT;
  at: string;
  badge: ReactNode;
  children: ReactNode;
  testId: string;
  muted?: boolean;
}) {
  return (
    <li data-testid={testId} className="relative grid gap-1 py-2 pl-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      {dot ? <span className={cn('absolute -left-[7px] top-3.5 h-3 w-3 rounded-full border-2', DOT[dot])} /> : null}
      <time dateTime={at} className="pt-0.5 font-mono text-[11px] tabular-nums text-zinc-500">{formatTimestamp(at)}</time>
      <span className={cn('min-w-0 break-words text-sm leading-6', muted ? 'text-zinc-500' : 'text-zinc-200')}>
        {badge}
        {children}
      </span>
    </li>
  );
}

function KindBadge({ label, variant }: { label: string; variant: BadgeVariant }) {
  return <Badge variant={variant} className="mr-2 font-mono text-[10px] uppercase">{label}</Badge>;
}

function AssignmentMeta({ a }: { a: TimelineAssignment }) {
  const target = targetLabel(a);
  return (
    <span className="block text-xs text-zinc-500">
      {a.state.replaceAll('_', ' ')}
      {a.adoption !== 'none' ? <> · <span className={outcomeClass(a)}>{a.adoption}</span></> : null}
      {a.attempts > 1 ? ` · ${a.attempts} runs` : ''}
      {target ? <> · <span className="font-mono">{target}</span></> : null}
      {a.needsPerson ? <span data-testid="timeline-needs-person" className="block text-amber-300">Needs a person: {a.needsPerson}</span> : null}
    </span>
  );
}

function AssignmentRow({ a }: { a: TimelineAssignment }) {
  return (
    <Row testId="timeline-assignment" dot={assignmentTone(a)} at={a.at} badge={<KindBadge label={kindLabel(a.kind)} variant={a.kind === 'action' ? 'accent' : 'neutral'} />}>
      <Expandable summary={a.summary} full={a.objective} truncated={a.truncated} />
      <AssignmentMeta a={a} />
    </Row>
  );
}

function retryLine(entry: Extract<TimelineEntry, { type: 'retries' }>): string {
  const parts = [`${entry.steps.length} attempts`];
  if (entry.rejected) parts.push(`${entry.rejected} rejected`);
  if (entry.failed) parts.push(`${entry.failed} failed`);
  const last = entry.steps.at(-1)!;
  if (last.adoption !== 'rejected' && last.state !== 'failed') parts.push(`then ${entry.finalOutcome}`);
  return parts.join(' · ');
}

function EntryRow({ entry }: { entry: TimelineEntry }) {
  switch (entry.type) {
    case 'assignment':
      return <AssignmentRow a={entry.assignment} />;
    case 'retries': {
      const last = entry.steps.at(-1)!;
      return (
        <Row testId="timeline-retries" dot={assignmentTone(last)} at={entry.at} badge={<KindBadge label={`${kindLabel(entry.kind)} ×${entry.steps.length}`} variant={entry.kind === 'action' ? 'accent' : 'neutral'} />}>
          <Expandable summary={last.summary} full={last.objective} truncated={last.truncated} />
          <details className="mt-0.5">
            <summary className={cn('cursor-pointer text-xs', outcomeClass(last))}>{retryLine(entry)}</summary>
            <ol className="mt-1 space-y-1.5 border-l border-zinc-800 pl-3">
              {entry.steps.map((step) => (
                <li key={step.id} data-testid="timeline-retry-step" className="text-sm leading-6 text-zinc-300">
                  <span className="mr-2 font-mono text-[11px] tabular-nums text-zinc-500">{formatTimestamp(step.at)}</span>
                  <Expandable summary={step.summary} full={step.objective} truncated={step.truncated} />
                  <AssignmentMeta a={step} />
                </li>
              ))}
            </ol>
          </details>
        </Row>
      );
    }
    case 'decision':
      return (
        <Row testId="timeline-decision" dot="decision" at={entry.at} muted={entry.status !== 'standing'} badge={<KindBadge label="decision" variant="accent" />}>
          {entry.title}
          <span className="block text-xs text-zinc-500">
            {entry.madeBy === 'human' ? 'by a person · ' : ''}
            {entry.supersedes ? <>replaces “{entry.supersedes.title}” · </> : null}
            {entry.status === 'standing' ? <span className="text-emerald-300">standing</span> : null}
            {entry.status === 'superseded' ? <>superseded{entry.supersededBy ? <> by “{entry.supersededBy.title}”</> : null}</> : null}
            {entry.status === 'closed' ? <>closed{entry.closedReason ? ` — ${entry.closedReason}` : ''}</> : null}
          </span>
        </Row>
      );
    case 'cycle':
      return (
        <Row testId="timeline-cycle" dot="decision" at={entry.at} badge={<KindBadge label={`cycle ${entry.cycle}`} variant="accent" />}>
          Cycle {entry.cycle} began · {entry.label}
          <span className="block text-xs text-zinc-500">{entry.decisionTitle}</span>
        </Row>
      );
    case 'steer':
      return (
        <Row testId="timeline-steer" dot="human" at={entry.at} muted={!!entry.withdrawn} badge={<KindBadge label="steer" variant="warning" />}>
          <span className={entry.withdrawn ? 'line-through decoration-zinc-600' : undefined}>
            <Expandable summary={entry.summary} full={entry.body} truncated={entry.truncated} />
          </span>
          <span className="block text-xs text-zinc-500">
            {entry.by ? `by ${entry.by}` : 'by a person'}
            {entry.withdrawn
              ? <> · <span className="text-zinc-400">withdrawn {formatTimestamp(entry.withdrawn.at)}{entry.withdrawn.by ? ` by ${entry.withdrawn.by}` : ''}</span></>
              : entry.read ? ' · read by the coordinator' : ' · not yet read'}
          </span>
        </Row>
      );
    case 'verdict': {
      const good = entry.verdict !== 'rejected';
      const what = entry.on === 'action' ? 'action' : entry.on === 'send' ? 'send' : 'result';
      return (
        <Row testId="timeline-verdict" dot={good ? 'accepted' : 'rejected'} at={entry.at} badge={<KindBadge label={`${entry.verdict} ${what}`} variant={good ? 'success' : 'attention'} />}>
          {entry.subject}
          <span className="block text-xs text-zinc-500">by {entry.by}{entry.note ? ` — ${entry.note}` : ''}</span>
        </Row>
      );
    }
    case 'attention':
      return (
        <Row testId="timeline-attention" dot={entry.phase === 'asked' ? 'human' : 'accepted'} at={entry.at} muted={entry.phase === 'resolved'} badge={<KindBadge label={entry.phase === 'asked' ? 'asked you' : 'resolved'} variant={entry.phase === 'asked' ? 'attention' : 'outline'} />}>
          {entry.summary}
          <span className="block text-xs text-zinc-500">{entry.attentionKind}{entry.by ? ` · by ${entry.by}` : ''}</span>
        </Row>
      );
    case 'conclusion':
      return (
        <Row testId="timeline-conclusion" dot="concluded" at={entry.at} badge={<KindBadge label="concluded" variant="warning" />}>
          {entry.summary}
          <span className="block text-xs text-zinc-500">
            Disposition: <span className={entry.successful ? 'text-emerald-300' : 'text-zinc-300'}>{entry.dispositionLabel}</span>
            {` · ${entry.evidence} cited record${entry.evidence === 1 ? '' : 's'}`}
          </span>
        </Row>
      );
    case 'gap':
      return (
        <li data-testid="timeline-gap" className="py-1.5 pl-5 text-xs italic text-zinc-500">
          {entry.ongoing ? `waiting ${entry.label} so far` : `waited ${entry.label}`}
          {entry.reason ? <span className="not-italic text-zinc-600"> · {entry.reason}</span> : null}
        </li>
      );
  }
}

export function Timeline({ timeline, earlierHref, footer }: {
  timeline: WorkstreamTimeline;
  /** Where "show earlier" points when rows were left out. */
  earlierHref?: string;
  footer?: ReactNode;
}) {
  return (
    <div data-testid="workstream-timeline" className="space-y-2">
      <p data-testid="timeline-caption" className="text-xs leading-5 text-zinc-600">Oldest first. {RETRY_RULE} A quiet stretch of six hours or more shows as one wait.</p>
      {timeline.omitted ? (
        <p data-testid="timeline-earlier" className="text-xs text-zinc-500">
          {timeline.omitted} earlier {timeline.omitted === 1 ? 'entry' : 'entries'} not shown.{' '}
          {earlierHref ? <a href={earlierHref} className="text-violet-300 hover:text-violet-200">Show earlier</a> : null}
        </p>
      ) : null}
      {!timeline.entries.length ? <p className="text-sm text-zinc-600">Nothing has been recorded yet.</p> : null}
      {timeline.entries.length || footer ? (
        <ol className="ml-1.5 border-l-2 border-zinc-800">
          {timeline.entries.map((entry) => <EntryRow key={entry.key} entry={entry} />)}
          {footer}
        </ol>
      ) : null}
    </div>
  );
}
