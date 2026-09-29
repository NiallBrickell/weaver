# The team overview

The [operator workspace](./operator-workspace.md) has three kinds of page. The board shows jobs, the fleet page shows shared infrastructure, and each workstream page shows one job in depth. None of them answers the question a teammate asks first: what is this thing, and is it doing anything useful? `GET /overview` answers it for people who have never used Weaver. It sits in the sidebar as **Overview**, behind the same Clerk or Basic sign-in as every other workspace page.

The page is read-only. It has no forms and no write route, and it reads nothing outside Weaver's own records.

## How it reads

The page is written for a newcomer, in plain English. It calls a workstream a *job*, an assignment a *piece of work*, and a coordinator pass a *check-in*, and it defines each of those once in a short glossary. Internal terms such as adoption, readback or projection do not appear in its copy; a test keeps them out.

Every section leads with one to three takeaway sentences, then shows the numbers behind them. The sentences are not written by hand. `overviewInsights(payload)` in `src/overview.ts` picks each one by a rule over the computed numbers (a majority, a threshold, the largest row), puts the figures it rests on in the same sentence, and leaves a sentence out when the data cannot support it. Shares are said the way a person would say them ("about 5 in 6 results") when a small fraction is within two percentage points, and as a percentage otherwise. Something that looks off is marked **Worth a look**, for example:

- a group of jobs whose results are rejected much more often than the fleet's (at least 20 checked results, and at least ten points and one and a half times above the fleet rate);
- a fifth or more of check-ins waiting for model capacity, or a tenth or more failing for other reasons;
- a tenth or more of the jobs started by other jobs being opened by a job that was itself opened by another;
- a quarter or more of active jobs waiting for model capacity;
- more merges that did not go through than merges confirmed.

## What it answers

**What Weaver is.** A short explainer, a diagram of the loop and the glossary. A person gives Weaver a job or a message. Each job has one record in a shared database. The engine starts a fresh model for each check-in, which reads the record, decides what to do next and saves its changes; a save that clashes with a newer message or result is refused. Agents hand back results that only count once Weaver accepts them, and actions such as merging code count only once Weaver has checked they happened. The section opens with how many jobs Weaver has taken on and where they stand.

**Where work comes from.** Most jobs are started by other jobs. A routine wakes up on a schedule, looks at a source and opens one new job for each real problem. The page groups every job by the job that started it (its `managedBy` parent) and draws one bar per parent, split into active, paused and finished. Work people started directly has its own row. The takeaway says who starts most of the work and which jobs started the most others.

**What it is doing now.** Active jobs, one tab per parent. The busiest tab opens first, and the chosen tab is part of the link (`?now=<parent>`), so it survives a live refresh. Each card shows what the job is for and its current plan (the title of its latest standing decision). The takeaway counts what the active jobs are waiting on, using the board's precedence: a need for a person first, then work in flight (a running or in-review piece of work, or a live check-in), then a wait for model capacity, then a scheduled check; anything else is ready for its next step.

**How jobs ended.** Weaver can only mark a job finished by pointing to evidence, and it records what kind of ending it was: delivered something, nothing needed changing, not worth doing, a duplicate, or closed by a person. Jobs that finished before endings were recorded are counted on their own line and never guessed from the summary text. The takeaway separates those from what has been recorded since. Jobs closed without saying how they ended, and paused jobs, are counted separately, because neither is a success.

**Is the work useful?** Each figure carries its denominator:

- results accepted versus rejected, out of those Weaver has checked;
- finished pieces of work that succeeded on the first try;
- merges confirmed on GitHub afterwards. There is no field that says "this is a merge", so a merge is recognised by `gh pr merge` in the action's command or objective. A single sentence under this figure says what it cannot tell you: it counts merges, not whether the code was good, because checking quality needs GitHub history that this page does not read;
- jobs opened by a job that another job opened. A rising share would mean fixes are causing more fixes;
- how often a person stepped in per successfully finished job, the number Weaver tries to push down. It is shared with [`weaver stats`](./stats.md) rather than re-derived, and the takeaway also gives the share of jobs that needed a person at all;
- check-ins that completed, with waits for model capacity kept apart from real failures.

**What it costs.** The page adds up the cost recorded on every check-in and every agent run. The takeaway gives the total and the cost per day since the first job, whether most of it went on deciding what to do next or on the work itself, the single most expensive job (with its cost per day), the costliest group of work under a job that started others, and how much of the total is real money. The tables break cost down by group (a job plus every job it opened directly) and by where the model ran, each labelled with how it is billed. Anthropic runs through the Claude SDK (`local-sdk`) report a list price even on a subscription, so that figure is an *estimate*. OpenRouter charges per use, so its figure is *real money*. Everything else is *unknown* rather than guessed, including records old enough to have no target at all.

**Examples, one tab per way a job ends.** Delivered (preferring a run that merged a fix), looked into with no code needed, corrected by a person, and stopped without delivering. Each tab is the most recently finished job of that kind with at least five pieces of work, preferring one that is easy to follow (at most 30 pieces of work and 60 check-ins, at most a quarter of checked results rejected) over simply the newest one. A job appears under one tab only, and a kind with no example has no tab. The chosen tab is part of the link (`?example=<kind>`). Each renders with the same timeline a job page opens on (see [operator workspace](./operator-workspace.md)), showing the most recent 40 rows with a link to the full timeline.

## Why it does not slow the fleet down

Reading every workstream is not cheap on a hosted store, because each document body crosses the database proxy. The overview reuses the single fleet load that already backs the board and computes everything, the takeaway sentences included, from those documents. It keeps the result keyed by the fleet revision, a hash of every workstream's revision plus runner presence and a one-minute presentation tick, which is read from head columns without loading any bodies. While that revision is unchanged, every viewer is served the same computed overview, and concurrent first views share one load. A write, a change in runner presence or the next minute makes the next view recompute. So the cost is at most one fleet load per revision, however many people have the page open.

## Where it lives

- `src/overview.ts` holds `computeOverview(docs, policies, now)` and `overviewInsights(payload)`, both pure over Weaver's records, and the revision memo.
- `src/ui/operator/overview-page.tsx` holds the page markup.
- The route is `GET /overview` in `src/operatorUi.ts`.
