# Weaver

**A durable execution layer that gives real-world agent work what code always had: history, review, and verified outcomes.**

Agent harnesses already run models for hours. Memory features already carry facts between sessions. Weaver is about the part nobody has: when an agent system works on something for weeks — a hiring pipeline, a growth experiment, a standing Sentry-triage routine — *where is the record of why the current course exists, what was actually done to the world, and what made the system better than it was last month?*

For code, that layer has existed for decades: git history holds accepted work, PRs hold review, CI holds verified outcomes, and the repo outlives every editor session. For everything else agents do — outreach, operations, research, recurring business routines — there is nothing. Every "agent product" collapses into one immortal chat that degrades until someone starts over.

Weaver is that missing layer, built standalone on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk):

> **A Workstream is the durable organizational execution — direction, work, deliverables, interactions, results. Coordinator runs and workers are disposable: they enter, advance bounded work, publish results, and leave.**

## What's actually new here

Not the agent loop (the SDK provides it), not scheduling, not "long-running agents". Three things:

### 1. A decision log with lineage — git history for work that doesn't live in git

Every course change is a typed **decision**: what became authoritative, why, superseding what. A fresh coordinator — days later, possibly a different model — receives standing decisions from state and *cannot silently reverse one*; supersession is explicit and keeps both sides. The returning human reads **now / since-you-left / needs-me / next / why** without opening a transcript, and "why" is a real lineage, not a summary's guess. (It turns out this helps even for work that *does* live in git: the code shows what changed; the decision log shows why the tenth approach was chosen over the nine that were corrected away.)

### 2. Verified outcomes — the system cannot grade its own homework

A worker finishing is not the work being done. Adoption is a separate act that pins an immutable content hash. Real-world **actions** (open a PR, run a deploy, call an API) are gated on human approval, and count as done only when a deterministic **readback** — a shell command the engine runs, no model involved — confirms the effect in the outside world. A crashed action is never blindly re-run; the world is re-inspected instead. Self-reported success is structurally worthless here, which is exactly what makes the history trustworthy enough to build on.

### 3. Improvement you can audit — corrections become policies that earn their place

When a human corrects the course, the correction is distilled into a **policy**: plain language, typed scope, full provenance. New policies run in *shadow*; they're promoted to *active* only by evidence — a later matching workstream applied them and needed no correction on the same point. Wrong policies are superseded with lineage, like decisions. The reward being optimized is **human interventions per successful outcome** (tracked on every workstream), and a closed effect vocabulary guarantees a policy can add verification or narrow authority but can never spend, send, merge, or widen access. This is "improves over time" as a measurable, inspectable claim — not a memory feature's marketing copy.

## The shape

- **Durable**: one typed document per workstream (revision-checked writes, single-flight lease) + content-addressed artifacts. The projection every coordinator pass receives is assembled from this state — never from a transcript, never from a summary that could quietly become truth.
- **Disposable**: every coordinator pass and worker run is a fresh SDK `query()` that exits. Nothing survives a wait except stored data; wakes (time, completions, replies, human steering) are rows, not sleeping processes.
- **Human contract**: a **needs-you queue** of judgment calls — approve/reject an action with the exact commands visible, resolve a verdict, steer with a sentence. Everything mechanical stays out of it, and every intervention is counted, because driving that count down per outcome *is* the product.

## Running it

```bash
yarn install
yarn weaver create --slug my-stream --title "..." --objective "..." [--tag routine]
yarn weaver steer my-stream "context, repo paths, what done looks like"
yarn weaver run                # resident runner: ticks every active workstream (10 in parallel)
yarn weaver watch              # interactive dashboard: the needs-you queue + fleet at a glance
```

- **Routines**: tag a workstream `routine` and have it schedule its own next wake — a standing loop (Sentry sweep, evals health, usage reports) that, unlike cron'd prompts, wakes with its decision log, constraints, and learned policies intact. Run #30 is smarter than run #1.
- **Secrets**: `echo VALUE | yarn weaver secret set NAME [--ws slug]`. Models only ever see *names*; the engine injects values into approved action shells and scrubs them from everything captured back. The store refuses any write that embeds a known secret value.
- **Operator access**: approved action workers inherit the MCP servers you've registered for the directories they touch, plus your real CLIs — they act as you, on your machine, inside the approval gate. Research workers stay isolated and side-effect-free.
- Auth rides the local Claude Code subscription login; API keys are stripped from every spawned process. Cost figures are SDK-reported estimates, used only as a runaway backstop.

## Docs

- [docs/harness.md](./docs/harness.md) — where each kernel invariant lives in code
- [docs/learning.md](./docs/learning.md) — the learning loop, and why it's deliberately shaped as an RL substrate
- [CLAUDE.md](./CLAUDE.md) — the kernel rules and working agreements

## Provenance

Weaver is the fast falsification vehicle for the Workstream thesis being built properly inside [erdo](https://erdo.ai) (erdoai/erdo#1812). It holds none of erdo's internals and never grows into a second platform; findings flow back as plan changes. The longitudinal acceptance proof has passed with real model runs (see [demo/TRANSCRIPT.md](./demo/TRANSCRIPT.md)); durability and authority rails are covered by a deterministic test suite (`yarn test`, no model calls) — model quality can never make a durability test pass.
