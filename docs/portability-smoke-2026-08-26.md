# Executor portability smoke — 26 August 2026

Delivery step 5 of the consolidated organization plan
([cross-harness-agent-organization-plan.md](./cross-harness-agent-organization-plan.md)):
prove live, not by inspection, that the same durable work and the same
stored topology run across every production substrate. Deterministic
rails are covered by `yarn test`; this run adds the live-model half.

## Workers: one stored `work` Assignment, four substrates

The `code-repair` harness-eval case is the canonical bounded work
assignment (seeded bug, hidden deterministic grading, real
`submit_result` surface). One fresh run per substrate, every hard gate
passed on each (rows are in `evals/ledger.jsonl`, suite ids
`20260826T14…Z`):

| Substrate | Target | Hard gates | Wall |
| --- | --- | --- | --- |
| `claude-sdk` | `sonnet` | all passed | 57s |
| `codex-sdk` | `gpt-5.6-sol` | all passed | 59s |
| `pi` | `zai-coding-plan/glm-5.3` | all passed | 46s |
| `openhands` | `openrouter/moonshotai/kimi-k3` | all passed | 348s |

Two executors launched with one dead operator MCP server (`magpie`) and
proceeded without it — the documented per-server degradation, unchanged
by substrate.

Single runs are smoke evidence, not a cohort: nothing here enters the
reviewed routing registry (a route needs a complete cohort of its
declared minimum runs; four scattered single runs cannot activate
anything — the ledger is evidence, never configuration).

## Coordinators: one stored topology, two coordinator substrates

Topology created through the human composition path:

```
weaver create --slug fleet-ops …
weaver create --slug triage-line … --under fleet-ops
```

- `tick triage-line` ran a **Claude** coordinator pass
  (`local-sdk:claude-fable-5`) — completed, recorded its standing
  triage decision, dispatched nothing (dormant by design).
- `tick fleet-ops` then ran a **fresh Codex** coordinator pass
  (`codex-sdk:gpt-5.6-sol`) on the same stored state — completed,
  confirmed its managed child from typed state (`listManagedBy`), not a
  transcript, recorded its own standing decision, scheduled its 30-day
  review wake.

Both passes `completed`; session ids distinct and unreused
(`4d3416c9…`, `01a03e81…` — provenance only, nothing resumed); the
`managedBy` pointer and the parent's decision/wake are typed facts.
The resident runner was never involved: each tick is a fresh process
over the store, exactly as the plan required.

## What this does and does not claim

- It proves the seams compose live: one durable work contract, four
  worker substrates; one stored topology, two coordinator substrates.
- It does not grade quality differences between substrates (that is
  the harness-evals bakeoff's job), and it does not touch the action
  lane — actions stay on the supervised default by design.
