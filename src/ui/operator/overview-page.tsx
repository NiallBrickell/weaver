import type { ReactNode } from 'react';

import type { OriginRow, OverviewPayload } from '../../overview.js';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '../components/index.js';
import { formatTimestamp } from '../inspect/model.js';
import { Timeline } from './timeline.js';

// Only timeless copy is written here. Every number on the page comes from the
// computed overview, which is derived from typed state on each fleet revision.

const MAX_ORIGIN_ROWS = 12;

function money(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString('en-GB')}`;
  return `$${value.toFixed(2)}`;
}

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '—';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

function workstreamHref(slug: string): string {
  return `/workstreams/${encodeURIComponent(slug)}`;
}

function Section({ id, eyebrow, title, lede, children }: { id: string; eyebrow: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section data-testid={`overview-${id}`} aria-labelledby={`overview-${id}-title`} className="space-y-4">
      <div className="max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-violet-300">{eyebrow}</p>
        <h2 id={`overview-${id}-title`} className="mt-1 text-xl font-semibold tracking-tight text-white">{title}</h2>
        {lede ? <p className="mt-2 text-sm leading-6 text-zinc-400">{lede}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ value, label, detail }: { value: string; label: string; detail?: string }) {
  return (
    <div className="border-t border-zinc-800 pt-3">
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-zinc-100">{value}</p>
      <p className="mt-0.5 text-sm text-zinc-300">{label}</p>
      {detail ? <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p> : null}
    </div>
  );
}

function HowItWorksDiagram({ workstreams }: { workstreams: number }) {
  const box = 'fill-zinc-900 stroke-zinc-600';
  const title = 'fill-zinc-100 text-[14px] font-semibold';
  const sub = 'fill-zinc-400 text-[12px]';
  const mono = 'fill-zinc-200 font-mono text-[12px]';
  const label = 'fill-zinc-500 text-[11.5px]';
  const zone = 'fill-none stroke-zinc-800';
  const zoneLabel = 'fill-zinc-500 font-mono text-[11px] uppercase tracking-[0.08em]';
  return (
    <svg
      viewBox="0 0 1140 520"
      role="img"
      aria-label="An operator writes objectives and steering into a Workstream record in the shared store. A runner repeatedly ticks without a model, starts a fresh coordinator that reads a projection of the record and makes a revision-checked write, and launches worker runs and gated actions. Worker results return as proposals; actions change the outside world and are confirmed by readback. What needs a person flows back to the needs-you queue."
      className="block h-auto w-full min-w-[820px]"
    >
      <defs>
        <marker id="ov-h" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" className="fill-zinc-400" /></marker>
        <marker id="ov-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" className="fill-violet-400" /></marker>
        <marker id="ov-p" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" className="fill-amber-400" /></marker>
      </defs>

      <rect className={zone} strokeDasharray="5 4" x="10" y="30" width="190" height="460" rx="10" />
      <text className={zoneLabel} x="22" y="22">Operator</text>
      <rect className={zone} strokeDasharray="5 4" x="280" y="30" width="260" height="460" rx="10" />
      <text className={zoneLabel} x="292" y="22">Shared store</text>
      <rect className={zone} strokeDasharray="5 4" x="620" y="30" width="370" height="460" rx="10" />
      <text className={zoneLabel} x="632" y="22">Runner · disposable models</text>
      <rect className={zone} strokeDasharray="5 4" x="1040" y="30" width="90" height="460" rx="10" />
      <text className={zoneLabel} x="1046" y="22">Outside</text>

      <rect className="fill-amber-500/10 stroke-amber-400" x="30" y="70" width="150" height="130" rx="8" />
      <text className={title} x="46" y="98">A person</text>
      <text className={mono} x="46" y="126">do: a new outcome</text>
      <text className={mono} x="46" y="150">steer</text>
      <text className={mono} x="46" y="174">approve / reject</text>

      <rect className={box} x="30" y="330" width="150" height="120" rx="8" />
      <text className={title} x="46" y="358">Needs-you queue</text>
      <text className={sub} x="46" y="384">approvals · reviews</text>
      <text className={sub} x="46" y="406">blockers · budget</text>
      <text className={sub} x="46" y="428">board · this page</text>

      <rect className="fill-violet-500/10 stroke-violet-400" x="300" y="70" width="220" height="400" rx="8" />
      <text className={title} x="316" y="98">Workstream record</text>
      <text className={sub} x="316" y="118">one per outcome · {workstreams.toLocaleString('en-GB')} so far</text>
      <line className="stroke-zinc-800" x1="312" y1="134" x2="508" y2="134" />
      <text className={mono} x="316" y="160">objective + done-bar</text>
      <text className={mono} x="316" y="194">decisions</text>
      <text className={sub} x="392" y="194">standing/superseded</text>
      <text className={mono} x="316" y="228">assignments</text>
      <text className={sub} x="416" y="228">+ attempts</text>
      <text className={mono} x="316" y="262">deliverables</text>
      <text className={sub} x="420" y="262">hash-pinned</text>
      <text className={mono} x="316" y="296">waits &amp; wakes</text>
      <text className={mono} x="316" y="330">steering</text>
      <text className={mono} x="316" y="364">attention items</text>
      <text className={mono} x="316" y="398">policies</text>
      <text className={sub} x="390" y="398">learned + yours</text>
      <line className="stroke-zinc-800" x1="312" y1="420" x2="508" y2="420" />
      <text className={sub} x="316" y="446">revision N · every write checked</text>

      <rect className={box} x="640" y="70" width="330" height="110" rx="8" />
      <text className={title} x="656" y="98">Coordinator pass</text>
      <text className={sub} x="656" y="122">a fresh model every time, no memory of the last</text>
      <text className={sub} x="656" y="144">reads · verifies · adopts or rejects · dispatches</text>
      <text className={sub} x="656" y="166">records a decision · schedules a wake · exits</text>

      <rect className={box} x="640" y="220" width="155" height="120" rx="8" />
      <text className={title} x="656" y="248">Worker run</text>
      <text className={sub} x="656" y="272">fresh agent with a</text>
      <text className={sub} x="656" y="290">bounded brief; returns</text>
      <text className={sub} x="656" y="308">a proposed result</text>

      <rect className={box} x="815" y="220" width="155" height="120" rx="8" />
      <text className={title} x="831" y="248">Action</text>
      <text className={sub} x="831" y="272">exact command run</text>
      <text className={sub} x="831" y="290">by the engine, only</text>
      <text className={sub} x="831" y="308">after approval</text>

      <rect className={box} x="640" y="380" width="330" height="90" rx="8" />
      <text className={title} x="656" y="408">Engine tick</text>
      <text className={sub} x="656" y="432">every few seconds, no model involved:</text>
      <text className={sub} x="656" y="452">readbacks → sends → workers → wakes → pass</text>
      <line className="stroke-zinc-400" strokeWidth="1.4" x1="717" y1="380" x2="717" y2="344" markerEnd="url(#ov-h)" />
      <line className="stroke-zinc-400" strokeWidth="1.4" x1="892" y1="380" x2="892" y2="344" markerEnd="url(#ov-h)" />
      <text className={label} x="724" y="366">launches</text>
      <text className={label} x="899" y="366">launches</text>

      <rect className={box} x="1050" y="220" width="70" height="42" rx="6" />
      <text className={sub} x="1085" y="246" textAnchor="middle">GitHub</text>
      <rect className={box} x="1050" y="272" width="70" height="42" rx="6" />
      <text className={sub} x="1085" y="298" textAnchor="middle">Sentry</text>
      <rect className={box} x="1050" y="324" width="70" height="42" rx="6" />
      <text className={sub} x="1085" y="350" textAnchor="middle">other APIs</text>

      <line className="stroke-amber-400" strokeWidth="1.8" x1="180" y1="120" x2="298" y2="120" markerEnd="url(#ov-p)" />
      <text className="fill-amber-300 text-[11.5px] font-semibold" x="190" y="110">objective, steer</text>
      <text className={label} x="190" y="140">(a steer wakes it)</text>
      <line className="stroke-amber-400" strokeWidth="1.8" x1="300" y1="390" x2="182" y2="390" markerEnd="url(#ov-p)" />
      <text className="fill-amber-300 text-[11.5px] font-semibold" x="190" y="380">what needs you</text>

      <line className="stroke-violet-400" strokeWidth="1.8" x1="520" y1="100" x2="638" y2="100" markerEnd="url(#ov-a)" />
      <text className="fill-violet-300 text-[11.5px] font-semibold" x="530" y="92">projection</text>
      <line className="stroke-violet-400" strokeWidth="1.8" x1="640" y1="150" x2="522" y2="150" markerEnd="url(#ov-a)" />
      <text className="fill-violet-300 text-[11.5px] font-semibold" x="530" y="142">checked write</text>

      <line className="stroke-zinc-400" strokeWidth="1.4" x1="520" y1="250" x2="638" y2="250" markerEnd="url(#ov-h)" />
      <text className={label} x="530" y="242">assignment</text>
      <line className="stroke-zinc-400" strokeWidth="1.4" x1="640" y1="310" x2="522" y2="310" markerEnd="url(#ov-h)" />
      <text className={label} x="530" y="302">proposed result</text>

      <line className="stroke-zinc-400" strokeWidth="1.4" x1="522" y1="425" x2="638" y2="425" markerStart="url(#ov-h)" markerEnd="url(#ov-h)" />
      <text className={label} x="530" y="417">wakes, readbacks</text>

      <line className="stroke-zinc-400" strokeWidth="1.4" x1="970" y1="240" x2="1048" y2="240" markerEnd="url(#ov-h)" />
      <text className={label} x="978" y="232">merge, push</text>
      <line className="stroke-zinc-400" strokeWidth="1.4" x1="1048" y1="300" x2="972" y2="300" markerEnd="url(#ov-h)" />
      <text className={label} x="978" y="292">readback</text>
    </svg>
  );
}

const GLOSSARY: Array<[string, string]> = [
  ['Workstream', 'The outcome and everything needed to finish it. Lives for days to months, across any number of model runs.'],
  ['Assignment', 'One bounded piece of work with acceptance criteria. Survives any number of failed attempts.'],
  ['Attempt', 'One execution of an assignment, pinned to an executor and model. Disposable.'],
  ['Decision', 'Which course became authoritative and why. A later pass can supersede it, but only explicitly, with lineage.'],
  ['Adoption', 'The coordinator accepting a result. A worker finishing is not adoption; adoption pins the exact content.'],
  ['Action + readback', 'A gated real-world change (merge, push, send), confirmed by a deterministic check, never by a model saying so.'],
  ['Wake', 'Stored data saying when to look again: a time, a worker finishing, a steer, a reply.'],
  ['Policy', 'A lesson from a person\'s correction. Starts in shadow, becomes active only after it works elsewhere, and can never grant authority.'],
];

function Explainer({ overview }: { overview: OverviewPayload }) {
  return (
    <Section
      id="explainer"
      eyebrow="01 · What Weaver is"
      title="One durable record per outcome; fresh agents do the work"
      lede="An agent can do a task. Weaver owns the outcome: it keeps one durable record of what is wanted, sends fresh agents in to do bounded pieces, checks what they return, and keeps going across failures, reviews and multi-day waits until the done-bar is met. No agent stays alive between steps. Every step starts a new model that reads the record, does its bit, writes back and exits. The record is the memory, never a conversation."
    >
      <Card className="bg-zinc-900/30">
        <CardContent className="overflow-x-auto p-4">
          <HowItWorksDiagram workstreams={overview.totals.workstreams} />
        </CardContent>
      </Card>
      <p className="max-w-3xl text-xs leading-5 text-zinc-500">
        The record in the middle is the only thing that lasts. The coordinator reads a typed projection of it, writes back against the revision it read (a clash with a newer steer or result fails the write and forces a fresh read), and exits. Worker results arrive as proposals; only a coordinator adoption makes them count. Actions that change the outside world run as exact commands and count as done only when a readback confirms the effect.
      </p>
      <dl data-testid="overview-glossary" className="grid gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 sm:grid-cols-2 xl:grid-cols-4">
        {GLOSSARY.map(([term, definition]) => (
          <div key={term} className="bg-zinc-950 p-4">
            <dt className="text-sm font-semibold text-zinc-100">{term}</dt>
            <dd className="mt-1 text-xs leading-5 text-zinc-400">{definition}</dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat value={overview.totals.workstreams.toLocaleString('en-GB')} label="workstreams" detail={`${overview.totals.active} active · ${overview.totals.paused} paused · ${overview.totals.done} done`} />
        <Stat value={overview.totals.assignments.toLocaleString('en-GB')} label="assignments" detail={`${overview.totals.actionAssignments.toLocaleString('en-GB')} actions · ${overview.totals.workAssignments.toLocaleString('en-GB')} work`} />
        <Stat value={overview.totals.passes.toLocaleString('en-GB')} label="coordinator passes" detail="including errored and backed-off passes" />
        <Stat value={overview.totals.decisions.toLocaleString('en-GB')} label="decisions recorded" />
        <Stat value={overview.totals.steers.toLocaleString('en-GB')} label="human steers" detail="across the whole fleet" />
        <Stat value={money(overview.cost.totalUsd)} label="recorded model cost" detail="see the cost section for what is cash and what is notional" />
      </div>
    </Section>
  );
}

function foldOrigins(rows: OriginRow[]): OriginRow[] {
  if (rows.length <= MAX_ORIGIN_ROWS) return rows;
  const shown = rows.slice(0, MAX_ORIGIN_ROWS - 1);
  const rest = rows.slice(MAX_ORIGIN_ROWS - 1);
  const other: OriginRow = {
    parent: '',
    label: `${rest.length} other parents`,
    count: 0,
    active: 0,
    paused: 0,
    done: 0,
  };
  for (const row of rest) {
    other.count += row.count;
    other.active += row.active;
    other.paused += row.paused;
    other.done += row.done;
  }
  return [...shown, other];
}

function Origins({ overview }: { overview: OverviewPayload }) {
  const rows = foldOrigins(overview.origins.rows);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Section
      id="origins"
      eyebrow="02 · How work gets created"
      title={`${overview.origins.managed.toLocaleString('en-GB')} of ${overview.origins.total.toLocaleString('en-GB')} workstreams were opened by other workstreams`}
      lede="A person starts a handful of routines: standing workstreams that wake on a schedule, look at a source (errors, monitors, support threads, review comments) and open a child workstream for each real problem, keyed by its source so a repeat reuses the existing one. The children run the full loop on their own and report back to their parent. Each bar below is one parent; the top-level row is work opened directly by a person or by intake."
    >
      <Card className="bg-zinc-900/30">
        <CardContent className="space-y-2.5 p-4">
          {rows.map((row) => (
            <div key={row.parent ?? 'top-level'} data-testid="overview-origin-row" className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3 sm:grid-cols-[14rem_minmax(0,1fr)_3rem]">
              <span className="truncate font-mono text-xs text-zinc-300" title={row.label}>
                {row.parent ? <a href={workstreamHref(row.parent)} className="hover:text-white">{row.label}</a> : row.label}
              </span>
              <span className="order-3 col-span-2 flex h-3 overflow-hidden rounded bg-zinc-900 sm:order-none sm:col-span-1" title={`${row.active} active · ${row.paused} paused · ${row.done} done`}>
                <span className="bg-violet-400" style={{ width: `${(row.active / max) * 100}%` }} />
                <span className="bg-amber-400" style={{ width: `${(row.paused / max) * 100}%` }} />
                <span className="bg-emerald-400/80" style={{ width: `${(row.done / max) * 100}%` }} />
              </span>
              <span className="text-right text-xs tabular-nums text-zinc-300">{row.count}</span>
            </div>
          ))}
          <p className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-[11px] text-zinc-500">
            <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-violet-400" />active</span>
            <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-amber-400" />paused</span>
            <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-emerald-400/80" />done</span>
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

/** The tab key of a group: its parent slug, or the top level. */
function nowKey(group: { parent: string | null }): string {
  return group.parent ?? 'top-level';
}

function Now({ overview, selected }: { overview: OverviewPayload; selected?: string }) {
  const groups = [...overview.now.groups].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  // A plain link per group (?now=<parent>), so the choice survives the shell's
  // live refresh, which re-fetches the current URL. Unknown or absent keys
  // fall back to the busiest group.
  const current = groups.find((group) => nowKey(group) === selected) ?? groups[0];
  return (
    <Section
      id="now"
      eyebrow="03 · What it is doing now"
      title={`${plural(overview.now.active, 'active workstream')}`}
      lede="One tab per parent: the routine or workstream that opened them, or the top level for work a person started. Each shows its objective and the latest standing decision, the course the fleet is currently committed to."
    >
      {current ? (
        <div className="space-y-4">
          <nav aria-label="Active workstreams by parent" data-testid="overview-now-tabs" className="-mx-1 flex gap-1 overflow-x-auto border-b border-zinc-800 px-1">
            {groups.map((group) => {
              const key = nowKey(group);
              const isCurrent = group === current;
              return (
                <a
                  key={key}
                  href={`?now=${encodeURIComponent(key)}#now`}
                  data-testid={`overview-now-tab-${key}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-xs transition ${isCurrent ? 'border-violet-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
                >
                  <span className="font-mono">{group.label}</span>
                  <span className="tabular-nums text-zinc-500">{group.items.length}</span>
                </a>
              );
            })}
          </nav>
          <div data-testid="overview-now-items" className="grid items-start gap-3 lg:grid-cols-2">
            {current.items.map((item) => (
              <a key={item.slug} href={workstreamHref(item.slug)} className="block rounded-lg border border-zinc-800 px-3 py-2 transition hover:border-zinc-700">
                <p className="text-sm font-medium text-zinc-100">{item.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-zinc-400">{item.objective}</p>
                {item.decision ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-violet-300/90">Standing: {item.decision}</p> : null}
              </a>
            ))}
          </div>
        </div>
      ) : <p className="text-sm text-zinc-500">Nothing is active.</p>}
    </Section>
  );
}

function Outcomes({ overview }: { overview: OverviewPayload }) {
  const { outcomes } = overview;
  const max = Math.max(1, ...outcomes.rows.map((r) => r.count));
  return (
    <Section
      id="outcomes"
      eyebrow="04 · How outcomes ended"
      title={`${plural(outcomes.concluded, 'concluded outcome')}`}
      lede="A conclusion is a success claim that must cite typed evidence: an adopted deliverable, a readback-confirmed action, or a person's own direction. Its disposition says what kind of ending it was. Conclusions recorded before dispositions existed are shown as unclassified rather than guessed."
    >
      <Card className="bg-zinc-900/30">
        <CardContent className="p-0">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-2 font-medium">Disposition</th>
                <th className="px-4 py-2 text-right font-medium">Count</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell"><span className="sr-only">Share</span></th>
                <th className="px-4 py-2 text-right font-medium">Median cost</th>
                <th className="px-4 py-2 text-right font-medium">Total cost</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.rows.map((row) => (
                <tr key={row.outcome} data-testid={`overview-outcome-${row.outcome}`} className="border-b border-zinc-900 last:border-0">
                  <td className="px-4 py-2 text-zinc-200">{row.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-200">{row.count}</td>
                  <td className="hidden w-1/3 px-4 py-2 sm:table-cell">
                    <span className="block h-2 overflow-hidden rounded bg-zinc-900"><span className="block h-full bg-emerald-400/80" style={{ width: `${(row.count / max) * 100}%` }} /></span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-400">{row.medianUsd === null ? '—' : money(row.medianUsd)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-400">{money(row.totalUsd)}</td>
                </tr>
              ))}
              {!outcomes.rows.length ? <tr><td colSpan={5} className="px-4 py-3 text-zinc-500">No workstream has concluded yet.</td></tr> : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="bg-zinc-900/20">
          <CardContent className="p-4 text-sm leading-6 text-zinc-400">
            <p><span className="font-semibold text-zinc-200">{outcomes.doneWithoutConclusion}</span> {outcomes.doneWithoutConclusion === 1 ? 'workstream is' : 'workstreams are'} marked done without a typed conclusion: closed, but with no success claim to count.</p>
          </CardContent>
        </Card>
        <Card data-testid="overview-paused" className="bg-zinc-900/20">
          <CardContent className="p-4 text-sm leading-6 text-zinc-400">
            <p><span className="font-semibold text-amber-300">{outcomes.paused.length} paused.</span> Pausing is how a person stops work without concluding it; paused workstreams keep their record and can be resumed.</p>
            {outcomes.paused.length ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-zinc-500">Show paused workstreams</summary>
                <ul className="mt-2 space-y-1">
                  {outcomes.paused.map((item) => (
                    <li key={item.slug} className="truncate text-xs">
                      <a href={workstreamHref(item.slug)} className="text-zinc-300 hover:text-white">{item.title}</a>
                      {item.parent ? <span className="text-zinc-600"> · under {item.parent}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </Section>
  );
}

function Signals({ overview }: { overview: OverviewPayload }) {
  const { signals } = overview;
  const { adoption, firstAttempt, merges, repairsOfRepairs, interventions, passes } = signals;
  return (
    <Section
      id="signals"
      eyebrow="05 · Useful work or churn?"
      title="Signals from the record, each with its denominator"
      lede="None of these is a verdict on its own. Together they show whether work is being accepted, done right first time, landing in the outside world, and needing people less."
    >
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
        <Stat
          value={pct(adoption.accepted, adoption.judged)}
          label="of judged worker results adopted"
          detail={`${adoption.accepted.toLocaleString('en-GB')} adopted, ${adoption.rejected.toLocaleString('en-GB')} rejected of ${adoption.judged.toLocaleString('en-GB')} the coordinator judged. ${adoption.pending} still proposed, ${adoption.superseded} superseded.`}
        />
        <Stat
          value={firstAttempt.rate === null ? '—' : pct(firstAttempt.firstAttempt, firstAttempt.completed)}
          label="of completed assignments done on the first attempt"
          detail={`${firstAttempt.firstAttempt.toLocaleString('en-GB')} of ${firstAttempt.completed.toLocaleString('en-GB')} completed; ${firstAttempt.failed} failed outright.`}
        />
        <Stat
          value={pct(merges.confirmed, merges.total)}
          label="of merge actions confirmed by readback"
          detail={`${merges.confirmed} confirmed, ${merges.failedReadback} whose readback failed, ${merges.notRun} not yet run, of ${plural(merges.total, 'merge action')}. A merge is detected heuristically: an action whose command or objective contains "gh pr merge".`}
        />
        <Stat
          value={repairsOfRepairs.count.toLocaleString('en-GB')}
          label="repairs of repairs"
          detail={`Workstreams opened by a workstream that was itself opened by another, out of ${repairsOfRepairs.managed.toLocaleString('en-GB')} opened by workstreams. A rising share would suggest fixes spawning fixes.`}
        />
        <Stat
          value={interventions.perOutcome === null ? '—' : interventions.perOutcome.toFixed(2)}
          label="human interventions per successful outcome"
          detail={`${interventions.count.toLocaleString('en-GB')} recorded steers, approvals, rejections and overrides over ${interventions.successfulOutcomes.toLocaleString('en-GB')} typed conclusions. This is the number Weaver tries to push down without weakening verification.`}
        />
        <Stat
          value={pct(passes.completed, passes.total)}
          label="of coordinator passes completed"
          detail={`${passes.completed.toLocaleString('en-GB')} of ${passes.total.toLocaleString('en-GB')}; ${passes.providerBackoff.toLocaleString('en-GB')} waited on provider capacity and ${passes.logicalFailure.toLocaleString('en-GB')} failed for other reasons.`}
        />
      </div>
      <Card data-testid="overview-limits" className="border-amber-500/25 bg-amber-500/5">
        <CardContent className="p-4 text-sm leading-6 text-zinc-300">
          <p className="font-semibold text-amber-200">What this page cannot tell you yet</p>
          <p className="mt-1 text-zinc-400">Whether merged code was good, whether it was later reverted, and whether it caused follow-up fixes. Those facts live in GitHub, and this page deliberately makes no external reads: it reports only what the typed record holds. A merge confirmed by readback means the merge happened, not that it was right.</p>
        </CardContent>
      </Card>
    </Section>
  );
}

function basisBadge(basis: OverviewPayload['cost']['byProvider'][number]['basis']) {
  if (basis === 'cash') return <Badge variant="warning">cash</Badge>;
  if (basis === 'subscription-notional') return <Badge variant="outline">notional</Badge>;
  return <Badge variant="neutral">unknown</Badge>;
}

function Cost({ overview }: { overview: OverviewPayload }) {
  const { cost } = overview;
  const families = cost.byFamily.slice(0, 12);
  return (
    <Section
      id="cost"
      eyebrow="06 · What it costs"
      title={`${money(cost.totalUsd)} of recorded model cost`}
      lede="Summed from each coordinator pass and each worker attempt. Read the billing basis before reading the total: the Claude SDK reports a list-price figure even when the run is on a subscription, so that cost is notional; OpenRouter bills per token, so its figure is money spent."
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        <Stat value={cost.coordinatorShare === null ? '—' : pct(cost.coordinatorUsd, cost.totalUsd)} label="spent on coordinators" detail={`${money(cost.coordinatorUsd)} coordinator · ${money(cost.workerUsd)} workers`} />
        <Stat value={money(cost.byBasis.cash)} label="real cash" detail="OpenRouter" />
        <Stat value={money(cost.byBasis['subscription-notional'])} label="notional, on subscription" detail="Anthropic via the Claude SDK" />
        <Stat
          value={cost.perOutcome.medianUsd === null ? '—' : money(cost.perOutcome.medianUsd)}
          label="median per concluded outcome"
          detail={`${money(cost.perOutcome.totalUsd)} across ${cost.perOutcome.count} concluded workstreams`}
        />
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card className="bg-zinc-900/20">
          <CardHeader className="pb-2"><CardTitle className="text-sm">By parent</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="mb-2 text-xs leading-5 text-zinc-500">A parent's cost is its own passes and workers plus every workstream it opened directly. Top-level work that opened nothing is grouped as top level.</p>
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500"><tr className="border-b border-zinc-800"><th className="py-1.5 font-medium">Parent</th><th className="py-1.5 text-right font-medium">Workstreams</th><th className="py-1.5 text-right font-medium">Own</th><th className="py-1.5 text-right font-medium">Children</th><th className="py-1.5 text-right font-medium">Total</th></tr></thead>
              <tbody>
                {families.map((row) => (
                  <tr key={row.family ?? 'top-level'} data-testid="overview-cost-family" className="border-b border-zinc-900 last:border-0">
                    <td className="max-w-40 truncate py-1.5 font-mono text-zinc-300" title={row.label}>{row.label}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-400">{row.workstreams}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-400">{money(row.ownUsd)}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-400">{money(row.childrenUsd)}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-200">{money(row.totalUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cost.byFamily.length > families.length ? <p className="mt-2 text-[11px] text-zinc-600">{cost.byFamily.length - families.length} smaller parents not shown.</p> : null}
          </CardContent>
        </Card>
        <Card className="bg-zinc-900/20">
          <CardHeader className="pb-2"><CardTitle className="text-sm">By executor and provider</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500"><tr className="border-b border-zinc-800"><th className="py-1.5 font-medium">Target</th><th className="py-1.5 font-medium">Basis</th><th className="py-1.5 pl-3 text-right font-medium">Coordinator</th><th className="py-1.5 pl-3 text-right font-medium">Workers</th></tr></thead>
              <tbody>
                {cost.byProvider.map((row) => (
                  <tr key={row.key} data-testid="overview-cost-provider" className="border-b border-zinc-900 align-top last:border-0">
                    <td className="py-1.5">
                      <span className="font-mono text-zinc-300">{row.key}</span>
                      <span className="block text-[11px] leading-4 text-zinc-600">{row.label}</span>
                    </td>
                    <td className="py-1.5 pl-2">{basisBadge(row.basis)}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums text-zinc-400">{money(row.coordinatorUsd)}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums text-zinc-400">{money(row.workerUsd)}</td>
                  </tr>
                ))}
                {!cost.byProvider.length ? <tr><td colSpan={4} className="py-2 text-zinc-500">No cost recorded yet.</td></tr> : null}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </Section>
  );
}

function Example({ overview }: { overview: OverviewPayload }) {
  const example = overview.example;
  if (!example) {
    return (
      <Section id="example" eyebrow="07 · One outcome, end to end" title="No worked example yet">
        <p className="text-sm text-zinc-500">An example appears once a workstream with at least five assignments has concluded.</p>
      </Section>
    );
  }
  return (
    <Section
      id="example"
      eyebrow="07 · One outcome, end to end"
      title={example.title}
      lede={
        <>
          The most recently concluded workstream with at least five assignments, chosen automatically.{' '}
          {example.parent ? <>Opened by <span className="font-mono text-zinc-300">{example.parent}</span>. </> : 'Opened at the top level. '}
          {plural(example.passes, 'pass', 'passes')}, {plural(example.assignments, 'assignment')} ({example.actions} of them actions), {plural(example.steers, 'human steer')}, {money(example.costUsd)} recorded cost.{' '}
          <a href={workstreamHref(example.slug)} className="text-violet-300 hover:text-violet-200">Open it</a>
        </>
      }
    >
      <p className="max-w-3xl text-sm leading-6 text-zinc-300">{example.objective}</p>
      <Timeline
        timeline={example.timeline}
        earlierHref={`${workstreamHref(example.slug)}?tab=timeline&all=1`}
      />
    </Section>
  );
}

export function OverviewPage({ overview, scopeLabel, nowTab }: { overview: OverviewPayload; scopeLabel: string; nowTab?: string }) {
  return (
    <div data-testid="operator-overview-page">
      <header className="border-b border-zinc-900 px-5 py-6 sm:px-8">
        <div className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">{scopeLabel}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">How Weaver works, and what it is doing</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            A read-only account for people who have not used Weaver: what it is, where its work comes from, how that work ends, and what it costs. Every number is computed from the fleet's typed record as of {formatTimestamp(overview.generatedAt)}; nothing here is read from a transcript.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-6xl space-y-12 p-5 sm:p-8">
        <Explainer overview={overview} />
        <Origins overview={overview} />
        <Now overview={overview} selected={nowTab} />
        <Outcomes overview={overview} />
        <Signals overview={overview} />
        <Cost overview={overview} />
        <Example overview={overview} />
      </div>
    </div>
  );
}
