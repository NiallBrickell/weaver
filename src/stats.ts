/**
 * weaver stats — the fleet outcome scoreboard.
 *
 * Renders the METRICS layer across every workstream as one self-contained
 * static HTML file (no server, no CDN, charts drawn client-side from embedded
 * JSON): recorded interventions per SUCCESSFUL OUTCOME over time, plus the
 * approval split, policy evidence, and per-workstream stats. The success
 * denominator is a qualified typed conclusion (WorkstreamCore.conclusion) —
 * adoption is not completion, so adopted work products ride alongside as an
 * explicit leading indicator, never relabeled as outcome success. Provider
 * capacity backoff is kept out of the logical-failure bucket, and pilot
 * auto-approvals (delegated authority) never count as learned-policy wins.
 *
 * Every time series is computed from DURABLE typed records: steering
 * timestamps, gate approvals, deliverable adoption pins, pass records, policy
 * evidence. Never from doc.events — that is a bounded tail (store.ts
 * EVENT_TAIL_LIMIT), and a trend computed from it would fabricate convergence
 * as old intervention events fall off. Interventions that leave no durable
 * timestamp (legacy/config edits count in spend.humanInterventions only) are
 * reported as an explicit undated remainder, never silently dropped.
 *
 * Timestamps: virtual where the record carries one (adoption pins), real
 * otherwise (steering, approvals, passes). Bucketing is per-day, so the mix
 * only shows when the virtual clock has been deliberately advanced — then
 * adoptions date to their virtual day, which is the day the workstream
 * believes it acted. That is the honest choice, not a bug.
 *
 * Read-only over the store; rendered HTML passes through redactSecrets like
 * every other output surface.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PolicyRecord } from './policies.js';
import { loadPolicies } from './policies.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import { listWorkstreams, load, weaverHome } from './store.js';
import type { PassRecord, WorkstreamDoc } from './types.js';

// ---------------------------------------------------------------------------
// Compute layer — pure over typed state (this is what the tests exercise)

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export type ActKind = 'steering' | 'approval' | 'rejection' | 'resolution' | 'adoption';

export interface DatedAct {
  at: string;
  kind: ActKind;
  slug: string;
  /** WEAVER_ACTOR at act time; records predating attribution stay honest. */
  actor: string;
}

export const UNATTRIBUTED = 'unattributed';

/** Resolutions stamped by these are system acts, never human interventions. */
const SYSTEM_ACTORS = new Set(['pilot', 'coordinator']);

/**
 * Who a durable act is attributable to, as distinct buckets that must never
 * collapse into one number:
 * - `human`  — a person acting directly at the keyboard.
 * - `session`  — the human via an agent session on their behalf (actor name
 *                carries a session marker); still a human intervention, but a
 *                cheaper one than a human keypress.
 * - `pilot`    — the operator's pilot daemon or the coordinator (system acts).
 *                Delegated/standing authority, NOT a human intervention and
 *                NEVER a learned-policy win.
 * - `unattributed` — dated acts predating actor attribution (legacy residual).
 */
export type ActorClass = 'human' | 'session' | 'pilot' | 'unattributed';

const SESSION_MARKER = 'session';

export function actorClass(actor: string): ActorClass {
  if (actor === UNATTRIBUTED) return 'unattributed';
  if (SYSTEM_ACTORS.has(actor)) return 'pilot';
  if (actor.toLowerCase().includes(SESSION_MARKER)) return 'session';
  return 'human';
}

/**
 * Human interventions that left a durable timestamp, one entry per human ACT.
 * Approvals, rejections, steers, and adoption overrides are primary acts; an
 * attention card resolved within 5s of any primary act was resolved BY that
 * act (humanActs auto-resolves the attached card in the same keypress and
 * increments the counter once), so those resolutions fold into it rather than
 * double-counting. Word-for-word twin cards resolved together share a
 * resolvedAt and fold to one act. Pilot auto-approvals are authority
 * delegation, never interventions, and are excluded entirely.
 */
export function datedInterventions(doc: WorkstreamDoc): DatedAct[] {
  const slug = doc.workstream.slug;
  const acts: DatedAct[] = [];
  for (const s of doc.steering) acts.push({ at: s.at, kind: 'steering', slug, actor: s.by ?? UNATTRIBUTED });
  for (const a of doc.assignments) {
    const ap = a.exec?.approval;
    if (ap?.by === 'human') acts.push({ at: ap.at, kind: 'approval', slug, actor: ap.actor ?? UNATTRIBUTED });
    if (a.exec?.rejection) {
      acts.push({ at: a.exec.rejection.at, kind: 'rejection', slug, actor: a.exec.rejection.actor });
    }
    if (a.adoption.at && a.adoption.actor) {
      acts.push({ at: a.adoption.at, kind: 'adoption', slug, actor: a.adoption.actor });
    }
  }
  for (const i of doc.interactions) {
    if (i.approvedAt) acts.push({ at: i.approvedAt, kind: 'approval', slug, actor: i.approvedByActor ?? UNATTRIBUTED });
    if (i.rejectedAt) acts.push({ at: i.rejectedAt, kind: 'rejection', slug, actor: i.rejectedBy ?? UNATTRIBUTED });
  }
  const primaryTimes = acts.map((a) => Date.parse(a.at));
  const seenResolved = new Set<string>();
  for (const att of doc.attention) {
    if (att.status !== 'resolved' || !att.resolvedAt) continue;
    // Resolutions count only when durably attributed to a NON-system actor.
    // Pilot/coordinator resolutions are system acts; legacy records with no
    // resolvedBy are indistinguishable from them, so they fall into the
    // undated remainder (anchored to the counter) instead of being guessed.
    if (!att.resolvedBy || SYSTEM_ACTORS.has(att.resolvedBy)) continue;
    if (seenResolved.has(att.resolvedAt)) continue; // twins resolved in one act
    const t = Date.parse(att.resolvedAt);
    if (primaryTimes.some((pt) => Math.abs(pt - t) < 5000)) continue; // the primary act was the act
    seenResolved.add(att.resolvedAt);
    acts.push({ at: att.resolvedAt, kind: 'resolution', slug, actor: att.resolvedBy });
  }
  return acts.sort((a, b) => a.at.localeCompare(b.at));
}

/** Lifetime counter minus dated acts: interventions with no durable timestamp. */
export function undatedInterventions(docs: WorkstreamDoc[]): number {
  const counted = docs.reduce((n, d) => n + (d.spend.humanInterventions ?? 0), 0);
  const dated = docs.reduce((n, d) => n + datedInterventions(d).length, 0);
  return Math.max(0, counted - dated);
}

export interface FleetDay {
  day: string;
  interventions: number;
  /** Qualified typed conclusions (WorkstreamCore.conclusion) — the outcome
   * denominator. A concluded workstream is a successful outcome; an adopted
   * work product is not (adoption ≠ completion), so it is a leading indicator. */
  conclusions: number;
  adoptions: number;
  rejections: number;
  autoApproved: number;
  humanApproved: number;
  passes: number;
}

function blank(day: string): FleetDay {
  return { day, interventions: 0, conclusions: 0, adoptions: 0, rejections: 0, autoApproved: 0, humanApproved: 0, passes: 0 };
}

/** Daily fleet activity from durable records, gap-filled up to `today`. */
export function fleetDays(docs: WorkstreamDoc[], today: string): FleetDay[] {
  const byDay = new Map<string, FleetDay>();
  const touch = (iso: string): FleetDay => {
    const k = dayKey(iso);
    let row = byDay.get(k);
    if (!row) byDay.set(k, (row = blank(k)));
    return row;
  };
  for (const doc of docs) {
    for (const act of datedInterventions(doc)) touch(act.at).interventions += 1;
    // A qualified typed conclusion is the outcome; dated to the virtual day the
    // workstream believes it concluded, exactly like adoption pins.
    if (doc.workstream.conclusion) touch(doc.workstream.conclusion.atVirtual).conclusions += 1;
    for (const del of doc.deliverables) {
      if (del.adopted) touch(del.adopted.atVirtual).adoptions += 1;
    }
    const passById = new Map(doc.passes.map((p) => [p.id, p]));
    for (const a of doc.assignments) {
      if (a.adoption.state === 'rejected') {
        const pass = a.adoption.passId ? passById.get(a.adoption.passId) : undefined;
        touch(pass?.startedAt ?? a.createdAtVirtual).rejections += 1;
      }
      const ap = a.exec?.approval;
      if (ap) touch(ap.at)[ap.by === 'pilot' ? 'autoApproved' : 'humanApproved'] += 1;
    }
    for (const p of doc.passes) {
      const row = touch(p.startedAt);
      row.passes += 1;
    }
  }
  if (!byDay.size) return [];
  const keys = [...byDay.keys()].sort();
  const first = keys[0]!;
  const last = today > keys[keys.length - 1]! ? today : keys[keys.length - 1]!;
  const out: FleetDay[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); dayKey(d.toISOString()) <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = dayKey(d.toISOString());
    out.push(byDay.get(k) ?? blank(k));
  }
  return out;
}

export interface RatioPoint {
  day: string;
  interventions: number; // cumulative
  conclusions: number; // cumulative qualified typed conclusions
  adoptions: number; // cumulative adopted work products (leading indicator)
  /** The outcome curve: interventions per successful outcome (typed
   * conclusion). Null until the first qualified conclusion exists. */
  ratio: number | null;
  /** Leading indicator, NOT outcome success: interventions per adopted work
   * product. Null until the first adoption exists. */
  ratioAdopted: number | null;
}

/**
 * The intervention curve. Primary denominator is qualified typed conclusions
 * (successful outcomes); adopted work products ride alongside as an explicit
 * leading indicator, never relabeled as success (adoption ≠ completion).
 */
export function cumulativeRatio(days: FleetDay[]): RatioPoint[] {
  let ints = 0;
  let concl = 0;
  let adopts = 0;
  return days.map((d) => {
    ints += d.interventions;
    concl += d.conclusions;
    adopts += d.adoptions;
    return {
      day: d.day,
      interventions: ints,
      conclusions: concl,
      adoptions: adopts,
      ratio: concl > 0 ? ints / concl : null,
      ratioAdopted: adopts > 0 ? ints / adopts : null,
    };
  });
}

/** Promotion moment: shadow flips active on its first intervention-free evidence. */
export function promotionAt(p: PolicyRecord): string | undefined {
  const free = p.evidence.filter((e) => e.interventionFree).sort((a, b) => a.at.localeCompare(b.at));
  return free[0]?.at;
}

/** Supersession moment: when the superseding policy was recorded. */
export function supersessionAt(p: PolicyRecord, byId: Map<string, PolicyRecord>): string | undefined {
  if (p.status !== 'superseded') return undefined;
  const sup = p.supersededBy ? byId.get(p.supersededBy) : undefined;
  return sup?.createdAt ?? p.createdAt;
}

export interface PolicyDay {
  day: string;
  active: number;
  shadow: number;
  superseded: number;
}

/** Policy population by status as of each day's end. */
export function policyStatusByDay(policies: PolicyRecord[], days: string[]): PolicyDay[] {
  const byId = new Map(policies.map((p) => [p.id, p]));
  const facts = policies.map((p) => ({
    created: dayKey(p.createdAt),
    promoted: promotionAt(p) ? dayKey(promotionAt(p)!) : undefined,
    superseded: supersessionAt(p, byId) ? dayKey(supersessionAt(p, byId)!) : undefined,
  }));
  return days.map((day) => {
    const row: PolicyDay = { day, active: 0, shadow: 0, superseded: 0 };
    for (const f of facts) {
      if (f.created > day) continue;
      if (f.superseded && f.superseded <= day) row.superseded += 1;
      else if (f.promoted && f.promoted <= day) row.active += 1;
      else row.shadow += 1;
    }
    return row;
  });
}

export interface ProvenanceSplit {
  seeded: { active: number; shadow: number; superseded: number };
  learned: { active: number; shadow: number; superseded: number };
}

/**
 * Seeded (backfilled from the human's pre-Weaver rules/transcripts or a team
 * seed) vs learned live from workstream corrections — the "converging to what
 * is ACTUALLY ideal" split: a seeded rule keeps active status only by earning
 * intervention-free evidence, exactly like a learned one.
 */
export function provenanceSplit(policies: PolicyRecord[]): ProvenanceSplit {
  const out: ProvenanceSplit = {
    seeded: { active: 0, shadow: 0, superseded: 0 },
    learned: { active: 0, shadow: 0, superseded: 0 },
  };
  for (const p of policies) {
    const bucket = 'source' in p.provenance ? out.seeded : out.learned;
    bucket[p.status] += 1;
  }
  return out;
}

export interface ActorSummary {
  actor: string;
  total: number;
  byKind: Record<ActKind, number>;
}

export interface InterruptionLoad {
  /** Chart segments: top actors by lifetime total, plus 'other' when folded. */
  segments: string[];
  rows: { day: string; counts: Record<string, number> }[];
  /** Every actor, unfolded, for the totals table. */
  totals: ActorSummary[];
}

/**
 * Who is actually absorbing the interruptions — the human at the keyboard,
 * an agent session steering on their behalf, someone else on the team. The
 * pilot never appears here by construction: auto-approval is delegated
 * authority, not an interruption. Only dated acts can be attributed, so the
 * undated remainder (legacy/config edits) is out of scope by design.
 */
export function interruptionLoad(docs: WorkstreamDoc[], days: string[]): InterruptionLoad {
  const acts = docs.flatMap((d) => datedInterventions(d));
  const byActor = new Map<string, ActorSummary>();
  for (const act of acts) {
    let s = byActor.get(act.actor);
    if (!s) {
      byActor.set(act.actor, (s = { actor: act.actor, total: 0, byKind: { steering: 0, approval: 0, rejection: 0, resolution: 0, adoption: 0 } }));
    }
    s.total += 1;
    s.byKind[act.kind] += 1;
  }
  const totals = [...byActor.values()].sort((a, b) => b.total - a.total);
  const top = totals.slice(0, 3).map((s) => s.actor);
  const folded = totals.length > 3;
  const segments = folded ? [...top, 'other'] : top;
  const segOf = (actor: string): string => (top.includes(actor) ? actor : 'other');
  const rows = days.map((day) => {
    const counts: Record<string, number> = {};
    for (const seg of segments) counts[seg] = 0;
    for (const act of acts) {
      if (dayKey(act.at) === day) counts[segOf(act.actor)] = (counts[segOf(act.actor)] ?? 0) + 1;
    }
    return { day, counts };
  });
  return { segments, rows, totals };
}

/**
 * Intervention load split into fixed attribution buckets, never one number.
 * `human + session + unattributed` partition the DATED human interventions
 * (the same acts `datedInterventions` yields); `pilot` counts the operator's
 * delegated pilot auto-approvals — delegated authority, reported here so it is
 * visibly SEPARATE from human interventions and from learned-policy effects.
 */
export interface Attribution {
  human: number;
  session: number;
  unattributed: number;
  pilot: number;
}

export function attributionSplit(docs: WorkstreamDoc[]): Attribution {
  const out: Attribution = { human: 0, session: 0, unattributed: 0, pilot: 0 };
  for (const doc of docs) {
    for (const act of datedInterventions(doc)) {
      const cls = actorClass(act.actor);
      // datedInterventions excludes system acts by construction, so a dated act
      // never classifies as 'pilot'; the guard keeps human buckets honest even
      // if a rejection were ever stamped by a system actor.
      if (cls !== 'pilot') out[cls] += 1;
    }
    for (const a of doc.assignments) {
      if (a.exec?.approval?.by === 'pilot') out.pilot += 1;
    }
  }
  return out;
}

/**
 * A coordinator pass's health, with provider backoff separated from logical
 * failure so a capacity/rate/auth outage never reads as the coordinator being
 * wrong:
 * - `providerBackoff` — any pass carrying a typed `.infrastructure` wait. These
 *   don't consume the pass cap and aren't logical failures.
 * - `logicalFailure`  — outcome `error`/`no_finish` with NO `.infrastructure`.
 * - `conflicted`      — a revision-conflict finish: the revision check working,
 *   so neither success nor logical failure. Not emitted by the schema today;
 *   classified forward-compatibly and always kept out of the failure bucket.
 * - `completed` / `running` — success and in-flight.
 */
export type PassHealthKind = 'completed' | 'providerBackoff' | 'logicalFailure' | 'conflicted' | 'running';

export function passHealth(p: PassRecord): PassHealthKind {
  if (p.infrastructure) return 'providerBackoff';
  const outcome = p.outcome as string;
  if (outcome === 'completed') return 'completed';
  if (outcome === 'error' || outcome === 'no_finish') return 'logicalFailure';
  if (outcome === 'conflicted') return 'conflicted';
  return 'running';
}

export interface PassHealthTotals {
  completed: number;
  providerBackoff: number;
  logicalFailure: number;
  conflicted: number;
  running: number;
}

export function passHealthTotals(docs: WorkstreamDoc[]): PassHealthTotals {
  const out: PassHealthTotals = { completed: 0, providerBackoff: 0, logicalFailure: 0, conflicted: 0, running: 0 };
  for (const doc of docs) for (const p of doc.passes) out[passHealth(p)] += 1;
  return out;
}

/**
 * Worker reliability from assignment attempt history. First-attempt completion
 * is the assignment finishing without needing a retry; recovery is the harness
 * absorbing a flake by retrying to a completion. Both are computed from typed
 * `attempts`, never a run trace.
 */
export interface WorkerReliability {
  completed: number; // assignments in state 'completed'
  firstAttempt: number; // completed with a single attempt
  recovered: number; // completed after more than one attempt
  neededRetry: number; // terminal (completed|failed) assignments with >1 attempt
  failed: number; // assignments in state 'failed'
  firstAttemptRate: number | null; // firstAttempt / completed
  recoveryRate: number | null; // recovered / neededRetry
}

export function workerReliability(docs: WorkstreamDoc[]): WorkerReliability {
  let completed = 0;
  let firstAttempt = 0;
  let recovered = 0;
  let neededRetry = 0;
  let failed = 0;
  for (const doc of docs) {
    for (const a of doc.assignments) {
      const attempts = a.attempts.length;
      if (a.state === 'completed') {
        completed += 1;
        if (attempts <= 1) firstAttempt += 1;
        else recovered += 1;
      }
      if (a.state === 'failed') failed += 1;
      if ((a.state === 'completed' || a.state === 'failed') && attempts > 1) neededRetry += 1;
    }
  }
  return {
    completed,
    firstAttempt,
    recovered,
    neededRetry,
    failed,
    firstAttemptRate: completed > 0 ? firstAttempt / completed : null,
    recoveryRate: neededRetry > 0 ? recovered / neededRetry : null,
  };
}

export interface WorkstreamRow {
  slug: string;
  title: string;
  status: string;
  /** A qualified typed conclusion exists — this workstream is a successful
   * outcome, not merely one with adopted work products. */
  concluded: boolean;
  passes: number;
  interventions: number;
  adopted: number;
  rejected: number;
  autoApproved: number;
  humanApproved: number;
  /** Leading indicator: interventions per adopted work product (NOT per
   * successful outcome — a single stream concludes 0 or 1 times). */
  perOutcome: number | null;
}

export function workstreamRows(docs: WorkstreamDoc[]): WorkstreamRow[] {
  return docs
    .map((doc) => {
      const adopted = doc.deliverables.filter((d) => d.adopted).length;
      const interventions = doc.spend.humanInterventions ?? 0;
      let auto = 0;
      let human = 0;
      for (const a of doc.assignments) {
        const ap = a.exec?.approval;
        if (ap) ap.by === 'pilot' ? (auto += 1) : (human += 1);
      }
      return {
        slug: doc.workstream.slug,
        title: doc.workstream.title,
        status: doc.workstream.status,
        concluded: !!doc.workstream.conclusion,
        passes: doc.spend.coordinatorPasses,
        interventions,
        adopted,
        rejected: doc.assignments.filter((a) => a.adoption.state === 'rejected').length,
        autoApproved: auto,
        humanApproved: human,
        perOutcome: adopted > 0 ? interventions / adopted : null,
      };
    })
    .sort((a, b) => b.passes - a.passes);
}

export interface StatsPayload {
  generatedAt: string;
  days: FleetDay[];
  ratio: RatioPoint[];
  policyDays: PolicyDay[];
  provenance: ProvenanceSplit;
  actors: InterruptionLoad;
  rows: WorkstreamRow[];
  totals: {
    workstreams: number;
    active: number;
    passes: number;
    interventions: number; // durable lifetime counters
    undated: number; // interventions without a durable timestamp
    /** Qualified typed conclusions — the SUCCESS denominator. */
    successfulOutcomes: number;
    /** Adopted work products — a leading indicator, NEVER the success count. */
    adoptions: number;
    autoApproved: number;
    humanApproved: number;
    /** Interventions per successful outcome (conclusion denominator) — target. */
    interventionsPerOutcome: number | null;
    /** Leading indicator: interventions per adopted work product. */
    interventionsPerAdopted: number | null;
    /** Week-ago value of the outcome curve (conclusion denominator, dated acts). */
    perOutcomeWeekAgo: number | null;
    passHealth: PassHealthTotals;
    reliability: WorkerReliability;
    attribution: Attribution;
    policiesActive: number;
    policiesShadow: number;
    policiesSuperseded: number;
  };
}

export function computeStats(docs: WorkstreamDoc[], policies: PolicyRecord[], now: Date): StatsPayload {
  const days = fleetDays(docs, dayKey(now.toISOString()));
  const ratio = cumulativeRatio(days);
  const last = ratio[ratio.length - 1];
  const weekAgo = ratio.length > 7 ? ratio[ratio.length - 8] : undefined;
  const adoptions = days.reduce((n, d) => n + d.adoptions, 0);
  const successfulOutcomes = docs.filter((d) => d.workstream.conclusion).length;
  const counterInterventions = docs.reduce((n, d) => n + (d.spend.humanInterventions ?? 0), 0);
  const rows = workstreamRows(docs);
  return {
    generatedAt: now.toISOString(),
    days,
    ratio,
    policyDays: policyStatusByDay(
      policies,
      days.map((d) => d.day),
    ),
    provenance: provenanceSplit(policies),
    actors: interruptionLoad(
      docs,
      days.map((d) => d.day),
    ),
    rows,
    totals: {
      workstreams: docs.length,
      active: docs.filter((d) => d.workstream.status === 'active').length,
      passes: docs.reduce((n, d) => n + d.spend.coordinatorPasses, 0),
      interventions: counterInterventions,
      undated: undatedInterventions(docs),
      successfulOutcomes,
      adoptions,
      autoApproved: days.reduce((n, d) => n + d.autoApproved, 0),
      humanApproved: days.reduce((n, d) => n + d.humanApproved, 0),
      // The headline anchors to the LIFETIME counter over qualified conclusions,
      // so the undated remainder can never quietly leave the numerator; the
      // curve (dated acts only) is the trend, and its endpoints feed the delta.
      interventionsPerOutcome: successfulOutcomes > 0 ? counterInterventions / successfulOutcomes : null,
      interventionsPerAdopted: adoptions > 0 ? counterInterventions / adoptions : null,
      perOutcomeWeekAgo: weekAgo?.ratio ?? null,
      passHealth: passHealthTotals(docs),
      reliability: workerReliability(docs),
      attribution: attributionSplit(docs),
      policiesActive: policies.filter((p) => p.status === 'active').length,
      policiesShadow: policies.filter((p) => p.status === 'shadow').length,
      policiesSuperseded: policies.filter((p) => p.status === 'superseded').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Page chrome — light + dark from the same validated palette
// (slots 1–2 categorical; superseded/context is de-emphasis gray, not a slot)

function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

const STYLE = `
:root { color-scheme: light;
  --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,0.10);
  --s1:#2a78d6; --s2:#eb6834; --de:#c3c2b7; --good:#006300; --bad:#d03b3b; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) { color-scheme: dark;
  --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10);
  --s1:#3987e5; --s2:#d95926; --de:#52514e; --good:#0ca30c; --bad:#e66767; } }
:root[data-theme="dark"] { color-scheme: dark;
  --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10);
  --s1:#3987e5; --s2:#d95926; --de:#52514e; --good:#0ca30c; --bad:#e66767; }
* { box-sizing: border-box; }
body { margin:0; background:var(--page); color:var(--ink); font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 28px 24px 80px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 0 0 2px; }
.subtitle { color: var(--ink2); margin: 0 0 20px; }
section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin: 16px 0; }
.hint { color: var(--ink2); font-size: 13px; margin: 2px 0 14px; }
.empty { color: var(--muted); font-style: italic; }
code { font-family: ui-monospace, monospace; font-size: 12px; }
.filters { display:flex; gap:8px; align-items:center; margin: 0 0 4px; }
.filters .flabel { color: var(--muted); font-size: 12px; margin-right: 4px; }
.filters button { font: 13px system-ui,sans-serif; color: var(--ink2); background: none; border: 1px solid var(--border); border-radius: 999px; padding: 3px 12px; cursor: pointer; }
.filters button[aria-pressed="true"] { color: var(--ink); border-color: var(--ink2); font-weight: 600; }
.kpis { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.tile .label { color: var(--ink2); font-size: 12px; }
.tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
.tile.hero .value { font-size: 48px; line-height: 1.1; }
.tile .delta { font-size: 12px; margin-top: 2px; color: var(--ink2); }
.tile .delta.down-good { color: var(--good); } .tile .delta.up-bad { color: var(--bad); }
.chart-grid { display:grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 900px) { .chart-grid.two { grid-template-columns: 1fr 1fr; } }
.chart { position: relative; }
.chart svg { display:block; width:100%; }
.chart .tip { position:absolute; pointer-events:none; background: var(--surface); border:1px solid var(--border); border-radius:8px; box-shadow: 0 2px 10px rgba(0,0,0,.12); padding:7px 10px; font-size:12px; display:none; z-index:2; max-width: 240px; }
.tip .tip-day { color: var(--muted); margin-bottom: 3px; }
.tip .row { display:flex; align-items:center; gap:6px; }
.tip .key { display:inline-block; width:12px; height:0; border-top:2px solid; }
.tip .v { font-weight:600; } .tip .n { color: var(--ink2); }
.legend { display:flex; gap:16px; color: var(--ink2); font-size: 12px; margin: 6px 0 2px; }
.legend .key { display:inline-block; vertical-align:middle; margin-right:5px; }
.legend .key.line { width:14px; height:0; border-top:2px solid; }
.legend .key.rect { width:11px; height:11px; border-radius:3px; }
details.tableview { margin-top: 8px; }
details.tableview summary { color: var(--muted); font-size: 12px; cursor: pointer; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 6px; }
th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--grid); }
th { color: var(--ink2); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.scroll-x { overflow-x: auto; }
svg text { font: 11px system-ui,sans-serif; fill: var(--muted); }
svg .gridline { stroke: var(--grid); stroke-width: 1; }
svg .axisline { stroke: var(--axis); stroke-width: 1; }
svg .crosshair { stroke: var(--axis); stroke-width: 1; }
svg .endlabel { fill: var(--ink2); font-weight: 600; }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; line-height: 1.6; }
`;

// Client-side renderer. Plain string (no backticks) so it nests in the template.
const SCRIPT = String.raw`
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('stats-data').textContent);
  var state = { range: 0 }; // 0 = all, else last N days

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }
  function fmt(v) {
    if (v == null) return '—';
    if (typeof v !== 'number') return String(v);
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    return v.toFixed(2);
  }
  function slice(arr) { return state.range > 0 ? arr.slice(-state.range) : arr; }
  function niceMax(v) {
    if (v <= 0) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / pow;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }
  function xticks(days) {
    var maxTicks = 8, stride = Math.max(1, Math.ceil(days.length / maxTicks)), out = [];
    for (var i = 0; i < days.length; i += stride) out.push(i);
    return out;
  }
  function short(day) { return day.slice(5); }

  // --- shared tooltip machinery -------------------------------------------
  function makeTip(wrap) { var t = el('div', 'tip'); wrap.appendChild(t); return t; }
  function showTip(tip, wrap, x, day, rows) {
    tip.textContent = '';
    tip.appendChild(el('div', 'tip-day', day));
    rows.forEach(function (r) {
      var row = el('div', 'row');
      var key = el('span', 'key'); key.style.borderTopColor = r.color;
      var v = el('span', 'v', fmt(r.value));
      var n = el('span', 'n', r.label);
      row.appendChild(key); row.appendChild(v); row.appendChild(n);
      tip.appendChild(row);
    });
    tip.style.display = 'block';
    var w = tip.offsetWidth, ww = wrap.clientWidth;
    tip.style.left = Math.min(Math.max(0, x - w / 2), ww - w) + 'px';
    tip.style.top = '0px';
  }
  function hideTip(tip) { tip.style.display = 'none'; }

  // --- line chart ----------------------------------------------------------
  // series: [{key or get, label, cssVar}]; hoverAll lists every series at X.
  function lineChart(mount, cfg) {
    mount.textContent = '';
    var days = cfg.rows;
    if (!days.length) { mount.appendChild(el('p', 'empty', 'No data in this range.')); return; }
    var wrap = el('div', 'chart');
    mount.appendChild(wrap);
    var W = Math.max(320, mount.clientWidth || 600), H = 210, AX = 26, padL = 40, padR = 56, padT = 12;
    var plotW = W - padL - padR, plotH = H - padT - AX;
    var vals = [];
    days.forEach(function (d) { cfg.series.forEach(function (s) { var v = s.get(d); if (v != null) vals.push(v); }); });
    var yMax = niceMax(Math.max.apply(null, vals.concat([1])));
    var x = function (i) { return padL + (days.length === 1 ? plotW / 2 : (i * plotW) / (days.length - 1)); };
    var y = function (v) { return padT + plotH - (v / yMax) * plotH; };
    var svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', cfg.label);
    // grid + y ticks
    [0, 0.5, 1].forEach(function (f) {
      var gy = y(yMax * f);
      var ln = svgEl('line');
      ln.setAttribute('x1', padL); ln.setAttribute('x2', W - padR);
      ln.setAttribute('y1', gy); ln.setAttribute('y2', gy);
      ln.setAttribute('class', f === 0 ? 'axisline' : 'gridline');
      svg.appendChild(ln);
      var t = svgEl('text');
      t.setAttribute('x', padL - 6); t.setAttribute('y', gy + 4); t.setAttribute('text-anchor', 'end');
      t.setAttribute('style', 'font-variant-numeric: tabular-nums');
      t.textContent = fmt(yMax * f);
      svg.appendChild(t);
    });
    xticks(days).forEach(function (i) {
      var t = svgEl('text');
      t.setAttribute('x', x(i)); t.setAttribute('y', H - 8); t.setAttribute('text-anchor', 'middle');
      t.textContent = short(days[i].day);
      svg.appendChild(t);
    });
    // series paths + end dots + end labels
    var placedLabels = [];
    cfg.series.forEach(function (s) {
      var dPath = '', started = false;
      days.forEach(function (d, i) {
        var v = s.get(d);
        if (v == null) { return; }
        dPath += (started ? ' L ' : 'M ') + x(i) + ' ' + y(v);
        started = true;
      });
      if (!dPath) return;
      var p = svgEl('path');
      p.setAttribute('d', dPath);
      p.setAttribute('fill', 'none');
      p.setAttribute('style', 'stroke: var(' + s.cssVar + '); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round;');
      svg.appendChild(p);
      var lastI = -1;
      for (var i = days.length - 1; i >= 0; i--) if (s.get(days[i]) != null) { lastI = i; break; }
      if (lastI >= 0) {
        var dot = svgEl('circle');
        dot.setAttribute('cx', x(lastI)); dot.setAttribute('cy', y(s.get(days[lastI])));
        dot.setAttribute('r', 4);
        dot.setAttribute('style', 'fill: var(' + s.cssVar + '); stroke: var(--surface); stroke-width: 2;');
        svg.appendChild(dot);
        // Colliding end-labels are dropped, never stacked — the legend and
        // tooltip carry the value instead.
        var ly = y(s.get(days[lastI])) + 4;
        var collides = placedLabels.some(function (py) { return Math.abs(py - ly) < 13; });
        if (!collides) {
          placedLabels.push(ly);
          var lbl = svgEl('text');
          lbl.setAttribute('x', x(lastI) + 8); lbl.setAttribute('y', ly);
          lbl.setAttribute('class', 'endlabel');
          lbl.textContent = fmt(s.get(days[lastI]));
          svg.appendChild(lbl);
        }
      }
    });
    // crosshair + hover
    var cross = svgEl('line');
    cross.setAttribute('class', 'crosshair');
    cross.setAttribute('y1', padT); cross.setAttribute('y2', padT + plotH);
    cross.style.display = 'none';
    svg.appendChild(cross);
    var tip = makeTip(wrap);
    function idxFromClientX(clientX) {
      var r = svg.getBoundingClientRect();
      var px = ((clientX - r.left) / r.width) * W;
      var i = Math.round(((px - padL) / plotW) * (days.length - 1));
      return Math.min(days.length - 1, Math.max(0, i));
    }
    function focusIdx(i) {
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      cross.style.display = '';
      var r = svg.getBoundingClientRect();
      showTip(tip, wrap, (x(i) / W) * r.width, days[i].day, cfg.series.map(function (s) {
        return { label: s.label, value: s.get(days[i]), color: getComputedStyle(document.documentElement).getPropertyValue(s.cssVar) };
      }));
      svg.dataset.idx = i;
    }
    function blur() { cross.style.display = 'none'; hideTip(tip); }
    svg.addEventListener('pointermove', function (e) { focusIdx(idxFromClientX(e.clientX)); });
    svg.addEventListener('pointerleave', blur);
    svg.addEventListener('keydown', function (e) {
      var i = svg.dataset.idx != null ? +svg.dataset.idx : days.length - 1;
      if (e.key === 'ArrowLeft') { focusIdx(Math.max(0, i - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { focusIdx(Math.min(days.length - 1, i + 1)); e.preventDefault(); }
      else if (e.key === 'Escape') blur();
    });
    svg.addEventListener('blur', blur);
    wrap.appendChild(svg);
    if (cfg.series.length > 1) {
      var lg = el('div', 'legend');
      cfg.series.forEach(function (s) {
        var item = el('span');
        var key = el('span', 'key line'); key.style.borderTopColor = 'var(' + s.cssVar + ')';
        item.appendChild(key); item.appendChild(document.createTextNode(s.label));
        lg.appendChild(item);
      });
      wrap.appendChild(lg);
    }
  }

  // --- stacked columns -----------------------------------------------------
  function stackedCols(mount, cfg) {
    mount.textContent = '';
    var days = cfg.rows;
    if (!days.length) { mount.appendChild(el('p', 'empty', 'No data in this range.')); return; }
    var wrap = el('div', 'chart');
    mount.appendChild(wrap);
    var W = Math.max(320, mount.clientWidth || 600), H = 210, AX = 26, padL = 40, padR = 16, padT = 12;
    var plotW = W - padL - padR, plotH = H - padT - AX;
    var totals = days.map(function (d) { return cfg.segs.reduce(function (n, s) { return n + s.get(d); }, 0); });
    var yMax = niceMax(Math.max.apply(null, totals.concat([1])));
    var band = plotW / days.length;
    var bw = Math.min(24, Math.max(3, band - 4));
    var y = function (v) { return padT + plotH - (v / yMax) * plotH; };
    var svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', cfg.label);
    [0, 0.5, 1].forEach(function (f) {
      var gy = y(yMax * f);
      var ln = svgEl('line');
      ln.setAttribute('x1', padL); ln.setAttribute('x2', W - padR);
      ln.setAttribute('y1', gy); ln.setAttribute('y2', gy);
      ln.setAttribute('class', f === 0 ? 'axisline' : 'gridline');
      svg.appendChild(ln);
      var t = svgEl('text');
      t.setAttribute('x', padL - 6); t.setAttribute('y', gy + 4); t.setAttribute('text-anchor', 'end');
      t.setAttribute('style', 'font-variant-numeric: tabular-nums');
      t.textContent = fmt(yMax * f);
      svg.appendChild(t);
    });
    xticks(days).forEach(function (i) {
      var t = svgEl('text');
      t.setAttribute('x', padL + i * band + band / 2); t.setAttribute('y', H - 8); t.setAttribute('text-anchor', 'middle');
      t.textContent = short(days[i].day);
      svg.appendChild(t);
    });
    var tip = makeTip(wrap);
    days.forEach(function (d, i) {
      var cx = padL + i * band + (band - bw) / 2;
      var acc = 0, segTops = [];
      cfg.segs.forEach(function (s) { segTops.push({ s: s, v: s.get(d), y0: acc }); acc += s.get(d); });
      var topAt = y(acc);
      segTops.forEach(function (seg, si) {
        if (seg.v <= 0) return;
        var isTop = (function () { for (var j = segTops.length - 1; j >= 0; j--) if (segTops[j].v > 0) return j === si; return false; })();
        var yTop = y(seg.y0 + seg.v), yBot = y(seg.y0);
        if (seg.y0 > 0) yBot -= 2; // 2px surface gap below every non-base segment
        var h = Math.max(1, yBot - yTop);
        var r = svgEl('path');
        var rad = isTop ? Math.min(4, bw / 2, h) : 0; // rounded data-end, square baseline
        var x0 = cx, x1 = cx + bw, yT = yBot - h;
        var dPath = 'M ' + x0 + ' ' + yBot + ' L ' + x0 + ' ' + (yT + rad) +
          ' Q ' + x0 + ' ' + yT + ' ' + (x0 + rad) + ' ' + yT +
          ' L ' + (x1 - rad) + ' ' + yT +
          ' Q ' + x1 + ' ' + yT + ' ' + x1 + ' ' + (yT + rad) +
          ' L ' + x1 + ' ' + yBot + ' Z';
        r.setAttribute('d', dPath);
        r.setAttribute('style', 'fill: var(' + seg.s.cssVar + ');');
        svg.appendChild(r);
      });
      // hit target: the whole band, wider than the mark
      var hit = svgEl('rect');
      hit.setAttribute('x', padL + i * band); hit.setAttribute('y', padT);
      hit.setAttribute('width', band); hit.setAttribute('height', plotH);
      hit.setAttribute('fill', 'transparent');
      hit.setAttribute('tabindex', '0');
      function show() {
        var r = svg.getBoundingClientRect();
        showTip(tip, wrap, ((padL + i * band + band / 2) / W) * r.width, d.day, cfg.segs.map(function (s) {
          return { label: s.label, value: s.get(d), color: getComputedStyle(document.documentElement).getPropertyValue(s.cssVar) };
        }));
      }
      hit.addEventListener('pointermove', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', function () { hideTip(tip); });
      hit.addEventListener('blur', function () { hideTip(tip); });
      svg.appendChild(hit);
      void topAt;
    });
    wrap.appendChild(svg);
    var lg = el('div', 'legend');
    cfg.segs.forEach(function (s) {
      var item = el('span');
      var key = el('span', 'key rect'); key.style.background = 'var(' + s.cssVar + ')';
      item.appendChild(key); item.appendChild(document.createTextNode(s.label));
      lg.appendChild(item);
    });
    wrap.appendChild(lg);
  }

  // --- horizontal provenance bars -----------------------------------------
  function hBars(mount, cfg) {
    mount.textContent = '';
    var wrap = el('div', 'chart');
    mount.appendChild(wrap);
    var W = Math.max(320, mount.clientWidth || 600), rowH = 40, padL = 110, padR = 50, padT = 6;
    var H = padT + cfg.rows.length * rowH + 6;
    var plotW = W - padL - padR;
    var max = 1;
    cfg.rows.forEach(function (r) { max = Math.max(max, r.segs.reduce(function (n, s) { return n + s.value; }, 0)); });
    var svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', cfg.label);
    var tip = makeTip(wrap);
    cfg.rows.forEach(function (row, ri) {
      var yTop = padT + ri * rowH + 6, bh = 22;
      var name = svgEl('text');
      name.setAttribute('x', padL - 10); name.setAttribute('y', yTop + bh / 2 + 4); name.setAttribute('text-anchor', 'end');
      name.textContent = row.label;
      svg.appendChild(name);
      var acc = 0, total = row.segs.reduce(function (n, s) { return n + s.value; }, 0);
      row.segs.forEach(function (seg, si) {
        if (seg.value <= 0) return;
        var x0 = padL + (acc / max) * plotW;
        var w = (seg.value / max) * plotW - 2; // 2px surface gap
        if (w < 1) w = 1;
        var isLast = (function () { for (var j = row.segs.length - 1; j >= 0; j--) if (row.segs[j].value > 0) return j === si; return false; })();
        var rad = isLast ? 4 : 0;
        var r = svgEl('path');
        var yB = yTop + bh, x1 = x0 + w;
        var dPath = 'M ' + x0 + ' ' + yTop + ' L ' + (x1 - rad) + ' ' + yTop +
          ' Q ' + x1 + ' ' + yTop + ' ' + x1 + ' ' + (yTop + rad) +
          ' L ' + x1 + ' ' + (yB - rad) +
          ' Q ' + x1 + ' ' + yB + ' ' + (x1 - rad) + ' ' + yB +
          ' L ' + x0 + ' ' + yB + ' Z';
        r.setAttribute('d', dPath);
        r.setAttribute('style', 'fill: var(' + seg.cssVar + ');');
        r.setAttribute('tabindex', '0');
        function show() {
          var rc = svg.getBoundingClientRect();
          showTip(tip, wrap, (((x0 + x1) / 2) / W) * rc.width, row.label, [
            { label: seg.label, value: seg.value, color: getComputedStyle(document.documentElement).getPropertyValue(seg.cssVar) },
          ]);
        }
        r.addEventListener('pointermove', show);
        r.addEventListener('focus', show);
        r.addEventListener('pointerleave', function () { hideTip(tip); });
        r.addEventListener('blur', function () { hideTip(tip); });
        svg.appendChild(r);
        // in-segment count only when it comfortably fits (~11px/char + padding)
        if (w > 8 + 8 * String(seg.value).length) {
          var lbl = svgEl('text');
          lbl.setAttribute('x', x0 + w / 2); lbl.setAttribute('y', yTop + bh / 2 + 4); lbl.setAttribute('text-anchor', 'middle');
          var fill = seg.cssVar === '--de' ? 'var(--ink)' : '#ffffff';
          lbl.setAttribute('style', 'fill: ' + fill + '; font-weight: 600;');
          lbl.textContent = String(seg.value);
          svg.appendChild(lbl);
        }
        acc += seg.value;
      });
      var totalLbl = svgEl('text');
      totalLbl.setAttribute('x', padL + (total / max) * plotW + 8); totalLbl.setAttribute('y', yTop + bh / 2 + 4);
      totalLbl.setAttribute('class', 'endlabel');
      totalLbl.textContent = String(total);
      svg.appendChild(totalLbl);
    });
    wrap.appendChild(svg);
    var lg = el('div', 'legend');
    cfg.legend.forEach(function (s) {
      var item = el('span');
      var key = el('span', 'key rect'); key.style.background = 'var(' + s.cssVar + ')';
      item.appendChild(key); item.appendChild(document.createTextNode(s.label));
      lg.appendChild(item);
    });
    wrap.appendChild(lg);
  }

  // --- table views ---------------------------------------------------------
  function tableView(mount, cols, rows) {
    mount.textContent = '';
    var det = el('details', 'tableview');
    det.appendChild(el('summary', null, 'Table view'));
    var scroll = el('div', 'scroll-x');
    var table = el('table');
    var thead = el('thead'), trh = el('tr');
    cols.forEach(function (c) { var th = el('th', c.num ? 'num' : null, c.label); trh.appendChild(th); });
    thead.appendChild(trh); table.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      cols.forEach(function (c) { tr.appendChild(el('td', c.num ? 'num' : null, fmt(c.get(r)))); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    det.appendChild(scroll);
    mount.appendChild(det);
  }

  // --- render everything for the current range ----------------------------
  function renderAll() {
    var days = slice(DATA.days);
    var ratio = slice(DATA.ratio);
    var policyDays = slice(DATA.policyDays);

    lineChart(document.getElementById('chart-activity'), {
      label: 'Human interventions vs adopted work products per day',
      rows: days,
      series: [
        { label: 'adopted work products', cssVar: '--s1', get: function (d) { return d.adoptions; } },
        { label: 'human interventions', cssVar: '--s2', get: function (d) { return d.interventions; } },
      ],
    });
    tableView(document.getElementById('table-activity'),
      [{ label: 'day', get: function (d) { return d.day; } },
       { label: 'adopted', num: true, get: function (d) { return d.adoptions; } },
       { label: 'interventions', num: true, get: function (d) { return d.interventions; } },
       { label: 'rejected', num: true, get: function (d) { return d.rejections; } }], days);

    lineChart(document.getElementById('chart-ratio'), {
      label: 'Cumulative interventions per successful outcome, with the adopted-work leading indicator',
      rows: ratio,
      series: [
        { label: 'per successful outcome (conclusion)', cssVar: '--s1', get: function (d) { return d.ratio == null ? null : Math.round(d.ratio * 100) / 100; } },
        { label: 'per adopted work product (leading indicator, not outcome success)', cssVar: '--s2', get: function (d) { return d.ratioAdopted == null ? null : Math.round(d.ratioAdopted * 100) / 100; } },
      ],
    });
    tableView(document.getElementById('table-ratio'),
      [{ label: 'day', get: function (d) { return d.day; } },
       { label: 'cum. interventions', num: true, get: function (d) { return d.interventions; } },
       { label: 'cum. outcomes', num: true, get: function (d) { return d.conclusions; } },
       { label: 'cum. adopted', num: true, get: function (d) { return d.adoptions; } },
       { label: 'per successful outcome', num: true, get: function (d) { return d.ratio == null ? null : Math.round(d.ratio * 100) / 100; } },
       { label: 'per adopted (leading)', num: true, get: function (d) { return d.ratioAdopted == null ? null : Math.round(d.ratioAdopted * 100) / 100; } }], ratio);

    stackedCols(document.getElementById('chart-approvals'), {
      label: 'Action approvals per day: pilot vs human',
      rows: days,
      segs: [
        { label: 'auto-approved (pilot)', cssVar: '--s1', get: function (d) { return d.autoApproved; } },
        { label: 'human-approved', cssVar: '--s2', get: function (d) { return d.humanApproved; } },
      ],
    });
    tableView(document.getElementById('table-approvals'),
      [{ label: 'day', get: function (d) { return d.day; } },
       { label: 'pilot', num: true, get: function (d) { return d.autoApproved; } },
       { label: 'human', num: true, get: function (d) { return d.humanApproved; } }], days);

    lineChart(document.getElementById('chart-policies'), {
      label: 'Policy population by status over time',
      rows: policyDays,
      series: [
        { label: 'active (earned)', cssVar: '--s1', get: function (d) { return d.active; } },
        { label: 'shadow (unproven)', cssVar: '--s2', get: function (d) { return d.shadow; } },
        { label: 'superseded', cssVar: '--de', get: function (d) { return d.superseded; } },
      ],
    });
    tableView(document.getElementById('table-policies'),
      [{ label: 'day', get: function (d) { return d.day; } },
       { label: 'active', num: true, get: function (d) { return d.active; } },
       { label: 'shadow', num: true, get: function (d) { return d.shadow; } },
       { label: 'superseded', num: true, get: function (d) { return d.superseded; } }], policyDays);

    var loadCfg = DATA.actors;
    var segVars = ['--s1', '--s2', '--s3'];
    stackedCols(document.getElementById('chart-actors'), {
      label: 'Interruption load by actor per day',
      rows: slice(loadCfg.rows),
      segs: loadCfg.segments.map(function (name, i) {
        return {
          label: name,
          cssVar: name === 'other' ? '--de' : segVars[i],
          get: function (d) { return d.counts[name] || 0; },
        };
      }),
    });
    tableView(document.getElementById('table-actors'),
      [{ label: 'day', get: function (d) { return d.day; } }].concat(loadCfg.segments.map(function (name) {
        return { label: name, num: true, get: function (d) { return d.counts[name] || 0; } };
      })), slice(loadCfg.rows));

    hBars(document.getElementById('chart-provenance'), {
      label: 'Policy provenance: seeded vs learned live',
      rows: ['seeded', 'learned'].map(function (k) {
        var v = DATA.provenance[k];
        return { label: k === 'seeded' ? 'seeded (backfill)' : 'learned live', segs: [
          { label: 'active', value: v.active, cssVar: '--s1' },
          { label: 'shadow', value: v.shadow, cssVar: '--s2' },
          { label: 'superseded', value: v.superseded, cssVar: '--de' },
        ] };
      }),
      legend: [
        { label: 'active (earned)', cssVar: '--s1' },
        { label: 'shadow (unproven)', cssVar: '--s2' },
        { label: 'superseded', cssVar: '--de' },
      ],
    });
    tableView(document.getElementById('table-provenance'),
      [{ label: 'provenance', get: function (r) { return r.label; } },
       { label: 'active', num: true, get: function (r) { return r.active; } },
       { label: 'shadow', num: true, get: function (r) { return r.shadow; } },
       { label: 'superseded', num: true, get: function (r) { return r.superseded; } }],
      [{ label: 'seeded (backfill)', active: DATA.provenance.seeded.active, shadow: DATA.provenance.seeded.shadow, superseded: DATA.provenance.seeded.superseded },
       { label: 'learned live', active: DATA.provenance.learned.active, shadow: DATA.provenance.learned.shadow, superseded: DATA.provenance.learned.superseded }]);
  }

  document.querySelectorAll('.filters button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.range = +b.dataset.range;
      document.querySelectorAll('.filters button').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      renderAll();
    });
  });
  renderAll();
  var t;
  window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(renderAll, 150); });
})();
`;

// ---------------------------------------------------------------------------
// HTML assembly

function tile(label: string, value: string, extra = '', hero = false): string {
  return `<div class="tile${hero ? ' hero' : ''}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${extra}</div>`;
}

function chartSection(id: string, title: string, hint: string): string {
  return `<div><h2>${esc(title)}</h2><p class="hint">${esc(hint)}</p><div id="chart-${id}"></div><div id="table-${id}"></div></div>`;
}

export function renderStatsHtml(stats: StatsPayload): string {
  const t = stats.totals;
  const per = t.interventionsPerOutcome;
  // The delta compares like with like: both endpoints come from the dated-act
  // outcome curve (conclusion denominator); the hero VALUE is counter-anchored.
  const curveNow = stats.ratio[stats.ratio.length - 1]?.ratio ?? null;
  let delta = '';
  if (curveNow != null && t.perOutcomeWeekAgo != null) {
    const diff = curveNow - t.perOutcomeWeekAgo;
    const cls = diff < 0 ? 'down-good' : diff > 0 ? 'up-bad' : '';
    delta = `<div class="delta ${cls}">${diff <= 0 ? '' : '+'}${diff.toFixed(2)} over 7 days (dated acts)</div>`;
  } else {
    delta = `<div class="delta">↓ means fewer recorded touches per successful outcome — compare like with like</div>`;
  }
  const autonomyPct =
    t.autoApproved + t.humanApproved > 0
      ? `${Math.round((t.autoApproved / (t.autoApproved + t.humanApproved)) * 100)}%`
      : '—';
  const rel = t.reliability;
  const ph = t.passHealth;
  const at = t.attribution;
  const firstAttemptPct = rel.firstAttemptRate == null ? '—' : `${Math.round(rel.firstAttemptRate * 100)}%`;
  const recoveryPct = rel.recoveryRate == null ? '—' : `${Math.round(rel.recoveryRate * 100)}%`;
  const kpis = [
    tile(
      'Interventions per successful outcome',
      per == null ? '—' : per.toFixed(2),
      `${delta}<div class="delta">${t.interventionsPerAdopted == null ? '—' : t.interventionsPerAdopted.toFixed(2)} per adopted work product (leading indicator, not outcome success)</div>`,
      true,
    ),
    tile(
      'Successful outcomes',
      String(t.successfulOutcomes),
      `<div class="delta">qualified typed conclusions · ${t.adoptions} adopted work products (leading indicator, not outcome success)</div>`,
    ),
    tile(
      'Human interventions',
      String(t.interventions),
      `<div class="delta">${at.human} human · ${at.session} agent-session · ${at.unattributed} legacy${t.undated ? ` · ${t.undated} undated (legacy/config)` : ''}</div>`,
    ),
    tile(
      'Actions auto-approved (delegated)',
      autonomyPct,
      `<div class="delta">${at.pilot} pilot · ${t.humanApproved} human — delegated authority, NOT a learned-policy win</div>`,
    ),
    tile(
      'Worker first-attempt completion',
      firstAttemptPct,
      `<div class="delta">${rel.firstAttempt}/${rel.completed} completed first try · ${recoveryPct} retry recovery</div>`,
    ),
    tile(
      'Coordinator pass health',
      String(ph.logicalFailure),
      `<div class="delta">logical failures · ${ph.providerBackoff} provider backoff · ${ph.conflicted} conflicted (revision check)</div>`,
    ),
    tile('Policies earned active', String(t.policiesActive), `<div class="delta">${t.policiesShadow} shadow · ${t.policiesSuperseded} superseded</div>`),
    tile('Coordinator passes', String(t.passes), `<div class="delta">${t.workstreams} workstreams (${t.active} active)</div>`),
  ].join('\n');

  const rowsHtml = stats.rows
    .map(
      (r) => `<tr>
<td><strong>${esc(r.slug)}</strong> <span style="color:var(--muted)">${esc(r.status)}</span></td>
<td>${r.concluded ? '✓ concluded' : '—'}</td>
<td class="num">${r.passes}</td>
<td class="num">${r.adopted}</td>
<td class="num">${r.rejected}</td>
<td class="num">${r.interventions}</td>
<td class="num">${r.perOutcome == null ? '—' : r.perOutcome.toFixed(1)}</td>
<td class="num">${r.autoApproved}/${r.autoApproved + r.humanApproved}</td>
</tr>`,
    )
    .join('\n');

  const actorTotalsHtml = stats.actors.totals
    .map(
      (a) => `<tr>
<td><strong>${esc(a.actor)}</strong></td>
<td class="num">${a.byKind.steering}</td>
<td class="num">${a.byKind.approval}</td>
<td class="num">${a.byKind.rejection}</td>
<td class="num">${a.byKind.resolution}</td>
<td class="num">${a.byKind.adoption}</td>
<td class="num">${a.total}</td>
</tr>`,
    )
    .join('\n');

  const json = JSON.stringify(stats).replaceAll('<', '\\u003c');
  const body = stats.days.length
    ? `
<div class="filters" role="group" aria-label="Date range">
  <span class="flabel">Range</span>
  <button data-range="7" aria-pressed="false">7d</button>
  <button data-range="30" aria-pressed="false">30d</button>
  <button data-range="90" aria-pressed="false">90d</button>
  <button data-range="0" aria-pressed="true">All</button>
</div>
<div class="kpis">${kpis}</div>
<section><div class="chart-grid two">
${chartSection('activity', 'Work products vs interventions', 'Adopted work products and recorded human interventions per day, fleet-wide. Adopted work is a leading indicator, not outcome success. Compare similar work; a quieter line is not a quality measure by itself.')}
${chartSection('ratio', 'The intervention curve', 'Cumulative recorded human interventions over dated acts only. The primary line divides by successful outcomes (qualified typed conclusions) — the product target; the secondary line divides by adopted work products, an explicit leading indicator, never completed-outcome success relabeled.')}
</div></section>
<section><div class="chart-grid two">
${chartSection('approvals', 'Who approves the real world', 'Gated actions approved per day: pilot auto-approvals (within the operator’s standing rules) vs explicit human keypresses. Authority is never learned — this ratio moves only when the operator widens pilot’s rules.')}
${chartSection('policies', 'Policy population', 'Every policy starts shadow (unproven) and earns active through an intervention-free matching workstream; a wrong one is superseded with lineage, never edited away.')}
</div></section>
<section>
<h2>Who absorbs the interruptions</h2>
<p class="hint">Interventions by named actor (WEAVER_ACTOR): the human at the keyboard, agent sessions steering on their behalf, teammates. Agents-on-agents is the intended shape — a session absorbing routine interruptions is cheap; human keypresses are the scarce resource the curve should drive down first. The pilot never appears here: auto-approval is delegated authority, not an interruption. Acts predating attribution show as “unattributed”.</p>
<div id="chart-actors"></div><div id="table-actors"></div>
<div class="scroll-x"><table>
<thead><tr><th>Actor</th><th class="num">Steers</th><th class="num">Approvals</th><th class="num">Rejections</th><th class="num">Resolutions</th><th class="num">Adoptions</th><th class="num">Total</th></tr></thead>
<tbody>${actorTotalsHtml}</tbody>
</table></div>
</section>
<section>
<h2>Whose rules accumulate evidence</h2>
<p class="hint">Seeded policies came from the operator’s pre-Weaver rules and transcripts; learned ones from live corrections. Both earn active status through intervention-free matching work. This shows where evidence is accumulating, not which rule is universally best.</p>
<div id="chart-provenance"></div>
<div id="table-provenance"></div>
</section>
<section>
<h2>Per workstream</h2>
<p class="hint">A workstream is a successful outcome only once it carries a qualified typed conclusion (the “Outcome” column); adopted work is a leading indicator beside it. The intervention count per adopted work product varies with task mix and required authority. The fleet trend is a prompt to investigate; this table is where to look when it moves.</p>
<div class="scroll-x"><table>
<thead><tr><th>Workstream</th><th>Outcome</th><th class="num">Passes</th><th class="num">Adopted work</th><th class="num">Rejected</th><th class="num">Interventions</th><th class="num">Per adoption</th><th class="num">Auto-approved</th></tr></thead>
<tbody>${rowsHtml}</tbody>
</table></div>
</section>`
    : `<section><p class="empty">No fleet activity yet — create a workstream and run the engine, then regenerate.</p></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weaver — outcome scoreboard</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Does each outcome need you less often?</h1>
<p class="subtitle">${stats.totals.workstreams} workstream(s) · generated ${esc(stats.generatedAt)} · target: fewer human interventions per successful outcome, without weaker work or wider authority · success denominator: qualified typed conclusions · adopted work products shown as a leading indicator, not outcome success</p>
${body}
<footer>
Generated by <code>weaver stats</code> from durable typed state — steering timestamps, gate approvals, adoption pins, pass records, and policy evidence; never from the bounded event tail, which would fabricate convergence as old events fall off. An intervention is a steer, an approval or rejection of a gated action or send, an attention resolution, or a human adoption override — one keypress counts once, whatever it also auto-resolves; ${
    stats.totals.undated
      ? `${stats.totals.undated} intervention(s) (legacy/config edits) carry no durable timestamp and appear in totals only.`
      : `legacy/config edits would appear in totals only.`
  } Adoption ≠ completion: the success denominator is qualified typed Workstream conclusions; adopted work products are reported alongside as a leading indicator, never as outcome success. Provider capacity/rate/auth backoff (a pass carrying a typed infrastructure wait) is reported separately from logical coordinator failure (error/no_finish with no infrastructure); a revision-conflict finish counts as neither. Pilot auto-approvals are delegated authority, reported separately from learned-policy effects.
</footer>
<script type="application/json" id="stats-data">${json}</script>
<script>${SCRIPT}</script>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Entry point: load → compute → render → redact → write

export async function runStats(now = new Date()): Promise<string> {
  const docs: WorkstreamDoc[] = [];
  for (const s of await listWorkstreams()) docs.push(await load(s));
  const policies = (await loadPolicies()).policies;
  const allSecrets = loadAllSecrets();
  const html = renderStatsHtml(computeStats(docs, policies, now));
  const out = path.join(weaverHome(), 'stats.html');
  fs.writeFileSync(out, redactSecrets(html, allSecrets));
  return out;
}
