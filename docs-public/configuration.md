# Configuration

Weaver's durable state lives in the store; its *settings* — which model the
coordinator uses, where the store is, how actions reach the outside — are plain
environment variables. You can export them in your shell, but that makes them
apply to everything you run and hides them from anyone reading the repo. So
`weaver` also reads a **`.env` file at the repo root**, and that is the
recommended home for machine-local config.

## The `.env` file

Copy [`.env.example`](../.env.example) to `.env` and uncomment what you need.
`.env` is gitignored, so it stays local to your machine.

```dotenv
WEAVER_COORDINATOR_FALLBACK_MODEL=gpt-5.6-sol
WEAVER_COORDINATOR_FALLBACK_EXECUTOR=codex-sdk
WEAVER_STORE=postgres://user:pass@host:5432/weaver
```

Two rules make it safe to rely on:

- **It only fills gaps.** Anything already set in your environment — an explicit
  `export`, or a value passed for a single command — always wins. The file
  never overrides what you set for this invocation.
- **A missing `.env` is a no-op.** The file is optional; without it Weaver uses
  the built-in defaults below.
- **Resident processes snapshot it at launch.** Restart `weaver run` or
  `weaver watch` after changing model/executor settings. Executor-only provider
  secrets are the exception: adapters reload those for every attempt.

`.env` is for *config*, not secrets. Per-workstream action secrets belong in the
store via `weaver secret set <NAME> --ws <slug>`; model-provider keys use
`weaver secret set <NAME> --executor`, whose names and values are both hidden
from workers — see [Secrets & access](./secrets-and-access.md).

## Settings

### Models

The coordinator is the evaluative seat — it runs rarely, at the moments that
matter, so it gets the most capable model; workers do the volume on a cheaper
one. When the coordinator's primary model pool is capacity-limited, it degrades
one step to the **fallback** and keeps reconciling while the primary's retry is
pending (see [Claude capacity & billing](./claude-capacity.md)).

| Variable | Default | What it sets |
| --- | --- | --- |
| `WEAVER_COORDINATOR_MODEL` | `claude-fable-5` | The coordinator's primary model |
| `WEAVER_COORDINATOR_EXECUTOR` | `local-sdk` | Runtime for the primary coordinator: `local-sdk` (Claude) or `codex-sdk` (Codex) |
| `WEAVER_COORDINATOR_FALLBACK_MODEL` | `claude-opus-5` | The model it degrades to when the primary pool is limited |
| `WEAVER_COORDINATOR_FALLBACK_EXECUTOR` | primary executor | Runtime for the fallback coordinator; may differ from the primary |
| `WEAVER_WORKER_MODEL` | `sonnet` | Fallback model for general/unmatched work; reviewed typed routes may select another exact target |
| `WEAVER_ASK_MODEL` | `sonnet` | The model behind `weaver do`/`weaver ask` intake |

### Storage

| Variable | Default | What it sets |
| --- | --- | --- |
| `WEAVER_HOME` | `<repo>/state` | State root for the default filesystem backend |
| `WEAVER_STORE` | *(unset → fs)* | `postgres://…` or `sqlite:<path>` to share or consolidate the fleet — see [Hosted state](./hosted-state.md) |

### Execution and actions

| Variable | Default | What it sets |
| --- | --- | --- |
| `WEAVER_EXECUTOR` | `local-sdk` | Where a worker's model loop runs — `local-sdk` (Claude), `codex-sdk` (local Codex), `pi` (pinned provider-neutral host process), or `openhands` (pinned container). See [Where workers run](./executors.md) |
| `WEAVER_RUNNER_EXECUTORS` | configured coordinator, worker, and action executors | Comma-separated substrates this process may claim. Add reviewed route executors such as `openhands` explicitly on a capable host |
| `WEAVER_ACTION_EXECUTOR` | `local-sdk` | Separate Pilot-supervised action runtime; automatic model routes never apply to actions |
| `WEAVER_ACTION_MODEL` | `sonnet` | Model for declared action workers |
| `WEAVER_OPENHANDS_BASE_URL` | OpenRouter's official endpoint for `openrouter/*` | OpenAI-compatible upstream used by the host credential proxy; required for other OpenHands providers |
| `WEAVER_PILOT_URL` | `http://localhost:9721` | The operator's pilot daemon that gates external actions |

An unknown work or action executor fails hard before any attempt starts — a
silent local fallback would make a misconfigured remote fleet look healthy.

OpenHands provider credentials are values, not settings. Store OpenRouter's as
`OPENROUTER_API_KEY` with `weaver secret set ... --executor`; Weaver reloads it
for every attempt without restarting the runner. The older transient
`WEAVER_MODEL_API_KEY` / `LLM_API_KEY` environment inputs remain compatible,
but never belong in `.env`.

Pi targets are provider-qualified: for example
`openrouter/moonshotai/kimi-k3`, `zai/glm-5.3`, or
`zai-coding-plan/glm-5.3`. Store `OPENROUTER_API_KEY`, `ZHIPU_API_KEY`, or
Pi's native `ZAI_API_KEY` in executor-only scope. The `zai` and
`zai-coding-plan` prefixes remain separate capacity and billing pools.
When Pi is the configured substrate, the reviewed text-only bounded-repair
route selects `openrouter/moonshotai/kimi-k3`; every Pi runner must therefore
have its executor-only OpenRouter credential as well as any fallback-provider
credential. General and image work continue to the configured fallback.

New work stores a typed execution profile and modalities. Weaver checks matching
reviewed routes inside the configured `WEAVER_EXECUTOR` substrate, then advances
past a target only while that exact model pool has an active typed backoff. The
first available target is reserved for a runner that declares its substrate; an
incapable host does not turn the configured fallback into a race.
`WEAVER_WORKER_MODEL` remains the final ordered fallback. See
[Where workers run](./executors.md).

The global `weaver` command reads `.env` from the repo it resolves to, so these
apply no matter which directory you run from.
