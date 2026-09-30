# Operator workspace

`weaver ui` is a small browser surface for starting work and following it without learning the CLI. It reads and writes the same durable store as every other Weaver process; it is not a second source of truth.

```bash
# Terminal 1: serve the operator workspace
weaver ui

# Terminal 2: execute active workstreams
weaver run
```

The workspace listens on `127.0.0.1:9724` by default. Open the URL printed by the command. `--host` and `--port` change the listener:

```bash
weaver ui --host 0.0.0.0 --port 9724
```

## Jobs overview and workspace

The **Jobs** page is the work overview: scan how many jobs need attention, are
working, are waiting, or are done. **Fleet** is a separate compact system view
for shared data, execution visibility, and grouped operational incidents; those
facts do not become more sections inside a job. **Overview** is the read-only
[team overview](./overview.md) for teammates new to Weaver: how it works, where
the fleet's work comes from, how outcomes ended, and what it costs. On desktop the left sidebar uses the
same groups and stays available when you open a job; on mobile **All jobs**
returns to that list without repeating it above the selected job.

Two more pages sit beside them in the sidebar:

- **Policies** is the fleet's policy store: your own rules first, then lessons
  learned from your corrections that are in use, under review, on trial, or
  retired. Each row opens to show the full statement, the tags that decide
  which jobs it applies to, where it came from, and the evidence behind it
  (which jobs followed it cleanly and which still needed a person). It is the
  same store `weaver policies` shows; see [learning](./learning.md).
- **Analytics** answers "is Weaver needing me less often?": times a person
  stepped in per job that finished well, as a line over time with the
  week-on-week change, beside the rejection rate, how jobs ended, who stepped
  in, how many actions were approved automatically, first-try success, and the
  jobs that needed you most. The numbers come from the same computation as
  [`weaver stats`](./stats.md).

The **Fleet** page also lists every routine with when it last ran (the last
planning run that finished, not one that waited on model capacity or failed),
when it last put an agent to work, and when it runs next. A routine that is
behind schedule is marked and listed first. See [routines](./routines.md).

Each job has five task-oriented tabs. Only the selected tab body is rendered,
so scrolling is never the way you navigate between unrelated parts of a job.
Opening a job without choosing a tab lands on **Timeline**:

- **Timeline** (the default) is the job's history, one row per step, oldest
  first: each assignment with its creation time, kind, objective, work state,
  adoption (accepted green, rejected red, pending muted), number of runs, and
  the executor and model of its latest run; each decision, with what it
  replaced, what superseded it, or why it was closed; human acts (steers, with
  withdrawn ones struck through, approvals and rejections of actions and sends,
  results a person accepted or rejected, and every question asked of you and
  when it was resolved); the start of a routine's current cycle; and the
  conclusion with its disposition. Long objectives are cut to one line and
  expand in place. A quiet stretch of six hours or more between two rows shows
  as one row, such as "waited 2d 4h", with the reason of the scheduled check
  that ended it when one was recorded. Consecutive assignments of the same
  kind, with nothing else recorded between them, fold into one row ("5 attempts
  · 4 rejected · then accepted") when every one before the last was rejected
  or failed; the row expands to the individual steps. The most recent 60 rows
  show by default and **Show earlier** (`?tab=timeline&all=1`) shows them all.
  When the job needs you, the same decision card as Overview sits above the
  timeline, and an active job ends with its next move. Every row comes from a
  typed record, never from the bounded event log or a transcript. A routine's
  progress is overwritten in place, so only its current cycle's start is
  marked; earlier cycle boundaries live in [printouts](./printouts.md).
- **Overview** shows one current decision or one next-state card. Labelled
  choices are clickable, and every response can carry an optional condition;
  **Something else** accepts a different answer. The complete decision question
  and each complete option wrap rather than being cut off; long diagnostic
  context stays folded until you ask for it.
- **Work & results** shows live assignments and evidenced outputs. Accepted
  work leads with a short human summary; the exact agent-facing result stays
  under **Full technical result**. Older accepted results are folded as a group.
- **Activity** keeps the context composer and a bounded human-readable catch-up.
  Routine scheduler checkpoints and the current decision are not repeated.
- **Details** retains revisions and the standing course, with all Assignments
  and the full typed chronology in separate disclosures.

The active tab is part of the URL, so a link or live revision refresh returns
to the same view, including **Show earlier** on the timeline. The server sends one-way revision events and the browser
replaces the page's coherent server-rendered snapshot in place, including the
job list and fleet state; no manual reload is needed. A bounded revision poll
repairs a dropped event stream. Unsaved form input is never discarded: if an
update arrives while you are writing, Weaver holds it behind a small refresh
notice until you choose to replace the draft. On narrow screens the tab row
scrolls horizontally rather than turning into another tall section list.

These are two views over typed Workstream state. The workspace may look conversational, but a conversation is never the durable container and its prose cannot silently change authoritative state.

### Fleet status at a glance

The top of **Jobs** is a status strip, and a compact copy of it sits at the top
of the sidebar on every page. Both say in one line how the whole fleet is
doing: **All clear**, or a headline such as "3 need you · 1 blocked · 2 on a
backup model". Under the headline, a few plain sentences say what is wrong,
for example "2 jobs are running on a backup model because the main model is
limited." or "3 routines are behind schedule."

The **Runners** line lists the runners that are online. A runner that is still
checking in but can no longer save its work (for example, its disk is full)
has **stopped taking jobs**; the line names it with the reason it reported and
turns red, and the sidebar shows it too, so it cannot hide behind healthy job
counts. A runner that has not checked in for over two minutes is listed as not
checking in. Runners silent for more than a day are treated as retired and left
out.

Every job that is not finished is counted in exactly one bucket:

| Bucket | Meaning |
| --- | --- |
| **Needs you** | Waiting for your answer, approval, or review. |
| **Blocked** | Stuck for now: every model it can use is at its limit, no runner can run it, the approval service is down, or no runner is online to take it. |
| **Degraded** | Running on a backup model because the main model is limited. |
| **Working** | An agent is working on it right now. |
| **Waiting** | Nothing wrong. The next step is scheduled. |
| **Paused** | Paused by someone. Nothing runs until it is resumed. |
| **Done** | Finished in the last 7 days (older ones stay in the Done list). |

When more than one applies, the first match wins: **needs you > paused >
blocked > degraded > working > waiting**. A paused job asks you nothing, so the
first two never compete. A job with an agent still working while its next step
is blocked, or can only use a backup model, counts as blocked or degraded, and
its card says so ("Working · next step blocked", "Working · on backup model"),
so a card's label always matches the bucket it is counted in. The strip, the
sidebar, and the sentences under the headline all read the same counts, so
they never disagree.

Click a tile, or a count in the sidebar, to show only that bucket's jobs: the
address becomes `/board?state=needs-you`, `blocked`, `degraded`, `working`,
`waiting`, `paused`, or `done`. Click the active tile, or **Show all jobs**, to
clear it; an unknown value shows every job. The filter stays in place while
the page refreshes itself, and the counts update whenever a job changes or a
runner goes up or down.

## Start new work

Use **New job** to describe an outcome. Weaver creates a durable Workstream for it, then the separate runner picks it up. Creating a Workstream does not keep a browser request or model session alive; fresh coordinator and worker runs continue from stored state. **Advanced** offers an execution-host selector: **Automatic (default)** lets any capable live host claim the job, while an exact host binds both coordinator passes and intended work before the first wake. This chooses the machine, not the model executor configured on it. The optional parent selector also lives there because most requests are standalone jobs.

The UI server does not execute model runs. Keep `weaver run` running against the same `WEAVER_STORE` on this or another machine. Without that runner, the board remains usable and new work is safely stored, but no agent advances it.

## Add follow-up

Text entered under **Add context or answer a question**, and answers sent from
a **Decision needed** card, are recorded as untrusted **Observations** and wake
the Workstream. A decision response records the exact server-side option plus
any condition, or a custom answer. Stale or changed cards fail closed instead
of applying an answer to a different request.

These inputs can add evidence or context for the next fresh coordinator, but
they cannot grant authority, complete work, adopt a submission, approve an
action, or supersede standing direction by themselves. The shared browser
sign-in identifies a verified teammate for attribution; identity still does
not turn their input into authority.

Use the existing CLI for explicit human acts such as steering, adoption, attention resolution, or action approval. Keeping those acts separate prevents a convenient browser input from becoming an accidental authority channel.

## Close a job

The one explicit human act the workspace carries is a stop, never a go. Under
the job's **Activity** tab, **Close as not worth doing** takes a required
reason and closes the job at once, attributed to the signed-in teammate: the
reason is recorded as their steering, the job concludes as *not worth doing*
through the same validated path as `weaver close` (see
[Pausing work](./pausing.md#closing-work-that-should-not-continue)), and its
pending wakes are retired. The form carries the revision the page showed; if
the job changed since, the close is refused and you reload. Closing can only
narrow what happens — it cannot claim delivery, approve, send, or spend — and
`weaver resume <slug>` reopens the job with its history intact.

## Access and identity

The default loopback listener is available only on the local machine. A shared
deployment should use Clerk. Four settings form one atomic, fail-closed
configuration:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_…' \
CLERK_SECRET_KEY='sk_…' \
WEAVER_UI_ALLOWED_EMAIL_DOMAINS='company.example' \
WEAVER_UI_PUBLIC_ORIGIN='https://weaver.example.com' \
weaver ui --host 0.0.0.0
```

Every non-health request must then carry a valid Clerk session. Weaver fetches
the signed-in Clerk user server-side and requires at least one **verified**
email whose domain exactly matches `WEAVER_UI_ALLOWED_EMAIL_DOMAINS` (a
comma-separated allowlist). `person@sub.company.example` does not match
`company.example` unless the subdomain is listed separately. The normalized
verified email is recorded as the actor on browser input.
This authorization is revalidated on every request, so removing or unverifying
the allowed-domain email revokes access without waiting for an application cache.

`WEAVER_UI_PUBLIC_ORIGIN` is also the Clerk token's authorized party. Weaver
does not derive it from request or proxy headers, so a forged host cannot turn
a leaked subdomain cookie into a valid workspace session. Authenticated browser
mutations must carry that same complete HTTPS origin; a plaintext same-host
origin is not accepted. If any Clerk setting
is present while another is missing, the UI refuses to start; it never falls
back to a weaker mode. The secret key is server-only. The publishable key is
the only key rendered into the sign-in page and the session keep-alive page.

Clerk's session cookie is short-lived and is renewed by Clerk's browser SDK.
Workspace pages hold fleet data, so they never load that third-party script.
Instead, every signed-in page embeds a hidden, same-origin frame,
`/session-keepalive`: a content-free page that loads only the Clerk SDK and
keeps the cookie fresh. It is the one page that may be framed, and only by the
workspace's own origin. Without it, the cookie lapsed after about a minute, the
page's live updates came back unauthenticated, and the page reloaded from the
top. If a reload is ever unavoidable (a session that has truly ended), the page
comes back at the same scroll position.

On Railway, `WEAVER_UI_PUBLIC_ORIGIN` may be omitted: Weaver derives the exact
HTTPS origin from Railway's provider-owned `RAILWAY_PUBLIC_DOMAIN`. An explicit
origin remains available for custom domains and other hosts.

For a private self-hosted listener where Clerk is intentionally absent,
`WEAVER_UI_TOKEN` remains a fallback:

```bash
WEAVER_UI_TOKEN='use-a-long-random-value' weaver ui --host 0.0.0.0
```

That mode uses HTTP Basic authentication. The caller-supplied username is only
a provenance label and does not prove an individual's identity. A complete
Clerk configuration takes exclusive precedence over a stale Basic token.

All browser changes also require a same-origin request. Weaver normally checks
that the request's `Origin` matches the workspace host before reading the form
body or changing durable state. The page's `no-referrer` policy makes Chromium
serialize `Origin` as `null` on an ordinary same-origin form navigation; only
that case may use browser-controlled Fetch Metadata proving a same-origin
document navigation. Missing both signals, malformed origins, and cross-site
requests fail closed. This is the CSRF
boundary that prevents a different site from replaying a browser's Clerk
session or cached Basic credentials to create work, add follow-up, or force a
sign-out.

When Clerk is absent and `WEAVER_UI_TOKEN` is set, Basic authentication applies
on loopback too.

Basic authentication must be carried over a trusted network or HTTPS reverse
proxy because it does not encrypt traffic itself. Responses advertise a
one-year HTTP Strict Transport Security policy to HTTPS clients. Use Clerk,
not the Basic fallback, for a public shared workspace.

For a shared deployment, use the [Railway guide](./railway.md): the UI and
Postgres are hosted together while the initially separate execution host reads
and writes the same durable fleet.

The sidebar states which store the page is reading:

- **Shared fleet** means the workspace reads the shared team Postgres. The Fleet
  page reads runner TTL heartbeats from that same store and names the currently
  live execution hosts. No fresh heartbeat is reported as offline while every
  stored job remains safe for later execution.
- **Local fleet** means the page reads the local filesystem store and can
  measure the runner on the same machine.

The shared heartbeat is a narrow liveness observation. It does not say which
job a runner is executing, grant authority, or turn a worker result into an
accepted deliverable.

## Fleet attention

The Fleet page groups a shared dependency once. If the approval service is
unavailable, every affected external action stays safely gated, while one
incident names the affected action/job counts and the evidence that will prove
recovery. Those actions do not become repeated **Needs you** cards. A human-only
action or an explicit deny/ask verdict remains an individual decision because
its consequence genuinely requires authority or judgment.

Only active jobs contribute to a live approval-service incident. Pausing a job
also pauses its retries, so its last outage marker remains durable history until
the job resumes; it is not evidence that the shared service is still down.

Routine health is model-free in the Jobs page health card: a dormant cadence,
wake overdue past the dispatch grace, or result genuinely stranded awaiting
review warns immediately, without waiting for the attention steward to write a
secondary card.

**Start attention steward** creates one source-keyed routine Workstream. Each
cycle audits typed attention and fleet-health state, groups related symptoms by
root cause, confirms an existing live repair owner or delegates one bounded
source-keyed repair outcome, and asks a person only for irreducible judgment,
credentials, spend, or external-effect authority. An unchanged queue is not a
healthy queue: **quiet** means every operational item has a recorded disposition
and every non-deferred item has a live owner, not merely that no new card
appeared. Before each steward worker starts, the harness writes a fresh read-only input containing only open human
asks, their current typed reference state, approval-service waits, active
capacity backoffs, overdue wakes, dormant routines, results awaiting review,
grouped incidents, counts, and source revisions. It does not expose unrelated
objectives, decisions, artifacts, event prose, wake reasons, or database
credentials. The steward does not inherit operator authority: it cannot approve
or resolve sends, merges, deploys, spending, or any other external effect, and
its worker output is still only a proposal until adopted. This read-and-submit
role is also capped at 16 model turns and a ten-minute wall: it cannot turn a
small approval queue into an open-ended coding-agent investigation.

For each operational group, the report recommends the producer-level cause to
investigate or fix, with recurrence evidence that would prove closure. If the
narrow evidence cannot establish that cause, the steward owns the gap through a
bounded managed investigation rather than guessing, retrying blindly, clearing
the card, or hiding it in the interface.

A paused job is the operator's explicit deferral. The steward still accounts
for it, but does not reactivate it through a repair job or re-page it through its
own attention; resuming the source job returns any still-open need to the global
queue.

When a repair is verified, the steward can post one idempotent untrusted
Observation to the owning job. That wakes the owner to reconcile its own card;
the steward still cannot resolve, steer, approve, or otherwise mutate the
owner's authority or course.

An old open card is not current provider evidence. Credits can be topped up,
tokens can be replaced, services can recover, and repository checks can move
without a Weaver write. Before the steward repeats one of those asks, it creates
or reuses a bounded read-only verification job. Recovery evidence is handed to
the source owner for reconciliation; only a freshly verified remaining need for
spend, a credential, judgment, or authority reaches **Needs you**.
If one clause in a grouped decision card later clears, the steward closes that
card and creates a concise replacement containing only the still-verified
clauses. The replacement does not recap what closed, and an operational
retry, resume, or repair cannot hitchhike beside a genuine human-only ask. It
never preserves false text merely to keep the same card id.

The steward also does not duplicate a precise current card already owned by one
active source job. It creates a grouped steward card only when at least two
active source asks share one cause, or when the decision is genuinely
fleet-level. Paused jobs are deferred and do not count toward that threshold.

The same steward can live on an exact remote execution host without keeping a
dashboard, terminal, or model session open:

```bash
weaver watch --on <runner-id>
```

This command creates or reuses the same source-keyed routine, binds both its
coordinator passes and future or safely pending Assignments to that host, wakes
a dormant routine, and exits. The resident `weaver run` service on the selected
host keeps it alive across fresh Claude, Pi, OpenHands, or other configured
executor runs. `--on` selects the physical runner, not a model; the runner's
reviewed executor configuration still chooses each disposable model seat.
Running the command again is idempotent. Plain `weaver watch` remains the local
interactive dashboard with its embedded local runner.

## Authority limits

The operator workspace deliberately exposes intake, inspection, untrusted follow-up, and one stop: closing a job as not worth doing. It does not turn browser access into permission to send messages, spend money, merge or deploy code, approve actions, or claim an external effect occurred. Those consequences remain behind Weaver's existing typed authority, approval, and deterministic readback boundaries.
