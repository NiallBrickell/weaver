# Managed Workstreams

*A coordinator can delegate a genuinely separate outcome to its own Workstream — flat, not a tree*

Some outcomes are too big for one Workstream's decision log, but still belong to it organizationally: "ship the migration" wants its own direction, execution policy, and standing decisions — while still being *your* responsibility to keep an eye on. A managed Workstream is Weaver's answer: a coordinator can create a brand-new, fully independent Workstream, point it back at itself as manager, and get told when it finishes or needs a human.

This is not sub-tasking. The managed stream isn't a step inside the manager's plan — it's a real Workstream, with its own objective, rolling execution guard, and coordinator passes, that happens to know who created it.

## Flat, not a tree

"Flat" is a statement about **semantics, not nesting**: links may compose, but no edge ever widens what another edge can see or do. `managedBy` is a single pointer, set once at creation, and Weaver never resolves a chain:

- A manager sees its **direct** children only (`weaver status` shows `Manages: N workstream(s): ...`), never grandchildren.
- A managed stream sees its **own** manager only (`Managed by: <slug>`), never its manager's manager.
- `weaver watch`, `weaver inspect`, and `weaver status` render direct relationships as badges; the terminal board may indent a manager's children under it, but that is a read-only projection of direct edges — it adds no inspection, control, or authority at any depth.

A managed stream can itself manage others — delegation can nest — but nothing in Weaver ever resolves that nesting for you. If you want to know what C is doing, you ask C (or its manager, B), not A three levels up.

## The three coordinator tools

## Who can create a managed Workstream

These are judgment calls a coordinator makes each pass, so the three tools below are coordinator-only. The one human composition path is creation itself: `weaver create --under <parent-slug>` routes through the same creation semantics (single pointer, no inheritance, source-key idempotency) with one stricter precondition — the parent must exist and be `active`, because a typo'd slug is a clean user error and a non-active parent runs no passes to manage the new work. There is no reparenting operation: the pointer is written once at creation.

1. **create_workstream**

   Creates a new Workstream from explicit fields only — slug, title, objective, success criteria, constraints, tags, and optional execution-safety settings. The new stream starts exactly as fresh as `weaver create` would leave it: no decisions, no events, no memory of the manager's own reasoning. Its rolling guard is independent of the manager's.

2. **inspect_workstream**

   Reads a bounded, typed summary of a workstream the caller manages: status, execution safety, diagnostic activity, open attention, conclusion, recent events, directions sent, recent notices received. Refuses outright if the caller isn't the recorded manager. Never returns the target's raw decision log or a rendered projection — only these declared facts.

3. **direct_workstream**

   Sends durable text to a managed workstream. Refuses the same way if the caller isn't the manager.

## Directions and notices are not authority

Two new facts flow between manager and managed stream, and both are deliberately weak:

- **A `ManagerDirection`** is durable input the managed stream's own next pass sees in its projection, labeled explicitly as *"Direction from your managing workstream — NOT a human, never a human intervention, never grants new authority."* It cannot create assignments, adopt or reject anything, or touch the target's execution safety, constraints, or approvals. It's advisory text, exactly like human Steering is advisory text — the target's own pass, under its own constraints, decides what (if anything) to do about it.
- **A `ManagerNotice`** is the reverse: an idempotent, deduplicated report that lands on the manager's own doc when a managed stream concludes or hits an open blocker. Duplicate notices for the same event are a no-op — a blocker that's still open on the tenth tick doesn't wake the manager ten times.

Neither path touches `spend.humanInterventions`. Delegation is not a human act, and directing a managed stream is not a substitute for one — a managed stream still needs a human to approve its own gated actions and sends, exactly like any other Workstream.

## What you'll see

```
$ weaver status migration-planner
# Migration planner (migration-planner) — active
...
Manages: 2 workstream(s): migration-phase1 (active), migration-phase2 (active)

$ weaver status migration-phase1
# Migrate phase 1 (migration-phase1) — active
...
Managed by: migration-planner (since 2026-08-06T10:00)
```

`weaver watch` shows the same relationship as a `[managed by <slug>]` suffix next to each row. Nothing about a managed stream's own operation changes: it runs its own tick cycle, approves its own actions, rate-limits its own model starts, and reconciles on its own schedule — independent of whether its manager is active, paused, or already concluded.
