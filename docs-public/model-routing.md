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

## Shadow coordinator seats: measurement only

The coordinator always runs on the strongest seat in its configured chain (`WEAVER_COORDINATOR_MODEL`, then `WEAVER_COORDINATOR_FALLBACKS`). Many of its passes look mechanical: adopt a result whose checks passed, then dispatch the step the standing course already named. Whether a cheaper model could take those passes is a question for evidence, so Weaver can measure a candidate seat without giving it any authority:

```bash
WEAVER_SHADOW_COORDINATOR=local-sdk:claude-sonnet-5   # one executor:model, local-sdk or codex-sdk
WEAVER_SHADOW_RATE=0.1                                 # fraction of completed passes to shadow; 0 or unset = off
WEAVER_SHADOW_EFFORT=medium                            # optional: the shadow seat's own reasoning effort; unset = the coordinator's
```

After a real pass completes, Weaver samples it at that rate. A sampled pass is replayed once by the shadow seat, detached from the real pass, with the same system prompt, the same projection text the real coordinator saw, and the same tool schemas. It runs through the coordinator's own isolated executor construction; only the tool set is swapped. Every tool is a capture twin: reads are served from the pass's snapshot, and writes are checked against that snapshot, recorded as `{tool, target ids}`, and answered with a plausible success. The twin never calls the real tool's code, so a shadow cannot write the Workstream, fire a wake, dispatch an assignment, or reach anything outside Weaver.

Weaver stores the comparison on the pass record as `shadow`. It holds the class of the real pass (verify-then-dispatch, dispatch-only, wait-only, conclude, or other), both seats' moves, the shadow's cost, and the agreement for each move type. The headline numbers are adopt/reject agreement for each assignment, and conclude and raise-attention agreement. Dispatch count, supersession, and the exact multiset of tools are reported beside them. Nothing a coordinator reads looks at this record: not the projection, the success counts, or spend. If a shadow run fails, Weaver records the failure and doesn't retry. The shadow's result is dropped rather than written while another pass holds the lease, so measurement can never make a real pass conflict.

```bash
weaver shadow-report [--since 2026-09-15T00:00:00Z]
```

The report prints agreement for each pass class with its denominators, the real and shadow cost and tokens on the same passes, and the disagreeing pass ids so you can read what each seat did. Results are grouped by shadow seat and reasoning effort, so runs at different efforts are never averaged together.

The shadow seat can also be the live model at a lower effort. Set `WEAVER_SHADOW_COORDINATOR` to the live seat and `WEAVER_SHADOW_EFFORT` to the effort you are considering: the shadow runs at that effort while live passes keep `WEAVER_COORDINATOR_EFFORT`.

**Promoting a seat is your decision, never Weaver's.** No agreement rate moves a class of passes onto the shadow seat automatically. The shadow seat is not a coordinator seat: it never joins the capacity chain, the runner's executor declaration, or the seats a runner publishes. It does spend real quota on its own seat, and that spend appears only in `weaver shadow-report`, not in coordinator spend. Keep the rate small.

## Where to read next

- [Where model loops run](./executors.md) — the executor substrates and their contracts
- [Configuration](./configuration.md) — every model/store/action variable
- [Harness evaluations](./harness-evals.md) — the bakeoff and the eval contract behind route evidence
