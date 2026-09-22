/**
 * The fleet capacity ledger — one account's provider limits, held once.
 *
 * A provider limit belongs to the ACCOUNT, not to the workstream that happened
 * to discover it: `sentry-sweep` learning that opus-5 is session-limited is the
 * same fact as `nobe-parc-feedback` learning it, and one stream's next
 * successful call is proof for every other stream parked on that target. Weaver
 * stored that fact per-workstream, so recovery was per-workstream too — after a
 * reset, streams whose own retry happened to land first resumed, while streams
 * whose stored retryAt sat further out stayed parked behind a limit that no
 * longer existed, indistinguishable on the board from ordinary waiting. That is
 * the "most resumed but one or two are still stuck" shape.
 *
 * So recovery is recorded here, once, keyed by capacity target. Each workstream
 * keeps its own wait records — they are its audit trail and its wake schedule —
 * but a record predating the fleet's latest recovery for the same target is
 * spent, and the runner releases it without waiting for that stream's timer.
 *
 * This ledger is still recovery-only and host-local. Discovery is now shared
 * too, but NOT here: it is derived from the workstream documents themselves
 * (`fleetSeatView` in capacity.ts), so every host sees the same parks and the
 * same successes. The rule used to be that one stream's rejection never parks
 * another, because "a single rejection is not proof the pool is empty for
 * everyone". The production store disproved that for ACTIVE waits on a known
 * executor/provider/model: over 30 days to 2026-09-21, 96.4% of 5,411
 * coordinator capacity backoffs started while another workstream already held
 * an active wait on the same target, and 91.6% had no success in between —
 * the launch only rediscovered the limit. The cost of trusting the shared wait
 * is small: 2% of successful passes (66 of 3,252) started under such a wait,
 * and the median one would have waited 13 minutes. So a seat parked for one
 * workstream is parked for the fleet, with three guards against the frozen
 * fleet the old rule feared: the wait expires at its own retryAt, any later
 * success anywhere refutes it, and when it expires unrefuted the runner admits
 * exactly one probe launch instead of the whole deferred herd.
 *
 * What stays per host: waits of kind `other` (a local safety wall, a network
 * or DNS drop, a provider 5xx) and `auth` (this host's credential). They are
 * facts about the machine that saw them, and a laptop that lost its network or
 * login must never park a healthy VM. A successful call, by contrast, is proof
 * of capacity wherever it happened — which is why this ledger may release any
 * stream's own wait, while borrowed copies are released only by the shared
 * document view that lent them (see fleetRecoveredSlugs in runner.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { capacityTargetKey } from './capacity.js';
import type { CapacityTarget } from './modelConfig.js';
import { weaverHome } from './store.js';
import type { Iso } from './types.js';

export interface FleetCapacityLedger {
  /** capacityTargetKey → when a real call last SUCCEEDED on that target. */
  recovered: Record<string, Iso>;
}

const EMPTY: FleetCapacityLedger = { recovered: {} };

function ledgerPath(): string {
  return path.join(weaverHome(), 'capacity.json');
}

export function readFleetCapacity(): FleetCapacityLedger {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')) as Partial<FleetCapacityLedger>;
    const recovered = parsed.recovered;
    if (!recovered || typeof recovered !== 'object') return EMPTY;
    // Hand-edited or partially-written ledgers must degrade to "no recovery
    // known", never to a bogus timestamp that would release live parks.
    const clean: Record<string, Iso> = {};
    for (const [key, at] of Object.entries(recovered)) {
      if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) clean[key] = at;
    }
    return { recovered: clean };
  } catch {
    return EMPTY; // absent or unreadable — the fleet simply knows of no recovery
  }
}

/**
 * Record that a real call just succeeded on this target. Monotonic: a slower
 * writer finishing late can never move a target's recovery backwards, which
 * would resurrect parks the fleet has already cleared.
 */
export function noteFleetRecovery(target: CapacityTarget, at: Iso): void {
  const key = capacityTargetKey(target);
  const ledger = readFleetCapacity();
  if (ledger.recovered[key] && ledger.recovered[key]! >= at) return;
  const next: FleetCapacityLedger = { recovered: { ...ledger.recovered, [key]: at } };
  const file = ledgerPath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file); // atomic: a reader never sees a half-written ledger
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    // A ledger write failing must never fail the successful call that
    // triggered it — the fleet loses an optimization, not correctness.
  }
}

/**
 * Whether a stored wait detected at `detectedAt` has been overtaken by a
 * fleet-wide recovery on the same target. Strictly-after, so the very call that
 * recorded a NEW limit is never read as its own release.
 */
export function supersededByFleetRecovery(
  ledger: FleetCapacityLedger,
  target: CapacityTarget,
  detectedAt: Iso,
): boolean {
  const at = ledger.recovered[capacityTargetKey(target)];
  return at !== undefined && at > detectedAt;
}
