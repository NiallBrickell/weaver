# Connecting bots to Weaver

*A fleet of disposable bots; one shared, durable brain*

You have — or will have — many bots: a code bot that opens a PR, a UX bot that
looks at the app holistically, whatever comes next. Each is a disposable process
that does a piece of work and exits. What they lack is memory: the next run
starts from nothing, the decisions and corrections from last time are gone, and
nobody can see the whole arc of an outcome.

Weaver is the part that lasts. A **Workstream** is the durable record of a piece
of work — its objective, standing decisions, adopted results, learned policies,
and history — and it survives every bot run. So the model is simple:

> A bot is disposable. The Workstream it works on is durable. The bot reports
> what it did; Weaver remembers, decides, and carries the outcome forward.

Two natural shapes fall out of that:

- **A Workstream per piece of work.** A code bot opening PR #1957 registers a
  workstream keyed `devbot:pr:1957`. It exists for that PR: review feedback,
  retries, the merge, all in one durable place.
- **A long-running Workstream.** A UX bot watching the whole app registers one
  workstream keyed `ux:app` and keeps reporting into it for months. Its decision
  log and learned policies accumulate — the second cycle is smarter than the
  first, and the tenth knows what "noise" means here.

## How a bot connects: `weaver serve`

Weaver's durable layer is a library over a store; put that store in Postgres
([Hosted state](./hosted-state.md)) and one fleet is shared across machines.
`weaver serve` is the thin HTTP seam that lets a bot in **any language** reach
that shared brain — the same spirit as the Postgres store adapter: it exposes
only ingress and read, runs no model, and holds no state of its own.

```bash
export WEAVER_STORE=postgres://…        # the shared fleet (optional; fs by default)
export WEAVER_SERVE_TOKEN=<a-strong-secret>
weaver serve --host 0.0.0.0 --port 9723   # refuses to start without the token
```

Execution still belongs to the resident runner (`weaver run`); `serve` only
accepts what bots send and reads state back.

### The three calls a bot makes

Every request carries `Authorization: Bearer $WEAVER_SERVE_TOKEN`.

**1. Register (or find) my workstream — idempotent on a source key.**

```bash
curl -X POST http://host:9723/workstreams \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"source_key":"devbot:pr:1957","title":"Fix the composer","objective":"Land PR #1957 with review feedback addressed and CI green"}'
# → 201 {"slug":"fix-the-composer","id":"ws_…","created":true}
#   the same call again → 200 {…, "created":false}   (no duplicate; safe to retry)
```

The source key is the idempotency key. Call it on every run — the second time
is a no-op that just tells you your workstream's slug. Two bots racing the same
key still land exactly one workstream.

**2. Report what I saw — an observation.**

```bash
curl -X POST http://host:9723/workstreams/fix-the-composer/observations \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"source":"devbot","summary":"CI failed: 2 e2e tests flaky on the upload path","key":"devbot:run:42"}'
```

An observation is **untrusted evidence**: it wakes the workstream and a
coordinator pass evaluates it. That is the point — a bot supplies facts; it does
not get to declare the work done or change direction. Pass a `key` for
at-least-once safety (a duplicate is a no-op).

**3. Read where things stand.**

```bash
curl http://host:9723/workstreams/fix-the-composer -H "Authorization: Bearer $TOKEN"
# → {"slug","status","objective","concluded","status_text": "…five-questions view…"}
```

## What the adapter deliberately will not do

There is no route to steer, approve, or adopt. Those are the **human's authority
channels**, and a bot is never handed them — an inbound report cannot grant
authority, complete work, or supersede a decision. A bot registers work and
reports evidence; a person (or the coordinator, under its own constraints)
decides what that evidence means. The bearer token is a machine-to-machine
trust boundary, not a login system — Weaver has no tenancy or orgs.

## Where the pieces run

```
  bots (any language, anywhere)        weaver serve            weaver run + Postgres
  ── disposable ──                     ── ingress adapter ──   ── durable brain ──
   register workstream (source key) ─────────► create-or-get ─────► workstream state
   report observations ──────────────────────► wake + evidence ──► coordinator evaluates,
   read status ◄────────────────────────────── five-questions ◄──  decides, adopts, remembers
```

Nothing here is bot-shaped: `weaver create --source-key …` and `weaver observe`
do exactly the same things from the CLI. A bot is just an external process that
keeps its work in a Workstream — see [Watching a tracker](./linear.md) for the
same idea where the "bot" is itself a Weaver routine.
