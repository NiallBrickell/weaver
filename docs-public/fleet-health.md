# Fleet health for external monitoring

`weaver ui` exposes `GET /healthz/fleet`: an unauthenticated JSON endpoint an
external monitor can poll on an interval and page on, answering the question
that actually matters — *is any runner still dispatching work, and is that
work actually being served?* A heartbeat alone answers only the first half:
a runner can tick every few seconds while every pass fails before completing,
so the endpoint also reads the freshest healthy runner's own observed output.

This exists because every fleet-health signal Weaver builds in by default —
the Fleet page, the attention steward — runs **on** a live runner. A runner
that goes fully dark reports nothing through them; a dead host is invisible to
the very tools meant to notice it. `/healthz/fleet` is answered by the
always-on `weaver ui` process instead, reading the same shared runner
presence those pages read, so it keeps working precisely when the runner it
reports on has stopped.

It is a different signal from plain `/healthz` (see the
[Railway guide](./railway.md)): that endpoint proves the configured store
answers one real read, and Railway uses it to gate *deployment* of the UI
service itself. `/healthz/fleet` is for continuous *operational* monitoring of
the runner, independent of any deploy.

## Response

```json
{
  "ok": true,
  "checked_at": "2026-09-21T09:00:00.000Z",
  "runners": [
    { "id": "gcp", "heartbeat_age_seconds": 4, "degraded": null }
  ],
  "freshest_heartbeat_age_seconds": 4,
  "healthy_runners": 1,
  "last_completed_pass_age_seconds": 42,
  "oldest_unserved_due_seconds": null,
  "capacity_blocked_workstreams": 0,
  "state_free_mib": 162304,
  "problems": [],
  "unhealthy": 0
}
```

- `runners` lists every runner id that has published presence to this store,
  each with how many seconds old its freshest heartbeat is and its current
  degraded reason (or `null`). Nothing beyond the id a runner already chose
  for itself — no host, address, or other mapping — is exposed.
- `freshest_heartbeat_age_seconds` is the minimum age across runners that are
  **not** degraded. It is `null` only when there is no such runner: none has
  ever heartbeated, or every one is currently degraded.
- A runner heartbeats roughly every 5 seconds. A runner counts toward
  `healthy_runners` only if its freshest heartbeat is **300 seconds** or
  newer — 60 missed ticks, well past a GC pause or a network blip — and it is
  not publishing itself `degraded`. A degraded runner's state directory can't
  take a write, so it dispatches nothing even with a heartbeat published
  seconds ago (see [Hosting Weaver](./hosting.md)).
- A fresh heartbeat proves the poll loop is running, not that it is
  accomplishing anything — a runner can tick every 5 seconds while every pass
  fails before completing. `last_completed_pass_age_seconds`,
  `oldest_unserved_due_seconds`, and `capacity_blocked_workstreams` are taken
  from the freshest **healthy** runner's own last scan (its `RunnerOutput`,
  published alongside its heartbeat) — never a separate store read, so this
  endpoint stays a cheap presence-only poll. They are `null`/`0` when no
  healthy runner has ever published output (an older runner version, or no
  healthy runner at all).
- `unhealthy` is `1` when `problems` is non-empty and `0` otherwise — point an
  external monitor at this one field; its meaning is unchanged, only what can
  set it has grown. `ok` mirrors it (`ok == (unhealthy == 0)`). `problems` is
  a plain-English list of which condition(s) below are currently failing:
  - **No healthy runner.** Same condition as before: `healthy_runners` is `0`.
  - **Due work unserved for over an hour.** `oldest_unserved_due_seconds` is
    over **3600** (`FLEET_UNSERVED_DUE_LIMIT_SECONDS`) — a due wake has sat
    unclaimed well past ordinary dispatch latency, meaning dispatch itself has
    stalled even though the runner is heartbeating.
  - **No pass completed in 12h while capacity is blocked.**
    `last_completed_pass_age_seconds` is over **43200** (12h,
    `FLEET_STALLED_OUTPUT_SECONDS`) **and** `capacity_blocked_workstreams` is
    greater than `0`. Either fact alone is not a problem — a quiet fleet with
    nothing due is fine, and a coordinator pass can legitimately take hours
    while a provider is in backoff — but together they mean the fleet is
    stuck waiting on capacity, not just idle.
  - **State filesystem under 2 GiB free.** `state_free_mib` (free space on
    the freshest healthy runner's `WEAVER_HOME` filesystem, from the same
    `RunnerOutput`; `null` when none has published it) is under **2048**
    (`FLEET_STATE_FREE_WARN_BYTES`). The runner itself stops dispatching and
    publishes `degraded` at 512 MiB, which the first condition already
    catches — this one fires a day or two earlier, while there is still room
    to act. On a hosted VM the nightly `weaver gc-workspaces` timer normally
    keeps this from ever tripping (see [Hosting Weaver](./hosting.md)).

The endpoint answers HTTP 200 for any completed check, healthy or not — the
`unhealthy` field carries the verdict, not the status code. Only a failure to
read the store itself returns HTTP 503, with a reduced body that never
includes connection details or a path:

```json
{ "ok": false, "unhealthy": 1, "error": "store unreachable" }
```

## Pointing a monitor at it

Point any monitor that can poll a URL on an interval and evaluate a JSON field
— UptimeRobot, Better Uptime, Cronitor, a cron job with `curl` and `jq`, or
your own — at `https://<your-ui-host>/healthz/fleet`, and page when
`unhealthy == 1` or the request fails or times out. No credential is required:
`/healthz/fleet` is exempt from the operator UI's Clerk/Basic auth gate,
exactly like `/healthz`, because it exposes no workstream content — only
runner ids, heartbeat freshness, and coarse counts/ages of what a runner
observed (never a workstream slug, title, or any other identifying detail).
