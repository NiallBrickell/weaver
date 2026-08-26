# Weaver docs

Weaver manages an outcome across fresh agents, reviews, failures, approvals, and waits — coming back to you only for judgment or authority that genuinely needs you. These pages are plain GitHub-rendered markdown; start with the Introduction, then the Quickstart.

## Overview

- [Introduction](./introduction.md) — agents can do a task; Weaver manages the outcome until it is actually done
- [What's actually new](./whats-new.md) — the outcome survives every agent run, verified outcomes, improvement you can audit
- [How Weaver compares](./comparisons.md) — session managers, workflow engines, and memory layers persist different things; Weaver persists commitments

## Using Weaver

- [Quickstart](./quickstart.md) — name the outcome once and keep the work moving until the done-bar is met
- [Giving it work](./giving-it-work.md) — the shapes of work a workstream can hold, and the arc from objective to verified effect
- [Watching a tracker](./linear.md) — point a workstream at Linear, Jira, or anything with an MCP server, and labeled issues become real work
- [Connecting bots](./bots.md) — a fleet of disposable bots (any language) keep their durable memory in Weaver over `weaver serve`
- [Hosting Weaver](./hosting.md) — run the resident runner and the ingress adapter against one Postgres so a fleet lives somewhere, not just on a laptop
- [Hosting the team workspace on Railway](./railway.md) — shared Postgres + browser UI, with execution left on an honestly provisioned host
- [The dashboard](./dashboard.md) — the terminal controls and visual Workstream/Assignment board
- [Operator workspace](./operator-workspace.md) — create work, inspect one Workstream, and add follow-up from a browser
- [Printouts](./printouts.md) — an exact, copyable account since the last delivered printout
- [Does each outcome need you less often?](./stats.md) — recorded human interventions beside quality and authority signals
- [Routines](./routines.md) — standing loops that wake with their decision log, constraints, and learned policies intact
- [Pausing work](./pausing.md) — stop one workstream or the active fleet without losing its durable position
- [Secrets & access](./secrets-and-access.md) — models see names, shells get values, approved actions inherit your MCP servers and CLIs
- [GitHub access on a hosted runner](./github-app.md) — a dedicated App mints short-lived, repo-scoped credentials without putting a person's login on the VM
- [Configuration](./configuration.md) — machine-local settings (models, store, actions) in a `.env` file that only ever fills gaps
- [Claude capacity & billing](./claude-capacity.md) — keeping durable work moving through Claude usage limits without changing billing or identity
- [Execution safety](./execution-safety.md) — the rolling model-start guard that catches runaway churn and resumes automatically, without pretending SDK estimates are billing
- [Team seeds](./team-seeds.md) — share your guardrails with your team, never your trust or your transcripts
- [Hosted state](./hosted-state.md) — point `WEAVER_STORE` at SQLite or plain Postgres and the durable layer lives in one database
- [Managed Workstreams](./managed-workstreams.md) — a coordinator can delegate a genuinely separate outcome to its own Workstream, flat, not a tree

## Under the hood

- [The harness](./harness.md) — where each continuity invariant lives: durable typed state, disposable model runs
- [Where model loops run](./executors.md) — switch fresh coordinators and workers among local Claude, local Codex, pinned Pi/API, and OpenHands container substrates without changing the durable contract
- [Harness evaluations](./harness-evals.md) — comparing disposable agent runtimes through the same real assignment and adoption boundary
- [Actions](./actions.md) — how intentional external effects are gated, executed with normal tools, and confirmed by deterministic readback
- [The learning loop](./learning.md) — corrections become policies, policies earn trust with evidence, authority is never learnable
