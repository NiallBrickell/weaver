# Cost reduction plan (2026-09-29)

Weaver's decisions are good, and they are expensive. This plan cuts cost without weakening those decisions: fewer model passes spent on bookkeeping, and every judgment pass kept on a strong model. It is ordered by measured spend, not by intuition.

## Where the spend goes

All figures come from typed pass and attempt records in the shared store (`passes[].costUsd`, `assignments[].attempts[].costUsd`). Anthropic `local-sdk` costs are SDK-reported notional figures on a subscription. There, the real limit is quota, and running out of quota is itself an outage. OpenRouter costs are cash.

Fleet lifetime (2026-08-04 → 2026-09-28): about $11.6k reported. Coordinator passes account for $7.3k (63%) and worker attempts for $4.3k (37%). The 1,843 engine-run action attempts cost nothing, because no model runs. A concluded workstream costs about $38 on average; the median coordinator spend per concluded workstream is $16.

The last 14 days (since 2026-09-15), coordinator passes grouped by what woke them:

| Wake | Passes | Reported cost |
|---|---|---|
| A single assignment or action completed | 1,874 | **$2,327 (67%)** |
| Scheduled / other | 509 | $426 |
| Infrastructure retry / fallback | 1,105 | $364 |
| Manager or child notice | 257 | $216 |
| Backstop / safety | 89 | $58 |
| Probe output changed | 74 | $54 |
| Human steer | 30 | $23 |

The dominant cost is one full coordinator pass per completion. `daily-engineering-update` shows it most clearly: 121 of its 189 passes in 14 days were completion wakes. The first reading of that row was a parallel fan-out paying one pass per sibling. The replay under Phase 1 shows that reading is wrong. A pass's assignments already share one pass, and nearly every completion pass follows an assignment that its pass dispatched alone.

Routine polling (the "scheduled" row) is a small share. Probes (`schedule_probe`, docs-public/routines.md) already move change detection below the model. Only thread-review, ci-deploy-pipeline-health and e2e-test-hygiene use them today.

## What not to do

- **No lifetime budget.** It was deliberately retired (src/executionSafety.ts): a lifetime cap gives every healthy routine a scheduled death. The rolling execution-safety guard remains the runaway protection.
- **No silent model downgrade.** A cheaper coordinator seat is justified only by measured decision quality (phase 3), never assumed.
- **No keeping context alive to save re-reads.** Each pass re-reads the projection by design (kernel rule 2). The saving comes from running fewer passes, never from resuming a session.

## Phase 1: batch completion wakes (measured, not built)

The proposal was to hold a completion wake while sibling assignments of the same workstream are still running, and to wake once when the last sibling settles or a bounded delay expires. The replay was the acceptance gate, and it was run before any code: `npx tsx scripts/replay-completion-batching.ts <state-dir>` reads a filesystem snapshot and reports, for every pass woken only by completions, whether another assignment of that workstream had a live attempt at the pass's start.

Against the local mirror (2026-08-03 → 2026-08-29, 164 workstreams, 5,586 passes, $2,923):

| | Passes | Reported cost |
|---|---|---|
| Completion passes | 1,211 | $1,096 |
| … woken by a single completion | 1,104 | $944 |
| … with a sibling running at pass start (would be held) | 3 (0.2%) | $3.25 |
| … coalesced into a later pass within 15 minutes (saved) | 1 | $1.20 |

Of the 1,104 single-completion passes, the completed assignment's creating pass had dispatched it **alone** in 1,063 ($909, 96%). The remaining 41 had siblings from the same dispatch: 19 had already settled before the pass, 11 were waiting on `dependsOn` (which needs this pass's adoption), 7 never started, and 1 was running.

The architecture explains the result. A workstream's tick holds a fleet-wide per-workstream lock (`tryTickLock`), and inside it the engine runs every runnable assignment one after another, then fires a single coalesced pass for all their completion wakes (`tickLocked` in src/engine.ts). A pass that dispatches four independent assignments therefore already pays for one review pass, not four, and a completion practically never lands while a sibling of the same workstream is running. The rule would absorb almost nothing, so its wake machinery is not worth its complexity. If worker execution ever becomes asynchronous inside a workstream (a remote substrate that returns before the run ends), re-run the replay: that change reintroduces the overlap this rule was designed for.

The real pattern is serial stepping: a coordinator dispatches one assignment, adopts its result, and dispatches the next. Each `dependsOn` edge also costs a pass by design, because adoption is a coordinator act (kernel rule 6) and a dependent assignment receives only adopted input. The saving here is a cheaper adopt-and-continue pass (Phase 3), or briefs that ask coordinators to dispatch independent work together, not fewer wakes. A current snapshot of the shared store confirms the same shape (2026-09-15 → 2026-09-29, 201 workstreams, 3,939 passes, $3,468). Of 1,536 completion passes ($1,965), none had a sibling running at pass start, and 1,301 of the 1,368 single-completion passes ($1,604) followed an assignment dispatched alone. Classifying those passes by the step they reviewed and what the pass did next:

| Reviewed step | Then | Passes | Reported cost |
|---|---|---|---|
| work result | dispatched the next step | 458 | $633 |
| effect action (push, merge, comment) | dispatched the next step | 396 | $450 |
| read-only action (PR state, threads, checks) | dispatched the next step | 289 | $379 |
| any | waited or other | 161 | $193 |

So about $1,460 per fortnight goes to the review-one-step-then-dispatch-the-next loop, at roughly $1.27 a pass. That loop is what Phases 3 and 4 target.

## Phase 2: routines adopt probes (operational)

Once the runner is healthy, steer each routine that has no probe and whose cycle mostly checks for change to declare one. Candidates: sentry-sweep, axiom-monitor-triage, support-intake-routine, session-replay-review, evals-health, edp-sync-health. This is Weaver managing Weaver: a steer per routine, no code. Expected saving is modest (the whole scheduled row is $426 per 14 days), and it also cuts quota pressure. Done 2026-09-29: each of the six routines was steered (actor `claude-session-cost-plan`) to declare a probe wherever a read-only command can observe its source, and to keep a slow time-based wake only as a backstop.

## Phase 3: a cheaper seat for mechanical passes (experiment, shadow first)

This is now the largest lever: the serial review-and-continue loop measured above costs about $1,460 per fortnight. Many passes are mechanical: adopt a result whose checks or readback passed, then dispatch the step the standing course already named. Classify each pass's shape from its typed changes. Rebuild its projection offline from `PassRecord.baseRevision` and the printout journal. Replay a cheap model against it and compare its typed moves with the frontier coordinator's, scored against later outcomes (supersession, rejection, human correction). Only if the cheap model agrees within a stated margin on a class of passes does that class get a seat, and even then it is recorded per pass so its effect stays attributable. This is where a calibrated decision model (Jev-style) could route between seats; it earns the role on replayed evidence or not at all.

## Phase 4: fewer gated round trips for read-only GitHub facts (needs an explicit decision)

654 of 2,771 actions were read-only readbacks: PR state, review threads, check status. Each costs a dispatch pass and a review pass, because hosted workers deliberately receive no GitHub token (docs-public/github-app.md, "Runtime boundary"). Probes already get a repository-narrowed, read-only App token. Extending that to work assignments would remove most of these round trips. It also changes a documented isolation boundary on the hosted fleet, so it needs the operator's explicit decision before it is built. Each of these readbacks is also a serial step of the kind Phase 1 measured, so wake batching would not have absorbed this cost.

## Measuring the result

The team overview page (`/overview`) shows spend by routine and per concluded outcome, split by provider. Compare the completion-wake share and the coordinator cost per concluded outcome in the two weeks before and after each phase ships. A cost cut counts only if interventions per successful outcome and the rejection rate do not get worse.
