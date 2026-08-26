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

The **Jobs** page is the fleet-level view: scan how many jobs need attention,
are working, are waiting, or are done. On desktop the left sidebar uses the
same groups and stays available when you open a job; on mobile **All jobs**
returns to that list without repeating it above the selected job.

Each job has four task-oriented tabs. Only the selected tab body is rendered,
so scrolling is never the way you navigate between unrelated parts of a job:

- **Overview** shows one current decision or one next-state card. Labelled
  choices are clickable, and every response can carry an optional condition;
  **Something else** accepts a different answer. Long diagnostic context stays
  folded until you ask for it.
- **Work & results** shows live assignments and evidenced outputs. Accepted
  work leads with a short human summary; the exact agent-facing result stays
  under **Full technical result**. Older accepted results are folded as a group.
- **Activity** keeps the context composer and a bounded human-readable catch-up.
  Routine scheduler checkpoints and the current decision are not repeated.
- **Details** retains revisions and the standing course, with all Assignments
  and the full typed chronology in separate disclosures.

The active tab is part of the URL, so a link, reload, or live revision refresh
returns to the same view. On narrow screens the tab row scrolls horizontally
rather than turning into another tall section list.

These are two views over typed Workstream state. The workspace may look conversational, but a conversation is never the durable container and its prose cannot silently change authoritative state.

## Start new work

Use **New job** to describe an outcome. Weaver creates a durable Workstream for it, then the separate runner picks it up. Creating a Workstream does not keep a browser request or model session alive; fresh coordinator and worker runs continue from stored state. The optional parent selector is under **Advanced** because most requests are standalone jobs.

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
password identifies a team session; it is not trusted individual authority.

Use the existing CLI for explicit human acts such as steering, adoption, attention resolution, or action approval. Keeping those acts separate prevents a convenient browser input from becoming an accidental authority channel.

## Access and identity

The default loopback listener is available only on the local machine. For any non-loopback host, set `WEAVER_UI_TOKEN` before starting the server:

```bash
WEAVER_UI_TOKEN='use-a-long-random-value' weaver ui --host 0.0.0.0
```

Non-loopback access uses HTTP Basic authentication. Enter an operator label as the username and `WEAVER_UI_TOKEN` as the password. The label is recorded as the actor on input from that browser session, but it is supplied by the caller and does not prove an individual's identity or grant authority.

All browser changes also require a same-origin request. Weaver normally checks
that the request's `Origin` matches the workspace host before reading the form
body or changing durable state. The page's `no-referrer` policy makes Chromium
serialize `Origin` as `null` on an ordinary same-origin form navigation; only
that case may use browser-controlled Fetch Metadata proving a same-origin
document navigation. Missing both signals, malformed origins, and cross-site
requests fail closed. This is the CSRF
boundary that prevents a different site from replaying a browser's cached
Basic-auth credentials to create work or add follow-up.

When `WEAVER_UI_TOKEN` is set, Basic authentication applies on loopback too.

Basic authentication must be carried over a trusted network or HTTPS reverse proxy because it does not encrypt traffic itself. Responses advertise a one-year HTTP Strict Transport Security policy to HTTPS clients. Do not expose this listener directly to the public internet.

For a shared deployment, use the [Railway guide](./railway.md): the UI and
Postgres are hosted together while the initially separate execution host reads
and writes the same durable fleet.

The sidebar states which store the page is reading:

- **Shared fleet · execution on another host** means the page and remote runner
  share Postgres. Workstreams, decisions, knowledge, and results are shared;
  process heartbeat, checkouts, and credentials stay on the execution host.
- **Local fleet · this machine** means the page reads the local filesystem
  store.

A shared UI cannot measure a runner heartbeat stored only on another host.
That is normal deployment context, not evidence that the runner is offline.

## Authority limits

The operator workspace deliberately exposes intake, inspection, and untrusted follow-up. It does not turn browser access into permission to send messages, spend money, merge or deploy code, approve actions, or claim an external effect occurred. Those consequences remain behind Weaver's existing typed authority, approval, and deterministic readback boundaries.
