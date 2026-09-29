# The team overview

The [operator workspace](./operator-workspace.md) has three kinds of page. The board shows jobs, the fleet page shows shared infrastructure, and each workstream page shows one outcome in depth. None of them answers the question a teammate asks first: what is this thing, and is it doing anything useful? `GET /overview` answers it, for people who have never used Weaver, from the same typed record the coordinator works from. It sits in the sidebar as **Overview**, behind the same Clerk or Basic sign-in as every other workspace page.

The page is read-only. It has no forms and no write route, and it performs no external reads.

## What it answers

**What Weaver is.** A short explainer and a diagram of the loop. A person writes an objective or a steer into a Workstream record in the shared store. The runner's engine ticks without a model and starts a fresh coordinator pass. The pass reads a projection of the record, makes a revision-checked write and exits. Worker runs return *proposed* results that only an adoption makes count. Gated actions change the outside world and count only when a readback confirms the effect. Anything that needs a person comes back through the needs-you queue. A glossary of the eight nouns (workstream, assignment, attempt, decision, adoption, action and readback, wake, policy) follows the diagram. The copy is fixed text because it describes the design, not the fleet. Every number on the page is computed.

**How work gets created.** Most workstreams are opened by other workstreams. A routine wakes on a schedule, looks at a source and opens one child per real problem. The page groups every workstream by its `managedBy` parent and draws one bar per parent, split into active, paused and done. Work opened directly by a person or by intake appears as the top-level row. Grouping follows the single parent pointer and never resolves a chain, just as a workstream only knows its own manager.

**What it is doing now.** Active workstreams, one tab per parent: the routine or workstream that opened them, or the top level for work a person started. The busiest tab opens first, and the chosen tab is part of the link (`?now=<parent>`), so it survives a live refresh. Each shows a one-line objective and the title of its latest *standing* decision, the course it is committed to right now. Superseded and closed decisions are lineage and do not appear here.

**How outcomes ended.** A conclusion is a success claim backed by cited evidence. Each conclusion is counted by its disposition: delivered, no change needed, not worth doing, duplicate, or closed at a person's direction. A conclusion recorded before dispositions existed is shown as *unclassified*. The page never infers one from the summary prose. Workstreams marked done without any conclusion are counted separately. So are paused workstreams, because pausing is how a person stops work without claiming it succeeded.

**Whether the work is useful or churn.** Each signal states its denominator:

- adopted versus rejected worker results, out of the results the coordinator has judged;
- completed assignments that needed only one attempt;
- merge actions whose readback confirmed the merge. There is no typed "this is a merge" field, so a merge is recognised by `gh pr merge` in the action's exact command or objective, and the page says so;
- repairs of repairs: workstreams opened by a workstream that was itself opened by another. A rising share would mean fixes are spawning fixes;
- human interventions per successful outcome, the number Weaver tries to push down. It is shared with [`weaver stats`](./stats.md) rather than re-derived;
- coordinator passes that completed, with capacity waits kept apart from real failures.

The page also states what it cannot tell you. It cannot say whether merged code was good, whether it was later reverted, or whether it caused follow-up fixes. Those facts live in GitHub, and a page that fetched them on every view would be slow, costly and a second source of truth. A readback-confirmed merge means the merge happened, not that it was right.

**What it costs.** The page adds up the cost recorded on every coordinator pass and every worker attempt. It shows the split between coordinator and worker spend, a breakdown by parent (a parent's own runs plus the workstreams it opened directly), and the total and median cost per concluded outcome, overall and by disposition. It also groups cost by executor and provider and labels each group with its billing basis. Anthropic runs through the Claude SDK (`local-sdk`) report a list-price figure even on a subscription, so that cost is *notional*. OpenRouter bills per token, so its figure is *cash*. Every other target is labelled *unknown* rather than guessed, and that includes records old enough to have no target at all.

**Worked examples, one tab per way work ends.** Delivered (preferring a run that merged a fix), investigated with no code needed, corrected by a person, and stopped without delivery. Each tab is the most recently concluded workstream of that kind with at least five assignments, preferring a readable run (at most 30 assignments and 60 coordinator passes, at most a quarter of judged results rejected) over simply the newest one; a workstream appears under one tab only, and a kind with no example has no tab. The chosen tab is part of the link (`?example=<kind>`). Each renders with the same timeline a job page opens on (see [operator workspace](./operator-workspace.md)): assignments with their kind, time, objective, state and adoption, decisions, human acts, waits, folded retries, and the conclusion with its disposition. It shows the most recent 40 rows, with a link to the full timeline.

## Why it does not slow the fleet down

Reading every workstream is not cheap on a hosted store, because each document body crosses the database proxy. The overview reuses the single fleet load that already backs the board and computes everything from those documents. It then keeps the result keyed by the fleet revision, a hash of every workstream's revision plus runner presence and a one-minute presentation tick, which is read from head columns without loading any bodies. While that revision is unchanged, every viewer is served the same computed overview. Concurrent first views share one load. A durable write, a change in runner presence or the next minute makes the next view recompute. So the cost is at most one fleet load per revision, however many people have the page open.

## Where it lives

- `src/overview.ts` holds `computeOverview(docs, policies, now)`, which is pure over typed state, and the revision memo.
- `src/ui/operator/overview-page.tsx` holds the page markup.
- The route is `GET /overview` in `src/operatorUi.ts`.
