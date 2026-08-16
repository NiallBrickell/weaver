# What's actually new

*Agents do individual work; Weaver keeps the whole outcome moving until it is done*

An agent can produce an excellent patch, report, or draft. That still leaves someone responsible for turning it into an outcome: decide what happens next, carry context into the next piece of work, notice failures, wait for the outside world, chase review, and verify that done really happened. Usually that someone is you.

Pilot keeps an individual agent moving without returning every routine permission or premature stop to you. Weaver keeps the outcome moving after any one agent run ends. It is not another agent loop and it does not keep one agent alive forever; the Claude Agent SDK supplies fresh agents as the work needs them.

## 1. The outcome survives every agent run

The Workstream — not the session — owns the objective. Every course change is a typed **decision**: what became authoritative, why, superseding what. A fresh agent receives the current course, accepted work, open loops, and next commitment, so it continues the outcome instead of rediscovering the task.

For code work, a commit records what changed. The Workstream also knows why that approach won, which evidence from the codebase and outside systems supported it, whether the change survived review, whether it was merged and tested, and what still stands between the current state and done. For a hiring pipeline, the same record carries the work cleanly across drafts, approvals, outreach, replies, and screens.

## 2. Verified outcomes

The system cannot grade its own homework:

- A worker finishing is a **submission**, not completion. Adoption is a separate act that pins an immutable content hash.
- Real-world **actions** are gated: Pilot approves routine-safe commands under your standing rules, while anything beyond them needs you. An action counts as done only when a deterministic **readback** — a shell command the engine runs, no model involved — confirms the effect in the outside world.
- A crashed action is never blindly re-run. The world is re-inspected; re-reading is always safe, re-doing is not.

Self-reported success is structurally worthless here — which is exactly what makes the history trustworthy enough to build on.

## 3. Improvement you can audit

"Improves over time" is usually a memory feature plus marketing. Weaver makes it a measurable claim:

- A human correction is distilled into a **policy**: plain language, typed scope, full provenance back to the correction that created it.
- New policies run in **shadow**. Promotion to **active** is earned — a later matching workstream applied the policy and needed no correction on the same point. Wrong policies are superseded with lineage.
- Weaver's target is **human interventions per successful outcome**: how often a person had to step in for the same kind of completed result. Fewer interventions count as improvement only while verification remains strong and learning never widens authority. [See the evidence and its current limits](./stats.md).
- A closed effect vocabulary means a policy can add verification or narrow authority, but can never spend, send, merge, or widen access — however confident it becomes. Learning recommends; it never permits.

See [The learning loop](./learning.md) for the full mechanism and why it's deliberately shaped as an RL substrate.

## 4. Choose the model loop without changing the Workstream

Fresh coordinators and workers can run through local Claude, local Codex, the
pinned Pi API executor, or an OpenHands container while the durable Workstream
contract stays the same. Reviewed model routes are typed, versioned commitments:
the first Pi route sends text-only bounded code repair to Kimi K3 only when Pi
is already the configured substrate, and never changes the action executor.
[Where model loops run](./executors.md) documents the boundaries and setup.
