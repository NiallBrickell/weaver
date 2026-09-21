# Fleet health for external monitoring

`weaver ui` exposes `GET /healthz/fleet`: an unauthenticated JSON endpoint an
external monitor can poll on an interval and page on, answering one narrow
question — *is any runner still dispatching work?*

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
- `unhealthy` is `1` exactly when `healthy_runners` is `0` — point an external
  monitor at this one field. `ok` mirrors it (`ok == (unhealthy == 0)`).

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
runner ids and heartbeat freshness.
