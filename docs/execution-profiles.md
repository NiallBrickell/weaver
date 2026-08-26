# Execution profiles — why the vocabulary exists

*Decision record and plan, 26 August 2026. The question: do we even need the
`general / bounded-code-repair / evidence-synthesis / ui-build` profile
vocabulary on assignments? Verdict: yes — but its job was undocumented, which
made two of the four values look like dead machinery. This note is the fix.*

## The decision

Keep the mechanism and all four values, and document what they actually are:
**the closed routing key an assignment declares — the reviewed registry match
between what harness evals can prove and what intended work can carry
durably.** Nothing about routing behavior changes. The binding is a
reviewed declaration in the registry, not a typed schema join: eval rows
carry case ids and gates, not assignment profiles — the registry declares
which profile a route serves.

## What a profile is, and is not

A profile is a typed fact the coordinator declares on an assignment
(`AssignmentExecutionRequirements.profile`) that says *what kind of capability
the work needs*. Reviewed model routes in
[`src/modelRouting.ts`](../src/modelRouting.ts) match on exactly this key plus
input modalities — never on briefing prose, never on a model name the
coordinator wrote.

It is deliberately **not**:

- **A persona or subagent definition.** Weaver has never persisted a portable
  Agent catalogue, and profiles do not create one — a "security agent" or
  "implementer agent" in the operator's mental model is a security-shaped or
  implementation-shaped *assignment*, and the profile is part of how that
  shape is declared. Whether a reusable named specialist definition is ever
  earned is held behind its own acceptance trigger (the consolidated
  organization plan,
  [#128](https://github.com/NiallBrickell/weaver/pull/128));
  capability requirements survive worker replacement (kernel rule 1), while a
  named persona would invite identity where there should only be intended
  work.
- **A model or provider choice.** The coordinator never names a model. The
  operator's config and the reviewed registry answer a declared requirement;
  the exact target is pinned per disposable attempt, never on intended work.
- **Authority.** Profiles change routing only. They cannot widen what an
  assignment may do — the work/action lifecycle and the egress gates are
  untouched by routing.

## Why the vocabulary is closed, and why it must exist at all

The alternative to a closed, typed key is one of three things, each wrong:

1. **Route on inferred prose.** Then model quality influences execution: a
   more fluent coordinator gets different workers for the same work. That is
   exactly the class of coupling the deterministic-rails discipline forbids —
   model quality must never make a durability or routing outcome pass or fail.
2. **Route on `general` only.** A route can never safely bind to `general`:
   it would match the whole fleet's fallback work, so no reviewed evidence
   could ever justify it. The fallback must stay unrouted.
3. **Complexity or modality alone.** Complexity says *how demanding*, not
   *what kind* — a route proven on bounded code repair must not fire on a
   high-complexity research brief, and `complexity: high` already has its own
   honest effect (the `WEAVER_WORKER_MODEL_COMPLEX` seat). Modality is a
   constraint (text-only routes cannot take image work), not a capability
   class.

## Why keep values with no routes today

Only `bounded-code-repair` currently has reviewed routes. `evidence-synthesis`
and `ui-build` are not dead weight; they are **forward-declared route scope**:

- The harness eval suite ([`src/evals/cases.ts`](../src/evals/cases.ts))
  already grades `evidence-synthesis` and `ui-build` cases. A value earns a
  route when a complete cohort passes every hard gate and named quality check
  — at that point the route is a registry-only addition that binds to exactly
  the assignments already carrying that declaration.
- Removing the values would make coordinators declare `general` for analysis
  and UI work. When the first such route later earns its cohort, it could not
  be applied narrowly without re-teaching and migrating history — the
  declaration is the scope, and history carries it.

The honest cost of the two unrouted values is one enum entry each; the honest
cost of removing them is foreclosing narrow future routes. Keep them.

## Status of each value (as of this note)

| Profile | Reviewed routes today | Effect if unmatched |
| --- | --- | --- |
| `general` | None, ever (the fallback must stay unrouted) | Configured seat |
| `bounded-code-repair` | 3, text-only: `pi:zai-coding-plan/glm-5.3` (pref 110), `codex-sdk:gpt-5.6-sol`, `pi:openrouter/moonshotai/kimi-k3` — within the configured substrate only | Configured seat |
| `evidence-synthesis` | None yet; eval case exists | Declared fact; future route scope |
| `ui-build` | None yet; eval case exists | Declared fact; future route scope |

## Invariants the mechanism already enforces (unchanged)

- Actions never enter routing (`workerTargetsForAssignment` returns the
  supervised action target immediately for `kind: 'action'`).
- Automatic routes never cross the configured substrate; the operator's
  explicit `WEAVER_WORKER_FALLBACKS` ladder may, because it is machine config.
- Requirements survive attempts; the selected executor/provider/model is
  pinned on the attempt.
- The coordinator declares the shape; it is never told which routes pay out,
  so it cannot game the registry — the enum description stays shape-based.

## Work items (this change)

1. This decision record.
2. `docs-public/model-routing.md` — the user-facing page: typed facts, the
   resolution order (routes → configured seat → operator ladder), why the
   vocabulary exists, how a route earns its place. Linked from the docs
   index, `executors.md`, `configuration.md`, and the root README.
3. One tightened comment on the union in `src/types.ts` stating the
   forward-scope purpose, so the next reader of the schema doesn't re-derive
   this from git archaeology.

## Acceptance

- `yarn typecheck` clean, `yarn test` green (documentation and comments only;
  no behavior change).
- The four-value vocabulary is explainable in one place without reading
  source: what each value means, which have routes, and what a value does
  before any route exists.
