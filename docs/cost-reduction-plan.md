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

## Phase 4: fewer gated round trips for read-only GitHub facts (approved and implemented 2026-09-29)

654 of 2,771 actions were read-only readbacks: PR state, review threads, check status. Each costs a dispatch pass and a review pass, because hosted workers deliberately received no GitHub token (docs-public/github-app.md, "Runtime boundary"). Probes already got a repository-narrowed, read-only App token. Extending that to work assignments removes most of these round trips. Each of these readbacks is also a serial step of the kind Phase 1 measured, so wake batching would not have absorbed this cost.

It changes a documented isolation boundary on the hosted fleet, so it waited for the operator's explicit decision, which approved it on 2026-09-29. The reasoning that carried it: the worker already holds the repository's contents in its checkout, so the token adds read access only to that one repository's GitHub metadata; it cannot push, merge, or comment; it expires within the hour; and it is redacted from everything stored. What it buys is the 289 read-only-action review passes (about $379 per fortnight) plus the dispatch pass in front of each.

As built, the coordinator opts a work assignment in with `github_read` (refused on actions, which mint their own tokens). The controller mints the token after the attempt claim through the exact read path probes use (`githubAppEnvironment(<checkout>, 'read')`) and hands the worker only `GH_TOKEN` and the process-local Git credential helper, as environment variables. `WEAVER_WORKER_GITHUB_READ=0` turns it off per runner; a disabled runner or a failed mint launches the work without a token and one brief line saying so. Readback actions stay: a readback confirms an effect the engine performed, which is a kernel fact and must stay deterministic. The coordinator prompt now says to dispatch GitHub-fact work with `github_read` rather than as a separate read-only action. Measure it as the section below describes: the read-only-action row of the completion-pass table should shrink, and the rejection rate of the work that absorbed those reads should not rise.

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
| Projection, all 201 docs: median / p90 / max | 74k / 86k / 115k | 18.5k / 21.6k / 28.9k | every pass (since the marker: the stable 72% only on a write) |

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
- **Before the stable-prefix marker, the projection could not be reused across passes.** It was sent as one text block, and Claude Code's only message breakpoint is the end of the last message. Consecutive passes of one workstream shared 56–92% of the projection's leading bytes (median 86% over five workstreams), and they first differed at §7. But no breakpoint landed on that boundary, and the cache only reads at positions an earlier request marked, so every pass wrote the whole projection to cache on its first turn. The next section says what changed.
- **TTL.** Claude Code gives an SDK query a 1-hour cache when the login is a claude.ai subscription that is not on overage (the `sdk` query source is on its 1-hour allowlist). API-key and OpenRouter runs get 5 minutes. `ENABLE_PROMPT_CACHING_1H=1` and `FORCE_PROMPT_CACHING_5M=1` pin either behaviour, and the 5-minute switch wins if both are set. A 1-hour write bills at 2× base input and a 5-minute write at 1.25×. A read bills at 0.1× (0.025× on Fable 5.1).

Rough pricing of a median Opus 5 pass on the subscription seat, at $5 per million input tokens: the projection's first-turn write is about 18.5k × $10/M ≈ $0.19. Reading the prefix and the projection on the later turns adds about $0.06. That puts the static input at roughly a quarter of the $1.01 median. The other three quarters are output (adaptive thinking at the default `effort: high`, and tool arguments) plus whatever tool results bring in, such as read_artifact contents. That split is an estimate until the new `PassRecord.usage` rows arrive. Those rows settle it.

### Shipped: measurement and lossless reductions

- Every pass now records `PassRecord.usage`, the provider-reported token anatomy: uncached input, cache reads, cache writes (with a 1h/5m split on Claude), output, reasoning (Codex), model turns (Claude `num_turns`) and tool calls. It is provenance only. It never reaches the projection, and the printout journal leaves it out, like `costUsd`. The two providers disagree on what "input" means, so the counts keep each provider's own meaning and the field documents both.
- §8 no longer repeats the events §7 just listed. It names how many it left to §7 instead. Reconstructing 1,370 recent passes shows §8 reprinting a median of 553 characters (mean 759) of §7 arrivals at pass time.
- A policy excerpt ends in `… [excerpt]` rather than repeating the full read_policy pointer on every excerpt. The block's closing line names the marker once and still says read_policy returns the full record. That saves about 2.2k characters in every projection that has policies.

On the snapshot this removes 3.1% of all projection bytes: a median of 1,680 characters per projection (p90 4,686), plus the live §7 overlap. That comes to roughly 0.6–0.8k tokens a pass, or about 1% of pass cost ($0.01 on Opus 5, $0.02 on Fable 5). It is small, and it is all the shortening this PR can do without changing what the coordinator knows. A before/after render of all 201 documents shows identical sets of ids, event lines, and every other rendered line (the three rewritten lines normalized), and `projection.test.ts` pins the same property on representative documents.

### Shipped: a cache breakpoint after the stable prefix

`buildProjectionParts` now renders the projection stable-first. The policy and doctrine block moved from the end of §4 to the top, under its own heading, followed by the title, §1 and §2. Those parts change only on a real write: a policy write in the workstream's tags, or an edit to the objective, criteria, constraints, authority or credential names. §3–§9 follow. Nothing above the split reads the clock, the revision or the wake reasons. The Claude executor sends the prompt as two text blocks through the SDK's streaming-input `SDKUserMessage`, which is the same path the SDK takes for a string prompt. The first block is the fixed opening line plus the stable part, and it carries `cache_control: {type: "ephemeral", ttl: "1h"}`. The second block is the rest. Codex gets the same text as one string, with no marker, and caches the prefix on its own. Policies lead because the block depends only on the tag set, so Codex can also share it between workstreams with the same tags. `WEAVER_PROJECTION_CACHE_MARKER=0` restores the single block.

**The coordinator reads the same thing.** Over all 201 snapshot documents, the old and new renderings had identical sets of ids, event lines and other lines, and the same multiset of non-blank lines apart from the one new heading. After a simulated volatile change (three hours later, a finished pass, a new arrival, another wake reason, revision + 1), the stable part stayed byte-identical in all 201. It is a median of 53,255 characters (p90 58,119), or 72% of a median 72,046-character projection. `projection.test.ts` pins the same properties on representative documents.

**Breakpoints per request.** The capture harness from "How it was measured" was rebuilt. The stub now answers the first two turns with a read-only Weaver tool call, so each pass makes three model requests. Two snapshot workstreams ran two passes each through the real `runCoordinatorPass`, the real executor and Claude Code 2.1.220. Every request carried exactly four breakpoints, all 1h: Claude Code's two system blocks, the stable block, and Claude Code's own marker on the last message (the volatile block on turn 1, the newest tool result after that). The stable block (50,615 and 52,835 characters) was byte-identical across both passes and every turn. With `WEAVER_PROJECTION_CACHE_MARKER=0`, each request carried the old three breakpoints.

**Why Claude Code's remote flags are off for these passes.** Claude Code fetches its feature flags for each config directory, and the hosted fleet gives every pass a fresh one. In 8 fresh sessions, `tengu_basalt_spur` came up on in 3 of them. When it is on, Claude Code also marks the second-to-last message. Our marker makes that five breakpoints, and every turn after the first fails with `400 A maximum of 4 blocks with cache_control may be provided. Found 5.` The stub reproduced this through the real executor. With `DISABLE_GROWTHBOOK=1`, Claude Code uses its built-in defaults, and the flag is off. In 8 more sessions no extra breakpoint appeared, even with the flag forced on in the local flag cache. The request bodies with and without remote flags were identical apart from that marker. The only header difference was one beta for a tool the coordinator does not have. So a pass that sends the marker also gets `DISABLE_GROWTHBOOK=1` and `ENABLE_PROMPT_CACHING_1H=1`, and `FORCE_PROMPT_CACHING_5M` is removed. The API rejects a 1h breakpoint that comes after a 5m one, so all four markers must share the 1h TTL. OpenRouter seats get no marker. They run other providers' models on cash billing, and nobody has verified the marker there. If a provider still rejects the marker (the error names `cache_control`), that pass fails once, and every later pass in the same process sends one block.

**Live check (claude-opus-5, local subscription login, throwaway filesystem state).** A small workstream with two policies ran two passes, with a trivial arrival between them. Both passes completed, and neither got a 400. Pass 1 wrote 22,646 tokens to cache, all 1h, and read 22,516 (turn 2 reading what turn 1 wrote). Its cost was $0.244. Pass 2's first turn read 21,462 tokens and wrote only 1,319: the volatile tail after the arrival. Everything up to and including the stable prefix came from cache. Pass 2 read 44,243 and wrote 1,451 in total, and cost $0.043. That workstream's stable prefix is small (3,766 characters). The fleet's median is 53k.

**Expected saving.** A pass whose prefix is warm moves about 13.3k tokens (53k characters ÷ 4, a lower bound) from a 2× write to a 0.1× read. That is about $0.13 on Opus 5 and roughly double on Fable 5. Since 2026-09-15, 73% of Opus 5 passes and 49% of Fable 5 passes in the snapshot started within an hour of the same workstream's previous pass on the same model. That averages about $0.09 a pass on Opus 5 (≈9% of the $1.01 median) and about $0.12 on Fable 5 (≈6%). Things that make the prefix go cold: a policy write in the workstream's tags, an edit to §1 or §2, a new day (Claude Code's date reminder sits before the projection), a Weaver release, and a change of model. `PassRecord.usage` shows the real effect: in a warm pass, the first turn's cache reads cover the stable prefix.

**Found on the way, not changed here.** When nonessential traffic is allowed, Claude Code also sends each pass's whole first prompt (about 63k characters) to `claude-haiku-4-5` to generate a session title. That is roughly 16k uncached Haiku tokens a pass, about $0.016 at API prices. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` removes it (the captures with it set have no title request). This is proposal 5 below.

### Proposed, not shipped (the operator decides)

Each estimate is per pass on the subscription seat, where a cache write bills at 2×. Fable 5 figures are twice the Opus 5 figures.

1. *(Shipped above: the stable prefix has its own cache breakpoint.)*
2. **Use 5-minute cache writes on the subscription seat** (`FORCE_PROMPT_CACHING_5M=1` in the coordinator env). 99% of gaps inside a pass are under 4 minutes, so the projection's write would drop from 2× to 1.25×, a saving of about $0.07 a pass on Opus 5. The cost is that the 14k-token fleet prefix goes cold after 5 idle minutes rather than an hour, and each cold rewrite costs about $0.08. Opus ran about one pass every 9.5 minutes, so the net effect is somewhere between a wash and +$0.05. It now conflicts with the stable-prefix marker, whose value depends on the hour: a pass that sends the marker removes this setting. It only makes sense for the volatile tail with the marker off.
3. **Slim the policy block.** For example, keep statements whole but leave effect and mechanism prose to read_policy (about 12.2k characters, or 3k tokens a pass: $0.035 on Opus 5, 3.5%). Or lower the 25/30/25 caps. Either one changes what a fresh coordinator sees without asking.
4. **Excerpt the §8 history tail.** Long adoption and withdrawal rationales make §8 a median of 8.2k and p90 21.9k characters at pass time. Excerpting each event summary to about 300 characters (the full text stays in inspection) would save roughly 1k tokens a pass at the median ($0.012 on Opus 5) and much more at p90.
5. **Turn off Claude Code's nonessential traffic for coordinator passes** (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`). That drops the per-pass Haiku title request (about $0.016) along with telemetry and error reporting. The cost is a little less diagnostic data from Claude Code itself.
6. **Lower `effort`.** Claude Code sends `output_config.effort: "high"` on every coordinator request. If `usage.outputTokens` confirms that output dominates, effort is the largest remaining lever, but it trades against decision quality. It is a model-behaviour choice, not a formatting one.

## Measuring the result

The team overview page (`/overview`) shows spend by routine and per concluded outcome, split by provider. Compare the completion-wake share and the coordinator cost per concluded outcome in the two weeks before and after each phase ships. A cost cut counts only if interventions per successful outcome and the rejection rate do not get worse.
