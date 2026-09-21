# The daily digest

*What needs you, pushed to you every morning*

Every other way to see what Weaver is waiting on — `weaver watch`, printouts,
the operator workspace — waits for you to go and look. When you don't, the
fleet quietly queues up behind you: approvals age, drafted replies sit unsent,
and the Workstreams that depend on your answer stop moving. The daily digest
turns that queue into one Slack message that arrives on its own at 07:30
London time.

## What it contains

The digest is rendered from Weaver's typed state with no model involved, so it
can never contain a summary that is not backed by a record:

- **Health** — whether a runner is live, whether it has published itself
  degraded (for example a full disk), and any fleet-wide incident such as the
  approval service being unreachable.
- **Needs you** — the same queue, in the same order, as the workspace's fleet
  board: blockers first, then approvals, actions, and sends, oldest first.
  Paused Workstreams are left out, exactly as they are on the board. Each item
  shows its kind, how long it has waited (flagged with ⚠ past 72 hours), the
  headline the workspace shows, a link to its Workstream page, and the exact
  command that answers it — `weaver approve-action <slug> <id>`,
  `weaver approve <slug> <id>`, or `weaver resolve <slug> <id> "your answer"`.
  At most 15 items are listed; the message says how many more are waiting.
- **Closed in the last 24 hours** — concluded Workstreams, actions whose
  deterministic readback confirmed the effect (merges are called out), and
  resolved cards. Worker prose claiming something happened never counts.
- **Next 24 hours** — scheduled wakes per Workstream, soonest first.

If nothing needs you and nothing closed, no message is sent.

## Running it

```bash
weaver digest                  # print today's digest as Slack mrkdwn; sends nothing
weaver digest --post           # send it to the configured destination, once per London day
weaver digest --dry-run        # read the channel back and say whether --post would send
```

`--post` is safe to run as often as you like. Every message carries a
`[weaver-digest YYYY-MM-DD]` marker; before posting, Weaver reads the channel's
recent history for today's marker and does nothing if it is already there. If
the post itself errors or times out, Weaver reads the channel back instead of
posting again: a message that landed is reported as sent, and one that did not
fails the run so the next `--post` can try again, reading back first. If the
history cannot be read at all, nothing is posted — Weaver will not send
without proving today's digest is absent.

## Setting up Slack

1. Create a Slack app for your workspace and give its bot token the scopes
   `chat:write` plus the history scope for the conversation it posts to:
   `im:history` for a direct message with the app, `channels:history` for a
   public channel, or `groups:history` for a private one. The history scope is
   what makes the digest idempotent; without it every `--post` fails before
   sending.
2. Install the app and copy its bot token (`xoxb-…`).
3. Choose where it goes and copy that conversation's ID: `D…` for the app's
   direct message with you (open the app's **Messages** tab and copy the ID
   from the conversation details), or `C…`/`G…` for a channel only you read
   (invite the app with `/invite @your-app`). A `#name` is refused.
4. Store both values in the executor-only secret store on the machine that
   will send the digest. They never enter process environments, worker runs,
   or Workstream state:

   ```bash
   weaver secret set WEAVER_DIGEST_SLACK_TOKEN --executor    # hidden prompt
   weaver secret set WEAVER_DIGEST_SLACK_CHANNEL --executor
   weaver login --status                                     # names only, never values
   ```

For links, set `WEAVER_UI_PUBLIC_ORIGIN` to your operator workspace's public
origin (on Railway the assigned domain is used automatically). Without it the
digest still lists every answering command, just without links.

**Point it at yourself.** The digest counts as operator notification rather
than an outbound message because its destination is yours, fixed by you,
outside anything a Workstream can read or change. Aim it at a shared team
channel and it becomes a message to other people, which in Weaver is always a
gated, approved action — so don't.

## On a hosted GCP runner

[`bin/weaver-gcp.sh`](../bin/weaver-gcp.sh) installs the digest as its own
systemd unit and timer — `weaver-digest.service` runs
`weaver digest --post` as the `weaver` user, and `weaver-digest.timer` fires it
at `07:30 Europe/London` with `Persistent=true`, so a morning missed while the
VM was down is sent at the next boot. It is deliberately independent of
`weaver-run`: the morning the runner has crashed, wedged, or been refused by
its launch preflight is the morning you most need the digest, and the digest
launches no model and holds no action capability.

```bash
# On the operator laptop, after the secrets above are registered there:
WEAVER_UI_PUBLIC_ORIGIN=https://your-workspace.example \
  bin/weaver-gcp.sh push-env        # the two digest secrets go only to the host's executor-only store
bin/weaver-gcp.sh status            # "daily digest timer: active" once started
bin/weaver-gcp.sh ssh --command 'sudo -H -u weaver /usr/local/bin/weaver digest --dry-run'
bin/weaver-gcp.sh logs weaver-digest
```

Provisioning (`create`) writes the units; `start`, the explicit cutover,
enables the timer alongside the runner, so a host is never reporting on a store
you have not yet pointed it at. A host provisioned before the digest existed
picks the units up by re-provisioning the documented way: `stop`, `create`
(with `--external-store` if that is how it was built), then `start`.

The digest reads every Workstream once per run. That is a once-a-day read, not
the per-tick fleet load that made hosted-store egress expensive.
