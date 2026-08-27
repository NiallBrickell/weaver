import * as fs from 'node:fs';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ClerkBrowserAssets } from '../../clerkOperatorAuth.js';
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
  firstSentence,
  formatTimestamp,
  presentNeed,
  type FleetBoardView,
  type WorkstreamCardView,
  type WorkstreamPageView,
} from '../inspect/model.js';

const CSS = fs.readFileSync(new URL('../inspect/tailwind.generated.css', import.meta.url), 'utf8');

export interface OperatorFleetView {
  board: FleetBoardView;
  groups: Array<{ label: string; cards: WorkstreamCardView[] }>;
  scope: {
    label: string;
    detail: string;
  };
  health: {
    tone: 'healthy' | 'warning' | 'critical';
    headline: string;
    detail: string;
  };
  status: {
    storage: FleetStatusClaim;
    execution: FleetStatusClaim;
    attention: FleetStatusClaim;
  };
  incidents: Array<{
    key: string;
    tone: 'warning';
    title: string;
    detail: string;
    recovery: string;
    firstObservedAt: string;
    affectedActions: number;
    affectedWorkstreams: string[];
  }>;
  steward: {
    state: 'not-configured' | 'active' | 'paused' | 'done';
    title: string;
    detail: string;
    slug?: string;
  };
  /** Active Workstreams selectable as a parent at intake — the human
   * composition surface over the same create-under-parent primitive. */
  intakeParents: Array<{ slug: string; title: string }>;
  revision: string;
}

interface FleetStatusClaim {
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'healthy' | 'warning' | 'critical';
}

export interface OperatorBaseRenderProps {
  fleet: OperatorFleetView;
  actor: string;
  notice?: string;
  signOutAction?: string;
}

export interface OperatorBoardRenderProps extends OperatorBaseRenderProps {}

export interface OperatorFleetRenderProps extends OperatorBaseRenderProps {}

export interface OperatorNewRenderProps extends OperatorBaseRenderProps {
  requestId: string;
}

export type WorkspaceTab = 'overview' | 'work' | 'activity' | 'details';

export interface OperatorWorkspaceRenderProps extends OperatorBaseRenderProps {
  view: WorkstreamPageView;
  tab: WorkspaceTab;
  responseId: string;
  needVersion?: string;
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
  for (const input of document.querySelectorAll('[data-testid="decision-custom"]')) {
    input.addEventListener('focus', () => {
      const custom = input.closest('form')?.querySelector('input[name="choice"][value="custom"]');
      if (custom instanceof HTMLInputElement) custom.checked = true;
    });
  }
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
})();`;

function documentHtml(node: ReactNode): string {
  return `<!doctype html>${renderToStaticMarkup(node)}`;
}

function inlineJson(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function clerkBootScript(kind: 'sign-in' | 'access-denied' | 'sign-out', returnTo: string): string {
  const destination = inlineJson(returnTo);
  return `
window.addEventListener('load', async () => {
  const status = document.querySelector('[data-clerk-status]');
  try {
    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      localization: {
        signIn: {
          start: {
            title: 'Sign in to Weaver',
            titleCombined: 'Sign in to Weaver',
            subtitle: 'Use your company account to continue',
            subtitleCombined: 'Use your company account to continue',
          },
        },
      },
    });
    if (${inlineJson(kind)} === 'sign-in') {
      if (window.Clerk.user) {
        window.location.replace(${destination});
        return;
      }
      window.Clerk.mountSignIn(document.getElementById('clerk-sign-in'), {
        routing: 'hash',
        forceRedirectUrl: ${destination},
        appearance: {
          options: { elevation: 'raised' },
          variables: {
            colorPrimary: '#a78bfa',
            colorPrimaryForeground: '#09090b',
            colorBackground: '#18181b',
            colorForeground: '#fafafa',
            colorMuted: '#27272a',
            colorMutedForeground: '#a1a1aa',
            colorInput: '#09090b',
            colorInputForeground: '#fafafa',
            colorBorder: '#3f3f46',
            colorRing: '#a78bfa',
            colorShadow: '#000000',
            borderRadius: '0.75rem',
            fontFamily: 'inherit',
            fontSize: '0.875rem',
            spacing: '0.875rem',
          },
          elements: {
            rootBox: { width: '100%' },
            cardBox: { width: '100%', maxWidth: '24rem' },
            headerTitle: { fontSize: '1.25rem', fontWeight: 600 },
          },
        },
      });
      if (status) status.remove();
      return;
    }
    const button = document.querySelector('[data-clerk-sign-out]');
    const signOut = async () => {
      if (button) button.setAttribute('disabled', '');
      await window.Clerk.signOut({ redirectUrl: '/sign-in' });
    };
    if (${inlineJson(kind)} === 'sign-out') {
      await signOut();
      return;
    }
    button?.addEventListener('click', () => void signOut());
    if (status) status.remove();
  } catch (_) {
    if (status) status.textContent = 'Authentication is temporarily unavailable. Please reload in a moment.';
  }
});`;
}

function ClerkAuthDocument({
  assets,
  kind,
  returnTo,
}: {
  assets: ClerkBrowserAssets;
  kind: 'sign-in' | 'access-denied' | 'sign-out';
  returnTo: string;
}) {
  const denied = kind === 'access-denied';
  const signingOut = kind === 'sign-out';
  return (
    <html lang="en" className="bg-zinc-950 text-zinc-100">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{denied ? 'Weaver · Access restricted' : signingOut ? 'Weaver · Signing out' : 'Weaver · Sign in'}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <script defer crossOrigin="anonymous" src={assets.uiScriptUrl} />
        <script
          defer
          crossOrigin="anonymous"
          data-clerk-js-script="true"
          data-clerk-publishable-key={assets.publishableKey}
          src={assets.scriptUrl}
        />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <main className="flex min-h-screen items-center justify-center px-4 py-8">
          {denied || signingOut ? (
            <section className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 shadow-2xl shadow-black/30">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-violet-300">Weaver</p>
              {denied ? (
                <>
                  <h1 className="mt-2 text-2xl font-semibold text-white">Access restricted</h1>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">Your signed-in account does not have access to this workspace.</p>
                  <button
                    type="button"
                    data-clerk-sign-out=""
                    className="mt-5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-600 hover:text-white disabled:opacity-50"
                  >
                    Sign out and switch account
                  </button>
                </>
              ) : (
                <>
                  <h1 className="mt-2 text-2xl font-semibold text-white">Signing out</h1>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">Closing this workspace session…</p>
                </>
              )}
              <p data-clerk-status="" className="mt-5 text-xs leading-5 text-zinc-500">Loading secure sign-in…</p>
            </section>
          ) : (
            <div className="w-full max-w-sm" data-testid="clerk-sign-in-shell">
              <div id="clerk-sign-in" className="flex w-full justify-center" />
              <p data-clerk-status="" className="mt-4 text-center text-xs leading-5 text-zinc-500">Loading secure sign-in…</p>
            </div>
          )}
        </main>
        <script dangerouslySetInnerHTML={{ __html: clerkBootScript(kind, returnTo) }} />
      </body>
    </html>
  );
}

export function renderOperatorClerkAuthHtml(
  assets: ClerkBrowserAssets,
  kind: 'sign-in' | 'access-denied' | 'sign-out',
  returnTo = '/board',
): string {
  return documentHtml(<ClerkAuthDocument assets={assets} kind={kind} returnTo={returnTo} />);
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
  signOutAction,
  currentSlug,
  currentPage,
}: {
  fleet: OperatorFleetView;
  actor: string;
  signOutAction?: string;
  currentSlug?: string;
  currentPage: 'board' | 'fleet' | 'new' | 'workspace';
}) {
  const selectedDone = currentSlug
    ? fleet.board.done.find((item) => item.slug === currentSlug)
    : undefined;
  const newestDone = fleet.board.done.slice(0, 8);
  const visibleDone = selectedDone && !newestDone.some((item) => item.slug === selectedDone.slug)
    ? [selectedDone, ...newestDone.slice(0, 7)]
    : newestDone;
  const olderDone = fleet.board.done.filter((item) => !visibleDone.some((visible) => visible.slug === item.slug));
  return (
    <aside
      data-testid="workstream-sidebar"
      className="z-20 flex max-h-[44vh] min-h-0 flex-col border-b border-zinc-800 bg-zinc-950 lg:sticky lg:top-0 lg:h-screen lg:max-h-none lg:border-b-0 lg:border-r"
    >
      <div className="border-b border-zinc-900 px-4 py-4">
        <div className="flex items-center justify-between">
          <a href="/" className="text-sm font-semibold tracking-tight text-white">Weaver</a>
          <span className="flex min-w-0 items-center gap-2">
            <span className="max-w-28 truncate text-xs text-zinc-500" title={actor}>{actor}</span>
            {signOutAction ? (
              <form method="post" action={signOutAction} className="shrink-0">
                <button type="submit" className="text-[11px] text-zinc-600 hover:text-zinc-300">Sign out</button>
              </form>
            ) : null}
          </span>
        </div>
        <p data-testid="fleet-scope" className="mt-2 text-[11px] font-medium text-emerald-300" title={fleet.scope.detail}>{fleet.scope.label}</p>
      </div>
      <nav aria-label="Operator" className="grid grid-cols-3 gap-2 border-b border-zinc-900 p-3">
        <a
          data-testid="overview-link"
          href="/"
          aria-current={currentPage === 'board' ? 'page' : undefined}
          className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-center text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-white"
        >
          All jobs
        </a>
        <a
          data-testid="fleet-link"
          href="/fleet"
          aria-current={currentPage === 'fleet' ? 'page' : undefined}
          className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-center text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-white"
        >
          Fleet
        </a>
        <a
          data-testid="new-work-link"
          href="/new"
          aria-current={currentPage === 'new' ? 'page' : undefined}
          className="rounded-lg bg-violet-500 px-3 py-2 text-center text-xs font-semibold text-white transition hover:bg-violet-400"
        >
          New job
        </a>
      </nav>
      <div className="hidden min-h-0 flex-1 overflow-y-auto px-2 py-3 lg:block">
        {fleet.groups.filter((group) => group.cards.length).map((group, groupIndex) => (
          <section
            key={`${group.label}-${groupIndex}`}
            data-testid="workstream-sidebar-group"
            data-group-label={group.label}
            className="mb-4 last:mb-0"
          >
            <header className="mb-1 flex items-center justify-between px-2 py-1">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">{group.label}</h2>
              <span className="text-[11px] tabular-nums text-zinc-600">{group.cards.length} job{group.cards.length === 1 ? '' : 's'}</span>
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
                      {card.needCount > 1 ? <span className="shrink-0 text-[10px] text-rose-300">{card.needCount} asks</span> : null}
                    </div>
                    <p className="mt-1 truncate pl-3.5 text-[11px] text-zinc-500">{card.state}{card.nowAge ? ` · ${card.nowAge}` : ''}</p>
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
            <span className="text-[11px] tabular-nums text-zinc-600">{fleet.board.done.length} job{fleet.board.done.length === 1 ? '' : 's'}</span>
          </header>
          {fleet.board.done.length ? (
            <>
              <div className="space-y-1">
                {visibleDone.map((item) => (
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
              {olderDone.length ? (
                <details className="mt-1 rounded-lg border border-zinc-900 px-2 py-1.5">
                  <summary className="cursor-pointer text-[11px] text-zinc-600">{olderDone.length} older</summary>
                  <div className="mt-1 space-y-1">
                    {olderDone.map((item) => (
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
  signOutAction,
  notice,
  title,
  revisionEndpoint,
  initialRevision,
  currentSlug,
  currentPage,
  children,
}: OperatorBaseRenderProps & {
  title: string;
  revisionEndpoint: string;
  initialRevision: string;
  currentSlug?: string;
  currentPage: 'board' | 'fleet' | 'new' | 'workspace';
  children: ReactNode;
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
          <WorkstreamSidebar fleet={fleet} actor={actor} signOutAction={signOutAction} currentSlug={currentSlug} currentPage={currentPage} />
          <main className="min-h-0 min-w-0 overflow-y-auto">
            {notice ? (
              <div data-testid="operator-notice" role="status" className="m-4 mb-0 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-3 text-sm text-violet-200 sm:m-6 sm:mb-0">
                {notice}
              </div>
            ) : null}
            {children}
          </main>
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
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-100">{fleet.health.headline}</p>
          <p className="mt-1 text-sm leading-6 text-zinc-400">{fleet.health.detail}</p>
        </div>
        <a href="/fleet" className="shrink-0 text-xs font-medium text-violet-300 hover:text-violet-200">Fleet details</a>
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
      {card.nowAge || card.needCount > 1 ? (
        <p className="mt-3 text-[11px] text-zinc-600">
          {card.nowAge ? `Updated ${card.nowAge} ago` : ''}
          {card.nowAge && card.needCount > 1 ? ' · ' : ''}
          {card.needCount > 1 ? `${card.needCount} separate asks` : ''}
        </p>
      ) : null}
    </a>
  );
}

function BoardPage({ fleet }: { fleet: OperatorFleetView }) {
  const live = fleet.groups.reduce((sum, group) => sum + group.cards.length, 0);
  const stats = [
    ['Needs you', fleet.board.lanes['needs-you'].length, 'text-rose-300'],
    ['Working', fleet.board.lanes.moving.length, 'text-violet-300'],
    ['Waiting', fleet.board.lanes.waiting.length, 'text-amber-300'],
    ['Ready', fleet.board.lanes.ready.length, 'text-sky-300'],
    ['Done', fleet.board.done.length, 'text-emerald-300'],
  ] as const;
  return (
    <div data-testid="operator-board-page">
      <PageHeader
        eyebrow={fleet.scope.label}
        title="Jobs"
        description={`${live} active job${live === 1 ? '' : 's'} · ${fleet.board.done.length} done`}
        action={<a href="/new" className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-400">New job</a>}
      />
      <div className="space-y-6 p-5 sm:p-8">
        <HealthCard fleet={fleet} />
        {fleet.board.unreadable.length ? (
          <div data-testid="unreadable-workstreams" className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-200">
            Some Workstream state could not be read: {fleet.board.unreadable.join(', ')}
          </div>
        ) : null}
        <section aria-label="Fleet position" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {stats.map(([label, count, color]) => (
            <div key={label} className="rounded-xl border border-zinc-900 bg-zinc-900/30 px-4 py-3">
              <p className="text-xs text-zinc-500">{label}</p>
              <p className={cn('mt-1 text-2xl font-semibold tabular-nums', color)}>{count}</p>
            </div>
          ))}
        </section>
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {fleet.groups.filter((group) => group.cards.length).map((group, index) => (
            <section key={`${group.label}-${index}`} data-testid="board-workstream-group" data-group-label={group.label}>
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-medium text-zinc-300">{group.label}</h2>
                <span className="text-xs text-zinc-600">{group.cards.length} job{group.cards.length === 1 ? '' : 's'}</span>
              </header>
              <div className="space-y-2">
                {group.cards.map((card) => <BoardWorkstreamCard key={card.slug} card={card} />)}
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

function statusTone(claim: FleetStatusClaim): string {
  if (claim.tone === 'healthy') return 'text-emerald-300';
  if (claim.tone === 'warning') return 'text-amber-300';
  if (claim.tone === 'critical') return 'text-rose-300';
  return 'text-zinc-300';
}

function FleetPage({ fleet }: { fleet: OperatorFleetView }) {
  const claims = [fleet.status.storage, fleet.status.execution, fleet.status.attention];
  return (
    <div data-testid="operator-fleet-page">
      <PageHeader
        eyebrow="Fleet"
        title="System status"
        description="Shared infrastructure and attention, separate from the jobs it affects."
      />
      <div className="mx-auto max-w-5xl space-y-4 p-5 sm:p-8">
        <Card className="bg-zinc-900/30">
          <CardContent className="p-0">
            <dl data-testid="fleet-status-claims" className="grid md:grid-cols-3">
              {claims.map((claim, index) => (
                <div key={claim.label} className={cn('p-4', index > 0 && 'border-t border-zinc-800 md:border-l md:border-t-0')}>
                  <dt className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-600">{claim.label}</dt>
                  <dd className={cn('mt-2 text-sm font-semibold', statusTone(claim))}>{claim.value}</dd>
                  <dd className="mt-1 text-xs leading-5 text-zinc-500">{claim.detail}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Card data-testid="fleet-incidents" className="bg-zinc-900/20">
            <CardHeader>
              <CardTitle>Incidents</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {fleet.incidents.length ? fleet.incidents.map((incident) => (
                <article key={incident.key} data-testid={`fleet-incident-${incident.key}`} className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-amber-200">{incident.title}</p>
                    <Badge variant="warning">Operational</Badge>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-zinc-300">{incident.detail}</p>
                  <p className="mt-2 text-xs leading-5 text-zinc-500">{incident.recovery}</p>
                  <details className="mt-3 border-t border-amber-500/15 pt-3">
                    <summary className="cursor-pointer text-xs font-medium text-zinc-500">Affected jobs ({incident.affectedWorkstreams.length})</summary>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {incident.affectedWorkstreams.map((slug) => (
                        <a key={slug} href={`/workstreams/${encodeURIComponent(slug)}`} className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200">{slug}</a>
                      ))}
                    </div>
                  </details>
                </article>
              )) : (
                <p className="text-sm leading-6 text-zinc-500">No shared dependency incident is visible in typed fleet state.</p>
              )}
            </CardContent>
          </Card>

          <Card data-testid="attention-steward" className="bg-zinc-900/20">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle>{fleet.steward.title}</CardTitle>
                <Badge variant={fleet.steward.state === 'active' ? 'success' : 'outline'}>{fleet.steward.state.replace('-', ' ')}</Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-sm leading-6 text-zinc-400">{fleet.steward.detail}</p>
              {fleet.steward.slug ? (
                <a href={`/workstreams/${encodeURIComponent(fleet.steward.slug)}`} className="mt-4 inline-flex rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-600 hover:text-white">Open steward job</a>
              ) : (
                <form method="post" action="/fleet/attention-steward" className="mt-4">
                  <button data-testid="enable-attention-steward" type="submit" className="rounded-lg bg-violet-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-violet-400">Start attention steward</button>
                </form>
              )}
              <p className="mt-3 text-xs leading-5 text-zinc-600">The steward may investigate and repair reversible causes. It cannot approve sends, merges, deploys, spending, or any other external effect.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function NewWorkPage({ requestId, fleet }: { requestId: string; fleet: OperatorFleetView }) {
  return (
    <div data-testid="operator-new-page">
      <PageHeader
        eyebrow="New job"
        title="What needs doing?"
        description="Describe the outcome in ordinary language. It is stored immediately and stays visible here while the team is away."
      />
      <div className="mx-auto max-w-3xl p-5 sm:p-8">
        <Card className="bg-zinc-900/30">
          <form data-testid="new-work-form" method="post" action="/workstreams">
            <CardHeader>
              <CardTitle className="text-base">Start a job</CardTitle>
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
              <details className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
                <summary className="cursor-pointer text-sm font-medium text-zinc-400">Advanced</summary>
                <label className="mt-4 block">
                  <span className="text-sm font-medium text-zinc-300">Manage under another job <span className="text-zinc-500">(optional)</span></span>
                  <select
                    data-testid="new-work-under"
                    name="under"
                    className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-violet-500/60"
                  >
                    <option value="">Standalone job</option>
                    {fleet.intakeParents.map((parent) => (
                      <option key={parent.slug} value={parent.slug}>{parent.slug} — {parent.title}</option>
                    ))}
                  </select>
                  <span className="mt-2 block text-xs leading-5 text-zinc-500">Use this only when the job is one part of a larger outcome.</span>
                </label>
              </details>
              <div className="flex items-center justify-between gap-4 border-t border-zinc-800 pt-4">
                <p className="text-xs leading-5 text-zinc-500">Creating work records intent; it does not grant new authority for irreversible actions.</p>
                <button data-testid="new-work-submit" type="submit" className="shrink-0 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-400">
                  Start job
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

function FactRows({ facts, limit, compact = false }: { facts: TypedFact[]; limit?: number; compact?: boolean }) {
  const shown = limit ? facts.slice(0, limit) : facts;
  if (!shown.length) return <p className="text-sm text-zinc-600">No updates yet.</p>;
  return (
    <div className="divide-y divide-zinc-900">
      {shown.map((fact) => (
        <article key={fact.key} data-testid="typed-fact" className={cn('grid gap-2 py-3 first:pt-0', !compact && 'sm:grid-cols-[8.5rem_minmax(0,1fr)]')}>
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
            <p className="text-sm leading-5 text-zinc-300">{compact ? firstLine(fact.summary, 180) : displayText(fact.summary)}</p>
            {!compact && fact.detail ? <p className="mt-1 text-xs leading-5 text-zinc-500">{displayText(fact.detail)}</p> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function DecisionCard({ view, responseId, needVersion }: { view: WorkstreamPageView; responseId: string; needVersion?: string }) {
  const primary = view.needs[0]!;
  const need = presentNeed(primary.summary);
  return (
    <Card data-testid="decision-needed" className="border-rose-500/35 bg-rose-500/5">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="attention">Decision needed</Badge>
          {view.needs.length > 1 ? <span className="text-xs text-rose-300">{view.needs.length} separate asks</span> : null}
        </div>
        <CardTitle id="decision-question" data-testid="decision-question" className="break-words text-lg leading-7">{need.headline}</CardTitle>
      </CardHeader>
      <CardContent>
        <form data-testid="decision-response-form" method="post" action={`/workstreams/${encodeURIComponent(view.doc.workstream.slug)}/responses`}>
          <input type="hidden" name="need_source_type" value={primary.source.type} />
          <input type="hidden" name="need_id" value={primary.source.id} />
          <input type="hidden" name="need_version" value={needVersion ?? ''} />
          <input type="hidden" name="response_id" value={responseId} />
          {need.choices.length ? (
            <fieldset data-testid="decision-choices" aria-labelledby="decision-question" className="space-y-2">
              <legend className="sr-only">Choose a response</legend>
              {need.choices.map((choice) => (
                <label key={choice.label} className="group flex cursor-pointer gap-3 rounded-lg border border-rose-500/20 bg-zinc-950/50 px-3 py-3 transition hover:border-rose-400/50 has-[:checked]:border-rose-400/70 has-[:checked]:bg-rose-500/10">
                  <input className="mt-1 h-4 w-4 shrink-0 accent-rose-400" type="radio" name="choice" value={choice.label} required />
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-rose-500/15 text-xs font-semibold text-rose-200">{choice.label}</span>
                  <span className="text-sm leading-6 text-zinc-200">{choice.text}</span>
                </label>
              ))}
              <label className="group block cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3 transition hover:border-zinc-700 has-[:checked]:border-violet-400/60">
                <span className="flex items-center gap-3 text-sm font-medium text-zinc-300">
                  <input className="h-4 w-4 accent-violet-400" type="radio" name="choice" value="custom" required />
                  Something else
                </span>
                <input
                  data-testid="decision-custom"
                  name="custom"
                  placeholder="Write a different response"
                  className="mt-3 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-violet-500/60"
                />
              </label>
            </fieldset>
          ) : (
            <label className="block text-sm font-medium text-zinc-300">
              Your answer
              <input type="hidden" name="choice" value="custom" />
              <textarea
                data-testid="decision-custom"
                name="custom"
                required
                rows={3}
                placeholder="Tell Weaver how to proceed"
                className="mt-2 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-violet-500/60"
              />
            </label>
          )}
          <label className="mt-3 block text-xs font-medium text-zinc-400">
            Add a condition or note <span className="font-normal text-zinc-600">(optional)</span>
            <textarea
              data-testid="decision-note"
              name="note"
              rows={2}
              placeholder="Yes, but only after…"
              className="mt-2 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-violet-500/60"
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-xs leading-5 text-zinc-500">This answers Weaver and wakes the job. External actions still use their normal approval gates.</p>
            <button data-testid="decision-response-submit" type="submit" className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-300">
              Send response
            </button>
          </div>
        </form>
        <details data-testid="decision-context" className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-300">Full context</summary>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-400">{need.full}</p>
        </details>
        {view.needs.length > 1 ? (
          <details className="mt-3 border-t border-rose-500/15 pt-3">
            <summary className="cursor-pointer text-xs font-medium text-rose-300">{view.needs.length - 1} other ask{view.needs.length === 2 ? '' : 's'}</summary>
            <ul className="mt-2 space-y-2 text-sm leading-6 text-zinc-400">
              {view.needs.slice(1).map((item, index) => <li key={`${item.kind}-${index}`}>{firstSentence(item.summary)}</li>)}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CurrentState({ view }: { view: WorkstreamPageView }) {
  const standing = view.course[0]?.decision;
  return (
    <Card data-testid="current-state" className="border-violet-500/20 bg-zinc-900/30">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={stateVariant(view.position)}>{view.position.state}</Badge>
          {view.position.nowAge ? <span className="text-xs text-zinc-600">Updated {view.position.nowAge} ago</span> : null}
        </div>
        <CardTitle className="text-lg">What happens next</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-6 text-zinc-200">{view.position.next}</p>
        {standing ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-300">Why this course</summary>
            <p className="mt-2 text-sm font-medium text-zinc-300">{displayText(standing.title)}</p>
            <p className="mt-1 text-sm leading-6 text-zinc-500">{displayText(standing.rationale)}</p>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ObservationComposer({ slug, actor }: { slug: string; actor: string }) {
  return (
    <Card className="bg-zinc-900/30">
      <form data-testid="observation-form" method="post" action={`/workstreams/${encodeURIComponent(slug)}/observations`}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Add context or answer a question</CardTitle>
          <p className="text-xs leading-5 text-zinc-500">Share a link, exact error, answer, or other useful context as {actor}.</p>
        </CardHeader>
        <CardContent>
          <textarea
            data-testid="observation-message"
            name="message"
            required
            rows={3}
            placeholder="Add a link, exact error, answer, or anything else the job needs."
            className="w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-violet-500/60"
          />
          <div className="mt-3 flex justify-end">
            <button data-testid="observation-submit" type="submit" className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-400">
              Add context
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

function AssignmentList({ view, includeAccepted = false }: { view: WorkstreamPageView; includeAccepted?: boolean }) {
  const lanes = (Object.keys(laneLabel) as AssignmentBoardLane[]).filter((lane) => includeAccepted || lane !== 'accepted');
  return (
    <div className="space-y-4">
        {lanes.map((lane) => {
          const cards = view.assignments.lanes[lane];
          if (!cards.length) return null;
          return (
            <section key={lane}>
              <header className="mb-2 flex items-center justify-between text-xs text-zinc-600">
                <span>{laneLabel[lane]}</span><span>{cards.length}</span>
              </header>
              <div className="space-y-2">
                {cards.map((card) => (
                  <article key={card.id} data-testid="job-assignment" className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium leading-5 text-zinc-200">{firstLine(card.objective, 140)}</p>
                      <Badge variant={assignmentVariant(card)}>{card.assignmentState.replaceAll('_', ' ')}</Badge>
                    </div>
                    {card.submission ? <p className="mt-2 text-xs leading-5 text-zinc-500">{displayText(card.submission.summary)}</p> : null}
                    {includeAccepted && card.acceptanceCriteria.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] font-medium text-zinc-500 hover:text-zinc-400">Acceptance criteria ({card.acceptanceCriteria.length})</summary>
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] leading-5 text-zinc-500">
                          {card.acceptanceCriteria.map((criterion, index) => <li key={index}>{displayText(criterion)}</li>)}
                        </ul>
                      </details>
                    ) : null}
                    {includeAccepted && card.attemptCount ? <p className="mt-1.5 text-[11px] text-zinc-600">{card.attemptCount} disposable attempt{card.attemptCount === 1 ? '' : 's'}</p> : null}
                    {card.action?.awaitingApproval ? <p className="mt-2 text-xs text-rose-300">Approval needed before this external action can run.</p> : null}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
        {!lanes.some((lane) => view.assignments.lanes[lane].length) ? <p className="text-sm text-zinc-600">No work is currently running.</p> : null}
    </div>
  );
}

function DeliverableList({ slug, title, deliverables, adopted }: { slug: string; title: string; deliverables: Deliverable[]; adopted: boolean }) {
  return (
    <section data-testid={adopted ? 'adopted-results' : 'proposed-results'}>
      <header className="mb-2 flex items-center justify-between text-xs text-zinc-600">
        <h3>{title}</h3><span>{deliverables.length}</span>
      </header>
      {deliverables.length ? (
        <div className="space-y-2">
          {deliverables.slice().reverse().map((deliverable) => (
            <article key={deliverable.id} data-testid="job-result" className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-zinc-200">{deliverable.title}</p>
                  <p className="mt-1 text-[11px] text-zinc-600">{adopted ? 'Accepted result' : 'Awaiting review'}</p>
                </div>
                <Badge variant={adopted ? 'success' : 'outline'}>{adopted ? 'Accepted' : 'Proposed'}</Badge>
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

function Results({ view }: { view: WorkstreamPageView }) {
  const slug = view.doc.workstream.slug;
  const adopted = view.doc.deliverables.filter((deliverable) => deliverable.adopted);
  const proposed = view.doc.deliverables.filter((deliverable) => !deliverable.adopted);
  const acceptedWork = view.assignments.lanes.accepted.filter((assignment) => assignment.submission);
  if (!view.doc.workstream.conclusion && !adopted.length && !proposed.length && !acceptedWork.length) return null;
  return (
    <section data-testid="job-results">
      <div className="mb-3">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">Outputs</p>
        <h2 className="mt-1 text-lg font-semibold text-zinc-100">Results</h2>
      </div>
      <Card className="border-emerald-500/20 bg-emerald-500/5">
        <CardContent className="space-y-5 p-4">
          {view.doc.workstream.conclusion ? (() => {
            const full = view.doc.workstream.conclusion.summary;
            const human = firstSentence(full, 220);
            return (
              <div data-testid="job-conclusion">
                <Badge variant="success">Outcome confirmed</Badge>
                <p className="mt-3 text-sm leading-6 text-zinc-200">{human}</p>
                {human !== full ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-300">Full technical result</summary>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-400">{full}</p>
                  </details>
                ) : null}
              </div>
            );
          })() : null}
          {acceptedWork.length ? (
            <section data-testid="accepted-work-results">
              <header className="mb-2 flex items-center justify-between text-xs text-zinc-600">
                <h3>Accepted work</h3><span>{acceptedWork.length}</span>
              </header>
              <div className="space-y-2">
                {acceptedWork.slice(0, 4).map((assignment) => <AcceptedWorkResult key={assignment.id} assignment={assignment} />)}
              </div>
              {acceptedWork.length > 4 ? (
                <details className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-300">{acceptedWork.length - 4} older accepted result{acceptedWork.length === 5 ? '' : 's'}</summary>
                  <div className="mt-2 space-y-2">
                    {acceptedWork.slice(4).map((assignment) => <AcceptedWorkResult key={assignment.id} assignment={assignment} />)}
                  </div>
                </details>
              ) : null}
            </section>
          ) : null}
          {adopted.length ? <DeliverableList slug={slug} title="Accepted files" deliverables={adopted} adopted /> : null}
          {proposed.length ? <DeliverableList slug={slug} title="Awaiting review" deliverables={proposed} adopted={false} /> : null}
        </CardContent>
      </Card>
    </section>
  );
}

function AcceptedWorkResult({ assignment }: { assignment: AssignmentBoardCard }) {
  const full = assignment.submission!.summary;
  const human = firstSentence(full, 220);
  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-5 text-zinc-200">{firstLine(assignment.objective, 160)}</p>
          <p data-testid="human-result-summary" className="mt-1 text-sm leading-6 text-zinc-400">{human}</p>
          {human !== full ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-300">Full technical result</summary>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-400">{full}</p>
            </details>
          ) : null}
        </div>
        <Badge variant="success">Accepted</Badge>
      </div>
    </article>
  );
}

function duplicatesCurrentNeed(view: WorkstreamPageView, fact: TypedFact): boolean {
  const openNeedSummaries = new Set(view.needs.map((need) => displayText(need.summary)));
  return openNeedSummaries.has(displayText(fact.summary));
}

function recentFacts(view: WorkstreamPageView, facts: TypedFact[]): TypedFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    if (fact.label === 'Checkpoint recorded') return false;
    if (duplicatesCurrentNeed(view, fact)) return false;
    const key = `${fact.label}:${displayText(fact.summary)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function JobDetails({ view, facts }: { view: WorkstreamPageView; facts: TypedFact[] }) {
  const standing = view.course[0];
  return (
    <section data-testid="job-details" className="rounded-xl border border-zinc-900 bg-zinc-900/20">
      <div className="p-4">
        <h2 className="text-lg font-semibold text-zinc-100">Technical details</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-zinc-600">Workstream</dt><dd className="text-zinc-400">{view.doc.workstream.slug} · revision {view.doc.revision}</dd>
          <dt className="text-zinc-600">Objective</dt><dd className="text-zinc-400">{view.doc.workstream.objective}</dd>
          {standing ? <><dt className="text-zinc-600">Standing course</dt><dd className="text-zinc-400">{displayText(standing.decision.title)} — {displayText(standing.decision.rationale)}</dd></> : null}
        </dl>
        <details className="mt-5 border-t border-zinc-800 pt-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-400 hover:text-zinc-200">All assignments</summary>
          <div className="mt-4"><AssignmentList view={view} includeAccepted /></div>
        </details>
        <details className="mt-4 border-t border-zinc-800 pt-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-400 hover:text-zinc-200">Full typed history</summary>
          <div className="mt-4"><FactRows facts={facts.filter((fact) => !duplicatesCurrentNeed(view, fact))} /></div>
        </details>
      </div>
    </section>
  );
}

const workspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'work', label: 'Work & results' },
  { id: 'activity', label: 'Activity' },
  { id: 'details', label: 'Details' },
];

function WorkspaceTabs({ slug, active }: { slug: string; active: WorkspaceTab }) {
  return (
    <nav data-testid="workspace-tabs" aria-label="Job sections" className="-mx-5 overflow-x-auto border-b border-zinc-800 px-5 sm:-mx-8 sm:px-8">
      <div className="flex min-w-max gap-1">
        {workspaceTabs.map((tab) => (
          <a
            key={tab.id}
            data-testid={`workspace-tab-${tab.id}`}
            href={`/workstreams/${encodeURIComponent(slug)}?tab=${tab.id}`}
            aria-current={active === tab.id ? 'page' : undefined}
            className={cn(
              'shrink-0 border-b-2 px-3 py-3 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-violet-400',
              active === tab.id
                ? 'border-violet-400 text-white'
                : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-200',
            )}
          >
            {tab.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

function WorkspaceRelationships({ view }: { view: WorkstreamPageView }) {
  if (!view.doc.workstream.managedBy && !view.managed.length) return null;
  return (
    <nav data-testid="workspace-relationships" aria-label="Workstream relationships" className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
      {view.doc.workstream.managedBy ? (
        <a
          data-testid="workspace-managed-by"
          href={`/workstreams/${encodeURIComponent(view.doc.workstream.managedBy.slug)}`}
          className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
        >
          ↑ part of <span className="font-medium">{view.doc.workstream.managedBy.slug}</span>
        </a>
      ) : null}
      {view.managed.map((child) => (
        <a
          key={child.slug}
          data-testid={`workspace-manages-${child.slug}`}
          href={`/workstreams/${encodeURIComponent(child.slug)}`}
          className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
        >
          ↳ includes <span className="font-medium">{child.slug}</span> <span className="text-zinc-600">({child.status})</span>
        </a>
      ))}
    </nav>
  );
}

function WorkspacePage({
  view,
  actor,
  tab,
  responseId,
  needVersion,
}: {
  view: WorkstreamPageView;
  actor: string;
  tab: WorkspaceTab;
  responseId: string;
  needVersion?: string;
}) {
  const { doc } = view;
  const ws = doc.workstream;
  const facts = typedFacts(view);
  const updates = recentFacts(view, facts);
  const hasCurrentWork = (['planned', 'working', 'review'] as AssignmentBoardLane[])
    .some((lane) => view.assignments.lanes[lane].length > 0);
  return (
    <div data-testid="operator-workspace-page">
      <PageHeader
        eyebrow={view.position.state}
        title={ws.title}
        description={firstLine(ws.objective, 240)}
      />
      <div className="mx-auto max-w-5xl p-5 sm:p-8">
        <WorkspaceTabs slug={ws.slug} active={tab} />
        <div className="mt-5 space-y-5">
          <WorkspaceRelationships view={view} />
          {tab === 'overview' ? (
            <section data-testid="workspace-overview">
              {view.needs.length
                ? <DecisionCard view={view} responseId={responseId} needVersion={needVersion} />
                : !ws.conclusion
                  ? <CurrentState view={view} />
                  : (
                    <Card className="border-emerald-500/20 bg-emerald-500/5">
                      <CardContent className="p-4">
                        <Badge variant="success">Done</Badge>
                        <p className="mt-3 text-sm leading-6 text-zinc-200">{firstSentence(ws.conclusion.summary, 240)}</p>
                      </CardContent>
                    </Card>
                  )}
            </section>
          ) : null}
          {tab === 'work' ? (
            <div data-testid="workspace-work" className="space-y-6">
              {hasCurrentWork ? <section data-testid="current-work">
                <div className="mb-3">
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">In progress</p>
                  <h2 className="mt-1 text-lg font-semibold text-zinc-100">Current work</h2>
                </div>
                <Card className="bg-zinc-900/20">
                  <CardContent className="p-4"><AssignmentList view={view} /></CardContent>
                </Card>
              </section> : null}
              <Results view={view} />
              {!hasCurrentWork && !ws.conclusion && !view.doc.deliverables.length && !view.assignments.lanes.accepted.length ? (
                <Card><CardContent className="p-4 text-sm text-zinc-500">No work or results have been recorded yet.</CardContent></Card>
              ) : null}
            </div>
          ) : null}
          {tab === 'activity' ? (
            <div data-testid="workspace-activity" className="space-y-6">
              <ObservationComposer slug={ws.slug} actor={actor} />
              <section data-testid="recent-updates">
                <div className="mb-3">
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">Latest activity</p>
                  <h2 className="mt-1 text-lg font-semibold text-zinc-100">Recent updates</h2>
                </div>
                <Card className="bg-zinc-900/20"><CardContent className="p-4"><FactRows facts={updates} limit={5} compact /></CardContent></Card>
              </section>
            </div>
          ) : null}
          {tab === 'details' ? <JobDetails view={view} facts={facts} /> : null}
        </div>
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
      currentPage="board"
    >
      <BoardPage fleet={props.fleet} />
    </OperatorShell>,
  );
}

export function renderOperatorFleetHtml(props: OperatorFleetRenderProps): string {
  return documentHtml(
    <OperatorShell
      {...props}
      title="Weaver · Fleet"
      revisionEndpoint="/api/fleet-revision"
      initialRevision={props.fleet.revision}
      currentPage="fleet"
    >
      <FleetPage fleet={props.fleet} />
    </OperatorShell>,
  );
}

export function renderOperatorNewHtml(props: OperatorNewRenderProps): string {
  return documentHtml(
    <OperatorShell
      {...props}
      title="Weaver · New job"
      revisionEndpoint="/api/fleet-revision"
      initialRevision={props.fleet.revision}
      currentPage="new"
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
      currentPage="workspace"
    >
      <WorkspacePage
        view={props.view}
        actor={props.actor}
        tab={props.tab}
        responseId={props.responseId}
        needVersion={props.needVersion}
      />
    </OperatorShell>,
  );
}
