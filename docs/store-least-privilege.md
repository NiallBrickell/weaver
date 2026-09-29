# Store least privilege: a Weaver role instead of the superuser

**Status: written up, not applied.** Every host that reaches the shared fleet
store today connects as `postgres`, the Railway database's superuser. TLS now
keeps that password off the wire (see the store TLS note in
[harness.md](./harness.md#surprises-worth-knowing)), but the credential itself
is still far wider than Weaver needs: a superuser can read and write every
database on the server, run `COPY … TO PROGRAM` (a shell on the database
host), create roles, and turn off the settings that bound Weaver's own
sessions. A leaked runner environment should cost the fleet's documents, not
the database server.

This document is the operator's runbook for moving the fleet to a role that
owns exactly Weaver's tables. It changes live credentials on three hosts (the
Railway UI service, the GCP runner VM, and the operator's Mac), so it is run by
hand, in the order below, with a check after each step.

## What Weaver actually needs

Everything Weaver does in Postgres is in [`src/store/pg.ts`](../src/store/pg.ts):

- **Tables** (all in schema `public`): `workstreams`, `artifacts`, `policies`,
  `runner_presence`, `probe_cursors`. Their indexes (`workstreams_managed_by`,
  `workstreams_source_key`, and the primary keys) belong to the tables.
- **DDL on first use and on upgrade.** `initializeSchema` runs
  `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
  `ALTER COLUMN … TYPE`, `CREATE INDEX` and `DROP INDEX` whenever a new build
  finds a missing piece. Altering a table requires *owning* it, so the role
  must own all five tables, and it needs `CREATE` on schema `public` so a
  future build can add a sixth.
- **Advisory locks** (`pg_advisory_xact_lock`, `pg_try_advisory_lock`) and the
  session settings Weaver sets at connect (`statement_timeout`,
  `lock_timeout`, `idle_in_transaction_session_timeout`). None needs a
  privilege.
- **Catalog reads** (`pg_attribute`, `pg_attrdef`, `to_regclass`), which every
  role may do.

It never needs `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`,
`BYPASSRLS`, or access to any other database or schema. `pg_stat_statements`
(the egress-attribution query in [railway.md](../docs-public/railway.md)) stays
an operator query run as `postgres`.

## 0. Before you start

Confirm the database holds nothing else Weaver's role would have to reach, and
that the table list above is complete. As `postgres`, on the `railway`
database:

```sql
SELECT n.nspname AS schema, c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
ORDER BY 1, 2;
```

Expect the five tables, their indexes, and nothing else Weaver wrote. If a
newer build has added a table, add it to the `ALTER TABLE … OWNER` list below.

Generate the new role's password on the Mac and keep it out of shell history
(hex needs no URL encoding):

```bash
openssl rand -hex 32   # paste into a password manager as "weaver_app store password"
```

## 1. Create the role and hand it the tables

Run as `postgres` (Railway dashboard → Postgres → Database → Query, or `psql`
against the public URL). Replace `<weaver_app password>`:

```sql
BEGIN;

CREATE ROLE weaver_app
  LOGIN
  PASSWORD '<weaver_app password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  NOINHERIT
  CONNECTION LIMIT 100;

-- Only this database, only this schema.
REVOKE ALL ON DATABASE railway FROM PUBLIC;
GRANT CONNECT ON DATABASE railway TO weaver_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO weaver_app;

-- Ownership, not grants: Weaver's schema pass alters these tables on upgrade,
-- and only an owner may ALTER. Indexes move with their tables.
ALTER TABLE public.workstreams     OWNER TO weaver_app;
ALTER TABLE public.artifacts       OWNER TO weaver_app;
ALTER TABLE public.policies        OWNER TO weaver_app;
ALTER TABLE public.runner_presence OWNER TO weaver_app;
ALTER TABLE public.probe_cursors   OWNER TO weaver_app;

-- The role's session bounds match what Weaver sets at connect, so a client
-- that forgets them (psql, a script) still cannot hold locks for hours.
ALTER ROLE weaver_app SET statement_timeout = '60s';
ALTER ROLE weaver_app SET lock_timeout = '10s';
ALTER ROLE weaver_app SET idle_in_transaction_session_timeout = '60s';

COMMIT;
```

`ALTER TABLE … OWNER` takes an `ACCESS EXCLUSIVE` lock on each table for an
instant. Weaver's `lock_timeout` is 10 seconds, so a runner write that queues
behind it fails fast and retries; run the block when no long transaction is
open (`SELECT pid, state, xact_start FROM pg_stat_activity WHERE xact_start < now() - interval '10 seconds';`
should be empty).

Check from the Mac before any host moves — a new role that cannot read the
fleet should fail here, not on the runner:

```bash
psql "postgresql://weaver_app:<password>@<host>.proxy.rlwy.net:<port>/railway?sslmode=require" \
  -c "select count(*) from workstreams" \
  -c "select count(*) from runner_presence" \
  -c "select rolsuper from pg_roles where rolname = current_user"   # f
```

(`psql` is libpq, where `sslmode=require` means encrypted without verification.
The Weaver URLs below are read by node-postgres, which gives `sslmode` a
different meaning; they carry no `sslmode` unless you pin the CA.)

## 2. Roll out, one host at a time

Order matters: the UI first (inside Railway, private network, easiest to
revert), then the runner (the only host that writes continuously), then the
Mac. Each host keeps working on the old credential until it moves, because the
superuser password does not change until step 3.

### 2a. Railway UI (private URL)

The UI's `WEAVER_STORE` is bound to `${{Postgres.DATABASE_URL}}` in
[`.railway/railway.ts`](../.railway/railway.ts), which is always the
superuser. Change that line to `WEAVER_STORE: preserve(),` in a PR, merge it,
then set the variable on the `ui` service (Railway → ui → Variables) to:

```text
postgresql://weaver_app:<password>@postgres.railway.internal:5432/railway
```

Run `railway config plan` (it must show only the `ui` variable change) and
`railway config apply`, let the service redeploy, and check `/healthz` returns
200 and the board loads. The private network carries no TLS by design; Weaver
treats `*.railway.internal` as private.

### 2b. GCP runner VM (set-store, then restart)

On the Mac, install the new URL over SSH stdin — it is never a shell argument
or log line:

```bash
bin/weaver-gcp.sh set-store
# paste: postgresql://weaver_app:<password>@<host>.proxy.rlwy.net:<port>/railway
```

Add `?sslmode=verify-ca&sslrootcert=/etc/weaver/railway-root.crt&uselibpqcompat=true`
if the pinned CA is installed on the VM (see
[railway.md](../docs-public/railway.md#what-is-encrypted-and-what-is-verified)).
`set-store` does not restart services; restart the runner between ticks
(`bin/weaver-gcp.sh restart`, or the systemd units on the VM), then confirm
`weaver status` shows a fresh, non-degraded runner and that a tick commits
(the runner's presence advances and a pending wake fires).

### 2c. Operator Mac (`.env`)

```bash
weaver link "postgresql://weaver_app:<password>@<host>.proxy.rlwy.net:<port>/railway"
```

`link` proves the connection before it rewrites `WEAVER_STORE` in `.env`.
Restart any resident local process (`weaver watch`, the UI) so it re-reads
`.env`.

### Confirm nothing still uses the superuser

As `postgres`:

```sql
SELECT usename, application_name, client_addr, count(*)
FROM pg_stat_activity
WHERE datname = 'railway'
GROUP BY 1, 2, 3
ORDER BY 1;
```

Every `weaver` / `weaver-tick` session must show `usename = weaver_app`. A
`postgres` row with `application_name` `weaver` or `weaver-tick` is a host that
has not moved; do not continue until it has.

## 3. Rotate the superuser password

Only after step 2's check is clean. The superuser password is what every host
has held until now, and it has crossed the internet in plaintext, so treat it
as disclosed.

1. As `postgres`: `ALTER ROLE postgres WITH PASSWORD '<new superuser password>';`
   (generate it with `openssl rand -hex 32`, store it in the password manager).
2. In Railway → Postgres → Variables, set `PGPASSWORD` and `POSTGRES_PASSWORD`
   to the same value, so the derived `DATABASE_URL` and `DATABASE_PUBLIC_URL`
   match the database again. Changing the variable alone does not change the
   password (it is used only at `initdb`); the `ALTER ROLE` alone leaves
   Railway's reference variables stale. Both, in this order.
3. Check anything else Railway runs against the superuser still connects —
   in particular the `Postgres-PITR` backup job, if it authenticates as
   `postgres` — by forcing or waiting for its next run and reading its logs.
4. Confirm the old password is refused: a `psql` with the old URL must fail
   with `password authentication failed for user "postgres"`.

## Rollback

Before step 3, rollback is only re-pointing a host at the old (superuser) URL;
nothing else changed for it. The table ownership transfer is harmless to the
superuser, which bypasses ownership checks. After step 3, the old URL is dead
by design; roll back with the new superuser URL from the password manager.

To undo the role entirely (as `postgres`):

```sql
ALTER TABLE public.workstreams     OWNER TO postgres;
ALTER TABLE public.artifacts       OWNER TO postgres;
ALTER TABLE public.policies        OWNER TO postgres;
ALTER TABLE public.runner_presence OWNER TO postgres;
ALTER TABLE public.probe_cursors   OWNER TO postgres;
REVOKE ALL ON SCHEMA public FROM weaver_app;
REVOKE ALL ON DATABASE railway FROM weaver_app;
DROP ROLE weaver_app;
```
