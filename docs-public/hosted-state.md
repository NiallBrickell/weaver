# Hosted state

*Point WEAVER_STORE at a SQLite file or plain Postgres and the durable layer — workstreams, artifacts, learned policies — lives in one database instead of loose files*

By default Weaver keeps its typed state on the local filesystem (`WEAVER_HOME`, default `./state`). Set one variable and the same state lives in a database instead:

```bash
# One local file — real transactions, nothing to run:
export WEAVER_STORE="sqlite:~/.weaver/weaver.db"

# Or shared Postgres — one fleet across machines:
export WEAVER_STORE="postgres://user:pass@host:5432/weaver"

weaver do "triage this morning's Sentry backlog"
```

## Which backend, when

| Backend | `WEAVER_STORE` | Use it when |
| --- | --- | --- |
| Filesystem (default) | unset | Zero setup; state as inspectable JSON files under `WEAVER_HOME`; one machine. |
| SQLite | `sqlite:<path>` (`~` expands; parent dirs are created) | One machine, one durable file: database transactions instead of file locks, easy to back up or sync, still no server to run. Uses Node's built-in `node:sqlite` — no extra install (Node 22.13+). |
| Postgres | `postgres://…` or `postgresql://…` | Several machines sharing one fleet — laptop CLI, dashboard, remote runners against the same decisions, policies, and needs-you queue. |

For Postgres, any plain instance works — Supabase, Neon, RDS, a self-hosted box, `docker run postgres:16`. No extensions, no provider-specific APIs. On both database backends the schema (workstreams, artifacts, policies) is created automatically on first connect; after that, a process only reads the catalog to confirm it is current and takes no table locks. Every Postgres session carries connection, statement, lock, and idle-in-transaction timeouts, so a dropped route or a client that died mid-transaction becomes a bounded failure the resident runner recovers from rather than a silent hang. Those timeouts travel as startup parameters, and tick exclusion uses session-scoped advisory locks, so connect to the database itself (or a session-mode pooler that passes `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout` through), not a transaction-mode pooler.

Setting `WEAVER_STORE` changes the selected backend; it does not silently move
an existing filesystem fleet. To preserve exact workstream revisions, adoption
pins, artifacts, and policy trust state in a new empty Postgres database, stop
the local runner and run:

```bash
WEAVER_STORE=fs weaver store copy-to-postgres
```

The destination URL is read with hidden input. The copy locks filesystem
writers, refuses a non-empty destination, verifies secret refusal and artifact
hashes before writing, installs the snapshot atomically, and proves a fresh
Postgres readback before reporting success. Machine-local activity/printout
files and execution credentials remain local. Then use `weaver link <url>` and
restart resident processes. See the complete [Railway deployment guide](./railway.md).

## What changes, and what doesn't

- **Same contract, different bytes.** The revision-checked write, artifact content pinning, and the learned-policy store behave identically on every backend — one contract-test suite runs over all three. Unset `WEAVER_STORE` (or set anything that isn't a `sqlite:`/`postgres://`/`postgresql://` value) and you're back on the filesystem.
- **Writes are genuinely atomic.** The revision check runs inside a database transaction: two writers racing the same workstream resolve with one write landing and the other told the state moved, so it reconciles. On SQLite that holds across every process on the machine (the database write lock serializes them); on Postgres it holds across machines. Postgres tick exclusion uses session-scoped advisory locks, which the database releases the instant a holder dies — a crashed runner never wedges its workstream.
- **The knowledge layer becomes shared (Postgres).** Learned policies live in the database, so every machine pointing at the same `WEAVER_STORE` proposes, applies, and promotes against one store — corrections you make on your laptop shape runs dispatched from a server.
- **Secrets stay local.** Credential values remain in `0600` env files on each machine and are never written to the database; the store refuses any document that embeds a known secret value, on every backend.
- **Live local views stay local.** The activity tail, the `watch` dashboard's file polling, and the simulated outbox read the machine-local state directory — the durable truth is what moves to the database.
