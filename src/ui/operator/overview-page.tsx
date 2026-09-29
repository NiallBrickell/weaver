import type { ReactNode } from 'react';

import {
  dollars as money,
  EXAMPLE_KIND_LABELS,
  overviewInsights,
  type Insight,
  type OriginRow,
  type OverviewPayload,
} from '../../overview.js';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '../components/index.js';
import { formatTimestamp } from '../inspect/model.js';
import { Timeline } from './timeline.js';

// Only timeless copy is written here, in plain English for someone new to
// Weaver. Every number, and every takeaway sentence a section leads with,
// comes from the computed overview (src/overview.ts), which is derived from
// Weaver's own records on each fleet revision.

const MAX_ORIGIN_ROWS = 12;

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

/** The computed takeaways a section leads with. Anything that looks off is
 * marked, so a reader can tell a warning from a plain fact at a glance. */
function Insights({ items }: { items: Insight[] }) {
  if (!items.length) return null;
  return (
    <div data-testid="overview-insights" className="mt-3 space-y-2">
      {items.map((item) => item.flag ? (
        <p key={item.text} data-testid="overview-flag" className="border-l-2 border-amber-400 pl-3 text-sm leading-6 text-amber-100">
          <span className="font-semibold text-amber-300">Worth a look: </span>{item.text}
        </p>
      ) : (
        <p key={item.text} className="text-base leading-7 text-zinc-100">{item.text}</p>
      ))}
    </div>
  );
}

function Section({ id, eyebrow, title, insights, lede, children }: {
  id: string;
  eyebrow: string;
  title: string;
  insights?: Insight[];
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} data-testid={`overview-${id}`} aria-labelledby={`overview-${id}-title`} className="space-y-4">
      <div className="max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-violet-300">{eyebrow}</p>
        <h2 id={`overview-${id}-title`} className="mt-1 text-xl font-semibold tracking-tight text-white">{title}</h2>
        {insights ? <Insights items={insights} /> : null}
        {lede ? <p className="mt-3 text-sm leading-6 text-zinc-400">{lede}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ value, label, detail, note }: { value: string; label: string; detail?: string; note?: string }) {
  return (
    <div className="border-t border-zinc-800 pt-3">
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-zinc-100">{value}</p>
      <p className="mt-0.5 text-sm text-zinc-300">{label}</p>
      {detail ? <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p> : null}
      {note ? <p data-testid="overview-stat-note" className="mt-1 text-xs leading-5 text-zinc-400">{note}</p> : null}
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
      aria-label="A person gives Weaver a new job or a message. Each job has one record in a shared database. Every few seconds the engine, which uses no AI model, starts a fresh model for a planning run: it reads the job's record, decides what to do next and saves its changes. It sends agents to do pieces of work and runs approved actions such as merging code. Agents hand back results that only count once Weaver accepts them; actions count once Weaver has checked they happened. Anything that needs a person comes back to the needs-you list."
      className="block h-auto w-full min-w-[820px]"
    >
      <defs>
        <marker id="ov-h" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" className="fill-zinc-400" /></marker>
        <marker id="ov-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" className="fill-violet-400" /></marker>
        <marker id="ov-p" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" className="fill-amber-400" /></marker>
      </defs>

      <rect className={zone} strokeDasharray="5 4" x="10" y="30" width="190" height="460" rx="10" />
      <text className={zoneLabel} x="22" y="22">People</text>
      <rect className={zone} strokeDasharray="5 4" x="280" y="30" width="260" height="460" rx="10" />
      <text className={zoneLabel} x="292" y="22">Shared database</text>
      <rect className={zone} strokeDasharray="5 4" x="620" y="30" width="370" height="460" rx="10" />
      <text className={zoneLabel} x="632" y="22">Runner · fresh AI models</text>
      <rect className={zone} strokeDasharray="5 4" x="1040" y="30" width="90" height="460" rx="10" />
      <text className={zoneLabel} x="1046" y="22">Outside</text>

      <rect className="fill-amber-500/10 stroke-amber-400" x="30" y="70" width="150" height="130" rx="8" />
      <text className={title} x="46" y="98">A person</text>
      <text className={mono} x="46" y="126">a new job</text>
      <text className={mono} x="46" y="150">a message</text>
      <text className={mono} x="46" y="174">approve / reject</text>

      <rect className={box} x="30" y="330" width="150" height="120" rx="8" />
      <text className={title} x="46" y="358">Needs you</text>
      <text className={sub} x="46" y="384">approvals · reviews</text>
      <text className={sub} x="46" y="406">blockers · budget</text>
      <text className={sub} x="46" y="428">board · this page</text>

      <rect className="fill-violet-500/10 stroke-violet-400" x="300" y="70" width="220" height="400" rx="8" />
      <text className={title} x="316" y="98">Job record</text>
      <text className={sub} x="316" y="118">one per job · {workstreams.toLocaleString('en-GB')} so far</text>
      <line className="stroke-zinc-800" x1="312" y1="134" x2="508" y2="134" />
      <text className={mono} x="316" y="160">goal + what done means</text>
      <text className={mono} x="316" y="194">current plan</text>
      <text className={sub} x="414" y="194">+ earlier ones</text>
      <text className={mono} x="316" y="228">pieces of work</text>
      <text className={sub} x="430" y="228">+ attempts</text>
      <text className={mono} x="316" y="262">results</text>
      <text className={sub} x="378" y="262">fixed once accepted</text>
      <text className={mono} x="316" y="296">scheduled wake-ups</text>
      <text className={mono} x="316" y="330">messages from people</text>
      <text className={mono} x="316" y="364">things that need you</text>
      <text className={mono} x="316" y="398">lessons</text>
      <text className={sub} x="384" y="398">learned + yours</text>
      <line className="stroke-zinc-800" x1="312" y1="420" x2="508" y2="420" />
      <text className={sub} x="316" y="446">every save checked against the</text>
      <text className={sub} x="316" y="462">version it was read from</text>

      <rect className={box} x="640" y="70" width="330" height="110" rx="8" />
      <text className={title} x="656" y="98">Planning run</text>
      <text className={sub} x="656" y="122">a fresh model every time, no memory of the last</text>
      <text className={sub} x="656" y="144">reads · checks results · accepts or rejects</text>
      <text className={sub} x="656" y="166">plans the next step · sets a wake-up · stops</text>

      <rect className={box} x="640" y="220" width="155" height="120" rx="8" />
      <text className={title} x="656" y="248">Agent run</text>
      <text className={sub} x="656" y="272">a fresh agent with one</text>
      <text className={sub} x="656" y="290">piece of work; hands</text>
      <text className={sub} x="656" y="308">back a result</text>

      <rect className={box} x="815" y="220" width="155" height="120" rx="8" />
      <text className={title} x="831" y="248">Action</text>
      <text className={sub} x="831" y="272">an exact command, run</text>
      <text className={sub} x="831" y="290">by Weaver itself, only</text>
      <text className={sub} x="831" y="308">after approval</text>

      <rect className={box} x="640" y="380" width="330" height="90" rx="8" />
      <text className={title} x="656" y="408">Engine</text>
      <text className={sub} x="656" y="432">every few seconds, no AI model involved:</text>
      <text className={sub} x="656" y="452">checks → sends → agents → wake-ups → planning</text>
      <line className="stroke-zinc-400" strokeWidth="1.4" x1="717" y1="380" x2="717" y2="344" markerEnd="url(#ov-h)" />
      <line className="stroke-zinc-400" strokeWidth="1.4" x1="892" y1="380" x2="892" y2="344" markerEnd="url(#ov-h)" />
      <text className={label} x="724" y="366">starts</text>
      <text className={label} x="899" y="366">starts</text>

      <rect className={box} x="1050" y="220" width="70" height="42" rx="6" />
      <text className={sub} x="1085" y="246" textAnchor="middle">GitHub</text>
      <rect className={box} x="1050" y="272" width="70" height="42" rx="6" />
      <text className={sub} x="1085" y="298" textAnchor="middle">Sentry</text>
      <rect className={box} x="1050" y="324" width="70" height="42" rx="6" />
      <text className={sub} x="1085" y="350" textAnchor="middle">other APIs</text>

      <line className="stroke-amber-400" strokeWidth="1.8" x1="180" y1="120" x2="298" y2="120" markerEnd="url(#ov-p)" />
      <text className="fill-amber-300 text-[11.5px] font-semibold" x="190" y="110">job, message</text>
      <text className={label} x="190" y="140">(a message wakes it)</text>
      <line className="stroke-amber-400" strokeWidth="1.8" x1="300" y1="390" x2="182" y2="390" markerEnd="url(#ov-p)" />
      <text className="fill-amber-300 text-[11.5px] font-semibold" x="190" y="380">what needs you</text>

      <line className="stroke-violet-400" strokeWidth="1.8" x1="520" y1="100" x2="638" y2="100" markerEnd="url(#ov-a)" />
      <text className="fill-violet-300 text-[11.5px] font-semibold" x="530" y="92">reads the record</text>
      <line className="stroke-violet-400" strokeWidth="1.8" x1="640" y1="150" x2="522" y2="150" markerEnd="url(#ov-a)" />
      <text className="fill-violet-300 text-[11.5px] font-semibold" x="530" y="142">saves changes</text>

      <line className="stroke-zinc-400" strokeWidth="1.4" x1="520" y1="250" x2="638" y2="250" markerEnd="url(#ov-h)" />
      <text className={label} x="530" y="242">piece of work</text>
      <line className="stroke-zinc-400" strokeWidth="1.4" x1="640" y1="310" x2="522" y2="310" markerEnd="url(#ov-h)" />
      <text className={label} x="530" y="302">result</text>

      <line className="stroke-zinc-400" strokeWidth="1.4" x1="522" y1="425" x2="638" y2="425" markerStart="url(#ov-h)" markerEnd="url(#ov-h)" />
      <text className={label} x="530" y="417">wake-ups, checks</text>

      <line className="stroke-zinc-400" strokeWidth="1.4" x1="970" y1="240" x2="1048" y2="240" markerEnd="url(#ov-h)" />
      <text className={label} x="978" y="232">merge, push</text>
      <line className="stroke-zinc-400" strokeWidth="1.4" x1="1048" y1="300" x2="972" y2="300" markerEnd="url(#ov-h)" />
      <text className={label} x="978" y="292">did it happen?</text>
    </svg>
  );
}

const GLOSSARY: Array<[string, string]> = [
  ['Job', 'Something Weaver has been asked to get done, with everything needed to finish it. Weaver\'s own code calls it a workstream. A job can last days or months.'],
  ['Routine', 'A job that wakes up on a schedule, looks for problems in one place and opens a new job for each real one.'],
  ['Piece of work', 'One bounded task inside a job, with a clear test for when it is done. If an attempt fails, the piece of work stays and gets another attempt.'],
  ['Planning run', 'Each time Weaver\'s planner looks at a job: a fresh model reads the job\'s record, decides the next step, saves its changes and stops. Weaver\'s code calls it a coordinator pass.'],
  ['Accepted or rejected result', 'An agent finishing is not enough. Weaver checks what came back and either accepts it, which makes it count, or rejects it.'],
  ['Current plan', 'The course a job is committed to right now, and why. A later planning run can replace it, but only openly, keeping the old one on record.'],
  ['Action', 'A change to the outside world, like merging code. It runs as an exact command, often needs approval first, and only counts once Weaver has checked it happened.'],
  ['Lesson', 'Something learned from a person\'s correction. It starts as a trial and applies more widely only once it has worked. It can never give Weaver more permission.'],
];

function Explainer({ overview, insights }: { overview: OverviewPayload; insights: Insight[] }) {
  return (
    <Section
      id="explainer"
      eyebrow="01 · What Weaver is"
      title="Weaver keeps track of each job; fresh AI agents do the work"
      insights={insights}
      lede="An AI agent can do a task. Weaver looks after the whole job: it writes down what is wanted, sends in a fresh agent for each piece, checks what comes back, and keeps going through failures, reviews and waits of several days until the job is done. No agent stays running between steps. Each step starts a new model that reads the job's record, does its part, saves its changes and stops. The record is the memory, not a chat history."
    >
      <Card className="bg-zinc-900/30">
        <CardContent className="overflow-x-auto p-4">
          <HowItWorksDiagram workstreams={overview.totals.workstreams} />
        </CardContent>
      </Card>
      <p className="max-w-3xl text-xs leading-5 text-zinc-500">
        The job record in the middle is the only thing that lasts. At each planning run a fresh model reads it, decides what to do and saves its changes. If a message or a result arrived in the meantime, the save is refused and the next planning run starts from the newer record. Results from agents only count once Weaver accepts them. Changes to the outside world, like merging code, run as exact commands and only count once Weaver has checked they really happened.
      </p>
      <dl data-testid="overview-glossary" className="grid gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 sm:grid-cols-2 xl:grid-cols-4">
        {GLOSSARY.map(([term, definition]) => (
          <div key={term} className="bg-zinc-950 p-4">
            <dt className="text-sm font-semibold text-zinc-100">{term}</dt>
            <dd className="mt-1 text-xs leading-5 text-zinc-400">{definition}</dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 xl:grid-cols-5">
        <Stat value={overview.totals.workstreams.toLocaleString('en-GB')} label="jobs" detail={`${overview.totals.active} active · ${overview.totals.paused} paused · ${overview.totals.done} finished`} />
        <Stat value={overview.totals.assignments.toLocaleString('en-GB')} label="pieces of work" detail={`${overview.totals.actionAssignments.toLocaleString('en-GB')} actions · ${overview.totals.workAssignments.toLocaleString('en-GB')} done by agents`} />
        <Stat value={overview.totals.passes.toLocaleString('en-GB')} label="planning runs" detail="including ones that had to wait or failed" />
        <Stat value={overview.totals.steers.toLocaleString('en-GB')} label="messages from people" detail="across every job" />
        <Stat value={money(overview.cost.totalUsd)} label="model cost recorded" detail="the cost section says how much is real money" />
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
    label: `${rest.length} other jobs`,
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

function Origins({ overview, insights }: { overview: OverviewPayload; insights: Insight[] }) {
  const rows = foldOrigins(overview.origins.rows);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Section
      id="origins"
      eyebrow="02 · Where work comes from"
      title="Who starts the jobs"
      insights={insights}
      lede="A person sets up a few routines. Each one wakes up on a schedule, looks somewhere for problems (error reports, monitoring alerts, support threads, code review comments) and opens a new job for each real one. If the same problem turns up again, the existing job is reused. Each bar below is one job that started others; the row for people counts work started directly by a person."
    >
      <Card className="bg-zinc-900/30">
        <CardContent className="space-y-2.5 p-4">
          {rows.length ? rows.map((row) => (
            <div key={row.parent ?? 'top-level'} data-testid="overview-origin-row" className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3 sm:grid-cols-[14rem_minmax(0,1fr)_3rem]">
              <span className="truncate font-mono text-xs text-zinc-300" title={row.label}>
                {row.parent ? <a href={workstreamHref(row.parent)} className="hover:text-white">{row.label}</a> : row.label}
              </span>
              <span className="order-3 col-span-2 flex h-3 overflow-hidden rounded bg-zinc-900 sm:order-none sm:col-span-1" title={`${row.active} active · ${row.paused} paused · ${row.done} finished`}>
                <span className="bg-violet-400" style={{ width: `${(row.active / max) * 100}%` }} />
                <span className="bg-amber-400" style={{ width: `${(row.paused / max) * 100}%` }} />
                <span className="bg-emerald-400/80" style={{ width: `${(row.done / max) * 100}%` }} />
              </span>
              <span className="text-right text-xs tabular-nums text-zinc-300">{row.count}</span>
            </div>
          )) : <p className="text-sm text-zinc-500">No jobs yet.</p>}
          <p className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-[11px] text-zinc-500">
            <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-violet-400" />active</span>
            <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-amber-400" />paused</span>
            <span><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-emerald-400/80" />finished</span>
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

function Now({ overview, insights, selected, exampleTab }: { overview: OverviewPayload; insights: Insight[]; selected?: string; exampleTab?: string }) {
  const groups = [...overview.now.groups].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  // A plain link per group (?now=<parent>), so the choice survives the shell's
  // live refresh, which re-fetches the current URL. Unknown or absent keys
  // fall back to the busiest group.
  const current = groups.find((group) => nowKey(group) === selected) ?? groups[0];
  return (
    <Section
      id="now"
      eyebrow="03 · What it's doing now"
      title="Active jobs"
      insights={insights}
      lede="One tab for each job that started others, plus one for work people started directly. Each card says what the job is for and, in purple, the plan it is following right now."
    >
      {current ? (
        <div className="space-y-4">
          <nav aria-label="Active jobs by who started them" data-testid="overview-now-tabs" className="-mx-1 flex gap-1 overflow-x-auto border-b border-zinc-800 px-1">
            {groups.map((group) => {
              const key = nowKey(group);
              const isCurrent = group === current;
              return (
                <a
                  key={key}
                  href={overviewQuery({ now: key, ...(exampleTab ? { example: exampleTab } : {}) }, 'now')}
                  data-inplace=""
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
                {item.decision ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-violet-300/90">Current plan: {item.decision}</p> : null}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function Outcomes({ overview, insights }: { overview: OverviewPayload; insights: Insight[] }) {
  const { outcomes } = overview;
  const max = Math.max(1, ...outcomes.rows.map((r) => r.count));
  return (
    <Section
      id="outcomes"
      eyebrow="04 · How jobs ended"
      title="Finished jobs"
      insights={insights}
      lede="Weaver can only mark a job finished by pointing to evidence: an accepted result, an action it checked really happened, or a person's instruction. It also records what kind of ending it was. Jobs that finished before it started doing that are counted on their own line rather than guessed."
    >
      <Card className="bg-zinc-900/30">
        <CardContent className="p-0">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-2 font-medium">How it ended</th>
                <th className="px-4 py-2 text-right font-medium">Jobs</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell"><span className="sr-only">Share</span></th>
                <th className="px-4 py-2 text-right font-medium">Typical cost</th>
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
              {!outcomes.rows.length ? <tr><td colSpan={5} className="px-4 py-3 text-zinc-500">No job has finished yet.</td></tr> : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="bg-zinc-900/20">
          <CardContent className="p-4 text-sm leading-6 text-zinc-400">
            <p><span className="font-semibold text-zinc-200">{plural(outcomes.doneWithoutConclusion, 'job')}</span> closed without saying how {outcomes.doneWithoutConclusion === 1 ? 'it' : 'they'} ended. These don't count as successes.</p>
          </CardContent>
        </Card>
        <Card data-testid="overview-paused" className="bg-zinc-900/20">
          <CardContent className="p-4 text-sm leading-6 text-zinc-400">
            <p><span className="font-semibold text-amber-300">{outcomes.paused.length} paused.</span> A person paused these without finishing them. They keep their record and can be picked back up.</p>
            {outcomes.paused.length ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-zinc-500">Show paused jobs</summary>
                <ul className="mt-2 space-y-1">
                  {outcomes.paused.map((item) => (
                    <li key={item.slug} className="truncate text-xs">
                      <a href={workstreamHref(item.slug)} className="text-zinc-300 hover:text-white">{item.title}</a>
                      {item.parent ? <span className="text-zinc-600"> · started by {item.parent}</span> : null}
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

function Signals({ overview, insights }: { overview: OverviewPayload; insights: Insight[] }) {
  const { signals } = overview;
  const { adoption, firstAttempt, merges, repairsOfRepairs, interventions, passes } = signals;
  return (
    <Section
      id="signals"
      eyebrow="05 · Useful work or churn?"
      title="Is the work useful?"
      insights={insights}
      lede="No single number settles it. Together these show whether results are accepted, whether work succeeds first time, whether changes land, and whether people have to step in less over time."
    >
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
        <Stat
          value={pct(adoption.accepted, adoption.judged)}
          label="of checked results accepted"
          detail={`${adoption.accepted.toLocaleString('en-GB')} accepted and ${adoption.rejected.toLocaleString('en-GB')} rejected, of ${adoption.judged.toLocaleString('en-GB')} Weaver has checked. ${adoption.pending} still waiting to be checked.`}
        />
        <Stat
          value={firstAttempt.rate === null ? '—' : pct(firstAttempt.firstAttempt, firstAttempt.completed)}
          label="of finished pieces of work succeeded first try"
          detail={`${firstAttempt.firstAttempt.toLocaleString('en-GB')} of ${firstAttempt.completed.toLocaleString('en-GB')}; ${firstAttempt.failed} failed outright.`}
        />
        <Stat
          value={pct(merges.confirmed, merges.total)}
          label="of merges confirmed on GitHub"
          detail={`${merges.confirmed} confirmed, ${merges.failedReadback} didn't go through and ${merges.notRun} haven't run, of ${plural(merges.total, 'merge attempt')}. A merge is spotted by "gh pr merge" in the action's command.`}
          note="This counts merges, not whether the code was good. Checking quality needs GitHub history, which this page doesn't read yet."
        />
        <Stat
          value={repairsOfRepairs.count.toLocaleString('en-GB')}
          label="jobs opened by a job another job opened"
          detail={`Out of ${repairsOfRepairs.managed.toLocaleString('en-GB')} jobs started by other jobs. A rising share would mean fixes are causing more fixes.`}
        />
        <Stat
          value={interventions.perOutcome === null ? '—' : interventions.perOutcome.toFixed(2)}
          label="times a person stepped in, per successfully finished job"
          detail={`${interventions.count.toLocaleString('en-GB')} messages, approvals, rejections and overrides across ${plural(interventions.successfulOutcomes, 'successfully finished job')}. Weaver tries to push this down without checking its work any less.`}
        />
        <Stat
          value={pct(passes.completed, passes.total)}
          label="of planning runs completed"
          detail={`${passes.completed.toLocaleString('en-GB')} of ${passes.total.toLocaleString('en-GB')}; ${passes.providerBackoff.toLocaleString('en-GB')} waited for model capacity and ${passes.logicalFailure.toLocaleString('en-GB')} failed for other reasons.`}
        />
      </div>
    </Section>
  );
}

function basisBadge(basis: OverviewPayload['cost']['byProvider'][number]['basis']) {
  if (basis === 'cash') return <Badge variant="warning">real money</Badge>;
  if (basis === 'subscription-notional') return <Badge variant="outline">estimate</Badge>;
  return <Badge variant="neutral">unknown</Badge>;
}

function Cost({ overview, insights }: { overview: OverviewPayload; insights: Insight[] }) {
  const { cost } = overview;
  const families = cost.byFamily.slice(0, 12);
  return (
    <Section
      id="cost"
      eyebrow="06 · What it costs"
      title="Model cost"
      insights={insights}
      lede="Added up from every planning run and every agent run. Not all of it is money actually spent: runs through the Claude SDK on a subscription report a list price that isn't charged, while OpenRouter charges for every use."
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        <Stat value={cost.coordinatorShare === null ? '—' : pct(cost.coordinatorUsd, cost.totalUsd)} label="spent deciding what to do next" detail={`${money(cost.coordinatorUsd)} on planning runs · ${money(cost.workerUsd)} on agents doing the work`} />
        <Stat value={money(cost.byBasis.cash)} label="real money" detail="OpenRouter" />
        <Stat value={money(cost.byBasis['subscription-notional'])} label="estimate, on a subscription" detail="Anthropic through the Claude SDK" />
        <Stat
          value={cost.perOutcome.medianUsd === null ? '—' : money(cost.perOutcome.medianUsd)}
          label="typical cost of a finished job"
          detail={`${money(cost.perOutcome.totalUsd)} across ${plural(cost.perOutcome.count, 'finished job')}`}
        />
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card className="bg-zinc-900/20">
          <CardHeader className="pb-2"><CardTitle className="text-sm">By group of work</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="mb-2 text-xs leading-5 text-zinc-500">A group is a job plus every job it opened directly. Jobs people started that opened nothing are grouped together.</p>
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500"><tr className="border-b border-zinc-800"><th className="py-1.5 font-medium">Group</th><th className="py-1.5 text-right font-medium">Jobs</th><th className="py-1.5 text-right font-medium">Itself</th><th className="py-1.5 text-right font-medium">Jobs it opened</th><th className="py-1.5 text-right font-medium">Total</th></tr></thead>
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
                {!families.length ? <tr><td colSpan={5} className="py-2 text-zinc-500">No jobs yet.</td></tr> : null}
              </tbody>
            </table>
            {cost.byFamily.length > families.length ? <p className="mt-2 text-[11px] text-zinc-600">{cost.byFamily.length - families.length} smaller groups not shown.</p> : null}
          </CardContent>
        </Card>
        <Card className="bg-zinc-900/20">
          <CardHeader className="pb-2"><CardTitle className="text-sm">By where the model ran</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500"><tr className="border-b border-zinc-800"><th className="py-1.5 font-medium">Where</th><th className="py-1.5 font-medium">Billing</th><th className="py-1.5 pl-3 text-right font-medium">Planning runs</th><th className="py-1.5 pl-3 text-right font-medium">Agents</th></tr></thead>
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

/** The overview's query string, keeping the other section's tab choice so
 * picking one tab never resets the other. */
function overviewQuery(params: { now?: string; example?: string }, anchor: string): string {
  const search = new URLSearchParams();
  if (params.now) search.set('now', params.now);
  if (params.example) search.set('example', params.example);
  return `?${search.toString()}#${anchor}`;
}

function Examples({ overview, tabs }: { overview: OverviewPayload; tabs: { now?: string; example?: string } }) {
  const { examples } = overview;
  const current = examples.find((example) => example.kind === tabs.example) ?? examples[0];
  if (!current) {
    return (
      <Section id="example" eyebrow="07 · Examples, start to finish" title="No examples yet">
        <p className="text-sm text-zinc-500">Examples appear once a job with at least five pieces of work has finished.</p>
      </Section>
    );
  }
  return (
    <Section
      id="example"
      eyebrow="07 · Examples, start to finish"
      title="How a job ends, step by step"
      lede="One recent example for each way a job can end, picked automatically. Weaver prefers one that is easy to follow (at most 30 pieces of work and 60 planning runs, with no more than a quarter of results rejected) over simply the newest."
    >
      <nav aria-label="Examples" data-testid="overview-example-tabs" className="-mx-1 flex gap-1 overflow-x-auto border-b border-zinc-800 px-1">
        {examples.map((example) => {
          const isCurrent = example === current;
          return (
            <a
              key={example.kind}
              href={overviewQuery({ ...tabs, example: example.kind }, 'example')}
              data-inplace=""
              data-testid={`overview-example-tab-${example.kind}`}
              aria-current={isCurrent ? 'page' : undefined}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-xs transition ${isCurrent ? 'border-violet-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
            >
              {EXAMPLE_KIND_LABELS[example.kind]}
            </a>
          );
        })}
      </nav>
      <div data-testid="overview-example-current" className="space-y-3">
        <h3 className="text-base font-semibold text-zinc-100">{current.title}</h3>
        <p className="text-sm leading-6 text-zinc-400">
          {current.parent ? <>Started by <span className="font-mono text-zinc-300">{current.parent}</span>. </> : 'Started directly by a person. '}
          {plural(current.passes, 'planning run')}, {plural(current.assignments, 'piece of work', 'pieces of work')} ({current.actions} of them actions), {plural(current.steers, 'message from people', 'messages from people')}, {money(current.costUsd)} of model cost.{' '}
          <a href={workstreamHref(current.slug)} className="text-violet-300 hover:text-violet-200">Open it</a>
        </p>
        <p className="max-w-3xl text-sm leading-6 text-zinc-300">{current.objective}</p>
        <Timeline
          timeline={current.timeline}
          earlierHref={`${workstreamHref(current.slug)}?tab=timeline&all=1`}
        />
      </div>
    </Section>
  );
}

export function OverviewPage({ overview, scopeLabel, nowTab, exampleTab }: { overview: OverviewPayload; scopeLabel: string; nowTab?: string; exampleTab?: string }) {
  const insights = overviewInsights(overview);
  return (
    <div data-testid="operator-overview-page">
      <header className="border-b border-zinc-900 px-5 py-6 sm:px-8">
        <div className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-600">{scopeLabel}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">How Weaver works, and what it is doing</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            A plain-English tour of the fleet for anyone new to Weaver: what it is, where its work comes from, how that work ends, whether it is useful, and what it costs. Every number and every summary sentence is worked out from Weaver's own records, as of {formatTimestamp(overview.generatedAt)}, and the page updates as things change.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-6xl space-y-12 p-5 sm:p-8">
        <Explainer overview={overview} insights={insights.intro} />
        <Origins overview={overview} insights={insights.origins} />
        <Now overview={overview} insights={insights.now} selected={nowTab} {...(exampleTab ? { exampleTab } : {})} />
        <Outcomes overview={overview} insights={insights.outcomes} />
        <Signals overview={overview} insights={insights.signals} />
        <Cost overview={overview} insights={insights.cost} />
        <Examples overview={overview} tabs={{ ...(nowTab ? { now: nowTab } : {}), ...(exampleTab ? { example: exampleTab } : {}) }} />
      </div>
    </div>
  );
}
