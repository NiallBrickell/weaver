# Model routing

*Typed facts decide where work runs — never briefing prose, never a model name*

When Weaver dispatches an assignment, something has to choose which model runs it. That choice is made from typed facts the coordinator declares on the assignment, in a fixed order, with the operator's configuration answering — never from a model name the coordinator wrote into a brief, and never by guessing capability needs from prose. This page is the whole story in one place: the facts, the order, and why the vocabulary looks the way it does.

## The three typed facts

Every work assignment can carry `executionRequirements`:

- **Profile** — *what kind of capability the work needs*: `general` (default), `bounded-code-repair` (a small, well-specified code fix with deterministic verification), `evidence-synthesis` (source-grounded analysis), `ui-build` (implementation whose acceptance depends on rendered UI quality).
- **Modalities** — what inputs the work must handle: `text`, or `text` + `image`. A text-only route can never take image work.
- **Complexity** — *how demanding* the work is: `standard` (default) or `high`, where acceptance depends on deep multi-file reasoning, design judgment, or hard debugging.

Profile and complexity answer different questions: `complexity: high` selects the operator's stronger **seat** (`WEAVER_WORKER_MODEL_COMPLEX`, same substrate, model only); profile selects **reviewed routes** proven on exactly that shape of work. A route proven on bounded code repair must not fire on a hard research brief — that is why "how demanding" is not a substitute for "what kind".

The profile is not a persona, an agent definition, or a model choice. There is no "security agent" record to configure — a security review is a security-shaped assignment, and its declared profile is how that shape stays durable across worker replacement. The coordinator never names a model or provider; it declares the shape, and routing answers.

## The resolution order

For a work assignment, Weaver builds an ordered list of candidate targets:

1. **Reviewed routes** — checked-in, evidence-backed preferences that match the assignment's profile and modalities, *within the configured substrate only*. Each carries its eval cohort as provenance: a complete cohort of the route's **declared minimum runs** (every active route declares ten), each an exact repetition passing every hard gate and named quality check in the same adapter and case versions — the auditor enforces that declared minimum, not a global count. The profile a route serves is a reviewed registry declaration: eval rows record the case and its gates, never the assignment profile. Preference order breaks ties.
2. **The configured seat** — `WEAVER_EXECUTOR` + `WEAVER_WORKER_MODEL`, or `WEAVER_WORKER_MODEL_COMPLEX` when complexity is `high`. Unmatched work always lands here.
3. **The operator's ladder** — `WEAVER_WORKER_FALLBACKS`, an explicit comma-separated list of `executor:model` seats that may cross substrates because the operator wrote it (same trust class as `WEAVER_EXECUTOR` itself).

A capacity-parked target is skipped in favor of the next candidate; the exact executor/provider/model actually used is pinned on the disposable attempt, while the declared requirements survive on the intended work. A checked-in route changes the model *within* your configured substrate — never the substrate itself — so a stock runner never silently reserves work for a different executor.

**Actions never enter this order.** They run on `WEAVER_ACTION_EXECUTOR` / `WEAVER_ACTION_MODEL` (supervised local Claude by default), because an irreversible egress needs the executor whose tool calls Pilot can supervise live.

## Why values without routes are still declared

Today only `bounded-code-repair` has reviewed routes; `evidence-synthesis` and `ui-build` are declared facts that no route binds to yet. That is deliberate, not unfinished: the harness eval suite already grades those shapes, and when a complete cohort passes, the new route is a registry-only addition that applies to exactly the assignments already carrying the declaration — no re-teaching, no over-matching, no migration. No route binds to `general`: a route bound to the fallback would match everything and no evidence could justify it. That is a registry convention — `routeMatches` itself would accept it — enforced by the registry auditor test rather than runtime code.

This is also why the vocabulary is closed: a value enters it as a deliberate schema decision, routes earn their way in with evidence, and nothing in between lets a fluent brief influence execution.

## Where to read next

- [Where model loops run](./executors.md) — the executor substrates and their contracts
- [Configuration](./configuration.md) — every model/store/action variable
- [Harness evaluations](./harness-evals.md) — the bakeoff and the eval contract behind route evidence
