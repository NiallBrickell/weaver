import type { AssignmentBoardCard, AssignmentBoardLane } from '../../assignmentBoard.js';
import type { PolicyRecord } from '../../policies.js';
import type { Decision, Deliverable, EventRecord, Interaction, Observation } from '../../types.js';
import { Badge, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, cn } from '../components/index.js';
import { displayText, firstLine, formatTimestamp, type WorkstreamPageView } from './model.js';
import { Empty, PolicyRow, RecordSection, Shell } from './shared.js';

function AssignmentCard({ card }: { card: AssignmentBoardCard }) {
  const variant = card.assignmentState === 'gated' ? 'attention' : card.adoptionState === 'accepted' ? 'success' : 'neutral';
  const objective = firstLine(card.objective, 180);
  const review = card.assignmentState === 'awaiting_review' || card.assignmentState === 'gated';
  const stateLabel: Record<AssignmentBoardCard['assignmentState'], string> = {
    gated: 'Approval needed',
    queued: 'Ready to start',
    running: 'Working',
    awaiting_review: 'Weaver is reviewing',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return (
    <Card className="bg-zinc-950">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={variant}>{stateLabel[card.assignmentState]}</Badge>
          {card.kind === 'action' ? <Badge variant="warning">External action</Badge> : null}
          {card.adoptionState === 'accepted' ? <Badge variant="success">Accepted work</Badge> : null}
          {card.adoptionState === 'proposed' ? <Badge variant="outline">Proposed result</Badge> : null}
          {card.adoptionState === 'rejected' ? <Badge variant="attention">Result rejected</Badge> : null}
          {card.adoptionState === 'superseded' ? <Badge variant="outline">Result replaced</Badge> : null}
        </div>
        <CardTitle className="text-sm">{objective}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {objective !== card.objective ? (
          <details className="text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">Full objective</summary>
            <p className="mt-2 whitespace-pre-wrap border-l border-zinc-800 pl-3 leading-5 text-zinc-400">{displayText(card.objective)}</p>
          </details>
        ) : null}
        {card.acceptanceCriteria.length ? (
          review ? (
            <div>
              <p className="mb-1 font-medium text-zinc-400">Done when</p>
              <ul className="space-y-1 text-zinc-400">
                {card.acceptanceCriteria.slice(0, 3).map((criterion) => <li key={criterion}>· {firstLine(criterion, 140)}</li>)}
              </ul>
              {card.acceptanceCriteria.length > 3 ? (
                <details className="mt-1 text-zinc-500">
                  <summary className="cursor-pointer">{card.acceptanceCriteria.length - 3} more</summary>
                  <ul className="mt-1 space-y-1 border-l border-zinc-800 pl-3 text-zinc-400">
                    {card.acceptanceCriteria.slice(3).map((criterion) => <li key={criterion}>· {displayText(criterion)}</li>)}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : (
            <details className="text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-300">Done when · {card.acceptanceCriteria.length}</summary>
              <ul className="mt-2 space-y-1 border-l border-zinc-800 pl-3 text-zinc-400">
                {card.acceptanceCriteria.map((criterion) => <li key={criterion}>· {displayText(criterion)}</li>)}
              </ul>
            </details>
          )
        ) : null}
        {card.submission ? (
          <details open={review} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5 text-zinc-300">
            <summary className="cursor-pointer text-zinc-400">Worker result</summary>
            <p className="mt-2 whitespace-pre-wrap leading-5">{displayText(card.submission.summary)}</p>
          </details>
        ) : null}
        {card.adoption.passId || card.adoption.reason || card.adoption.at || card.adoption.actor ? (
          <details className="text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">Why this result was {card.adoption.state === 'accepted' ? 'accepted' : card.adoption.state}</summary>
            <div className="mt-2 space-y-1 border-l border-zinc-800 pl-3">
              {card.adoption.reason ? <p className="whitespace-pre-wrap leading-5 text-zinc-400">{displayText(card.adoption.reason)}</p> : null}
              {card.adoption.actor ? <p>{card.adoption.actor}</p> : null}
              {card.adoption.at ? <p>{card.adoption.at}</p> : null}
            </div>
          </details>
        ) : null}
        {card.dependencies.length ? (
          <p className="text-zinc-500">
            Depends on {card.dependencies.map((dependency) => (
              <span key={dependency.id} className={cn('ml-1', dependency.accepted ? 'text-emerald-400' : 'text-amber-400')}>
                {firstLine(dependency.objective ?? 'an earlier assignment', 100)}
              </span>
            ))}
          </p>
        ) : null}
        {card.executionRequirements ? (
          <p className="text-zinc-500">
            Route requirements · {card.executionRequirements.profile} · {card.executionRequirements.modalities.join(' + ')}
          </p>
        ) : null}
        {card.action ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {card.action.awaitingApproval ? <Badge variant="attention">Approval needed</Badge> : null}
              {card.action.approved ? <Badge variant="success">Approved by {card.action.approvalBy}</Badge> : null}
              <Badge variant={card.action.readback === 'confirmed' ? 'success' : card.action.readback === 'failed' ? 'attention' : 'outline'}>
                Readback {card.action.readback}
              </Badge>
            </div>
            <details className="text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-300">Action details</summary>
              <div className="mt-2 space-y-2 border-l border-zinc-800 pl-3">
                {card.action.ask ? <p><span className="font-medium text-zinc-400">Ask</span><br />{displayText(card.action.ask)}</p> : null}
                {card.action.run ? <p><span className="font-medium text-zinc-400">Run</span><br /><span className="font-mono text-[11px]">{card.action.run}</span></p> : null}
                <p><span className="font-medium text-zinc-400">Preflight</span><br />{card.action.preflightMode === 'always-execute' ? 'Always execute — this run’s fresh output is the result; verify runs afterwards' : 'Postcondition — skip execution when verify already passes'}</p>
                <p><span className="font-medium text-zinc-400">Verify</span><br /><span className="font-mono text-[11px]">{card.action.verify}</span></p>
                {card.action.readbackOutput ? <p><span className="font-medium text-zinc-400">Readback</span><br /><span className="whitespace-pre-wrap font-mono text-[11px]">{card.action.readbackOutput}</span></p> : null}
                {card.action.rejection ? <p className="text-rose-300">Rejected by {card.action.rejection.actor} · {card.action.rejection.reason}<br /><span className="text-zinc-600">{card.action.rejection.at}</span></p> : null}
              </div>
            </details>
          </div>
        ) : null}
        {card.attempts.length ? (
          <details className="text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">Execution · {card.attemptCount} attempt{card.attemptCount === 1 ? '' : 's'}</summary>
            <div className="mt-2 border-l border-zinc-800 pl-3 font-mono text-[11px]">
              {[...card.attempts].reverse().map((attempt) => (
                <article key={attempt.runId} className="space-y-1 border-t border-zinc-800 py-2 first:border-t-0 first:pt-0">
                  <p>Attempt {card.attempts.indexOf(attempt) + 1}</p>
                  <p>{attempt.executor && attempt.provider
                    ? `${attempt.executor} / ${attempt.provider} / ${attempt.model ?? 'model unknown'}`
                    : (attempt.model ?? 'model unknown')}</p>
                  <p>{attempt.terminalReason ?? (attempt.endedAt ? 'ended' : 'in flight')}</p>
                  <time dateTime={attempt.startedAt}>{formatTimestamp(attempt.startedAt)}</time>
                </article>
              ))}
            </div>
          </details>
        ) : null}
        <details className="text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300">Technical details</summary>
          <div className="mt-2 space-y-1 border-l border-zinc-800 pl-3 font-mono text-[11px]">
            <p>{card.id}</p>
            {card.adoption.passId ? <p>{card.adoption.passId}</p> : null}
            {card.attempts.map((attempt) => <p key={attempt.runId}>{attempt.runId}</p>)}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

const assignmentLaneMeta: Record<AssignmentBoardLane, { title: string; empty: string }> = {
  planned: { title: 'Planned', empty: 'Nothing queued' },
  working: { title: 'Working', empty: 'No worker in flight' },
  review: { title: 'Review', empty: 'Nothing awaiting a decision' },
  accepted: { title: 'Accepted', empty: 'No accepted work yet' },
};

function AssignmentBoard({ view }: { view: WorkstreamPageView }) {
  return (
    <section id="work" className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">Assignments</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Work</h2>
        </div>
        <span className="text-xs text-zinc-600">Runs are inside cards</span>
      </div>
      <div className="grid grid-cols-[repeat(4,minmax(17rem,1fr))] items-start gap-3 overflow-x-auto pb-4 lg:grid-cols-4">
        {(Object.keys(assignmentLaneMeta) as AssignmentBoardLane[]).map((lane) => {
          const all = view.assignments.lanes[lane];
          const shown = all.slice(0, lane === 'accepted' ? 5 : all.length);
          return (
            <section key={lane} className="min-w-[17rem] rounded-2xl border border-zinc-900 bg-zinc-900/25 p-2.5 sm:min-w-0">
              <header className="mb-2 flex items-center justify-between px-1 py-1.5">
                <h3 className="text-sm font-medium text-zinc-300">{assignmentLaneMeta[lane].title}</h3>
                <span className="text-xs text-zinc-600">{all.length}</span>
              </header>
              <div className="space-y-2.5">
                {shown.length ? shown.map((card) => <AssignmentCard key={card.id} card={card} />) : (
                  <p className="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-center text-xs text-zinc-600">
                    {assignmentLaneMeta[lane].empty}
                  </p>
                )}
                {all.length > shown.length ? (
                  <details className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-500">
                    <summary className="cursor-pointer">{all.length - shown.length} older accepted</summary>
                    <div className="mt-3 space-y-2.5">
                      {all.slice(shown.length).map((card) => <AssignmentCard key={card.id} card={card} />)}
                    </div>
                  </details>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      {view.assignments.archive.total ? (
        <details className="mt-3 rounded-xl border border-zinc-900 bg-zinc-900/20">
          <summary className="cursor-pointer px-4 py-3 text-sm text-zinc-500">
            Assignment archive <span className="ml-1 text-zinc-700">{view.assignments.archive.total}</span>
          </summary>
          <div className="grid gap-3 border-t border-zinc-900 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {view.assignments.archive.cards.map((card) => <AssignmentCard key={card.id} card={card} />)}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Direction({ view }: { view: WorkstreamPageView }) {
  const statusLabel = {
    waiting: 'Waiting for Weaver',
    read: 'Read by Weaver',
    withdrawn: 'Withdrawn before Weaver read it',
  } as const;
  const directionSummary = view.latestDirection ? firstLine(view.latestDirection.body, 360) : undefined;
  return (
    <Card id="direction" className="bg-zinc-900/30">
      <CardHeader>
        <CardDescription className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">Current course</CardDescription>
        <CardTitle className="text-base">Direction</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {view.latestDirection ? (
          <section aria-labelledby="your-direction-title" className={cn(
            'rounded-xl border px-4 py-3',
            view.latestDirection.status === 'waiting'
              ? 'border-amber-500/30 bg-amber-500/5'
              : 'border-zinc-800 bg-zinc-950/70',
          )}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="your-direction-title" className="text-sm font-semibold text-zinc-100">Your direction</h3>
              <Badge variant={view.latestDirection.status === 'waiting' ? 'warning' : 'outline'}>
                {statusLabel[view.latestDirection.status]}
              </Badge>
            </div>
            <p className="mt-2 text-sm leading-6 text-zinc-300">{directionSummary}</p>
            {directionSummary !== view.latestDirection.body ? (
              <details className="mt-2 text-xs text-zinc-500">
                <summary className="cursor-pointer">Full direction</summary>
                <p className="mt-2 whitespace-pre-wrap border-l border-zinc-800 pl-3 text-sm leading-6 text-zinc-300">{view.latestDirection.body}</p>
              </details>
            ) : null}
            <p className="mt-2 text-xs text-zinc-400">
              {view.latestDirection.by} · <time dateTime={view.latestDirection.at} title={view.latestDirection.time}>{view.latestDirection.time} · {view.latestDirection.age} ago</time>
            </p>
          </section>
        ) : null}
        <section aria-labelledby="recorded-course-title">
          <h3 id="recorded-course-title" className="mb-2 text-sm font-medium text-zinc-400">
            {view.latestDirection?.status === 'waiting' ? 'Current recorded commitment · may be revised' : 'Current recorded commitment'}
          </h3>
          {view.course.length ? (
            <div className="space-y-3">
              {view.course.map(({ decision, time, age }) => (
                <article key={decision.id} className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
                    <Badge variant={decision.madeBy === 'human' ? 'warning' : 'accent'}>{decision.madeBy === 'human' ? 'You' : 'Weaver'}</Badge>
                    <time dateTime={decision.decidedAtVirtual} title={time}>{time} · {age} ago</time>
                  </div>
                  <h4 className="mt-2 text-sm font-medium text-zinc-100">{firstLine(decision.title, 220)}</h4>
                  <p className="mt-1 text-sm leading-6 text-zinc-400">{firstLine(decision.rationale, 260)}</p>
                  {firstLine(decision.rationale, 260) !== displayText(decision.rationale) ? (
                    <details className="mt-2 text-xs text-zinc-500">
                      <summary className="cursor-pointer">Why this course</summary>
                      <p className="mt-2 whitespace-pre-wrap border-l border-zinc-800 pl-3 leading-5 text-zinc-400">{displayText(decision.rationale)}</p>
                    </details>
                  ) : null}
                  <details className="mt-2 text-xs text-zinc-500">
                    <summary className="cursor-pointer">Technical details</summary>
                    <p className="mt-2 border-l border-zinc-800 pl-3 font-mono text-[11px]">{decision.id}</p>
                  </details>
                </article>
              ))}
            </div>
          ) : <p className="text-sm text-zinc-500">No standing direction.</p>}
        </section>
      </CardContent>
    </Card>
  );
}

function Deliverables({ deliverables }: { deliverables: Deliverable[] }) {
  const newest = deliverables.slice().reverse();
  const visible = newest.slice(0, 8);
  const older = newest.slice(8);
  const row = (deliverable: Deliverable) => (
    <article key={deliverable.id} className="flex items-start justify-between gap-4 border-t border-zinc-900 py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-200">{deliverable.title}</p>
        <details className="mt-1 text-xs text-zinc-500">
          <summary className="cursor-pointer">Technical details</summary>
          <p className="mt-1 font-mono text-[11px]">{deliverable.path} · {deliverable.contentHash.slice(0, 8)}</p>
        </details>
      </div>
      <Badge variant={deliverable.adopted ? 'success' : 'outline'}>{deliverable.adopted ? 'Accepted result' : 'Proposed result'}</Badge>
    </article>
  );
  return (
    <RecordSection id="evidence" title="Deliverables" count={deliverables.length}>
      {deliverables.length ? (
        <>
          {visible.map(row)}
          {older.length ? (
            <details className="border-t border-zinc-900 pt-3 text-xs text-zinc-500">
              <summary className="cursor-pointer">{older.length} older deliverable{older.length === 1 ? '' : 's'}</summary>
              <div className="mt-3">{older.map(row)}</div>
            </details>
          ) : null}
        </>
      ) : <Empty label="No deliverables." />}
    </RecordSection>
  );
}

function Interactions({ interactions }: { interactions: Interaction[] }) {
  return (
    <RecordSection title="Interactions" count={interactions.length}>
      {interactions.length ? interactions.slice().reverse().map((interaction) => (
        <details key={interaction.id} className="border-t border-zinc-900 py-3 first:border-t-0 first:pt-0">
          <summary className="flex cursor-pointer items-center justify-between gap-4 text-sm">
            <span className="truncate text-zinc-300">{interaction.subject}</span>
            <Badge variant={interaction.status === 'confirmed' ? 'success' : interaction.status === 'unknown' ? 'attention' : 'outline'}>{interaction.status.replace('_', ' ')}</Badge>
          </summary>
          <div className="mt-3 space-y-2 border-l border-zinc-800 pl-3 text-xs text-zinc-500">
            <p>To {interaction.to}</p>
            <p>{interaction.replies.length} repl{interaction.replies.length === 1 ? 'y' : 'ies'}</p>
            {interaction.replies.map((reply) => <p key={reply.id} className="text-zinc-400">{reply.from}: {reply.body}</p>)}
          </div>
        </details>
      )) : <Empty label="No interactions." />}
    </RecordSection>
  );
}

function Observations({ observations }: { observations: Observation[] }) {
  return (
    <RecordSection title="Observations" count={observations.length}>
      {observations.length ? observations.slice(-10).reverse().map((observation) => (
        <article key={observation.id} className="border-t border-zinc-900 py-3 first:border-t-0 first:pt-0">
          <p className="text-sm text-zinc-300">{observation.summary}</p>
          <p className="mt-1 text-xs text-zinc-600">{observation.source}{observation.evaluation ? ` · ${observation.evaluation.countsTowardObjective ? 'counts' : 'does not count'}` : ' · unevaluated'}</p>
        </article>
      )) : <Empty label="No observations." />}
    </RecordSection>
  );
}

function Policies({ policies }: { policies: PolicyRecord[] }) {
  return (
    <RecordSection title="Policies in play" count={policies.length}>
      {policies.length ? policies.map((policy) => <PolicyRow key={policy.id} policy={policy} />) : <Empty label="No policies shaped this Workstream." />}
    </RecordSection>
  );
}

function DirectionHistory({ view }: { view: WorkstreamPageView }) {
  const statusLabel = {
    waiting: 'Waiting for Weaver',
    read: 'Read by Weaver',
    withdrawn: 'Withdrawn before Weaver read it',
  } as const;
  return (
    <RecordSection title="Your direction history" count={view.directionHistory.length}>
      {view.directionHistory.length ? view.directionHistory.map((direction) => (
        <article key={`${direction.at}-${direction.body}`} className="border-t border-zinc-900 py-3 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge variant={direction.status === 'waiting' ? 'warning' : 'outline'}>{statusLabel[direction.status]}</Badge>
            <time dateTime={direction.at} title={direction.time} className="text-xs text-zinc-400">{direction.time} · {direction.age} ago</time>
          </div>
          <p className={cn('mt-2 text-sm leading-6', direction.status === 'withdrawn' ? 'text-zinc-500 line-through' : 'text-zinc-300')}>{direction.body}</p>
          <p className="mt-1 text-xs text-zinc-400">{direction.by}</p>
        </article>
      )) : <Empty label="No human direction recorded." />}
    </RecordSection>
  );
}

function EventHistory({ events }: { events: EventRecord[] }) {
  const humanKinds = /^(send\.(approved|rejected)|action\.(approved|rejected)|assignment\.(adopted|rejected)|attention\.resolved|priority\.)/;
  const human = events.filter((event) => humanKinds.test(event.type)).slice(-20).reverse();
  return (
    <RecordSection title="Human activity" count={human.length}>
      {human.length ? human.map((event, index) => (
        <article key={`${event.at}-${index}`} className="border-t border-zinc-900 py-3 first:border-t-0 first:pt-0">
          <p className="text-sm text-zinc-300">{firstLine(event.summary, 220)}</p>
          <p className="mt-1 text-xs text-zinc-400">{event.type.replaceAll('.', ' ')}</p>
          {firstLine(event.summary, 220) !== event.summary ? (
            <details className="mt-2 text-xs text-zinc-500"><summary className="cursor-pointer">Full record</summary><p className="mt-2 whitespace-pre-wrap border-l border-zinc-800 pl-3 leading-5 text-zinc-400">{event.summary}</p></details>
          ) : null}
        </article>
      )) : <Empty label="No recent human activity." />}
    </RecordSection>
  );
}

function DecisionHistory({ decisions }: { decisions: Decision[] }) {
  const history = [...decisions].sort((a, b) => b.decidedAtVirtual.localeCompare(a.decidedAtVirtual));
  const visible = history.slice(0, 10);
  const older = history.slice(10);
  const row = (decision: Decision) => (
    <details key={decision.id} className="border-t border-zinc-900 py-3 first:border-t-0 first:pt-0">
      <summary className="flex cursor-pointer items-center gap-2 text-sm">
        <Badge variant={decision.status === 'standing' ? 'accent' : 'outline'}>{decision.status}</Badge>
        <span className="min-w-0 flex-1 truncate text-zinc-300">{decision.title}</span>
        <time dateTime={decision.decidedAtVirtual} title={formatTimestamp(decision.decidedAtVirtual)} className="text-xs text-zinc-400">{formatTimestamp(decision.decidedAtVirtual)}</time>
      </summary>
      <div className="mt-3 space-y-2 border-l border-zinc-800 pl-3 text-sm leading-6 text-zinc-400">
        <p>{displayText(decision.rationale)}</p>
        {decision.supersedes ? <p className="text-xs text-zinc-500">Replaced an earlier course.</p> : null}
        {decision.supersededBy ? <p className="text-xs text-zinc-500">Replaced by a later course.</p> : null}
        <details className="text-zinc-500"><summary className="cursor-pointer">Technical details</summary><p className="mt-1 font-mono text-[11px]">{decision.id}</p></details>
      </div>
    </details>
  );
  return (
    <RecordSection id="history" title="Decision history" count={history.length}>
      {history.length ? (
        <>
          {visible.map(row)}
          {older.length ? (
            <details className="border-t border-zinc-900 pt-3 text-xs text-zinc-500">
              <summary className="cursor-pointer">{older.length} older decision{older.length === 1 ? '' : 's'}</summary>
              <div className="mt-3">{older.map(row)}</div>
            </details>
          ) : null}
        </>
      ) : <Empty label="No decisions." />}
    </RecordSection>
  );
}

export function WorkstreamPage({ view, totalPolicyCount }: { view: WorkstreamPageView; totalPolicyCount: number }) {
  const { doc } = view;
  const ws = doc.workstream;
  const objective = firstLine(ws.objective, 320);
  const positionTitle = view.needs.length
    ? 'Needs you'
    : view.position.state.charAt(0).toUpperCase() + view.position.state.slice(1);
  return (
    <Shell
      title={ws.title}
      subtitle={`${ws.status === 'active' ? 'Open' : ws.status === 'done' ? 'Done' : 'Paused'}${ws.managedBy ? ` · coordinated by ${ws.managedBy.slug}` : ''}${view.managed.length ? ` · coordinates ${view.managed.length} related Workstream${view.managed.length === 1 ? '' : 's'}` : ''} · snapshot r${doc.revision} generated ${formatTimestamp(view.generatedAt)}`}
      nav={[
        { href: '../inspect.html', label: '← Work' },
        { href: '#direction', label: 'Direction', count: doc.decisions.filter((decision) => decision.status === 'standing').length },
        { href: '#work', label: 'Work', count: doc.assignments.length },
        { href: '#evidence', label: 'Evidence', count: doc.deliverables.length },
        { href: '#history', label: 'History', count: doc.decisions.length },
        { href: '../learned.html', label: 'Learned', count: totalPolicyCount },
        { href: `../printouts/index.html#${encodeURIComponent(ws.slug)}`, label: 'Catch up' },
      ]}
    >
      <section className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <Card className="bg-zinc-900/30">
          <CardHeader>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={ws.status === 'done' ? 'success' : ws.status === 'paused' ? 'warning' : 'accent'}>{ws.status === 'active' ? 'Open' : ws.status === 'done' ? 'Done' : 'Paused'}</Badge>
              {ws.tags.includes('routine') ? <Badge variant="outline">Routine</Badge> : null}
              {ws.priority && ws.priority !== 'normal' ? <Badge variant="warning">{ws.priority}</Badge> : null}
            </div>
            <CardTitle className="text-lg leading-7">{objective}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            {objective !== ws.objective ? (
              <details className="sm:col-span-2 text-sm text-zinc-500">
                <summary className="cursor-pointer hover:text-zinc-300">Full intent</summary>
                <p className="mt-3 whitespace-pre-wrap border-l border-zinc-800 pl-4 leading-6 text-zinc-400">{ws.objective}</p>
              </details>
            ) : null}
            {ws.successCriteria.length ? (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-zinc-600">Done when</p>
                <ul className="space-y-1.5 text-sm leading-5 text-zinc-400">
                  {ws.successCriteria.slice(0, 3).map((criterion) => <li key={criterion}>· {firstLine(criterion, 180)}</li>)}
                </ul>
                {(ws.successCriteria.length > 3 || ws.successCriteria.some((criterion) => firstLine(criterion, 180) !== criterion)) ? (
                  <details className="mt-2 text-xs text-zinc-500"><summary className="cursor-pointer">All criteria</summary><ul className="mt-2 space-y-1 border-l border-zinc-800 pl-3 text-zinc-400">{ws.successCriteria.map((criterion) => <li key={criterion}>· {criterion}</li>)}</ul></details>
                ) : null}
              </div>
            ) : null}
            {ws.constraints.length ? (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-zinc-600">Constraints</p>
                <ul className="space-y-1.5 text-sm leading-5 text-zinc-400">
                  {ws.constraints.slice(0, 3).map((constraint) => <li key={constraint}>· {firstLine(constraint, 180)}</li>)}
                </ul>
                {(ws.constraints.length > 3 || ws.constraints.some((constraint) => firstLine(constraint, 180) !== constraint)) ? (
                  <details className="mt-2 text-xs text-zinc-500"><summary className="cursor-pointer">All constraints</summary><ul className="mt-2 space-y-1 border-l border-zinc-800 pl-3 text-zinc-400">{ws.constraints.map((constraint) => <li key={constraint}>· {constraint}</li>)}</ul></details>
                ) : null}
              </div>
            ) : null}
          </CardContent>
          {ws.conclusion ? (
            <CardFooter className="block border-emerald-500/20 bg-emerald-500/5">
              <p className="text-xs font-medium text-emerald-400">Outcome</p>
              <p className="mt-1 text-sm leading-6 text-zinc-300">{ws.conclusion.summary}</p>
              <p className="mt-1 text-xs text-zinc-400">{ws.conclusion.evidenceIds.length} supporting evidence record{ws.conclusion.evidenceIds.length === 1 ? '' : 's'}</p>
            </CardFooter>
          ) : null}
        </Card>
        <Card className={cn('bg-zinc-900/30', view.needs.length > 0 && 'border-rose-500/30')}>
          <CardHeader>
            <CardDescription className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">Position</CardDescription>
            <CardTitle className="text-base">{positionTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {view.needs.length ? view.needs.map((need, index) => (
              <div key={`${need.kind}-${index}`} className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
                <Badge variant="attention">{need.kind}</Badge>
                <p className="mt-2 text-sm leading-5 text-zinc-200">{firstLine(need.summary, 320)}</p>
                {firstLine(need.summary, 320) !== need.summary ? (
                  <details className="mt-2 text-xs text-zinc-400"><summary className="cursor-pointer">Full context</summary><p className="mt-2 whitespace-pre-wrap leading-5">{need.summary}</p></details>
                ) : null}
              </div>
            )) : (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-600">
                  {view.position.lane === 'waiting' ? 'Waiting for' : 'Next'}
                </p>
                <p className="mt-1 text-sm leading-5 text-zinc-200">{view.position.next}</p>
              </div>
            )}
            {view.integrityWarnings.map((warning) => (
              <div key={warning} className="text-xs text-rose-300">
                <p>{firstLine(warning, 220)}</p>
                <details className="mt-1 text-zinc-500"><summary className="cursor-pointer">Technical details</summary><p className="mt-1 font-mono text-[11px]">{warning}</p></details>
              </div>
            ))}
            {view.managed.length ? (
              <div className="border-t border-zinc-800 pt-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Related Workstreams</p>
                <div className="flex flex-wrap gap-1.5">
                  {view.managed.map((child) => (
                    <a key={child.slug} href={`../${child.slug}/inspect.html`} className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200">
                      {child.slug}<span className="text-zinc-600">{child.status}</span>
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>
      <div className="mt-3">
        <Direction view={view} />
      </div>
      <AssignmentBoard view={view} />
      <section className="mt-8">
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">Record</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Evidence and history</h2>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Deliverables deliverables={doc.deliverables} />
          <Interactions interactions={doc.interactions} />
          <Observations observations={doc.observations} />
          <Policies policies={view.policies} />
          <DirectionHistory view={view} />
          <DecisionHistory decisions={doc.decisions} />
          <EventHistory events={doc.events} />
        </div>
      </section>
    </Shell>
  );
}
