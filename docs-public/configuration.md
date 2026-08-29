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
WEAVER_COORDINATOR_FALLBACKS=local-sdk:claude-opus-5,codex-sdk:gpt-5.6-sol
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
  secrets and applicable global/workstream secrets are the exceptions: workers
  and adapters reload those for every attempt.

`.env` is for *config*, not secrets. Per-workstream action secrets belong in the
store via `weaver secret set <NAME> --ws <slug>`; model-provider keys use
`weaver secret set <NAME> --executor`, whose names and values are both hidden
from workers — see [Secrets & access](./secrets-and-access.md).

You don't have to write any of this by hand: **`weaver login`** walks through
it — pick the executor this host runs work through, register the credential it
needs (into the `0600` executor store, never `.env`), and choose the model
settings below, which it writes into `.env` in place. `weaver login --status`
shows the per-executor auth standing and where each setting came from (`.env`,
environment, or default), and `weaver login --render-remote-env` emits the
registered credentials plus the portable runner config as env lines for
provisioning a headless host (it refuses to print to a terminal — pipe it).
That render includes configured coordinator/worker fallback lists, complex-work
and intake models, execution capabilities, repository context, workspace root,
OpenHands endpoint, Pilot endpoint, and execution timing overrides. Store and
home remain host-local and are never rendered.

## Settings

### Models

The coordinator is the evaluative seat — it runs rarely, at the moments that
matter, so it gets the most capable model; workers do the volume on a cheaper
one. When the coordinator's primary model pool is capacity-limited, it degrades
down its ordered **fallback chain** to the first seat whose pool is not parked
and keeps reconciling while the earlier seats' retries are pending (see
[Claude capacity & billing](./claude-capacity.md)).

| Variable | Default | What it sets |
| --- | --- | --- |
| `WEAVER_COORDINATOR_MODEL` | `claude-fable-5` | The coordinator's primary model. `local-sdk` may use an `openrouter/`-qualified model with a registered `OPENROUTER_API_KEY`; the prefix is retained in durable provider attribution and removed only for the API call |
| `WEAVER_COORDINATOR_EXECUTOR` | `local-sdk` | Runtime for the primary coordinator: `local-sdk` (Claude) or `codex-sdk` (Codex) |
| `WEAVER_COORDINATOR_FALLBACKS` | *(unset → legacy pair below)* | Ordered fallback seats tried after the primary, as comma-separated `executor:model` entries — e.g. `local-sdk:claude-opus-5,codex-sdk:gpt-5.6-sol`. When set, the legacy pair below is ignored |
| `WEAVER_COORDINATOR_FALLBACK_MODEL` | `claude-opus-5` | Legacy single fallback model, used only while `WEAVER_COORDINATOR_FALLBACKS` is unset |
| `WEAVER_COORDINATOR_FALLBACK_EXECUTOR` | primary executor | Runtime for that legacy fallback; may differ from the primary |
| `WEAVER_WORKER_MODEL` | `sonnet` | Fallback model for general/unmatched work; reviewed typed routes may select another exact target |
| `WEAVER_WORKER_MODEL_COMPLEX` | *(unset → `WEAVER_WORKER_MODEL`)* | Stronger worker seat for assignments the coordinator declares `complexity: high` — same `WEAVER_EXECUTOR` substrate, only the model changes |
| `WEAVER_WORKER_FALLBACKS` | *(unset → no ladder)* | Ordered worker seats tried after the configured `WEAVER_EXECUTOR`/`WEAVER_WORKER_MODEL` seat when earlier targets are capacity-parked — e.g. `codex-sdk:gpt-5.6-sol,pi:zai-coding-plan/glm-5.3,pi:openrouter/moonshotai/kimi-k3`. See [Where workers run](./executors.md) |
| `WEAVER_ASK_MODEL` | `sonnet` | The model behind `weaver do`/`weaver ask` intake |

Chain entries split on the first colon only, so provider-qualified models keep
their slashes (`pi:openrouter/moonshotai/kimi-k3`). An unknown executor in a
chain fails hard at startup rather than silently skipping the seat. Because the
chains are ordinary machine config, every executor they name joins this
runner's default capability declaration (`WEAVER_RUNNER_EXECUTORS`), and each
one needs its credentials present on this host.

How an assignment picks its seat — typed profiles and complexity, reviewed
routes, then these configured seats — is covered in
[Model routing](./model-routing.md).

### Storage

| Variable | Default | What it sets |
| --- | --- | --- |
| `WEAVER_HOME` | `<repo>/state` | State root for the default filesystem backend |
| `WEAVER_STORE` | *(unset → fs)* | `postgres://…` or `sqlite:<path>` to share or consolidate the fleet — see [Hosted state](./hosted-state.md). Set it with **`weaver link <url>`**, which proves the store is reachable (read-only) before writing it into `.env`; `weaver link` alone reports the current target, `weaver link --unlink` removes it |
| `WEAVER_HOUSE_JSON` | *(unset)* | Deployment form of `WEAVER_HOME/house.json`: JSON with optional `constraints`, `repoMap`, and `tags`. Environment fields override matching local fields, so a stateless UI and its execution host can stamp one canonical repository context onto new work. Never put credentials in it |

### Execution and actions

| Variable | Default | What it sets |
| --- | --- | --- |
| `WEAVER_EXECUTOR` | `local-sdk` | Where a worker's model loop runs — `local-sdk` (Claude), `codex-sdk` (local Codex), `pi` (pinned provider-neutral host process), or `openhands` (pinned container). See [Where workers run](./executors.md) |
| `WEAVER_WORKSPACE_ROOT` | `~/.weaver/workspaces` | Absolute root for persistent neutral per-workstream workspaces when intended work does not name a checkout. Hosted runners should place it on their persistent disk |
| `WEAVER_RUNNER_ID` | OS hostname | Stable exact name for this execution host. Set it explicitly on hosted/container runners; assignments may use this name for machine-local placement, and attempts pin the actual claimant |
| `WEAVER_RUNNER_EXECUTORS` | configured coordinator, worker, and action executors | Comma-separated substrates this process may claim. Add reviewed route executors such as `openhands` explicitly on a capable host |
| `WEAVER_RUNNER_PLACEMENT_ONLY` | `0` | `1` narrows a bounded manual tick to assignments explicitly placed on this exact `WEAVER_RUNNER_ID`; requires an explicit runner ID and is refused by the resident runner. Use only with `weaver tick <slug> --engine-only` for a machine scheduler |
| `WEAVER_ACTION_EXECUTOR` | `local-sdk` | Separate Pilot-supervised action runtime; automatic model routes never apply to actions |
| `WEAVER_ACTION_MODEL` | `sonnet` | Model for declared action workers |
| `WEAVER_DETERMINISTIC_ACTIONS_ONLY` | `0` | Set to `1` on credential-bearing hosted controllers: action assignments must supply an exact `exec_run`, and no same-UID action model starts |
| `WEAVER_OPENHANDS_BASE_URL` | OpenRouter's official endpoint for `openrouter/*` | OpenAI-compatible upstream used by the host credential proxy; required for other OpenHands providers |
| `WEAVER_PILOT_URL` | `http://localhost:9721` | The operator's pilot daemon that gates external actions |

An unknown work or action executor fails hard before any attempt starts — a
silent local fallback would make a misconfigured remote fleet look healthy.
Runner IDs accept 1–128 ASCII letters, digits, dots, underscores, and hyphens,
starting with a letter or digit. Invalid IDs and placement-only values other
than `0`/`1` fail before a claim. The hostname fallback is conservative for a
normal machine, but container hostnames are often recreated, so hosted runners
should always set an explicit stable ID.

A hosted Pilot must use HTTPS and a bearer registered in Weaver's executor-only
secret store, never `.env` or an action-secret scope:

```bash
weaver secret set WEAVER_PILOT_TOKEN --executor
weaver pilot-auth-check
```

The check calls Pilot's `/internal/auth-check` through the same client used by
action evaluation and live tool supervision, and succeeds only on HTTP 204.
Weaver refuses cleartext remote Pilot URLs, redirects, and remote requests with
no registered token. Existing unauthenticated Pilot installations remain
compatible only on loopback (`localhost`, `127.0.0.1`, or `::1`). Executor-only
secret provisioning carries `WEAVER_PILOT_TOKEN` with the other adapter
credentials; general environment rendering deliberately does not.

Hosted GitHub access uses three executor-only values rather than a personal
CLI login or PAT: `WEAVER_GITHUB_APP_ID`,
`WEAVER_GITHUB_APP_INSTALLATION_ID`, and
`WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64`. They are reloaded for each mint and
produce short-lived installation tokens; they never enter `.env` or ordinary
worker containers. `weaver github-app-setup <organization>` creates, installs,
verifies, and stores all three through one browser-confirmed loopback flow;
`weaver github-auth-check` proves the configured App path later.
See [GitHub access on a hosted runner](./github-app.md).

OpenHands provider credentials are values, not settings. Store OpenRouter's as
`OPENROUTER_API_KEY` with `weaver secret set ... --executor`; Weaver reloads it
for every attempt without restarting the runner. The older transient
`WEAVER_MODEL_API_KEY` / `LLM_API_KEY` environment inputs remain compatible,
but never belong in `.env`.

For an always-on credential-bearing host, register a scoped Platform API key
as `ANTHROPIC_API_KEY` in executor-only storage. Do not copy
`CLAUDE_CODE_OAUTH_TOKEN`, Claude Code config, or Codex device state from a
person's machine. The GCP profile enforces this boundary before systemd starts:
direct Claude is primary and a fixed OpenRouter Haiku route is fallback-only.

Pi targets are provider-qualified: for example
`openrouter/moonshotai/kimi-k3`, `zai/glm-5.3`, or
`zai-coding-plan/glm-5.3`. Store `OPENROUTER_API_KEY`, `ZHIPU_API_KEY`, or
Pi's native `ZAI_API_KEY` in executor-only scope. The `zai` and
`zai-coding-plan` prefixes remain separate capacity and billing pools.
When Pi is the configured substrate, the reviewed text-only bounded-repair
route selects `openrouter/moonshotai/kimi-k3`; every Pi runner must therefore
have its executor-only OpenRouter credential as well as any fallback-provider
credential. General and image work continue to the configured fallback.

New work stores a typed execution profile, modalities, and a complexity tier.
The coordinator may mark an assignment `complexity: high` when its acceptance
depends on deep multi-file reasoning, design judgment, or hard debugging; the
requirement never names a model, and your `WEAVER_WORKER_MODEL_COMPLEX` — when
set — supplies the stronger seat on the same configured executor, while routine
work stays on `WEAVER_WORKER_MODEL`. Weaver checks matching
reviewed routes inside the configured `WEAVER_EXECUTOR` substrate, then advances
past a target only while that exact model pool has an active typed backoff. The
first available target is reserved for a runner that declares its substrate; an
incapable host does not turn the configured fallback into a race.
`WEAVER_WORKER_MODEL` follows the reviewed routes in that order, and the
operator's explicit `WEAVER_WORKER_FALLBACKS` ladder extends the order after
it. See [Where workers run](./executors.md).

The global `weaver` command reads `.env` from the repo it resolves to, so these
apply no matter which directory you run from.
