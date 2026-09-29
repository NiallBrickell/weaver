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

The dominant cost is one full coordinator pass per completion. A pass that dispatches four research assignments usually pays for four more passes: each completion wakes the workstream on its own, and each fresh coordinator re-reads the whole projection to adopt one result while three siblings are still running. `daily-engineering-update` shows the pattern most clearly: 121 of its 189 passes in 14 days were completion wakes, from a per-repository fan-out followed by a synthesis step.

Routine polling (the "scheduled" row) is a small share. Probes (`schedule_probe`, docs-public/routines.md) already move change detection below the model. Only thread-review, ci-deploy-pipeline-health and e2e-test-hygiene use them today.

## What not to do

- **No lifetime budget.** It was deliberately retired (src/executionSafety.ts): a lifetime cap gives every healthy routine a scheduled death. The rolling execution-safety guard remains the runaway protection.
- **No silent model downgrade.** A cheaper coordinator seat is justified only by measured decision quality (phase 3), never assumed.
- **No keeping context alive to save re-reads.** Each pass re-reads the projection by design (kernel rule 2). The saving comes from running fewer passes, never from resuming a session.

## Phase 1: batch completion wakes (in progress)

When an assignment or action completes while other assignments of the same workstream are still actively running, hold the coordinator's wake. Wake it once, when the last running sibling settles or a bounded delay expires (whichever comes first). The wake stays stored data with a typed condition. Delivery stays at-least-once and coalesced (kernel rule 8). Nothing that needs judgment waits behind a sibling:

- Human steering, replies, approvals, and failures that need a decision wake immediately, as today.
- A sibling that is queued behind a `dependsOn` on the completed work does not count as running, so batching can never deadlock a dependency chain.
- The delay is bounded (default 15 minutes after the first unreviewed completion), so a slow sibling cannot starve adoption of finished work.

**Acceptance:** deterministic tests for each rule above. A replay over the recorded fleet measures how many of the 1,874 completion passes would have been batched, reported in the PR.

## Phase 2: routines adopt probes (operational)

Once the runner is healthy, steer each routine that has no probe and whose cycle mostly checks for change to declare one. Candidates: sentry-sweep, axiom-monitor-triage, support-intake-routine, session-replay-review, evals-health, edp-sync-health. This is Weaver managing Weaver: a steer per routine, no code. Expected saving is modest (the whole scheduled row is $426 per 14 days), and it also cuts quota pressure.

## Phase 3: a cheaper seat for mechanical passes (experiment, shadow first)

Many passes are mechanical: adopt a result whose checks passed, then wait. Classify each pass's shape from its typed changes. Rebuild its projection offline from `PassRecord.baseRevision` and the printout journal. Replay a cheap model against it and compare its typed moves with the frontier coordinator's, scored against later outcomes (supersession, rejection, human correction). Only if the cheap model agrees within a stated margin on a class of passes does that class get a seat, and even then it is recorded per pass so its effect stays attributable. This is where a calibrated decision model (Jev-style) could route between seats; it earns the role on replayed evidence or not at all.

## Phase 4: fewer gated round trips for read-only GitHub facts (needs an explicit decision)

654 of 2,771 actions were read-only readbacks: PR state, review threads, check status. Each costs a dispatch pass and a review pass, because hosted workers deliberately receive no GitHub token (docs-public/github-app.md, "Runtime boundary"). Probes already get a repository-narrowed, read-only App token. Extending that to work assignments would remove most of these round trips. It also changes a documented isolation boundary on the hosted fleet, so it needs the operator's explicit decision before it is built. Re-measure after phase 1, since batching already absorbs some of this cost.

## Measuring the result

The team overview page (`/overview`) shows spend by routine and per concluded outcome, split by provider. Compare the completion-wake share and the coordinator cost per concluded outcome in the two weeks before and after phase 1 ships. A cost cut counts only if interventions per successful outcome and the rejection rate do not get worse.
