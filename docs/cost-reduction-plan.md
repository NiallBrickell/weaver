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

The measurement half is built and off by default: a shadow seat (`WEAVER_SHADOW_COORDINATOR`, `WEAVER_SHADOW_RATE`) replays a sampled fraction of live completed passes against the same projection text with capture-only tools, and each shadowed `PassRecord` carries the pass class and per-move-type agreement. `weaver shadow-report` reports it per class. Measuring live passes as they happen avoids rebuilding projections offline from `baseRevision`. Scoring against later outcomes (supersession, rejection, human correction) is still read off the disagreeing pass ids by hand. See [the harness note](./harness.md#shadow-coordinator-seats-evidence-without-authority).

## Phase 4: fewer gated round trips for read-only GitHub facts (needs an explicit decision)

654 of 2,771 actions were read-only readbacks: PR state, review threads, check status. Each costs a dispatch pass and a review pass, because hosted workers deliberately receive no GitHub token (docs-public/github-app.md, "Runtime boundary"). Probes already get a repository-narrowed, read-only App token. Extending that to work assignments would remove most of these round trips. It also changes a documented isolation boundary on the hosted fleet, so it needs the operator's explicit decision before it is built. Each of these readbacks is also a serial step of the kind Phase 1 measured, so wake batching would not have absorbed this cost.

## Pass anatomy (measured 2026-09-29)

The phases above cut the number of passes. This section asks the other question: what one pass costs, and how much of that can go without changing the model or what the coordinator sees. Reported cost per pass since 2026-09-15, from the pass records in a 201-workstream snapshot: `claude-opus-5` median $1.01 (n=2,130), `claude-fable-5` median $2.02 (n=181), OpenRouter `z-ai/glm-5.3` median $1.25 (n=559, cash).

### How it was measured

Nothing here spent a model call. The projection sizes come from `buildProjection` run over every document in a read-only snapshot, with the policy store from the last local copy (2026-08-23, which matches the production caps). The request anatomy comes from running the real `runCoordinatorPass` through the real `ClaudeCoordinatorExecutor` and Claude Code 2.1.220, with `ANTHROPIC_BASE_URL` pointed at a local stub that records each Messages request body and replies `end_turn`. That shows the exact bytes, block boundaries and `cache_control` markers Claude Code sends. Turn and tool-call counts come from 2,814 coordinator passes in the local tail logs (August). Token counts are characters ÷ 4. That is a lower bound: the Opus 4.7+ tokenizer can produce up to 1.35× more.

### What the first request of a pass contains

| Part | Chars | ≈ Tokens | Changes when |
|---|---|---|---|
| Tool definitions (28 Weaver tools) | 37,143 | 9.3k | Weaver release |
| System: attribution line, SDK identity, coordinator prompt | 18,773 | 4.7k | Weaver release |
| Date reminder (Claude Code) | 306 | <0.1k | daily |
| Projection, all 201 docs: median / p90 / max | 74k / 86k / 115k | 18.5k / 21.6k / 28.9k | every pass |

Projection by section, median / p90 characters over the 46 active workstreams:

| Section | Median | p90 | Share of all projection bytes |
|---|---|---|---|
| §4 learned policies and doctrine | 48,436 | 51,282 | 57% |
| §8 recent history (25-event tail) | 4,984 | 7,586 | 8% (16% over all 201) |
| §7 newly arrived | 3,982 | 12,270 | 9% |
| §1 objective, criteria, constraints | 4,707 | 7,471 | 7% |
| §6 open loops | 3,352 | 6,960 | 6% |
| §4 decisions | 2,936 | 7,965 | 6% |
| §3 operating state | 3,301 | 4,653 | 4% |
| §2 authority, §5 assignments, §9 versions, header | ~1,700 together | | 3% |

The policy block is over half of every projection. Statements are about half of it (median 23.5k characters), effect excerpts 7.5k, mechanism excerpts 4.7k, and ids, provenance, evidence counts and the fixed intro and outro make up the rest. The 46 active workstreams render only 11 distinct policy blocks, and the largest group of streams shares one block 12 ways.

A pass is short. It is a median of 4 model turns (mean 4.5, p90 8) and 3 tool calls (mean 3.5). The most common calls are finish_pass, create_assignment, schedule_wake, read_artifact, record_decision and adopt_submission. Of 14,469 gaps between consecutive events inside a pass, the median is 5 seconds, p90 28 seconds, and only 1.1% exceed 4 minutes.

### Where caching works today, and where it cannot

- **The fleet-wide prefix is byte-stable and cached.** Tools and system prompt were byte-identical across five workstreams, with two consecutive passes each. Claude Code puts `cache_control` on the system blocks, so tools and system (about 14k tokens) form one prefix shared by every pass on the same model. Claude Code's attribution line carries a 3-character fingerprint hashed from characters 4, 7 and 20 of the first user message. The coordinator prompt always opens "A wake fired for this workstream…", so the fingerprint is constant. Anyone rewording that opening changes it once, which is harmless.
- **The projection cannot be reused across passes.** It is sent as one text block, and Claude Code's only message breakpoint is the end of the last message. Consecutive passes of one workstream shared 56–92% of the projection's leading bytes (median 86% over five workstreams), and they first differ at §7, so the stable part already comes first. But no breakpoint lands on that boundary, and the cache only reads at positions an earlier request marked. Every pass therefore writes the whole projection to cache on its first turn and reads it on each later turn. Reordering inside the single block would save nothing, so this PR does not reorder. (Claude Code can also mark the second-to-last message, but only under the `tengu_basalt_spur` feature flag, which is off by default.)
- **TTL.** Claude Code gives an SDK query a 1-hour cache when the login is a claude.ai subscription that is not on overage (the `sdk` query source is on its 1-hour allowlist). API-key and OpenRouter runs get 5 minutes. `ENABLE_PROMPT_CACHING_1H=1` and `FORCE_PROMPT_CACHING_5M=1` pin either behaviour. A 1-hour write bills at 2× base input and a 5-minute write at 1.25×. A read bills at 0.1× (0.025× on Fable 5.1).

Rough pricing of a median Opus 5 pass on the subscription seat, at $5 per million input tokens: the projection's first-turn write is about 18.5k × $10/M ≈ $0.19. Reading the prefix and the projection on the later turns adds about $0.06. That puts the static input at roughly a quarter of the $1.01 median. The other three quarters are output (adaptive thinking at the default `effort: high`, and tool arguments) plus whatever tool results bring in, such as read_artifact contents. That split is an estimate until the new `PassRecord.usage` rows arrive. Those rows settle it.

### Shipped: measurement and lossless reductions

- Every pass now records `PassRecord.usage`, the provider-reported token anatomy: uncached input, cache reads, cache writes (with a 1h/5m split on Claude), output, reasoning (Codex), model turns (Claude `num_turns`) and tool calls. It is provenance only. It never reaches the projection, and the printout journal leaves it out, like `costUsd`. The two providers disagree on what "input" means, so the counts keep each provider's own meaning and the field documents both.
- §8 no longer repeats the events §7 just listed. It names how many it left to §7 instead. Reconstructing 1,370 recent passes shows §8 reprinting a median of 553 characters (mean 759) of §7 arrivals at pass time.
- A policy excerpt ends in `… [excerpt]` rather than repeating the full read_policy pointer on every excerpt. The block's closing line names the marker once and still says read_policy returns the full record. That saves about 2.2k characters in every projection that has policies.

On the snapshot this removes 3.1% of all projection bytes: a median of 1,680 characters per projection (p90 4,686), plus the live §7 overlap. That comes to roughly 0.6–0.8k tokens a pass, or about 1% of pass cost ($0.01 on Opus 5, $0.02 on Fable 5). It is small, and it is all the shortening this PR can do without changing what the coordinator knows. A before/after render of all 201 documents shows identical sets of ids, event lines, and every other rendered line (the three rewritten lines normalized), and `projection.test.ts` pins the same property on representative documents.

### Proposed, not shipped (the operator decides)

Each estimate is per pass on the subscription seat, where a cache write bills at 2×. Fable 5 figures are twice the Opus 5 figures.

1. **Give the stable prefix its own cache breakpoint.** Render the policy block first (it is shared across workstreams with the same tags), then the header, §1 and §2, as a separate user content block carrying an explicit `cache_control`. Pin the TTL with `ENABLE_PROMPT_CACHING_1H=1` so the marker TTLs cannot fall out of the longer-first order. When the same prefix recurs within the hour, about 11.7k tokens move from a 2× write to a 0.1× read, which saves about $0.11 a pass on Opus 5 (≈11%). Risks: the string-prompt path cannot carry content blocks, so the executor would move to streaming-input `SDKUserMessage`s. Claude Code already spends 3 of the 4 allowed breakpoints, so if `tengu_basalt_spur` is turned on, every turn after the first returns HTTP 400. The section order of the continuity contract also changes. It needs one live verification pass before any fleet rollout.
2. **Use 5-minute cache writes on the subscription seat** (`FORCE_PROMPT_CACHING_5M=1` in the coordinator env). 99% of gaps inside a pass are under 4 minutes, so the projection's write drops from 2× to 1.25×, a saving of about $0.07 a pass on Opus 5. The cost is that the 14k-token fleet prefix goes cold after 5 idle minutes rather than an hour, and each cold rewrite costs about $0.08. Opus ran about one pass every 9.5 minutes, so the net effect is somewhere between a wash and +$0.05. The new `cacheCreation1h/5mInputTokens` fields decide it within a few days. This conflicts with proposal 1, which wants the hour.
3. **Slim the policy block.** For example, keep statements whole but leave effect and mechanism prose to read_policy (about 12.2k characters, or 3k tokens a pass: $0.035 on Opus 5, 3.5%). Or lower the 25/30/25 caps. Either one changes what a fresh coordinator sees without asking.
4. **Excerpt the §8 history tail.** Long adoption and withdrawal rationales make §8 a median of 8.2k and p90 21.9k characters at pass time. Excerpting each event summary to about 300 characters (the full text stays in inspection) would save roughly 1k tokens a pass at the median ($0.012 on Opus 5) and much more at p90.
5. **Lower `effort`.** Claude Code sends `output_config.effort: "high"` on every coordinator request. If `usage.outputTokens` confirms that output dominates, effort is the largest remaining lever, but it trades against decision quality. It is a model-behaviour choice, not a formatting one.

## Measuring the result

The team overview page (`/overview`) shows spend by routine and per concluded outcome, split by provider. Compare the completion-wake share and the coordinator cost per concluded outcome in the two weeks before and after each phase ships. A cost cut counts only if interventions per successful outcome and the rejection rate do not get worse.
