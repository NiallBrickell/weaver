import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '../components/index.js';
import type { FleetBoardView, WorkstreamCardView, WorkstreamLane } from './model.js';
import { Shell } from './shared.js';

const laneMeta: Record<WorkstreamLane, { label: string; empty: string; accent: string }> = {
  'needs-you': { label: 'Needs you', empty: 'Nothing needs you', accent: 'bg-rose-400' },
  moving: { label: 'In motion', empty: 'No work in motion', accent: 'bg-violet-400' },
  waiting: { label: 'Waiting', empty: 'No scheduled waits', accent: 'bg-amber-400' },
  ready: { label: 'Ready', empty: 'No ready work', accent: 'bg-zinc-500' },
};

function stateVariant(lane: WorkstreamLane): 'attention' | 'accent' | 'warning' | 'outline' {
  if (lane === 'needs-you') return 'attention';
  if (lane === 'moving') return 'accent';
  if (lane === 'waiting') return 'warning';
  return 'outline';
}

function WorkstreamCard({ card }: { card: WorkstreamCardView }) {
  const routine = card.tags.includes('routine');
  const showDirection = card.direction && (card.direction.recent || card.direction.status === 'waiting');
  const showActivity = card.latestFact
    && card.latestFact.summary !== card.next
    && card.latestFact.summary !== card.course?.summary
    && !showDirection;
  return (
    <Card
      data-workstream-card=""
      data-search={`${card.title} ${card.slug} ${card.objective} ${card.tags.join(' ')}`.toLowerCase()}
      data-recent={card.latestFact?.recent || card.direction?.recent ? 'true' : 'false'}
      data-routine={routine ? 'true' : 'false'}
      className={cn(
        'group relative overflow-hidden bg-zinc-950 transition hover:-translate-y-0.5 hover:border-zinc-700 hover:shadow-lg hover:shadow-black/20',
        card.lane === 'needs-you' && 'border-rose-500/30',
      )}
    >
      <CardHeader className="pb-3">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge variant={stateVariant(card.lane)}>{card.state}</Badge>
          {card.needCount > 1 ? <Badge variant="attention">{card.needCount} needs</Badge> : null}
          {routine ? <Badge variant="outline">Routine</Badge> : null}
          {card.priority && card.priority !== 'normal' ? <Badge variant="warning">{card.priority}</Badge> : null}
          {card.integrityWarnings.length ? <Badge variant="attention">State problem</Badge> : null}
        </div>
        <CardTitle className="text-[15px]">
          <a href={`${card.slug}/inspect.html`} className="rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950">
            {card.title}
          </a>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="flex items-center justify-between gap-3 text-xs font-medium text-zinc-400">
            <span>Now</span>
            {card.nowAge ? <span>{card.nowAge} ago</span> : null}
          </p>
          <p className="mt-1 line-clamp-3 text-sm leading-5 text-zinc-200">{card.next}</p>
        </div>
        {showDirection ? (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
            <p className="flex items-center justify-between gap-3 text-xs text-amber-200">
              <span>{card.direction!.status === 'waiting' ? 'New direction from you' : 'You changed direction'}</span>
              <time dateTime={card.direction!.at} title={card.direction!.time}>{card.direction!.age} ago</time>
            </p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-300">{card.direction!.body}</p>
          </div>
        ) : null}
        {card.course ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
            <p className="flex items-center justify-between gap-3 text-xs text-zinc-400">
              <span>Course</span>
              <span>{card.course.age} ago</span>
            </p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-300">{card.course.summary}</p>
          </div>
        ) : null}
        {showActivity ? (
          <div className="rounded-lg border border-zinc-900 bg-zinc-900/40 px-3 py-2.5">
            <p className="flex items-center justify-between gap-3 text-xs text-zinc-400">
              <span>{card.latestFact!.label}</span>
              <span>{card.latestFact!.age} ago</span>
            </p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-300">{card.latestFact!.summary}</p>
          </div>
        ) : null}
        {card.managedBy || card.manages.length ? (
          <p className="text-xs text-zinc-400">
            {card.managedBy ? <>Coordinated by <span className="text-zinc-200">{card.managedBy}</span></> : null}
            {card.managedBy && card.manages.length ? ' · ' : null}
            {card.manages.length ? <><span className="text-zinc-200">{card.manages.length}</span> related Workstream{card.manages.length === 1 ? '' : 's'}</> : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FleetLane({ id, cards }: { id: WorkstreamLane; cards: WorkstreamCardView[] }) {
  const meta = laneMeta[id];
  const visibleLimit = id === 'needs-you' || id === 'moving' ? 12 : 8;
  const shown = cards.slice(0, visibleLimit);
  const folded = cards.slice(visibleLimit);
  return (
    <section className="min-w-[17rem] rounded-2xl border border-zinc-900 bg-zinc-900/25 p-2.5 sm:min-w-0">
      <header className="mb-2 flex items-center justify-between gap-3 px-1 py-1.5">
        <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <span className={cn('h-2 w-2 rounded-full', meta.accent)} />
          {meta.label}
        </h2>
        <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-xs text-zinc-500">{cards.length}</span>
      </header>
      <div className="space-y-2.5">
        {shown.length ? shown.map((card) => <WorkstreamCard key={card.slug} card={card} />) : (
          <p className="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-center text-xs text-zinc-600">
            {meta.empty}
          </p>
        )}
        {folded.length ? (
          <details data-fleet-overflow="" className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-2.5 py-2">
            <summary className="cursor-pointer px-1 text-xs text-zinc-500">{folded.length} more</summary>
            <div className="mt-2 space-y-2.5">
              {folded.map((card) => <WorkstreamCard key={card.slug} card={card} />)}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

const FLEET_SCRIPT = `
(() => {
  const input = document.querySelector('[data-board-search]');
  const resultStatus = document.querySelector('[data-board-results]');
  const buttons = [...document.querySelectorAll('[data-board-filter]')];
  const cards = [...document.querySelectorAll('[data-workstream-card]')];
  let filter = 'all';
  const apply = () => {
    const query = (input?.value || '').trim().toLowerCase();
    const filtering = Boolean(query) || filter !== 'all';
    let visible = 0;
    for (const card of cards) {
      const matchesText = !query || (card.dataset.search || '').includes(query);
      const matchesFilter = filter === 'all' || card.dataset[filter] === 'true';
      card.hidden = !(matchesText && matchesFilter);
      if (!card.hidden) visible += 1;
    }
    if (resultStatus) resultStatus.textContent = visible + ' Workstream' + (visible === 1 ? '' : 's') + ' shown';
    for (const overflow of document.querySelectorAll('[data-fleet-overflow]')) {
      if (filtering) overflow.open = Boolean(overflow.querySelector('[data-workstream-card]:not([hidden])'));
    }
  };
  input?.addEventListener('input', apply);
  for (const button of buttons) button.addEventListener('click', () => {
    filter = button.dataset.boardFilter || 'all';
    for (const candidate of buttons) {
      const selected = candidate === button;
      candidate.setAttribute('aria-pressed', String(selected));
      candidate.classList.toggle('bg-zinc-800', selected);
      candidate.classList.toggle('text-zinc-100', selected);
    }
    apply();
  });
})();`;

export function FleetPage({ view }: { view: FleetBoardView }) {
  const live = Object.values(view.lanes).flat().length;
  const moving = view.lanes.moving.length;
  const waiting = view.lanes.waiting.length;
  const recent = Object.values(view.lanes).flat().filter((card) => card.latestFact?.recent || card.direction?.recent).length;
  const routines = Object.values(view.lanes).flat().filter((card) => card.tags.includes('routine')).length;
  const stats = [
    ['Needs you', view.lanes['needs-you'].length, 'text-rose-300'],
    ['In motion', moving, 'text-violet-300'],
    ['Waiting', waiting, 'text-amber-300'],
    ['Done', view.done.length, 'text-emerald-300'],
  ] as const;
  return (
    <Shell
      title="Work"
      subtitle={`${live} live Workstream${live === 1 ? '' : 's'} · durable outcomes, current position, and the next consequential move`}
      nav={[
        { href: 'inspect.html', label: 'Work', count: live },
        { href: 'learned.html', label: 'Learned', count: view.policyCount },
        { href: 'printouts/index.html', label: 'Catch up' },
      ]}
    >
      <section aria-label="Fleet position" className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map(([label, count, color]) => (
          <div key={label} className="rounded-xl border border-zinc-900 bg-zinc-900/30 px-4 py-3">
            <p className="text-xs text-zinc-500">{label}</p>
            <p className={cn('mt-1 text-2xl font-semibold tabular-nums', color)}>{count}</p>
          </div>
        ))}
      </section>
      {view.unreadable.length ? (
        <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-200">
          Unreadable: {view.unreadable.join(', ')}
        </div>
      ) : null}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <input
          data-board-search=""
          type="search"
          aria-label="Find a Workstream"
          placeholder="Find a Workstream"
          className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500/60 sm:max-w-sm"
        />
        <div className="flex gap-1 overflow-x-auto" role="group" aria-label="Filter Workstreams">
          {[
            ['all', `All ${live}`],
            ['recent', `Moved 24h ${recent}`],
            ['routine', `Routines ${routines}`],
          ].map(([id, label], index) => (
            <button
              key={id}
              type="button"
              data-board-filter={id}
              aria-pressed={index === 0 ? 'true' : 'false'}
              className={cn(
                'shrink-0 rounded-lg px-3 py-2 text-xs text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200',
                index === 0 && 'bg-zinc-800 text-zinc-100',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p data-board-results="" aria-live="polite" className="sr-only">{live} Workstreams shown</p>
      <div className="grid grid-cols-[repeat(4,minmax(17rem,1fr))] items-start gap-3 overflow-x-auto pb-4 lg:grid-cols-4">
        {(Object.keys(laneMeta) as WorkstreamLane[]).map((lane) => (
          <FleetLane key={lane} id={lane} cards={view.lanes[lane]} />
        ))}
      </div>
      {view.done.length ? (
        <details className="mt-6 rounded-xl border border-zinc-900 bg-zinc-900/20">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-400">
            Done <span className="ml-1 text-zinc-600">{view.done.length}</span>
          </summary>
          <div className="divide-y divide-zinc-900 border-t border-zinc-900">
            {view.done.map((item) => (
              <a key={item.slug} href={`${item.slug}/inspect.html`} className="grid gap-1 px-4 py-3 hover:bg-zinc-900/50 sm:grid-cols-[minmax(12rem,1fr)_2fr_auto] sm:gap-4">
                <span className="text-sm font-medium text-zinc-200">{item.title}</span>
                <span className="truncate text-sm text-zinc-500">{item.outcome}</span>
                <span className="text-xs text-zinc-400">{item.adoptedDeliverableCount} accepted result{item.adoptedDeliverableCount === 1 ? '' : 's'}</span>
              </a>
            ))}
          </div>
        </details>
      ) : null}
      <script dangerouslySetInnerHTML={{ __html: FLEET_SCRIPT }} />
    </Shell>
  );
}
