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

Each job has one focused workspace:

- **Decision needed** appears once, with short choices when the request contains
  them. Long diagnostic context stays folded until you ask for it.
- **Current work** shows only live assignments.
- **Results** contains the evidenced conclusion and downloadable accepted or
  proposed outputs.
- **Recent updates** shows a bounded human-readable catch-up. Routine scheduler
  checkpoints and the current decision are not repeated there.
- **Technical details and full history** retains revisions, the standing course,
  acceptance criteria, attempt counts, and the typed chronology under one
  disclosure.

These are two views over typed Workstream state. The workspace may look conversational, but a conversation is never the durable container and its prose cannot silently change authoritative state.

## Start new work

Use **New job** to describe an outcome. Weaver creates a durable Workstream for it, then the separate runner picks it up. Creating a Workstream does not keep a browser request or model session alive; fresh coordinator and worker runs continue from stored state. The optional parent selector is under **Advanced** because most requests are standalone jobs.

The UI server does not execute model runs. Keep `weaver run` running against the same `WEAVER_STORE` on this or another machine. Without that runner, the board remains usable and new work is safely stored, but no agent advances it.

## Add follow-up

Text entered under **Add context or answer a question** is recorded as an
untrusted **Observation** and wakes the Workstream. It can add evidence or
context for the next fresh coordinator, but it cannot grant authority,
complete work, adopt a submission, approve an action, or supersede standing
direction by itself.

Use the existing CLI for explicit human acts such as steering, adoption, attention resolution, or action approval. Keeping those acts separate prevents a convenient browser input from becoming an accidental authority channel.

## Access and identity

The default loopback listener is available only on the local machine. For any non-loopback host, set `WEAVER_UI_TOKEN` before starting the server:

```bash
WEAVER_UI_TOKEN='use-a-long-random-value' weaver ui --host 0.0.0.0
```

Non-loopback access uses HTTP Basic authentication. Enter an operator label as the username and `WEAVER_UI_TOKEN` as the password. The label is recorded as the actor on input from that browser session, but it is supplied by the caller and does not prove an individual's identity or grant authority.

All browser changes also require a same-origin request: the request's `Origin`
must match the workspace host before Weaver reads the form body or changes
durable state. Missing, malformed, and cross-site origins fail closed. This is
the CSRF boundary that prevents a different site from replaying a browser's
cached Basic-auth credentials to create work or add follow-up.

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
