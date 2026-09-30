# The team REST API

`weaver ui` answers a small JSON API under `/api/v1/` for programs rather
than people: a team page that lists what the fleet is doing, a phone app that
shows what needs you and lets you answer it. It lives on the browser
workspace process because that is the part of Weaver you host publicly (for
example on [Railway](./railway.md)); `weaver serve` stays private on the
machine that runs the work.

The API can read everything the [operator workspace](./operator-workspace.md)
shows and do exactly one thing: answer an open "needs you" card. It cannot
start, steer, approve, merge, send, or close anything. An answer is recorded
the same way as one typed into the browser: as new information for the job,
which wakes it so Weaver can act on it. It does not close the card by itself
or approve anything on your behalf.

## Signing requests

Every call sends a bearer token:

```
Authorization: Bearer <token>
```

There are two tokens, each set as an environment variable on the `ui`
service:

| Variable | What it can do |
| --- | --- |
| `WEAVER_READ_TOKEN` | Every `GET` below. |
| `WEAVER_RESPOND_TOKEN` | Every `GET`, plus answering a card. |

Leave a variable unset and that token simply does not exist. A request with
no token or a wrong one gets `401`; a read token trying to answer gets `403`.
Browser sign-in (Clerk or the Basic password) never works here, and these
tokens never open the browser pages, so the two stay separate. Because
nothing rides a cookie, there is no same-origin check: any program holding a
token can call the API, so treat each token like a password, give the read
token to anything that only displays, and rotate either by changing the
variable and redeploying.

On Railway, `.railway/railway.ts` declares both variables as preserved, so
their values live only in the Railway dashboard. Generate each with something
like `openssl rand -hex 32`.

All responses are JSON with `snake_case` keys and ISO-8601 timestamps. Errors
look like `{"error": "…"}`.

## Resources

### `GET /api/v1/workstreams`

Every job, newest activity first.

Query parameters, all optional: `status` (`active`, `paused` or `done`),
`tag` (jobs carrying that tag), `updated_since` (an ISO timestamp), `limit`
(default 200, at most 1000).

```json
{
  "workstreams": [
    {
      "slug": "release-choice",
      "title": "Resolve the release choice",
      "status": "active",
      "tags": ["release"],
      "objective_excerpt": "Resolve the release choice.",
      "current_assignment": { "id": "asg_…", "title": "Run the smoke tests", "status": "running", "started_at": "2026-09-30T09:00:00.000Z" },
      "waiting": [{ "kind": "scheduled", "summary": "Check the CI result", "until": "2026-09-30T10:00:00.000Z" }],
      "needs_count": 1,
      "runner_id": "gcp",
      "updated_at": "2026-09-30T09:01:12.000Z",
      "revision": 42,
      "source_key": "ui:request:…"
    }
  ]
}
```

`current_assignment` is the task running now, else the newest one still on
its way, else `null`. `waiting` lists what the job is waiting for: `scheduled`
(a set time, in `until`), `watching` (waiting for something outside to
change), `due_now`, `provider_limit` (the AI model is unavailable until
`until`) and `rate_limit` (a short pause after many runs). `needs_count` is the
number of open cards. `runner_id` is the machine the job is pinned to, or
`null` when any runner may pick it up.

The list is shared by every caller for about ten seconds, and a job's summary
is only re-read when that job has actually changed. A busy dashboard polling
this endpoint therefore costs a list of names and revision numbers every ten
seconds, not a download of every job. That matters on a hosted database that
bills for data sent over its public address.

### `GET /api/v1/workstreams/:slug`

One job: the summary above plus `objective`, `success_criteria`,
`created_at`, its ten most recent `decisions` (title, reasoning, whether it
still stands, who made it, latest progress), its `deliverables` (with
`accepted` once Weaver has accepted the result), every pending wait in
`waits`, its open cards in `needs`, and how it finished in `conclusion`
(`null` while it is running). Unknown slugs get `404`.

### `GET /api/v1/workstreams/:slug/assignments`

The job's tasks, newest first (`limit`, default 50, at most 500), with
`total` for the full count. Each carries its `status`, whether its result was
accepted (`review`: `none`, `proposed`, `accepted`, `rejected` or
`superseded`), a short `result_summary`, and an `attempts` summary: how many
runs it took, their total recorded cost, and the last run's start, end,
model, and why it ended.

### `GET /api/v1/workstreams/:slug/events`

What happened, as one plain-English line per event, oldest first:

```json
{
  "events": [
    { "id": "d:dec_…", "ts": "2026-09-30T09:00:00.000Z", "kind": "decision", "message": "Decided: Ship behind the feature flag" },
    { "id": "a:asg_…", "ts": "2026-09-30T09:00:05.000Z", "kind": "work", "message": "Finished and accepted: Run the smoke tests" }
  ],
  "cursor": "WyIyMDI2LTA5…"
}
```

`kind` is one of `work`, `action`, `decision`, `cycle`, `direction`,
`approval`, `question`, `finished` or `wait`. Without `after` you get the most
recent `limit` events (default 50, at most 500). To follow along, pass the
returned `cursor` back as `after` and you get only what happened since; when
nothing has, `events` is empty and `cursor` comes back unchanged. The events
are built from the job's own records, the same ones the workspace's Timeline
tab shows, never from a model's summary.

### `GET /api/v1/needs`

Every open card across the fleet, or one job's with `?workstream=<slug>`:

```json
{
  "needs": [
    {
      "workstream": "release-choice",
      "source_type": "attention",
      "source_id": "att_…",
      "version": "3f1c…",
      "kind": "blocker",
      "title": "Choose the release course.",
      "text": "Choose the release course. (A) Continue on green tests. (B) Ask for another review.",
      "choices": [
        { "label": "A", "text": "Continue on green tests." },
        { "label": "B", "text": "Ask for another review." }
      ],
      "created_at": "2026-09-30T08:55:00.000Z"
    }
  ]
}
```

This includes cards on paused jobs, as the job's own workspace page does. It
reads from the same ten-second shared list as `/workstreams`.

### `POST /api/v1/workstreams/:slug/needs/:source_type/:source_id/responses`

Answer one card. Needs the respond token. Send JSON:

```json
{ "version": "3f1c…", "choice": "A", "note": "Only after the smoke test passes.", "response_id": "a uuid v4 you generate" }
```

Send either `choice` (one of the card's labels) or `custom` (your own
answer), not both; `note` is optional. `version` is the card's `version` from
`/needs`: if the card has changed or closed since you read it the answer is
refused with `409`, so you never answer a question that is no longer being
asked. Generate one `response_id` per answer and reuse it on a retry: sending
the same answer again returns `201` with `"duplicate": true` and records
nothing new. A malformed request gets `400`; success is `201`:

```json
{ "recorded": true, "duplicate": false, "observation_id": "obs_…", "workstream": "release-choice" }
```

The answer is stored exactly as the browser's answer form stores it, marked
as coming from `api:team`.

### `GET /api/v1/runners`

The machines running work, from their heartbeats:

```json
{
  "runners": [
    {
      "id": "gcp",
      "heartbeat_at": "2026-09-30T09:01:10.000Z",
      "age_seconds": 3,
      "live": true,
      "coordinator_seats": [{ "executor": "local-sdk", "provider": "anthropic", "model": "claude-opus-4" }],
      "worker_seats": [],
      "degraded": null
    }
  ]
}
```

`live` means it has checked in within the last two minutes. `degraded` is the
reason a runner that is checking in still cannot do any work (for example a
full disk), or `null`. The seat lists are `null` for runners too old to report
them. For paging on a dead fleet, use [`/healthz/fleet`](./fleet-health.md),
which needs no token.
