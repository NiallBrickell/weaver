# The learning loop: interventions become policies, policies earn trust

Design ported from the parallel `relay` experiment (its strongest idea), adapted to Weaver's store. The claim is deliberately narrow: **"stored a memory" is not learning — learning is the next matching workstream's plan being different for an inspectable, attributable reason, and needing fewer human interventions without weaker verification.**

## The episode

The unit of learning is a typed episode, already captured by Weaver's existing records:

```text
proposed course (decision/pass record) → human intervention (steering, rejection, correction)
  → adopted course (superseding/new decision) → actions → evidence → evaluated outcome
```

When steering *corrects* a course — as opposed to supplying facts the coordinator asked for — the coordinator distills the correction with `propose_policy` into a **policy candidate**: a plain-language rule with typed scope (workstream tags), a constrained effect, and full provenance (source workstream, pass, steering record, and what-was-proposed-vs-corrected).

## The policy lifecycle

```text
shadow ──(evidence: applied + intervention-free on its point)──► active
   │                                                                │
   └──────────────── superseded (lineage kept, like decisions) ◄────┘
```

- **Shadow**: appears in the projection of every workstream sharing a tag. The coordinator may apply it, and every application must be cited (`applied_policy_ids` on the applying decision) so the effect is attributable — a policy is never ambient prose with silent power.
- **Active**: earned, not asserted. Promotion requires `record_policy_outcome` evidence that a matching workstream applied the policy and needed no further human correction on the same point.
- **Superseded**: a policy that proved wrong is replaced with lineage, exactly like decisions. An unhelpful policy is contradicted openly in a decision, never silently ignored.

## The authority firewall

Structural, not behavioral: the policy effect vocabulary is closed — `add_verification`, `narrow_authority`, `advisory`. A policy that would spend, send, merge, contact, or otherwise widen authority is *unrepresentable* in the store (`src/policies.ts`), and `widensAuthority: false` is a literal type. However confident a policy becomes, authority still comes only from the workstream's own budget/autonomy config and from egress-time revalidation. Learning can recommend; it can never permit.

## Why this is an optimization substrate (the RL framing)

This bookkeeping is deliberately shaped like a reinforcement-learning problem so that later work can optimize over it rather than redesign it:

- **Trajectory**: the episode above — state (projection), action (proposed course), correction signal (intervention), outcome (evaluated results).
- **Action space**: policy proposal (when to distill, how to scope) and policy application (which matching policies to apply where).
- **Reward**: `humanInterventions` per successful outcome (tracked per workstream in `spend.humanInterventions`, surfaced in `weaver status`), guarded by outcome quality, spend, and the authority firewall — a policy that reduces interventions by weakening verification must score as a regression, not a win.

The optimization order is fixed: the bookkeeping must be trustworthy before anything trains against it. Concretely, before any learned proposal/application model: (1) episodes must be complete (every intervention linked to the proposal it corrected), (2) attribution must be enforced (unattributed policy influence is a bug), and (3) the reward must be adversarially audited (interventions can be *good* — an approval gate firing is the system working). Only then is "build agents that do RL over the policy space" — proposing better policies, scoping them tighter, pruning bad ones — a well-posed problem rather than vibes with a database.

## Backfill: seeding from pre-Weaver practice

`weaver backfill` (src/backfill.ts) seeds the store from practice that predates Weaver: deterministic parsing of CLAUDE.md/AGENTS.md-style rules files, and — optionally, behind `--claude-projects` — one bounded model pass that distills durable corrections from recent Claude Code transcripts. Backfill changes where candidates come from, never what they are: every seeded policy is shadow, carries a `backfill:*` provenance variant (file § heading, or session id + quote), and earns promotion through the normal evidence loop. The authority firewall applies at import — grant-shaped text (merge/send/spend/bypass without restricting language) is refused with a note, not converted — and re-runs dedup on normalized statement, so backfill is idempotent.

## What's deliberately not here yet

- Automatic intervention classification (correction vs. fact-supply vs. approval) — the coordinator judges this today; a classifier is future work and its errors must be inspectable.
- Confidence scores — evidence counts are stored raw; scorecard math belongs with acme's decision-lineage scorecard design, not improvised here.
- Cross-tag generalization — a policy applies where its tags say, never further; broadening scope is a human or explicitly-superseding act.
