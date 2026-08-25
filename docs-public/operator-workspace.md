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

## Board and workspace

The board is the fleet-level view: scan what needs attention, what is moving, what is waiting, and what is ready. Open a card to enter that Workstream's workspace, where the current position, plan, activity, and work products can be read together and follow-up can be added.

These are two views over typed Workstream state. The workspace may look conversational, but a conversation is never the durable container and its prose cannot silently change authoritative state.

## Start new work

Use **New work** to describe an outcome. Weaver creates a durable Workstream for it, then the separate runner picks it up. Creating a Workstream does not keep a browser request or model session alive; fresh coordinator and worker runs continue from stored state.

The UI server does not execute model runs. Keep `weaver run` running against the same `WEAVER_STORE` on this or another machine. Without that runner, the board remains usable and new work is safely stored, but no agent advances it.

## Add follow-up

Text entered in a Workstream workspace is recorded as an untrusted **Observation** and wakes the Workstream. It can add evidence or context for the next fresh coordinator, but it cannot grant authority, complete work, adopt a submission, approve an action, or supersede standing direction by itself.

Use the existing CLI for explicit human acts such as steering, adoption, attention resolution, or action approval. Keeping those acts separate prevents a convenient browser input from becoming an accidental authority channel.

## Access and identity

The default loopback listener is available only on the local machine. For any non-loopback host, set `WEAVER_UI_TOKEN` before starting the server:

```bash
WEAVER_UI_TOKEN='use-a-long-random-value' weaver ui --host 0.0.0.0
```

Non-loopback access uses HTTP Basic authentication. Enter any operator name as the username and `WEAVER_UI_TOKEN` as the password. The username is recorded as the actor on input from that browser session; it is attribution, not a grant of authority.

When `WEAVER_UI_TOKEN` is set, Basic authentication applies on loopback too.

Basic authentication must be carried over a trusted network or HTTPS reverse proxy because it does not encrypt traffic itself. Do not expose this listener directly to the public internet.

## Authority limits

The operator workspace deliberately exposes intake, inspection, and untrusted follow-up. It does not turn browser access into permission to send messages, spend money, merge or deploy code, approve actions, or claim an external effect occurred. Those consequences remain behind Weaver's existing typed authority, approval, and deterministic readback boundaries.
