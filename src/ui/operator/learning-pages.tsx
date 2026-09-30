import type { RoutineScheduleRow } from '../../fleetHealth.js';
import type { OverviewPayload } from '../../overview.js';
import { isDoctrine, policyOrigin, type PolicyRecord } from '../../policies.js';
import type { RatioPoint, StatsPayload } from '../../stats.js';
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '../components/index.js';
import { firstLine, formatTimestamp, learnedGroups } from '../inspect/model.js';

// The policies page, the analytics page, and the fleet page's routine list.
// Every number comes from typed state through the same functions `weaver
// stats` and the overview use (computeStats, learnedGroups, routineSchedule);
// only timeless copy lives here.

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

function workstreamHref(slug: string): string {
  return `/workstreams/${encodeURIComponent(slug)}`;
}

/** "3 hours ago" / "in 20 minutes", coarse on purpose: the exact time sits in
 * the title attribute for anyone who needs it. */
export function relativeTime(iso: string, now: Date): string {
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  const abs = Math.abs(ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const amount = abs < minute
    ? 'less than a minute'
    : abs < hour
      ? plural(Math.round(abs / minute), 'minute')
      : abs < day
        ? plural(Math.round(abs / hour), 'hour')
        : plural(Math.round(abs / day), 'day');
  return ms < 0 ? `${amount} ago` : `in ${amount}`;
}

function PageTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="border-b border-zinc-900 px-5 py-6 sm:px-8">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-violet-300">{eyebrow}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{title}</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">{description}</p>
    </header>
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

// ---------------------------------------------------------------------------
// Policies

type PolicyGroupKey = 'doctrine' | 'active' | 'contested' | 'shadowProven' | 'shadowUnproven' | 'superseded';

const POLICY_GROUPS: Array<{ key: PolicyGroupKey; title: string; description: string; folded?: boolean }> = [
  { key: 'doctrine', title: 'Your rules', description: 'Taken from your own words or rules file. They apply straight away and win over anything the fleet learned.' },
  { key: 'active', title: 'Learned and in use', description: 'Lessons that proved themselves: a later job followed them and nobody had to step in.' },
  { key: 'contested', title: 'Under review', description: 'A job still needed a correction on this point, so it is not treated as settled guidance until someone reviews it.' },
  { key: 'shadowProven', title: 'On trial, with evidence', description: 'Learned from a correction and tried at least once, but not yet proven on a different job.' },
  { key: 'shadowUnproven', title: 'On trial, not yet tried', description: 'Learned from a correction and never tried since.', folded: true },
  { key: 'superseded', title: 'Retired', description: 'Replaced by a newer rule or withdrawn. Kept so the history stays readable.', folded: true },
];

function statusBadge(policy: PolicyRecord) {
  if (policy.status === 'superseded') return <Badge variant="outline">retired</Badge>;
  if (isDoctrine(policy)) return <Badge variant="accent">your rule</Badge>;
  if (policy.contested) return <Badge variant="attention">under review</Badge>;
  if (policy.status === 'active') return <Badge variant="success">in use</Badge>;
  return <Badge variant="warning">on trial</Badge>;
}

const EFFECT_LABELS: Record<PolicyRecord['effect']['kind'], string> = {
  add_verification: 'Adds a check',
  narrow_authority: 'Narrows what jobs may do',
  advisory: 'Advice',
};

function provenanceLine(policy: PolicyRecord): string {
  const p = policy.provenance;
  if ('workstreamSlug' in p) {
    return p.directiveQuote
      ? `Your words in job ${p.workstreamSlug}: “${p.directiveQuote}”`
      : `Learned from a correction in job ${p.workstreamSlug}`;
  }
  if (p.source === 'backfill:rules') return `From your rules file: ${p.ref}`;
  if (p.source === 'backfill:sessions') return p.quote ? `From an earlier session (${p.ref}): “${p.quote}”` : `From an earlier session: ${p.ref}`;
  return `Imported from ${policyOrigin(policy)}`;
}

function PolicyItem({ policy }: { policy: PolicyRecord }) {
  const clean = policy.evidence.filter((evidence) => evidence.interventionFree).length;
  const needed = policy.evidence.length - clean;
  return (
    <details data-testid={`policy-${policy.id}`} className="border-t border-zinc-900 py-3 first:border-t-0">
      <summary className="flex cursor-pointer flex-wrap items-start gap-2 text-sm">
        {statusBadge(policy)}
        <span className="min-w-0 flex-1 text-zinc-200">{firstLine(policy.statement, 200)}</span>
        <span className="shrink-0 text-xs text-zinc-500" title="Jobs that followed this without anyone stepping in, out of all jobs that tried it">
          {policy.evidence.length ? `${clean} of ${policy.evidence.length} went cleanly` : 'not tried yet'}
        </span>
      </summary>
      <div className="mt-3 space-y-2 border-l border-zinc-800 pl-3 text-xs leading-5 text-zinc-400">
        <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-200">{policy.statement}</p>
        {policy.mechanism ? <p><span className="text-zinc-500">How it is done today: </span>{policy.mechanism}</p> : null}
        <p><span className="text-zinc-500">{EFFECT_LABELS[policy.effect.kind]}: </span>{policy.effect.description}</p>
        <p>
          <span className="text-zinc-500">Applies to jobs tagged </span>
          {policy.scope.tags.length ? policy.scope.tags.map((tag) => (
            <span key={tag} className="mr-1 inline-block rounded border border-zinc-800 px-1.5 font-mono text-[11px] text-zinc-300">{tag}</span>
          )) : <span>nothing yet</span>}
        </p>
        <p><span className="text-zinc-500">Where it came from: </span>{provenanceLine(policy)}</p>
        <p><span className="text-zinc-500">Added </span>{formatTimestamp(policy.createdAt)}</p>
        {policy.contested ? <p className="text-rose-300">Under review since {formatTimestamp(policy.contested.at)}: {policy.contested.note}</p> : null}
        {policy.supersededBy ? <p>Replaced by <span className="font-mono">{policy.supersededBy}</span></p> : null}
        {policy.supersededReason ? <p>Retired: {policy.supersededReason}</p> : null}
        {policy.supersedes ? <p>Replaces <span className="font-mono">{policy.supersedes}</span></p> : null}
        {policy.evidence.length ? (
          <div>
            <p className="text-zinc-500">Evidence ({clean} clean{needed ? `, ${needed} still needed a person` : ''}):</p>
            <ul className="mt-1 space-y-1">
              {[...policy.evidence].reverse().slice(0, 8).map((evidence, index) => (
                <li key={`${evidence.workstreamSlug}-${evidence.at}-${index}`} className="flex gap-2">
                  <span className={evidence.interventionFree ? 'text-emerald-300' : 'text-rose-300'}>{evidence.interventionFree ? 'clean' : 'needed a person'}</span>
                  <a href={workstreamHref(evidence.workstreamSlug)} className="font-mono text-zinc-300 hover:text-white">{evidence.workstreamSlug}</a>
                  <span className="min-w-0 flex-1 truncate">{evidence.note}</span>
                </li>
              ))}
            </ul>
            {policy.evidence.length > 8 ? <p className="mt-1 text-zinc-600">and {policy.evidence.length - 8} earlier</p> : null}
          </div>
        ) : null}
        <p className="font-mono text-[11px] text-zinc-600">{policy.id}</p>
      </div>
    </details>
  );
}

export function PoliciesPage({ policies }: { policies: PolicyRecord[] }) {
  const groups = learnedGroups(policies);
  const inUse = groups.doctrine.length + groups.active.length;
  const onTrial = groups.shadowProven.length + groups.shadowUnproven.length;
  const pending = [
    onTrial ? `${plural(onTrial, 'lesson')} ${onTrial === 1 ? 'is' : 'are'} on trial` : '',
    groups.contested.length ? `${plural(groups.contested.length, 'lesson')} ${groups.contested.length === 1 ? 'needs' : 'need'} review` : '',
  ].filter(Boolean);
  const takeaway = policies.length
    ? `${plural(inUse, 'rule')} ${inUse === 1 ? 'is' : 'are'} guiding jobs now (${groups.doctrine.length} yours, ${groups.active.length} learned).${pending.length ? ` ${pending.join(' and ')}.` : ''}`
    : 'No rules or lessons yet. When you correct a job, Weaver may record the lesson here and try it on later jobs.';
  return (
    <div data-testid="operator-policies-page">
      <PageTitle
        eyebrow="Policies"
        title="What the fleet has learned"
        description="Rules jobs follow: your own, and lessons learned from your corrections. A lesson starts on trial and is only used as settled guidance once a later job follows it without anyone stepping in. Nothing here can let a job send, spend, merge, or deploy."
      />
      <div className="mx-auto max-w-5xl space-y-4 p-5 sm:p-8">
        <p data-testid="policies-takeaway" className="text-base leading-7 text-zinc-100">{takeaway}</p>
        {POLICY_GROUPS.filter((group) => groups[group.key].length).map((group) => {
          const items = groups[group.key];
          const body = <div className="px-4 pb-1">{items.map((policy) => <PolicyItem key={policy.id} policy={policy} />)}</div>;
          return group.folded ? (
            <details key={group.key} data-testid={`policies-group-${group.key}`} className="rounded-xl border border-zinc-900 bg-zinc-900/20">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-300">
                {group.title} <span className="ml-1 text-zinc-600">{items.length}</span>
                <span className="mt-0.5 block text-xs font-normal text-zinc-500">{group.description}</span>
              </summary>
              {body}
            </details>
          ) : (
            <Card key={group.key} data-testid={`policies-group-${group.key}`} className="bg-zinc-900/20">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-sm">{group.title}</CardTitle>
                  <span className="text-xs text-zinc-600">{items.length}</span>
                </div>
                <p className="text-xs leading-5 text-zinc-500">{group.description}</p>
              </CardHeader>
              <CardContent className="px-0 pt-0">{body}</CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analytics

const CHART_W = 720;
const CHART_H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 40 };

function linePath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
}

/** Server-drawn: the operator UI allows no chart library, and a static SVG
 * reads the same with scripts off. */
function InterventionCurve({ ratio }: { ratio: RatioPoint[] }) {
  const points = ratio.filter((point) => point.ratio !== null || point.ratioAdopted !== null);
  if (points.length < 2) {
    return <p data-testid="analytics-curve-empty" className="text-sm text-zinc-500">The line appears once there are at least two days with a finished job.</p>;
  }
  const max = Math.max(...points.flatMap((point) => [point.ratio ?? 0, point.ratioAdopted ?? 0]), 0.5);
  const top = Math.ceil(max * 2) / 2;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + (points.length === 1 ? 0 : (index / (points.length - 1)) * innerW);
  const y = (value: number) => PAD.top + innerH - (value / top) * innerH;
  const series = (pick: (point: RatioPoint) => number | null) => linePath(points
    .map((point, index) => ({ value: pick(point), index }))
    .filter((point): point is { value: number; index: number } => point.value !== null)
    .map((point) => ({ x: x(point.index), y: y(point.value) })));
  const ticks = [0, top / 2, top];
  const last = points.at(-1)!;
  return (
    <figure data-testid="analytics-curve" className="space-y-2">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={`Times a person stepped in per successfully finished job, from ${points[0]!.day} to ${last.day}. Latest: ${last.ratio === null ? 'none yet' : last.ratio.toFixed(2)}.`} className="block h-auto w-full">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-zinc-800" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" className="fill-zinc-500 text-[11px]">{tick.toFixed(tick % 1 ? 1 : 0)}</text>
          </g>
        ))}
        <path d={series((point) => point.ratioAdopted)} fill="none" className="stroke-zinc-500" strokeWidth="1.5" strokeDasharray="4 4" />
        <path data-testid="analytics-curve-line" d={series((point) => point.ratio)} fill="none" className="stroke-violet-400" strokeWidth="2.5" strokeLinejoin="round" />
        <text x={PAD.left} y={CHART_H - 8} className="fill-zinc-500 text-[11px]">{points[0]!.day}</text>
        <text x={CHART_W - PAD.right} y={CHART_H - 8} textAnchor="end" className="fill-zinc-500 text-[11px]">{last.day}</text>
      </svg>
      <figcaption className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-violet-400" />per job finished well (the target)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t border-dashed border-zinc-500" />per accepted result (an early signal)</span>
        <span>Running totals, so a single busy day cannot swing it.</span>
      </figcaption>
    </figure>
  );
}

export function trendSentence(stats: StatsPayload): string | null {
  const current = stats.ratio.at(-1)?.ratio ?? null;
  const weekAgo = stats.totals.perOutcomeWeekAgo;
  if (current === null || weekAgo === null) return null;
  const diff = current - weekAgo;
  // The chart counts only dated interventions, so its level sits below the
  // lifetime headline. Quoting both chart endpoints keeps the comparison like
  // with like; "down from 3.58" beside a headline of 3.85 read as a contradiction.
  const trend = `On the chart, which counts only dated interventions, it is ${current.toFixed(2)} now against ${weekAgo.toFixed(2)} a week ago`;
  if (Math.abs(diff) < 0.005) return `${trend}: unchanged.`;
  return diff < 0 ? `${trend}, so jobs are needing you less.` : `${trend}, so jobs are needing you more.`;
}

const RECENT_DAYS = 14;
const MAX_JOB_ROWS = 25;

export function AnalyticsPage({ stats, overview }: { stats: StatsPayload; overview: OverviewPayload }) {
  const t = stats.totals;
  const per = t.interventionsPerOutcome;
  const trend = trendSentence(stats);
  const { adoption } = overview.signals;
  const approvals = t.autoApproved + t.humanApproved;
  const recent = stats.days.slice(-RECENT_DAYS).reverse();
  const jobs = [...stats.rows]
    .filter((row) => row.interventions > 0 || row.adopted > 0 || row.rejected > 0)
    .sort((a, b) => b.interventions - a.interventions || b.adopted - a.adopted)
    .slice(0, MAX_JOB_ROWS);
  return (
    <div data-testid="operator-analytics-page">
      <PageTitle
        eyebrow="Analytics"
        title="Is Weaver needing you less often?"
        description="The goal is fewer times a person has to step in for each job that finishes well, without weaker work or wider permissions. Stepping in means sending a job a message, approving or rejecting an action, resolving a question, or overriding which result was accepted."
      />
      <div className="mx-auto max-w-6xl space-y-6 p-5 sm:p-8">
        <section data-testid="analytics-headline" className="space-y-2">
          <p className="text-base leading-7 text-zinc-100">
            {per === null
              ? 'No job has finished well yet, so there is nothing to divide by.'
              : `Each job that finished well needed a person ${per.toFixed(2)} times on average (${plural(t.interventions, 'time')} across ${plural(t.successfulOutcomes, 'job')}).`}
            {trend ? ` ${trend}` : ''}
          </p>
        </section>

        <Card className="bg-zinc-900/20">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Times a person stepped in, per job finished well</CardTitle></CardHeader>
          <CardContent className="pt-0"><InterventionCurve ratio={stats.ratio} /></CardContent>
        </Card>

        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            value={per === null ? '—' : per.toFixed(2)}
            label="times stepped in, per job finished well"
            detail={t.interventionsPerAdopted === null ? undefined : `${t.interventionsPerAdopted.toFixed(2)} per accepted result`}
          />
          <Stat
            value={t.successfulOutcomes.toLocaleString('en-GB')}
            label="jobs finished well"
            detail={`${t.dispositions.delivered} delivered · ${t.dispositions.no_change_needed} found nothing needed changing${t.unclassifiedOutcomes ? ` · ${t.unclassifiedOutcomes} from before outcomes were recorded` : ''}`}
          />
          <Stat
            value={t.closedWithoutDelivery.toLocaleString('en-GB')}
            label="jobs closed without delivering"
            detail={`${t.dispositions.not_worth_doing} not worth doing · ${t.dispositions.duplicate} duplicates · ${t.dispositions.directed_closed} closed by a person`}
          />
          <Stat
            value={pct(adoption.rejected, adoption.judged)}
            label="of checked results rejected"
            detail={`${adoption.rejected.toLocaleString('en-GB')} rejected, ${adoption.accepted.toLocaleString('en-GB')} accepted${adoption.pending ? `, ${adoption.pending} waiting to be checked` : ''}`}
          />
          <Stat
            value={t.interventions.toLocaleString('en-GB')}
            label="times a person stepped in"
            detail={`${t.attribution.human} by people · ${t.attribution.session} by agent sessions on their behalf${t.attribution.unattributed ? ` · ${t.attribution.unattributed} not attributed` : ''}${t.undated ? ` · ${t.undated} undated` : ''}`}
          />
          <Stat
            value={pct(t.autoApproved, approvals)}
            label="of approved actions approved automatically"
            detail={`${t.autoApproved} within your standing approval rules · ${t.humanApproved} by a person. This moves only when those rules change, never from learning.`}
          />
          <Stat
            value={t.reliability.firstAttemptRate === null ? '—' : pct(t.reliability.firstAttempt, t.reliability.completed)}
            label="of finished pieces of work succeeded first try"
            detail={`${t.reliability.firstAttempt} of ${t.reliability.completed}${t.reliability.neededRetry ? ` · ${pct(t.reliability.recovered, t.reliability.neededRetry)} of retries recovered` : ''}`}
          />
          <Stat
            value={t.policiesActive.toLocaleString('en-GB')}
            label="learned rules in use"
            detail={`${t.policiesShadow} on trial · ${t.policiesSuperseded} retired`}
          />
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-2">
          <Card className="bg-zinc-900/20">
            <CardHeader className="pb-2"><CardTitle className="text-sm">Last {RECENT_DAYS} days</CardTitle></CardHeader>
            <CardContent className="pt-0">
              {recent.length ? (
                <div className="overflow-x-auto">
                  <table data-testid="analytics-days" className="w-full text-left text-xs">
                    <thead className="text-zinc-500"><tr className="border-b border-zinc-800">
                      <th className="py-1.5 font-medium">Day</th>
                      <th className="py-1.5 text-right font-medium">Stepped in</th>
                      <th className="py-1.5 text-right font-medium">Finished well</th>
                      <th className="py-1.5 text-right font-medium">Accepted</th>
                      <th className="py-1.5 text-right font-medium">Rejected</th>
                      <th className="py-1.5 text-right font-medium">Auto-approved</th>
                    </tr></thead>
                    <tbody className="tabular-nums text-zinc-300">
                      {recent.map((day) => (
                        <tr key={day.day} className="border-b border-zinc-900 last:border-0">
                          <td className="py-1.5 text-zinc-400">{day.day}</td>
                          <td className="py-1.5 text-right">{day.interventions}</td>
                          <td className="py-1.5 text-right">{day.conclusions}</td>
                          <td className="py-1.5 text-right">{day.adoptions}</td>
                          <td className="py-1.5 text-right">{day.rejections}</td>
                          <td className="py-1.5 text-right">{day.autoApproved}/{day.autoApproved + day.humanApproved}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-sm text-zinc-500">No activity yet.</p>}
            </CardContent>
          </Card>

          <Card className="bg-zinc-900/20">
            <CardHeader className="pb-2"><CardTitle className="text-sm">Who stepped in</CardTitle></CardHeader>
            <CardContent className="pt-0">
              <p className="mb-2 text-xs leading-5 text-zinc-500">Agent sessions stepping in on someone's behalf are cheap; a person's time is what this should save first. Automatic approvals never count here.</p>
              {stats.actors.totals.length ? (
                <table data-testid="analytics-actors" className="w-full text-left text-xs">
                  <thead className="text-zinc-500"><tr className="border-b border-zinc-800">
                    <th className="py-1.5 font-medium">Who</th>
                    <th className="py-1.5 text-right font-medium">Messages</th>
                    <th className="py-1.5 text-right font-medium">Approvals</th>
                    <th className="py-1.5 text-right font-medium">Rejections</th>
                    <th className="py-1.5 text-right font-medium">Answers</th>
                    <th className="py-1.5 text-right font-medium">Overrides</th>
                    <th className="py-1.5 text-right font-medium">Total</th>
                  </tr></thead>
                  <tbody className="tabular-nums text-zinc-300">
                    {stats.actors.totals.map((actor) => (
                      <tr key={actor.actor} className="border-b border-zinc-900 last:border-0">
                        <td className="max-w-40 truncate py-1.5 text-zinc-200" title={actor.actor}>{actor.actor}</td>
                        <td className="py-1.5 text-right">{actor.byKind.steering}</td>
                        <td className="py-1.5 text-right">{actor.byKind.approval}</td>
                        <td className="py-1.5 text-right">{actor.byKind.rejection}</td>
                        <td className="py-1.5 text-right">{actor.byKind.resolution}</td>
                        <td className="py-1.5 text-right">{actor.byKind.adoption}</td>
                        <td className="py-1.5 text-right font-semibold">{actor.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-sm text-zinc-500">Nobody has stepped in yet.</p>}
            </CardContent>
          </Card>
        </div>

        <Card className="bg-zinc-900/20">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Jobs that needed you most</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="mb-2 text-xs leading-5 text-zinc-500">When the line above moves, this is where to look. Jobs differ in what they ask for, so compare similar work.</p>
            {jobs.length ? (
              <div className="overflow-x-auto">
                <table data-testid="analytics-jobs" className="w-full text-left text-xs">
                  <thead className="text-zinc-500"><tr className="border-b border-zinc-800">
                    <th className="py-1.5 font-medium">Job</th>
                    <th className="py-1.5 font-medium">State</th>
                    <th className="py-1.5 text-right font-medium">Stepped in</th>
                    <th className="py-1.5 text-right font-medium">Accepted</th>
                    <th className="py-1.5 text-right font-medium">Rejected</th>
                    <th className="py-1.5 text-right font-medium">Auto-approved</th>
                  </tr></thead>
                  <tbody className="tabular-nums text-zinc-300">
                    {jobs.map((row) => (
                      <tr key={row.slug} className="border-b border-zinc-900 last:border-0">
                        <td className="max-w-md truncate py-1.5"><a href={workstreamHref(row.slug)} className="text-zinc-200 hover:text-white">{row.title}</a></td>
                        <td className="py-1.5 text-zinc-500">{row.concluded ? 'finished well' : row.disposition ? 'closed' : row.status}</td>
                        <td className="py-1.5 text-right">{row.interventions}</td>
                        <td className="py-1.5 text-right">{row.adopted}</td>
                        <td className="py-1.5 text-right">{row.rejected}</td>
                        <td className="py-1.5 text-right">{row.autoApproved}/{row.autoApproved + row.humanApproved}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="text-sm text-zinc-500">No job has needed you yet.</p>}
          </CardContent>
        </Card>

        <p className="text-xs leading-5 text-zinc-600">
          Counted from Weaver's own records of messages, approvals, accepted results and finished jobs, never from logs. A job counts as finished well when it was recorded as delivered or as needing no change. Updated {formatTimestamp(stats.generatedAt)}.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routines (on the fleet page)

function watchCadence(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'every day' : `every ${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? 'every hour' : `every ${seconds / 3_600} hours`;
  return `every ${Math.round(seconds / 60)} minutes`;
}

function When({ iso, now, empty }: { iso?: string; now: Date; empty: string }) {
  if (!iso) return <span className="text-zinc-600">{empty}</span>;
  return <time dateTime={iso} title={formatTimestamp(iso)}>{relativeTime(iso, now)}</time>;
}

export function RoutinesCard({ routines, now }: { routines: RoutineScheduleRow[]; now: Date }) {
  return (
    <Card data-testid="fleet-routines" className="bg-zinc-900/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Routines</CardTitle>
          <span className="text-xs text-zinc-600">{plural(routines.length, 'routine')}</span>
        </div>
        <p className="text-xs leading-5 text-zinc-500">Jobs that wake up on a schedule. Last run is the last time one finished checking and planning; last agent run is the last time it put an agent to work.</p>
      </CardHeader>
      <CardContent className="pt-0">
        {routines.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500"><tr className="border-b border-zinc-800">
                <th className="py-1.5 font-medium">Routine</th>
                <th className="py-1.5 font-medium">Last run</th>
                <th className="py-1.5 font-medium">Last agent run</th>
                <th className="py-1.5 font-medium">Next run</th>
              </tr></thead>
              <tbody className="text-zinc-300">
                {routines.map((routine) => (
                  <tr key={routine.slug} data-testid={`fleet-routine-${routine.slug}`} className="border-b border-zinc-900 align-top last:border-0">
                    <td className="py-2 pr-3">
                      <a href={workstreamHref(routine.slug)} className="font-medium text-zinc-200 hover:text-white">{routine.title}</a>
                      {routine.behind ? <Badge variant="warning" className="ml-2">behind schedule</Badge> : null}
                      {routine.status === 'paused' ? <Badge variant="outline" className="ml-2">paused</Badge> : null}
                    </td>
                    <td data-testid="routine-last-run" className="py-2 pr-3"><When iso={routine.lastRunAt} now={now} empty="never" /></td>
                    <td className="py-2 pr-3"><When iso={routine.lastWorkerRunAt} now={now} empty="never" /></td>
                    <td data-testid="routine-next-run" className={cn('py-2', routine.next && Date.parse(routine.next.at) < now.getTime() && 'text-amber-300')}>
                      {routine.next ? (
                        <>
                          <When iso={routine.next.at} now={now} empty="" />
                          <span className="block max-w-xs truncate text-zinc-500" title={routine.next.reason}>{routine.next.reason}</span>
                        </>
                      ) : routine.watchEverySeconds ? (
                        <span>when something changes <span className="text-zinc-500">(checks {watchCadence(routine.watchEverySeconds)})</span></span>
                      ) : routine.status === 'paused' ? (
                        <span className="text-zinc-600">paused</span>
                      ) : (
                        <span className="text-zinc-600">nothing scheduled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-zinc-500">No routines yet. A routine is a job tagged “routine” that keeps waking itself up.</p>}
      </CardContent>
    </Card>
  );
}
