# Execution safety

*A rolling runaway guard, not a dollar budget or a progress target*

Weaver no longer stops a Workstream because a lifetime SDK cost estimate or pass count reached a cap. Those figures did not represent Anthropic billing or remaining Claude-plan usage, and every healthy long-running routine would eventually hit a lifetime ceiling simply by continuing to work.

Instead, each Workstream allows 30 model starts in any rolling physical hour by default. A start is a coordinator pass or a model-backed worker attempt. Deterministic engine commands do not count. The limit is derived from durable pass and attempt timestamps, including failed or capacity-limited starts, so a retry storm cannot disappear from the calculation.

When the window is full, Weaver:

1. leaves intended assignments and organizational wakes pending;
2. stores one typed physical-time wake for the moment enough old starts expire;
3. opens no needs-you card; and
4. resumes automatically from durable state.

`weaver advance` moves the organizational demo/scheduling clock; it cannot fast-forward this physical safety pause. The guard is checked in the same revision-checked claim that records every model start, so parallel or direct callers cannot cross it.

The default comes from the live fleet: its observed peak was 23 model starts in one rolling hour, so 30 leaves headroom for healthy bursts while bounding rapid churn. Change an individual Workstream only when its workload genuinely needs a different rate:

```bash
weaver execution-safety sentry-sweep --window 1h --max-starts 30
```

This complements the existing per-run and per-tick bounds: worker/coordinator turn ceilings, sleep-aware wall limits, bounded tick cycles, concurrency control, and bounded action retries remain in force.

Wall expiry is classified by role rather than mistaken for provider capacity. A worker that reaches its 40-minute wall records a failed `wall_timeout` attempt and wakes a fresh coordinator to retry, split, or revise the assignment. A coordinator wall parks that controller target for automatic retry, because the pass made no durable work judgment. Neither path keeps a model session alive across the wait.

## Billing remains the provider's job

Weaver does not present SDK-reported dollar estimates: they are not a bill, a balance, or remaining plan usage. Old documents retain their stored field for backward compatibility, but it neither appears in operator views nor gates execution. If an executor uses API credits, configure the real spending limit with that model provider. Weaver never enables paid continuation or changes provider billing controls.

Older Workstream documents remain readable. Their historical lifetime cap fields are ignored for eligibility, and old dollar-exhaustion cards are retired automatically without counting as a human intervention. Old CLI, HTTP, or coordinator inputs that attempt to set a lifetime pass/dollar cap fail explicitly instead of pretending the limit still works.
