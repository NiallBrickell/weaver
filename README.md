# Weaver

**Weaver is an MVP of the Workstream durable-agent-harness thesis, built standalone on the Claude Agent SDK.**

The thesis (from [erdo#1812](https://github.com/erdoai/erdo/pull/1812)): coding agents only *appear* continuous because a durable harness surrounds a disposable model — the repo holds current truth, git holds accepted history, issues hold intended work, tests judge results. Real-world work (choosing an audience segment, launching a landing page, running outreach, reading the results weeks later) has no such harness, so every "agent product" for it collapses into one immortal chat that degrades and dies. Weaver builds the harness:

> **A Workstream is the durable organizational execution. Coordinator runs and subagent workers are disposable — they enter it, advance bounded work, publish results, and leave.**

## What Weaver must prove

One scenario, lifted from the plan's acceptance proof, that no session-scoped harness (Claude Code, Codex, a resumed chat) can do today:

1. A human creates a Workstream with an outcome, constraints, and budget.
2. Coordinator A records a strategy decision (e.g. which customer segment to target), dispatches research / build / outreach-draft assignments to isolated workers, and **exits**. No process stays alive.
3. Workers return work products; a draft waits for review; a wake condition is stored data (time, completion, a reply arriving).
4. Days later, completions and a human reply wake Coordinator B — a **fresh context, potentially a different model** — which receives the standing decision, active assignments, and candidate deliverables from typed state, not from a transcript. It adopts one deliverable, rejects another, and both lineages survive.
5. Sending is a separate, authority-checked action from drafting; a crash after send triggers readback, never a re-send.
6. A recipient reply and result observations wake Coordinator C, which evaluates against the objective and either continues the course or records a superseding decision.
7. The returning human sees **now / since-you-left / needs-you / next / why** without opening any agent transcript.

The proof fails if continuity ever depends on resuming a chat, keeping workers alive, parsing free-form logs, or trusting an unverified worker result as current state.

## Why this repo exists (and why it's separate from erdo)

Erdo is implementing this properly across `backend/workstream`, `backend/agent`, and `backend/job` — a months-long program. Weaver is the fast falsification vehicle: the smallest harness that exhibits the continuity contract, on top of the Claude Agent SDK's existing agent loop, so we can (a) prove the kernel works before erdo finishes the full build, (b) find where the plan's contracts are wrong while they're still cheap to change, and (c) have a crisp demo of *why we're different from everyone else with an agent harness* — the durable layer, not the loop, is the product.

Weaver holds none of erdo's internals and never grows into a second platform. Learnings flow back as plans/PRs on [erdoai/erdo](https://github.com/erdoai/erdo).

## Source material

- [erdo#1812 — Plan: make Workstream the durable multi-agent harness](https://github.com/erdoai/erdo/pull/1812) (`plans/proposed/workstream-durable-agent-harness.md`)
- [erdo plans/proposed/decision-lineage.md](https://github.com/erdoai/erdo/pull/1812/files) — decisions as the commitment/supersession layer
- [Claude Agent SDK docs](https://code.claude.com/docs/en/agent-sdk) — the disposable coordinator/worker loop we build on
- [Anthropic: effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

## Status

Scaffolding. See [CLAUDE.md](./CLAUDE.md) / [AGENTS.md](./AGENTS.md) for the working rules and the kernel invariants; architecture is documented there as it's built.
