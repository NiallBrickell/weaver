# The learning loop

*Corrections become policies; policies earn trust with evidence; authority is never learnable*

The claim is deliberately narrow: **"stored a memory" is not learning.** Learning is the next matching workstream's plan being different for an inspectable, attributable reason — and needing fewer human interventions without weaker verification.

## Two ledgers

Weaver keeps two ledgers, and what may cross between them is the whole design:

- **The workstream decision log** is local. Every decision — courses chosen, courses superseded, the evidence and corrections behind them — lives inside its workstream with full lineage. Decisions are *facts about one objective*: they never automatically apply anywhere else, because "what was right for this Sentry sweep" is not a rule.
- **The global policy store** is what generalizes. When a human correction reveals durable guidance — not a fact, a *way of working* — it is distilled into a policy candidate: plain-language statement, tag scope, constrained effect, provenance back to the exact workstream, pass, and correction that created it. That store is machine-wide; every future workstream sharing a tag starts with it.

Only distilled guidance crosses the boundary, and only downward in authority: local facts, adoption verdicts, and anything that would *permit* (spend, send, merge, widen access) stay local or are refused outright. Cross-stream **visibility** is a different, read-only thing: the knowledge inspector and `weaver ask` answer questions across every stream's decision log without making any of it normative.

## The episode

The unit of learning is a typed episode, captured by records the workstream already keeps:

```text
proposed course → human intervention (steering, rejection, correction)
  → adopted course (superseding decision) → actions → evidence → evaluated outcome
```

When steering *corrects* a course — rather than supplying facts the coordinator asked for — the correction is distilled into a **policy candidate**: a plain-language rule with typed scope (workstream tags), a constrained effect, and full provenance back to the workstream, pass, and correction that created it.

## The lifecycle

```text
shadow ──(another workstream applies it, cites it, and needs no correction)──► active
   │  └──(negative evidence)──► contested (under review) ──┐                    │
   │                                                       │                    │
   └──────────────── superseded (lineage kept) ◄───────────┴────────────────────┘
```

- **Shadow**: visible to every workstream sharing a tag. Applying one must be cited on the applying decision — a policy is never ambient prose with silent power. The citation is checked when the decision is written: a citation to a policy that does not exist, is superseded, or does not match the workstream's tags is rejected.
- **Active**: earned, attributable, and **cross-workstream**. Recording an outcome names the decision that applied the policy — that decision must really exist and really cite the policy. Promotion needs at least one intervention-free outcome from a workstream *other than* the one that proposed the policy: a policy can't certify itself on its own origin. (A shared or backfilled policy has no origin workstream, so any workstream's clean, cited outcome earns it.)
- **Contested**: when a matching workstream applies a policy and *still* needs a correction on its point, that negative evidence marks the policy **contested** — under review. A contested policy is pulled out of active guidance in the projection and won't guide (or promote) again until a human resolves it, but it is **never** silently demoted or deleted. You resolve it by superseding it with a better rule, or — if the failure was situational and the rule is still sound — clearing the review (`weaver policies review-clear`).
- **Superseded**: a wrong policy is replaced with lineage, exactly like decisions — contradicted openly, never silently ignored. Replacement and lineage are written together, atomically, so a crash can't leave two rules both live. You can supersede with a freshly written rule or by linking an existing one (`weaver policies supersede`, or the coordinator's `supersede_policy`).

## The authority firewall

Structural, not behavioral: the policy effect vocabulary is closed — *add verification*, *narrow authority*, *advisory*. A policy that would spend, send, merge, contact, or widen access is unrepresentable in the store. However trusted a policy becomes, authority still comes only from the workstream's own configuration and egress-time revalidation. **Learning can recommend; it can never permit.**

On top of that structural gate, the *wording* of a policy is screened wherever a statement enters the store — live proposals, backfill, seed import, and supersession alike. Text that reads as *granting* authority ("the workstream **may merge** its own PR ... only when CI is green", "reviewers **are allowed to deploy**") is refused, even when hedged with "only", because grant-shaped prose in the projection can still nudge a coordinator. A policy may advise how to act under a grant you already have ("only merge after CI passes"); it may never assert the grant itself. The screen errs toward refusal — rephrase without the permission word.

## Backfill: start from how you already work

A fresh install doesn't have to learn you from zero. `weaver backfill` seeds the policy store from your existing agent practice:

```bash
# deterministic: parse rule bullets from CLAUDE.md / AGENTS.md-style files
weaver backfill --tags myapp --rules ~/project/CLAUDE.md --dry-run

# optional, model-assisted: distill durable corrections ("don't do X, always do Y")
# from your recent Claude Code session transcripts — one bounded pass
weaver backfill --tags myapp --claude-projects ~/.claude/projects/<project> --limit 5
```

Backfill imports candidates, never trust. Every seeded policy lands in **shadow** with full provenance (file and heading, or session and quote) and earns *active* through the same evidence loop as a live correction. The authority firewall applies at import too: text that reads like granting authority — merging, sending, spending, bypassing gates — is refused with a note, never converted. Re-running is a no-op: candidates dedup against the store, so backfill is safe to repeat as your rules files evolve.

Once your store has substance, it's shareable: [team seeds](./team-seeds.md) export your guardrails in sanitized form for teammates to import — shadow on their machine, earning trust through their outcomes, with their corrections superseding yours on the record.

## The RL framing

The bookkeeping is deliberately shaped as a reinforcement-learning substrate so later work can optimize over it rather than redesign it:

- **Trajectory**: the episode — state (projection), action (proposed course), correction signal (intervention), outcome (evaluated results).
- **Action space**: when to distill a policy, how to scope it, which matching policies to apply where.
- **Target**: human interventions per successful outcome. The desired direction is down only while outcome quality and verification hold and the authority boundary does not move. [The stats page](./stats.md) shows the current adopted-work-product indicator beside those signals; it does not pretend adoption is completion.

The optimization order is fixed: episodes complete, attribution enforced, reward adversarially audited — only then is training against this data a well-posed problem rather than vibes with a database.
