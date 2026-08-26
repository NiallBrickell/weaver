import * as fs from 'node:fs';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AssignmentBoardCard, AssignmentBoardLane } from '../../assignmentBoard.js';
import type {
  AttentionItem,
  Deliverable,
  Interaction,
  Observation,
  Steering,
  Wake,
} from '../../types.js';
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '../components/index.js';
import {
  displayText,
  firstLine,
  formatTimestamp,
  type FleetBoardView,
  type WorkstreamCardView,
  type WorkstreamPageView,
} from '../inspect/model.js';

const CSS = fs.readFileSync(new URL('../inspect/tailwind.generated.css', import.meta.url), 'utf8');

export interface OperatorFleetView {
  board: FleetBoardView;
  groups: Array<{ label: string; cards: WorkstreamCardView[] }>;
  health: {
    tone: 'healthy' | 'warning' | 'critical';
    headline: string;
    detail: string;
  };
  /** Active Workstreams selectable as a parent at intake — the human
   * composition surface over the same create-under-parent primitive. */
  intakeParents: Array<{ slug: string; title: string }>;
  revision: string;
}

export interface OperatorBaseRenderProps {
  fleet: OperatorFleetView;
  actor: string;
  notice?: string;
}

export interface OperatorBoardRenderProps extends OperatorBaseRenderProps {}

export interface OperatorNewRenderProps extends OperatorBaseRenderProps {
  requestId: string;
}

export interface OperatorWorkspaceRenderProps extends OperatorBaseRenderProps {
  view: WorkstreamPageView;
}

interface TypedFact {
  key: string;
  at: string;
  label: string;
  summary: string;
  detail?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'attention';
}

const OPERATOR_SCRIPT = `
(() => {
  const root = document.querySelector('[data-operator-root]');
  let pollInFlight = false;
  const poll = async () => {
    if (!root || pollInFlight || document.hidden) {
      window.setTimeout(poll, 4000);
      return;
    }
    pollInFlight = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(root.dataset.revisionEndpoint, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json();
        const focused = document.activeElement;
        const editing = focused && focused.matches('input, textarea, select');
        if (typeof body.revision === 'string' && body.revision !== root.dataset.revision && !editing) {
          window.location.reload();
          return;
        }
      }
    } catch (_) {
      // The next bounded read repairs a transient missed poll.
    } finally {
      window.clearTimeout(timeout);
      pollInFlight = false;
    }
    window.setTimeout(poll, 4000);
  };
  window.setTimeout(poll, 4000);

  const panel = document.querySelector('[data-inspector-panel]');
  const handle = document.querySelector('[data-inspector-resize]');
  const dragShield = document.querySelector('[data-inspector-drag-shield]');
  const widthKey = 'weaver-operator-inspector-width';
  const clamp = (value) => Math.max(280, Math.min(640, value));
  let startX = 0;
  let startWidth = 360;
  let dragging = false;
  if (panel) {
    try {
      const stored = Number(window.localStorage.getItem(widthKey));
      if (Number.isFinite(stored) && stored > 0) {
        panel.style.setProperty('--operator-inspector-width', clamp(stored) + 'px');
      }
    } catch (_) {
      // Persistence is best effort; resizing still works for this page.
    }
  }
  handle?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = panel.getBoundingClientRect().width;
    dragging = true;
    dragShield?.classList.remove('hidden');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('pointermove', (event) => {
    if (!dragging || !panel) return;
    panel.style.setProperty('--operator-inspector-width', clamp(startWidth + startX - event.clientX) + 'px');
  });
  const stopDragging = () => {
    if (!dragging || !panel) return;
    dragging = false;
    const width = clamp(panel.getBoundingClientRect().width);
    try {
      window.localStorage.setItem(widthKey, String(width));
    } catch (_) {
      // Persistence is best effort; keep the in-memory width.
    }
    dragShield?.classList.add('hidden');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  window.addEventListener('pointerup', stopDragging);
  window.addEventListener('pointercancel', stopDragging);

  const mobileToggle = document.querySelector('[data-inspector-toggle]');
  const mobileClose = document.querySelector('[data-inspector-close]');
  const backdrop = document.querySelector('[data-inspector-backdrop]');
  const setMobileInspector = (open) => {
    if (!panel || !mobileToggle || !backdrop) return;
    panel.classList.toggle('hidden', !open);
    backdrop.classList.toggle('hidden', !open);
    mobileToggle.setAttribute('aria-expanded', String(open));
  };
  mobileToggle?.addEventListener('click', () => setMobileInspector(mobileToggle.getAttribute('aria-expanded') !== 'true'));
  mobileClose?.addEventListener('click', () => setMobileInspector(false));
  backdrop?.addEventListener('click', () => setMobileInspector(false));
})();`;

function documentHtml(node: ReactNode): string {
  return `<!doctype html>${renderToStaticMarkup(node)}`;
}

function laneDot(card: WorkstreamCardView): string {
  if (card.lane === 'needs-you') return 'bg-rose-400';
  if (card.lane === 'moving') return 'bg-violet-400';
  if (card.lane === 'waiting') return 'bg-amber-400';
  return 'bg-zinc-500';
}

function stateVariant(card: WorkstreamCardView): 'attention' | 'accent' | 'warning' | 'outline' {
  if (card.lane === 'needs-you') return 'attention';
  if (card.lane === 'moving') return 'accent';
  if (card.lane === 'waiting') return 'warning';
  return 'outline';
}

function WorkstreamSidebar({
  fleet,
  actor,
  currentSlug,
}: {
  fleet: OperatorFleetView;
  actor: string;
  currentSlug?: string;
}) {
  return (
    <aside
      data-testid="workstream-sidebar"
      className="z-20 flex max-h-[44vh] min-h-0 flex-col border-b border-zinc-800 bg-zinc-950 lg:sticky lg:top-0 lg:h-screen lg:max-h-none lg:border-b-0 lg:border-r"
    >
      <div className="flex items-center justify-between border-b border-zinc-900 px-4 py-4">
        <a href="/" className="text-sm font-semibold tracking-tight text-white">Weaver</a>
        <span className="max-w-32 truncate text-xs text-zinc-500" title={actor}>{actor}</span>
      </div>
      <nav aria-label="Operator" className="grid grid-cols-2 gap-2 border-b border-zinc-900 p-3">
        <a
          data-testid="overview-link"
          href="/"
          className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-center text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-white"
        >
          Overview
        </a>
        <a
          data-testid="new-work-link"
          href="/new"
          className="rounded-lg bg-violet-500 px-3 py-2 text-center text-xs font-semibold text-white transition hover:bg-violet-400"
        >
          New work
        </a>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {fleet.groups.map((group, groupIndex) => (
          <section
            key={`${group.label}-${groupIndex}`}
            data-testid="workstream-sidebar-group"
            data-group-label={group.label}
            className="mb-4 last:mb-0"
          >
            <header className="mb-1 flex items-center justify-between px-2 py-1">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">{group.label}</h2>
              <span className="text-[11px] tabular-nums text-zinc-600">{group.cards.length}</span>
            </header>
            <div className="space-y-1">
              {group.cards.length ? group.cards.map((card) => {
                const selected = card.slug === currentSlug;
                return (
                  <a
                    key={card.slug}
                    data-testid={`workstream-sidebar-item-${card.slug}`}
                    href={`/workstreams/${encodeURIComponent(card.slug)}`}
                    aria-current={selected ? 'page' : undefined}
                    className={cn(
                      'group block rounded-lg border px-2.5 py-2 transition',
                      selected
                        ? 'border-violet-500/40 bg-violet-500/10'
                        : 'border-transparent hover:border-zinc-800 hover:bg-zinc-900/50',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', laneDot(card))} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">{card.title}</span>
                      {card.needCount ? <span className="shrink-0 text-[10px] text-rose-300">{card.needCount}</span> : null}
                    </div>
                    <p className="mt-1 truncate pl-3.5 text-[11px] text-zinc-500">{card.next}</p>
                  </a>
                );
              }) : (
                <p className="px-2 py-2 text-xs text-zinc-700">None</p>
              )}
            </div>
          </section>
        ))}
        <section data-testid="workstream-sidebar-done" className="mb-4 last:mb-0">
          <header className="mb-1 flex items-center justify-between px-2 py-1">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">Done</h2>
            <span className="text-[11px] tabular-nums text-zinc-600">{fleet.board.done.length}</span>
          </header>
          {fleet.board.done.length ? (
            <>
              <div className="space-y-1">
                {fleet.board.done.slice(0, 8).map((item) => (
                  <a
                    key={item.slug}
                    data-testid={`workstream-sidebar-item-${item.slug}`}
                    href={`/workstreams/${encodeURIComponent(item.slug)}`}
                    aria-current={item.slug === currentSlug ? 'page' : undefined}
                    className={cn(
                      'group block rounded-lg border px-2.5 py-2 transition',
                      item.slug === currentSlug
                        ? 'border-violet-500/40 bg-violet-500/10'
                        : 'border-transparent hover:border-zinc-800 hover:bg-zinc-900/50',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-300">{item.title}</span>
                    </div>
                    <p className="mt-1 truncate pl-3.5 text-[11px] text-zinc-600">{item.outcome}</p>
                  </a>
                ))}
              </div>
              {fleet.board.done.length > 8 ? (
                <details className="mt-1 rounded-lg border border-zinc-900 px-2 py-1.5">
                  <summary className="cursor-pointer text-[11px] text-zinc-600">{fleet.board.done.length - 8} older</summary>
                  <div className="mt-1 space-y-1">
                    {fleet.board.done.slice(8).map((item) => (
                      <a
                        key={item.slug}
                        data-testid={`workstream-sidebar-item-${item.slug}`}
                        href={`/workstreams/${encodeURIComponent(item.slug)}`}
                        className="block truncate rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300"
                      >
                        {item.title}
                      </a>
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          ) : <p className="px-2 py-2 text-xs text-zinc-700">None</p>}
        </section>
      </div>
    </aside>
  );
}

function OperatorShell({
  fleet,
  actor,
  notice,
  title,
  revisionEndpoint,
  initialRevision,
  currentSlug,
  children,
  inspector,
}: OperatorBaseRenderProps & {
  title: string;
  revisionEndpoint: string;
  initialRevision: string;
  currentSlug?: string;
  children: ReactNode;
  inspector?: ReactNode;
}) {
  return (
    <html lang="en" className="bg-zinc-950 text-zinc-100">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased lg:h-screen lg:overflow-hidden">
        <div
          data-operator-root=""
          data-testid="operator-shell"
          data-revision={initialRevision}
          data-revision-endpoint={revisionEndpoint}
          className="min-h-screen lg:grid lg:h-screen lg:grid-cols-[18rem_minmax(0,1fr)]"
        >
          <WorkstreamSidebar fleet={fleet} actor={actor} currentSlug={currentSlug} />
          <div className="relative flex min-h-0 min-w-0">
            <main className="min-w-0 flex-1 overflow-y-auto">
              {notice ? (
                <div data-testid="operator-notice" role="status" className="m-4 mb-0 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-3 text-sm text-violet-200 sm:m-6 sm:mb-0">
                  {notice}
                </div>
              ) : null}
              {children}
            </main>
            {inspector ? (
              <>
                <button
                  data-inspector-backdrop=""
                  aria-label="Close details"
                  className="fixed inset-0 z-30 hidden bg-black/70 lg:hidden"
                />
                <aside
                  id="workspace-inspector"
                  data-inspector-panel=""
                  data-testid="workspace-inspector"
                  className="fixed inset-x-3 bottom-3 top-3 z-40 hidden min-h-0 overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl lg:relative lg:inset-auto lg:z-auto lg:block lg:h-screen lg:w-[var(--operator-inspector-width)] lg:shrink-0 lg:rounded-none lg:border-y-0 lg:border-r-0 lg:shadow-none"
                  style={{ '--operator-inspector-width': '360px' } as React.CSSProperties}
                >
                  <div
                    data-inspector-resize=""
                    data-testid="inspector-resize-handle"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize details"
                    className="absolute inset-y-0 -left-1 hidden w-2.5 cursor-col-resize after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent hover:after:bg-violet-400/60 lg:block"
                  />
                  <button
                    type="button"
                    data-inspector-close=""
                    className="absolute right-3 top-3 rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 lg:hidden"
                  >
                    Close
                  </button>
                  {inspector}
                </aside>
                <div data-inspector-drag-shield="" className="fixed inset-0 z-50 hidden cursor-col-resize" aria-hidden="true" />
              </>
            ) : null}
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: OPERATOR_SCRIPT }} />
      </body>
    </html>
  );
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 border-b border-zinc-900 px-5 py-6 sm:flex-row sm:items-start sm:justify-between sm:px-8">
      <div className="max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-400">{description}</p>
      </div>
      {action}
    </header>
  );
}

function HealthCard({ fleet }: { fleet: OperatorFleetView }) {
  const tone = fleet.health.tone;
  return (
    <Card
      data-testid="fleet-health"
      className={cn(
        'bg-zinc-900/30',
        tone === 'healthy' && 'border-emerald-500/30',
        tone === 'warning' && 'border-amber-500/30',
        tone === 'critical' && 'border-rose-500/40',
      )}
    >
      <CardContent className="flex items-start gap-3 p-4">
        <span className={cn(
          'mt-1 h-2.5 w-2.5 shrink-0 rounded-full',
          tone === 'healthy' && 'bg-emerald-400',
          tone === 'warning' && 'bg-amber-400',
          tone === 'critical' && 'bg-rose-400',
        )} />
        <div>
          <p className="text-sm font-semibold text-zinc-100">{fleet.health.headline}</p>
          <p className="mt-1 text-sm leading-6 text-zinc-400">{fleet.health.detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function BoardWorkstreamCard({ card }: { card: WorkstreamCardView }) {
  return (
    <a
      data-testid={`board-workstream-${card.slug}`}
      href={`/workstreams/${encodeURIComponent(card.slug)}`}
      className="group block rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 transition hover:-translate-y-0.5 hover:border-zinc-700 hover:shadow-lg hover:shadow-black/20"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={stateVariant(card)}>{card.state}</Badge>
        {card.managedBy ? <Badge variant="outline">under {card.managedBy}</Badge> : null}
        {card.manages.length ? <Badge variant="outline">manages {card.manages.length}</Badge> : null}
        {card.priority && card.priority !== 'normal' ? <Badge variant="warning">{card.priority}</Badge> : null}
        {card.integrityWarnings.length ? <Badge variant="attention">State problem</Badge> : null}
      </div>
      <h3 className="mt-3 text-sm font-semibold text-zinc-100">{card.title}</h3>
      <p className="mt-1 line-clamp-2 text-sm leading-5 text-zinc-400">{card.next}</p>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-600">
        <span>{card.openAssignmentCount} open</span>
        <span>{card.acceptedAssignmentCount} accepted</span>
        <span>{card.adoptedDeliverableCount} adopted deliverable{card.adoptedDeliverableCount === 1 ? '' : 's'}</span>
      </div>
    </a>
  );
}

function BoardPage({ fleet }: { fleet: OperatorFleetView }) {
  const live = fleet.groups.reduce((sum, group) => sum + group.cards.length, 0);
  const stats = [
    ['Needs you', fleet.board.lanes['needs-you'].length, 'text-rose-300'],
    ['In motion', fleet.board.lanes.moving.length, 'text-violet-300'],
    ['Waiting', fleet.board.lanes.waiting.length, 'text-amber-300'],
    ['Done', fleet.board.done.length, 'text-emerald-300'],
  ] as const;
  return (
    <div data-testid="operator-board-page">
      <PageHeader
        eyebrow="Fleet overview"
        title="Work"
        description={`${live} live Workstream${live === 1 ? '' : 's'} · current position and the next consequential move`}
        action={<a href="/new" className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-400">Start work</a>}
      />
      <div className="space-y-6 p-5 sm:p-8">
        <HealthCard fleet={fleet} />
        {fleet.board.unreadable.length ? (
          <div data-testid="unreadable-workstreams" className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-200">
            Some Workstream state could not be read: {fleet.board.unreadable.join(', ')}
          </div>
        ) : null}
        <section aria-label="Fleet position" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.map(([label, count, color]) => (
            <div key={label} className="rounded-xl border border-zinc-900 bg-zinc-900/30 px-4 py-3">
              <p className="text-xs text-zinc-500">{label}</p>
              <p className={cn('mt-1 text-2xl font-semibold tabular-nums', color)}>{count}</p>
            </div>
          ))}
        </section>
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {fleet.groups.map((group, index) => (
            <section key={`${group.label}-${index}`} data-testid="board-workstream-group" data-group-label={group.label}>
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-medium text-zinc-300">{group.label}</h2>
                <span className="text-xs text-zinc-600">{group.cards.length}</span>
              </header>
              <div className="space-y-2">
                {group.cards.length ? group.cards.map((card) => <BoardWorkstreamCard key={card.slug} card={card} />) : (
                  <p className="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-center text-xs text-zinc-600">Nothing here</p>
                )}
              </div>
            </section>
          ))}
        </div>
        {fleet.board.done.length ? (
          <details data-testid="board-done-workstreams" className="rounded-xl border border-zinc-900 bg-zinc-900/20">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-400">
              Done <span className="ml-1 text-zinc-600">{fleet.board.done.length}</span>
            </summary>
            <div className="divide-y divide-zinc-900 border-t border-zinc-900">
              {fleet.board.done.map((item) => (
                <a
                  key={item.slug}
                  data-testid={`board-workstream-${item.slug}`}
                  href={`/workstreams/${encodeURIComponent(item.slug)}`}
                  className="grid gap-1 px-4 py-3 hover:bg-zinc-900/50 sm:grid-cols-[minmax(12rem,1fr)_2fr_auto] sm:gap-4"
                >
                  <span className="text-sm font-medium text-zinc-200">{item.title}</span>
                  <span className="truncate text-sm text-zinc-500">{item.outcome}</span>
                  <span className="text-xs text-zinc-600">{item.adoptedDeliverableCount} adopted</span>
                </a>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function NewWorkPage({ requestId, fleet }: { requestId: string; fleet: OperatorFleetView }) {
  return (
    <div data-testid="operator-new-page">
      <PageHeader
        eyebrow="New Workstream"
        title="What needs doing?"
        description="Describe the outcome in ordinary language. Weaver will turn it into durable work and keep the position visible here."
      />
      <div className="mx-auto max-w-3xl p-5 sm:p-8">
        <Card className="bg-zinc-900/30">
          <form data-testid="new-work-form" method="post" action="/workstreams">
            <CardHeader>
              <CardTitle className="text-base">Start a Workstream</CardTitle>
              <p className="text-sm leading-6 text-zinc-400">Include links, symptoms, customer context, constraints, and anything already tried.</p>
            </CardHeader>
            <CardContent className="space-y-5">
              <input type="hidden" name="request_id" value={requestId} />
              <label className="block">
                <span className="text-sm font-medium text-zinc-300">What should happen?</span>
                <textarea
                  data-testid="new-work-message"
                  name="message"
                  required
                  rows={8}
                  autoFocus
                  placeholder="The customer cannot… Please investigate, fix it end to end, and confirm what they will see."
                  className="mt-2 w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-violet-500/60"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-zinc-300">Done means</span>
                <textarea
                  data-testid="new-work-done"
                  name="done"
                  required
                  rows={3}
                  placeholder="The issue is fixed, validated in the real user path, and the result is recorded."
                  className="mt-2 w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-violet-500/60"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-zinc-300">Manage under <span className="text-zinc-500">(optional)</span></span>
                <select
                  data-testid="new-work-under"
                  name="under"
                  className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-violet-500/60"
                >
                  <option value="">No parent — a standalone outcome</option>
                  {fleet.intakeParents.map((parent) => (
                    <option key={parent.slug} value={parent.slug}>{parent.slug} — {parent.title}</option>
                  ))}
                </select>
                <span className="mt-1.5 block text-xs leading-5 text-zinc-500">
                  Placing work under a parent gives it organizational context: the parent is told when this finishes or needs a human. It never widens authority, and nothing is inherited automatically.
                </span>
              </label>
              <div className="flex items-center justify-between gap-4 border-t border-zinc-800 pt-4">
                <p className="text-xs leading-5 text-zinc-500">Creating work records intent; it does not grant new authority for irreversible actions.</p>
                <button data-testid="new-work-submit" type="submit" className="shrink-0 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-400">
                  Start work
                </button>
              </div>
            </CardContent>
          </form>
        </Card>
      </div>
    </div>
  );
}

function interactionFacts(interaction: Interaction): TypedFact[] {
  const facts: TypedFact[] = [];
  if (interaction.sentAtVirtual) {
    facts.push({
      key: `${interaction.id}-sent`,
      at: interaction.sentAtVirtual,
      label: 'Message sent',
      summary: interaction.subject,
      detail: `To ${interaction.to} · current delivery state ${interaction.status.replaceAll('_', ' ')}`,
      tone: interaction.status === 'confirmed' ? 'success' : 'neutral',
    });
  }
  for (const reply of interaction.replies) {
    facts.push({
      key: reply.id,
      at: reply.receivedAtVirtual,
      label: 'Reply received · untrusted input',
      summary: reply.body,
      detail: `From ${reply.from}${reply.evaluation ? ` · ${reply.evaluation.countsTowardObjective ? 'counts toward the outcome' : 'does not count toward the outcome'}` : ' · not yet evaluated'}`,
      tone: reply.evaluation?.countsTowardObjective ? 'success' : 'warning',
    });
  }
  return facts;
}

function observationFact(observation: Observation): TypedFact {
  return {
    key: observation.id,
    at: observation.atVirtual,
    label: 'Observation recorded',
    summary: observation.summary,
    detail: `${observation.source}${observation.evaluation ? ` · ${observation.evaluation.countsTowardObjective ? 'counts toward the outcome' : 'does not count toward the outcome'}` : ' · not yet evaluated'}`,
    tone: observation.evaluation?.countsTowardObjective ? 'success' : 'neutral',
  };
}

function attentionFacts(attention: AttentionItem): TypedFact[] {
  const facts: TypedFact[] = [{
    key: `${attention.id}-opened`,
    at: attention.createdAt,
    label: 'Human attention requested',
    summary: attention.summary,
    tone: 'attention',
  }];
  if (attention.resolvedAt) {
    facts.push({
      key: `${attention.id}-resolved`,
      at: attention.resolvedAt,
      label: 'Attention item resolved',
      summary: attention.summary,
      detail: attention.resolvedBy ? `Resolved by ${attention.resolvedBy}` : undefined,
      tone: 'success',
    });
  }
  return facts;
}

function directionFact(direction: Steering): TypedFact {
  return {
    key: direction.id,
    at: direction.revokedAt ?? direction.at,
    label: direction.revokedAt ? 'Direction withdrawn' : 'Direction recorded',
    summary: direction.body,
    detail: `${direction.by ? `By ${direction.by}` : 'By you'} · current state ${direction.consumedByPass ? 'read' : direction.revokedAt ? 'withdrawn' : 'waiting'}`,
    tone: direction.revokedAt ? 'neutral' : direction.consumedByPass ? 'success' : 'warning',
  };
}

function wakeFact(wake: Wake): TypedFact {
  return {
    key: wake.id,
    at: wake.createdAt,
    label: 'Checkpoint recorded',
    summary: wake.reason,
    detail: `Current state ${wake.status}`,
    tone: wake.infrastructure ? 'warning' : 'neutral',
  };
}

/** Chronology is assembled only from typed organizational facts. */
function typedFacts(view: WorkstreamPageView): TypedFact[] {
  const { doc } = view;
  const facts: TypedFact[] = [];
  for (const decision of doc.decisions) {
    facts.push({
      key: decision.id,
      at: decision.decidedAtVirtual,
      label: 'Course recorded',
      summary: decision.title,
      detail: `Current state ${decision.status} · ${decision.rationale}`,
      tone: decision.status === 'standing' ? 'success' : 'neutral',
    });
  }
  for (const assignment of doc.assignments) {
    facts.push({
      key: assignment.id,
      at: assignment.createdAtVirtual,
      label: assignment.kind === 'action' ? 'External action assigned' : 'Assignment created',
      summary: assignment.objective,
      detail: `Current state ${assignment.state.replaceAll('_', ' ')} · result ${assignment.adoption.state}`,
      tone: assignment.state === 'gated' ? 'attention' : assignment.state === 'failed' ? 'attention' : 'neutral',
    });
  }
  for (const deliverable of doc.deliverables) {
    facts.push({
      key: `${deliverable.id}-proposed`,
      at: deliverable.createdAtVirtual,
      label: 'Deliverable proposed',
      summary: deliverable.title,
      tone: 'neutral',
    });
    if (deliverable.adopted) {
      facts.push({
        key: `${deliverable.id}-adopted`,
        at: deliverable.adopted.atVirtual,
        label: 'Deliverable adopted',
        summary: deliverable.title,
        tone: 'success',
      });
    }
  }
  for (const interaction of doc.interactions) facts.push(...interactionFacts(interaction));
  for (const observation of doc.observations) facts.push(observationFact(observation));
  for (const attention of doc.attention) facts.push(...attentionFacts(attention));
  for (const direction of doc.steering) facts.push(directionFact(direction));
  for (const wake of doc.wakes) facts.push(wakeFact(wake));
  for (const direction of doc.managerDirections ?? []) {
    facts.push({
      key: direction.id,
      at: direction.atVirtual,
      label: 'Coordinating Workstream direction',
      summary: direction.body,
      detail: `From ${direction.fromWorkstreamSlug}`,
    });
  }
  for (const notice of doc.managerNotices ?? []) {
    facts.push({
      key: notice.id,
      at: notice.receivedAtVirtual,
      label: notice.kind === 'finished' ? 'Related Workstream finished' : 'Related Workstream needs attention',
      summary: notice.summary,
      detail: `From ${notice.fromWorkstreamSlug}`,
      tone: notice.kind === 'finished' ? 'success' : 'attention',
    });
  }
  if (doc.workstream.conclusion) {
    facts.push({
      key: `${doc.workstream.conclusion.passId}-conclusion`,
      at: doc.workstream.conclusion.atVirtual,
      label: 'Outcome concluded',
      summary: doc.workstream.conclusion.summary,
      detail: `${doc.workstream.conclusion.evidenceIds.length} cited typed evidence record${doc.workstream.conclusion.evidenceIds.length === 1 ? '' : 's'}`,
      tone: 'success',
    });
  }
  return facts
    .filter((fact) => Number.isFinite(Date.parse(fact.at)))
    .sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

function FactRows({ facts, limit }: { facts: TypedFact[]; limit?: number }) {
  const shown = limit ? facts.slice(0, limit) : facts;
  if (!shown.length) return <p className="text-sm text-zinc-600">No typed facts recorded yet.</p>;
  return (
    <div className="divide-y divide-zinc-900">
      {shown.map((fact) => (
        <article key={fact.key} data-testid="typed-fact" className="grid gap-2 py-3 first:pt-0 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
          <div>
            <p className={cn(
              'text-xs font-medium',
              fact.tone === 'success' && 'text-emerald-300',
              fact.tone === 'warning' && 'text-amber-300',
              fact.tone === 'attention' && 'text-rose-300',
              (!fact.tone || fact.tone === 'neutral') && 'text-zinc-500',
            )}>{fact.label}</p>
            <time dateTime={fact.at} className="mt-1 block text-[11px] text-zinc-700">{formatTimestamp(fact.at)}</time>
          </div>
          <div className="min-w-0">
            <p className="text-sm leading-5 text-zinc-300">{displayText(fact.summary)}</p>
            {fact.detail ? <p className="mt-1 text-xs leading-5 text-zinc-500">{displayText(fact.detail)}</p> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function QuestionCard({ testId, number, title, children }: { testId: string; number: string; title: string; children: ReactNode }) {
  return (
    <Card data-testid={testId} className="bg-zinc-900/25">
      <CardHeader className="pb-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-600">{number}</p>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm leading-6 text-zinc-400">{children}</CardContent>
    </Card>
  );
}

function FiveQuestions({ view, facts }: { view: WorkstreamPageView; facts: TypedFact[] }) {
  const standing = view.course[0]?.decision;
  return (
    <section data-testid="five-question-position" aria-label="Workstream position" className="grid gap-3 md:grid-cols-2">
      <QuestionCard testId="question-now" number="1" title="Now">
        <p className="font-medium text-zinc-200">{view.position.state}</p>
        <p className="mt-1">{view.position.next}</p>
      </QuestionCard>
      <QuestionCard testId="question-since" number="2" title="Since you left">
        <FactRows facts={facts} limit={3} />
      </QuestionCard>
      <QuestionCard testId="question-needs" number="3" title="Needs you">
        {view.needs.length ? (
          <div className="space-y-2">
            {view.needs.map((need, index) => (
              <div key={`${need.kind}-${index}`} className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-rose-100">
                <p className="text-[11px] font-medium uppercase text-rose-300">{need.kind}</p>
                <p className="mt-1">{displayText(need.summary)}</p>
              </div>
            ))}
          </div>
        ) : <p>Nothing needs your attention.</p>}
      </QuestionCard>
      <QuestionCard testId="question-next" number="4" title="Next">
        <p className="font-medium text-zinc-200">{view.position.next}</p>
        {view.position.nowAge ? <p className="mt-1 text-xs text-zinc-600">Position updated {view.position.nowAge} ago</p> : null}
      </QuestionCard>
      <div className="md:col-span-2">
        <QuestionCard testId="question-why" number="5" title="Why">
          {standing ? (
            <>
              <p className="font-medium text-zinc-200">{displayText(standing.title)}</p>
              <p className="mt-1">{displayText(standing.rationale)}</p>
            </>
          ) : (
            <p>No standing course has been recorded. The durable objective remains: {view.doc.workstream.objective}</p>
          )}
        </QuestionCard>
      </div>
    </section>
  );
}

function ObservationComposer({ slug, actor }: { slug: string; actor: string }) {
  return (
    <Card className="bg-zinc-900/30">
      <form data-testid="observation-form" method="post" action={`/workstreams/${encodeURIComponent(slug)}/observations`}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Add information</CardTitle>
          <p className="text-xs leading-5 text-zinc-500">Share evidence or context as {actor}. Weaver records it as an Observation and wakes a fresh coordinator; it does not grant authority or complete work.</p>
        </CardHeader>
        <CardContent>
          <textarea
            data-testid="observation-message"
            name="message"
            required
            rows={3}
            placeholder="What did you observe? Include a link or exact error if there is one."
            className="w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-violet-500/60"
          />
          <div className="mt-3 flex justify-end">
            <button data-testid="observation-submit" type="submit" className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-400">
              Add information
            </button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}

function assignmentVariant(card: AssignmentBoardCard): 'attention' | 'accent' | 'success' | 'outline' {
  if (card.assignmentState === 'gated' || card.assignmentState === 'failed') return 'attention';
  if (card.adoptionState === 'accepted') return 'success';
  if (card.assignmentState === 'running' || card.assignmentState === 'awaiting_review') return 'accent';
  return 'outline';
}

const laneLabel: Record<AssignmentBoardLane, string> = {
  planned: 'Planned',
  working: 'Working',
  review: 'Review',
  accepted: 'Accepted',
};

function InspectorAssignments({ view }: { view: WorkstreamPageView }) {
  return (
    <section data-testid="inspector-assignments" className="border-t border-zinc-900 px-4 py-5">
      <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Assignments</h2>
      <div className="mt-3 space-y-4">
        {(Object.keys(laneLabel) as AssignmentBoardLane[]).map((lane) => {
          const cards = view.assignments.lanes[lane];
          if (!cards.length) return null;
          return (
            <section key={lane}>
              <header className="mb-2 flex items-center justify-between text-xs text-zinc-600">
                <span>{laneLabel[lane]}</span><span>{cards.length}</span>
              </header>
              <div className="space-y-2">
                {cards.map((card) => (
                  <article key={card.id} data-testid="inspector-assignment" className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium leading-5 text-zinc-200">{firstLine(card.objective, 140)}</p>
                      <Badge variant={assignmentVariant(card)}>{card.assignmentState.replaceAll('_', ' ')}</Badge>
                    </div>
                    {card.submission ? <p className="mt-2 text-xs leading-5 text-zinc-500">{displayText(card.submission.summary)}</p> : null}
                    {card.acceptanceCriteria.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] font-medium text-zinc-500 hover:text-zinc-400">Acceptance criteria ({card.acceptanceCriteria.length})</summary>
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] leading-5 text-zinc-500">
                          {card.acceptanceCriteria.map((criterion, index) => <li key={index}>{displayText(criterion)}</li>)}
                        </ul>
                      </details>
                    ) : null}
                    {card.attemptCount ? <p className="mt-1.5 text-[11px] text-zinc-600">{card.attemptCount} disposable attempt{card.attemptCount === 1 ? '' : 's'} — full execution history in the static record</p> : null}
                    {card.action?.awaitingApproval ? <p className="mt-2 text-xs text-rose-300">Approval needed before this external action can run.</p> : null}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
        {!Object.values(view.assignments.lanes).some((cards) => cards.length) ? <p className="text-xs text-zinc-600">No current assignments.</p> : null}
      </div>
    </section>
  );
}

function DeliverableList({ slug, title, deliverables, adopted }: { slug: string; title: string; deliverables: Deliverable[]; adopted: boolean }) {
  return (
    <section data-testid={adopted ? 'inspector-adopted-deliverables' : 'inspector-proposed-deliverables'}>
      <header className="mb-2 flex items-center justify-between text-xs text-zinc-600">
        <h3>{title}</h3><span>{deliverables.length}</span>
      </header>
      {deliverables.length ? (
        <div className="space-y-2">
          {deliverables.slice().reverse().map((deliverable) => (
            <article key={deliverable.id} data-testid="inspector-deliverable" className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-zinc-200">{deliverable.title}</p>
                  <p className="mt-1 text-[11px] text-zinc-600">{deliverable.kind} · {deliverable.contentHash.slice(0, 8)}</p>
                </div>
                <Badge variant={adopted ? 'success' : 'outline'}>{adopted ? 'Adopted' : 'Proposed'}</Badge>
              </div>
              <a
                data-testid={`deliverable-download-${deliverable.id}`}
                href={`/workstreams/${encodeURIComponent(slug)}/artifacts/${encodeURIComponent(deliverable.id)}`}
                download
                className="mt-2 inline-flex text-xs font-medium text-violet-300 hover:text-violet-200"
              >
                Download
              </a>
            </article>
          ))}
        </div>
      ) : <p className="text-xs text-zinc-600">None.</p>}
    </section>
  );
}

function WorkspaceInspector({ view }: { view: WorkstreamPageView }) {
  const slug = view.doc.workstream.slug;
  const adopted = view.doc.deliverables.filter((deliverable) => deliverable.adopted);
  const proposed = view.doc.deliverables.filter((deliverable) => !deliverable.adopted);
  return (
    <div className="min-h-full bg-zinc-950">
      <header className="sticky top-0 z-10 border-b border-zinc-900 bg-zinc-950/95 px-4 py-4 backdrop-blur">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-600">Details</p>
        <h2 className="mt-1 text-sm font-semibold text-zinc-100">Work and deliverables</h2>
      </header>
      <section data-testid="inspector-standing-course" className="px-4 py-5">
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Standing course</h2>
        <div className="mt-3 space-y-2">
          {view.course.length ? view.course.map(({ decision, time }) => (
            <article key={decision.id} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <Badge variant={decision.madeBy === 'human' ? 'warning' : 'accent'}>{decision.madeBy === 'human' ? 'Human' : 'Coordinator'}</Badge>
                <time dateTime={decision.decidedAtVirtual} className="text-[10px] text-zinc-700">{time}</time>
              </div>
              <p className="mt-2 text-xs font-medium leading-5 text-zinc-200">{displayText(decision.title)}</p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{displayText(decision.rationale)}</p>
            </article>
          )) : <p className="text-xs text-zinc-600">No standing course.</p>}
        </div>
      </section>
      <InspectorAssignments view={view} />
      <section data-testid="inspector-deliverables" className="space-y-5 border-t border-zinc-900 px-4 py-5">
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Deliverables</h2>
        <DeliverableList slug={slug} title="Adopted" deliverables={adopted} adopted />
        <DeliverableList slug={slug} title="Proposed" deliverables={proposed} adopted={false} />
      </section>
    </div>
  );
}

function WorkspacePage({ view, actor }: { view: WorkstreamPageView; actor: string }) {
  const { doc } = view;
  const ws = doc.workstream;
  const facts = typedFacts(view);
  return (
    <div data-testid="operator-workspace-page">
      <PageHeader
        eyebrow={`Workstream · revision ${doc.revision}`}
        title={ws.title}
        description={ws.objective}
        action={(
          <button
            type="button"
            data-inspector-toggle=""
            data-testid="inspector-toggle"
            aria-controls="workspace-inspector"
            aria-expanded="false"
            className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 lg:hidden"
          >
            Work and deliverables
          </button>
        )}
      />
      <div className="space-y-6 p-5 sm:p-8">
        {(view.doc.workstream.managedBy || view.managed.length) ? (
          <nav data-testid="workspace-relationships" aria-label="Workstream relationships" className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            {view.doc.workstream.managedBy ? (
              <a
                data-testid="workspace-managed-by"
                href={`/workstreams/${encodeURIComponent(view.doc.workstream.managedBy.slug)}`}
                className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
              >
                ↑ managed by <span className="font-medium">{view.doc.workstream.managedBy.slug}</span>
              </a>
            ) : null}
            {view.managed.map((child) => (
              <a
                key={child.slug}
                data-testid={`workspace-manages-${child.slug}`}
                href={`/workstreams/${encodeURIComponent(child.slug)}`}
                className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
              >
                ↳ manages <span className="font-medium">{child.slug}</span> <span className="text-zinc-600">({child.status})</span>
              </a>
            ))}
          </nav>
        ) : null}
        <Card data-testid="current-position" className={cn('bg-zinc-900/30', view.needs.length ? 'border-rose-500/30' : 'border-violet-500/20')}>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={stateVariant(view.position)}>{view.position.state}</Badge>
              <Badge variant="outline">{ws.status}</Badge>
              {ws.priority && ws.priority !== 'normal' ? <Badge variant="warning">{ws.priority}</Badge> : null}
            </div>
            <CardTitle className="text-lg">{ws.conclusion ? 'Outcome concluded' : 'Current position'}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-6 text-zinc-200">{ws.conclusion ? ws.conclusion.summary : view.position.next}</p>
            {ws.conclusion ? (
              <p className="mt-2 text-xs text-emerald-300">Supported by {ws.conclusion.evidenceIds.length} cited typed evidence record{ws.conclusion.evidenceIds.length === 1 ? '' : 's'}.</p>
            ) : null}
          </CardContent>
        </Card>
        <FiveQuestions view={view} facts={facts} />
        <section data-testid="typed-fact-feed">
          <div className="mb-3">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">Typed record</p>
            <h2 className="mt-1 text-lg font-semibold text-zinc-100">What happened</h2>
            <p className="mt-1 text-xs text-zinc-500">Newest first. This chronology excludes transcripts and coordinator pass summaries.</p>
          </div>
          <Card className="bg-zinc-900/20">
            <CardContent className="p-4"><FactRows facts={facts} /></CardContent>
          </Card>
        </section>
        <ObservationComposer slug={ws.slug} actor={actor} />
      </div>
    </div>
  );
}

export function renderOperatorBoardHtml(props: OperatorBoardRenderProps): string {
  return documentHtml(
    <OperatorShell
      {...props}
      title="Weaver · Work"
      revisionEndpoint="/api/fleet-revision"
      initialRevision={props.fleet.revision}
    >
      <BoardPage fleet={props.fleet} />
    </OperatorShell>,
  );
}

export function renderOperatorNewHtml(props: OperatorNewRenderProps): string {
  return documentHtml(
    <OperatorShell
      {...props}
      title="Weaver · New work"
      revisionEndpoint="/api/fleet-revision"
      initialRevision={props.fleet.revision}
    >
      <NewWorkPage requestId={props.requestId} fleet={props.fleet} />
    </OperatorShell>,
  );
}

export function renderOperatorWorkspaceHtml(props: OperatorWorkspaceRenderProps): string {
  const slug = props.view.doc.workstream.slug;
  return documentHtml(
    <OperatorShell
      {...props}
      title={`Weaver · ${props.view.doc.workstream.title}`}
      revisionEndpoint={`/api/workstreams/${encodeURIComponent(slug)}/revision`}
      initialRevision={String(props.view.doc.revision)}
      currentSlug={slug}
      inspector={<WorkspaceInspector view={props.view} />}
    >
      <WorkspacePage view={props.view} actor={props.actor} />
    </OperatorShell>,
  );
}
