# Watching a tracker

*Point a workstream at Linear, Jira or anything else with an MCP server, and labeled issues become real work*

Weaver has no Linear integration. It has something better: a workstream can read
the outside world through the MCP servers you already use, and open new
workstreams for what it finds. Point one at your Linear backlog and every issue
you label becomes a workstream of its own — with its own direction, execution policy and
lifetime, reporting back to the issue when it has something to say.

Nothing here is Linear-specific. If you have an MCP server for Jira, Google
Sheets or Drive, the same three steps work with a different objective.

## Setup

**1. Make sure the MCP server is registered where Weaver ticks.** A coordinator
resolves MCP servers from the working directory of the process running the tick,
exactly as your own Claude Code sessions do:

```bash
claude mcp list          # from the directory your runner or routine ticks in
```

**2. Create the intake workstream.** Its objective is the whole integration:

```bash
weaver create \
  --slug linear-intake \
  --title "Linear intake" \
  --objective "On each wake, list Linear issues carrying the 'weaver' label. For each one that does not already have a workstream, create_workstream with source_key 'linear:<issue uuid>', an objective built from the issue title and description, and a constraint telling it to post progress and the outcome back to that issue. Then schedule_wake in 15m." \
  --tag intake
```

**3. Tick it**, by hand or from the same routine that drives everything else:

```bash
weaver tick linear-intake
```

## What happens

The intake stream reads Linear on each wake and spawns a workstream per labeled
issue. Each spawned workstream reads its **own** issue directly on every pass —
so a teammate's comment is picked up without anything relaying it — and posts
back through the normal approval gate.

Reading Linear is ordinary work: a workstream dispatches a worker that reads the
issue — including opening any screenshots on it — and reports back. Changing
anything in Linear is not. Posting a comment or moving an issue to Done is a
real-world action: it waits for your approval, a worker performs it, and it
counts as done only once Weaver reads Linear back and confirms it landed.

## It cannot open the same work twice

Watching means seeing the same issue over and over. Each spawned workstream
stores the identity of the issue it stands for, and spawning is refused for an
issue that already has one — so re-reading the backlog every fifteen minutes
creates nothing, and a pass that dies halfway through a batch simply resumes.
It is not the model remembering; it is a check that runs before anything is
created.

Creating a workstream by hand for an issue that intake also watches is safe for
the same reason — pass `weaver create --source-key linear:<issue uuid>` and
intake will find it rather than duplicate it.

## Limits worth knowing

An intake pass opens at most ten workstreams; the rest come on the next wake.
The label, cadence and what gets posted back all live in the intake
workstream's objective and constraints, so changing any of them is
`weaver steer linear-intake` — not a config file, and not a redeploy.
