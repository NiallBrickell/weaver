# Weaver docs

Weaver manages an outcome across fresh agents, reviews, failures, approvals, and waits — coming back to you only for judgment or authority that genuinely needs you. These pages are plain GitHub-rendered markdown; start with the Introduction, then the Quickstart.

## Overview

- [Introduction](./introduction.md) — agents can do a task; Weaver manages the outcome until it is actually done
- [What's actually new](./whats-new.md) — the outcome survives every agent run, verified outcomes, improvement you can audit

## Using Weaver

- [Quickstart](./quickstart.md) — name the outcome once and keep the work moving until the done-bar is met
- [Giving it work](./giving-it-work.md) — the shapes of work a workstream can hold, and the arc from objective to verified effect
- [Watching a tracker](./linear.md) — point a workstream at Linear, Jira, or anything with an MCP server, and labeled issues become real work
- [The dashboard](./dashboard.md) — every outcome, what changed, what needs your judgment, and whether it is actually done
- [Printouts](./printouts.md) — a copyable account of what happened since you last checked
- [Does each outcome need you less often?](./stats.md) — recorded human interventions beside quality and authority signals
- [Routines](./routines.md) — standing loops that wake with their decision log, constraints, and learned policies intact
- [Pausing work](./pausing.md) — stop one workstream or the active fleet without losing its durable position
- [Secrets & access](./secrets-and-access.md) — models see names, shells get values, approved actions inherit your MCP servers and CLIs
- [Claude capacity & billing](./claude-capacity.md) — keeping durable work moving through Claude usage limits without changing billing or identity
- [Team seeds](./team-seeds.md) — share your guardrails with your team, never your trust or your transcripts
- [Hosted state](./hosted-state.md) — point `WEAVER_STORE` at SQLite or plain Postgres and the durable layer lives in one database
- [Managed Workstreams](./managed-workstreams.md) — a coordinator can delegate a genuinely separate outcome to its own Workstream, flat, not a tree

## Under the hood

- [The harness](./harness.md) — where each continuity invariant lives: durable typed state, disposable model runs
- [Actions](./actions.md) — how intentional external effects are gated, executed with normal tools, and confirmed by deterministic readback
- [The learning loop](./learning.md) — corrections become policies, policies earn trust with evidence, authority is never learnable
