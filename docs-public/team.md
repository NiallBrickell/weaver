# Running Weaver as a team

*Any org shape you want — no personas, no rosters, no agent registry to maintain*

A common way to run coding agents is one manager delegating to leads or ICs, with specialists (a security reviewer, an implementer) doing the actual work. Harness-native versions of that shape (Claude Code teammates, for example) keep the whole org inside one vendor's sessions: when the session ends, the org ends, and no other harness can join it. Weaver holds the same org in **durable typed state** instead — so the shape survives every run, works across Claude, Codex, Pi, and OpenHands workers, and nobody is forced into personas or team-member records.

This page is the recipe book: the one modeling rule, the shapes it covers, and where "specialists" actually live.

## The one modeling rule

> **If it owns an ongoing outcome — may wait days, keep its own decisions, or delegate again — make it a Workstream. If it is one bounded responsibility, make it an Assignment. The process that executes it is a Run (an Attempt), and Runs are always disposable.**

Only Workstream links compose recursively: a Workstream can manage other Workstreams, and each manager sees exactly one hop down (its direct children's status, attention, and conclusions — never their reasoning, never their children). Assignments and Attempts never nest across Workstreams.

## Shape 1: manager → lead → IC

The classic pyramid is expressed with managed Workstreams for the org and Assignments for the work:

```text
Engineering-manager stream
└── project-lead stream (created by the manager's coordinator, or by you)
    ├── "implement the parser fix" Assignment → disposable worker Run
    ├── "security-review the diff" Assignment → disposable worker Run
    └── "write the migration runbook" Assignment → disposable worker Run
```

- **You** create the top stream (`weaver do "..."`, or `weaver create --under` to place it under an existing stream yourself).
- **The manager's coordinator** decomposes and either dispatches Assignments directly or creates child Workstreams (`create_workstream`) for genuinely separate outcomes — things with their own objective, their own waits, their own decision log.
- **A child that finishes** notifies its manager (a durable, deduplicated notice) and wakes it. The manager never sees the child's transcript — only the typed facts.
- **Depth is your choice**: a lead stream can itself create streams, so two, three, more levels all compose. But every edge is one hop: the top of the pyramid cannot reach past the lead, by design. If you need to know what a grandchild is doing, you look at the board — you, the human, see everything.

When *not* to use a child stream: splitting one bounded task, or "sub-tasking" inside one plan. If it doesn't need its own objective and waits, it's an Assignment.

## Shape 2: the enduring function

A standing Security function (or ops, or triage) is itself a Workstream — often a `routine`-tagged one that sweeps on a cadence. It holds the function's standing decisions and learned corrections across cycles, manages its own per-sweep children if the work is big, and reports up to whatever stream owns that area. The function's *memory* is the Workstream; the workers it dispatches each cycle are disposable.

## Where specialists live (and where they don't)

There is deliberately no `Agent` registry, no persona screen, no "add team member". A specialist is composed from durable pieces:

- **The shape of its work** is an Assignment: objective, briefing, acceptance criteria — and a typed execution profile (`bounded-code-repair`, `evidence-synthesis`, `ui-build`) when the capability is routable. The profile selects reviewed, eval-backed model routes; it never names a persona. See [Model routing](./model-routing.md).
- **How your team does that kind of work** is doctrine: your rules files, imported by `weaver backfill`, binding without evidence and outranking anything learned. Scope it with tags (`security`, `frontend`) so it reaches the right streams.
- **What it may never do** is unchanged by any of the above: reversible work needs no approval; irreversible egress (merging, deploying, messaging a person, spending) is always a gated `action` with Pilot supervision and deterministic readback. No template, policy, or persona can widen that.
- **Personas, where you already have them, stay where they already are**: workers load your project's agent instructions and subagent definitions (`settingSources`), so a `.claude/agents` security-reviewer keeps working *inside* Weaver assignments. Weaver just refuses to make it a durable identity that outlives runs.

If a future need emerges for define-once specialist definitions selected across unrelated workstreams and harnesses — with auditable revision attribution — that's a recorded acceptance trigger, not a default ([the consolidated plan](../docs/cross-harness-agent-organization-plan.md) holds the bar).

## Sharing judgment across the team

- **[Team seeds](./team-seeds.md)** export your guardrails (statements, scopes, effects — never transcripts, never authority). Imports land in shadow and earn active status on the importer's own evidence.
- **One fleet or many**: a team can share one hosted fleet (Postgres + [hosted UI](./hosting.md), one operator authority, everyone else creating work and reading the board), or each run their own fleet and share seeds. What Weaver won't grow is multi-tenant authority — that's the platform boundary, and it's deliberate.

## The board is the team's view

The [dashboard](./dashboard.md) shows outcomes, not agent sessions: what's moving, what waits, what needs a human, nested one readable level under its manager. Manager/child links, acceptance criteria, attempts, and archives are all on the Workstream page — typed state, not a social feed.
