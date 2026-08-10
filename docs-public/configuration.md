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
WEAVER_COORDINATOR_FALLBACK_MODEL=claude-opus-4-8
WEAVER_STORE=postgres://user:pass@host:5432/weaver
```

Two rules make it safe to rely on:

- **It only fills gaps.** Anything already set in your environment — an explicit
  `export`, or a value passed for a single command — always wins. The file
  never overrides what you set for this invocation.
- **A missing `.env` is a no-op.** The file is optional; without it Weaver uses
  the built-in defaults below.

`.env` is for *config*, not secrets. Per-workstream secrets belong in the store
via `weaver secret set <NAME> --ws <slug>`, where models see the name and only
approved shells ever see the value — see [Secrets & access](./secrets-and-access.md).

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
| `WEAVER_COORDINATOR_FALLBACK_MODEL` | `claude-opus-5` | The model it degrades to when the primary pool is limited |
| `WEAVER_WORKER_MODEL` | `sonnet` | The model workers run on |
| `WEAVER_ASK_MODEL` | `sonnet` | The model behind `weaver do`/`weaver ask` intake |

### Storage

| Variable | Default | What it sets |
| --- | --- | --- |
| `WEAVER_HOME` | `<repo>/state` | State root for the default filesystem backend |
| `WEAVER_STORE` | *(unset → fs)* | `postgres://…` or `sqlite:<path>` to share or consolidate the fleet — see [Hosted state](./hosted-state.md) |

### Execution and actions

| Variable | Default | What it sets |
| --- | --- | --- |
| `WEAVER_EXECUTOR` | `local` | The worker execution substrate |
| `WEAVER_PILOT_URL` | `http://localhost:9721` | The operator's pilot daemon that gates external actions |

The global `weaver` command reads `.env` from the repo it resolves to, so these
apply no matter which directory you run from.
