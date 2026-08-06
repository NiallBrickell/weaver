# Weaver

**Agents can do a task. Weaver manages the outcome until it is actually done.**

Agents are already very good at individual pieces of work: investigate a bug, write a patch, draft a job description, analyse an incident. The trouble starts between those pieces. Research has to become a change; the change has to survive review, get merged, and be tested; a failed check needs another attempt; a candidate needs following up next week. The agent stops, the work comes back to you, and you become the person who remembers what happened and starts the next session.

[Pilot](https://github.com/erdoai/pilot) stops a live agent session coming back to you for routine approvals or because it gave up too early. Weaver handles what happens after and between those sessions. You give it the outcome; it keeps the work moving across fresh agents, reviews, failures, approvals, and waits, and comes back only for judgment or authority that genuinely needs you. A feature is not done because an agent wrote code. It is done when the change is reviewed, merged, tested, and shown to work — and Weaver stays with it until then.

That promise has a simple test: over comparable completed outcomes, does Weaver need you less often without the work getting worse or its authority growing? [`weaver stats`](./docs-public/stats.mdx) shows the human touches, rejections, approvals, and learned policies behind that trend. The target is not more agent activity; it is good outcomes that need less supervision.

> ### ⚡ Quick start — one sentence is the whole interface
>
> ```bash
> weaver do "Jeremy hit an upload bug yesterday — no progress bar, composer stuck on 'waiting for upload'. Dig in, check PostHog and Axiom, fix it."
> ```
>
> That's it. You named the outcome, not a prompt for one agent. Weaver derives the slug, title, brief, and success criteria (recurring phrasing like "every week…" makes it a routine automatically), then keeps crossing the boundaries between research, implementation, review, verification, and waiting until the done-bar is met. The house constraints — isolated worktrees, review loop, self-merge bar, credential discipline — are applied without being asked for. Workers set up their own environments; nothing about worktrees, branches, or env files is yours to think about. Watch it on the dashboard (`weaver watch`), press uppercase `P` for a copyable account of everything since your last printout, redirect it anytime (`weaver steer <slug> "…"`), and it only interrupts you for genuine judgment calls. `weaver create` remains for when you want to hand-set every field.
>
> When the default done-bar (fixed, merged through review, evidence in the PR) isn't what you mean, say what is — as an optional second sentence:
>
> ```bash
> weaver do "The onboarding banner renders behind the nav on mobile" \
>           "fixed, merged, AND verified read-only in the live product with a browser afterwards"
> ```
>
> Verification never touches production unless you ask for it like this — and even then, read-only.
>
> For anything longer than a sentence, run `weaver do` with **no arguments** and type or paste a multiline message (finish with Ctrl-D) — raw stdin, so `$`, quotes, and newlines survive exactly as written, with a progress spinner while the brief is derived.

Weaver is built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), which supplies the agents that enter the work, advance it, and leave:

> **A Workstream is the outcome and everything required to finish it: direction, work, decisions, evidence, interactions, and results. Individual agent runs come and go; the Workstream keeps going.**

## What's actually new here

Not another agent loop (the SDK provides that), and not one agent kept alive forever. Weaver adds three things that let fresh agents manage one outcome across time:

### 1. The outcome survives every agent run

Every course change is a typed **decision**: what became authoritative, why, superseding what. A fresh agent — days later, possibly a different model — receives the current course, accepted work, open loops, and next commitment without needing the old conversation. It continues the outcome instead of rediscovering the task. For code work, the diff shows what changed; the Workstream also knows why that approach won, which external evidence supported it, whether it has been merged and tested, and what still stands between the current state and done.

### 2. Verified outcomes — the system cannot grade its own homework

A worker finishing is not the work being done. Adoption is a separate act that pins an immutable content hash. Real-world **actions** (open a PR, run a deploy, call an API) are gated: Pilot approves routine-safe commands under your standing rules, while anything beyond them needs you. An action counts as done only when a deterministic **readback** — a shell command the engine runs, no model involved — confirms the effect in the outside world. A crashed action is never blindly re-run; the world is re-inspected instead. Self-reported success is structurally worthless here, which is exactly what makes the history trustworthy enough to build on.

### 3. Improvement you can audit — corrections become policies that earn their place

When a human corrects the course, the correction is distilled into a **policy**: plain language, typed scope, full provenance. New policies run in *shadow*; they're promoted to *active* only by evidence — a later matching workstream applied them and needed no correction on the same point. Wrong policies are superseded with lineage, like decisions. Weaver keeps score with one question: for the same kind of successful outcome, how often did a person have to step in? Fewer interventions count as improvement only while verification stays at least as strong and learning never expands authority. [`weaver stats`](./docs-public/stats.mdx) makes the evidence and guardrails inspectable.

## How it holds onto the outcome

- **The outcome has a home**: one structured record keeps the objective, constraints, decisions, accepted work, evidence, open loops, and waits together. A transcript or generated summary can never quietly rewrite what is true.
- **Agents can come and go**: every coordinator pass and worker run starts fresh and exits. When a reply arrives next week or a check fails tomorrow, the next agent gets the same organizational position rather than asking you to reconstruct it.
- **Routine continuation stays with Weaver**: a worker result is reviewed, an external action is confirmed, and the next piece of work is started without becoming your project-management task. The **needs-you queue** is reserved for authority, judgment, and blockers only you can resolve.

## What you give it

A workstream is any bounded outcome that spans several tasks, stages, people, or waits — something with a nameable "done" that you would otherwise have to keep supervising. Four shapes cover most of it:

- **Build something** — a feature or migration: research the code, choose an approach, implement it, get it through review, merge when authorized, run the required tests, and confirm the result.
- **Keep something healthy** — standing routines (error triage, evals health, usage reports) that schedule their own next wake and return with their decision log and learned policies intact.
- **Find something out** — audits and investigations whose deliverable is an adopted, hash-pinned report; its standing decisions become the seed context for the build workstream that follows.
- **Run a real-world process** — hiring, growth experiments, outreach: drafts are work products, sends are gated with authority revalidated at egress, and replies wake the workstream without ever granting authority.

Every shape follows the same arc: understand the next piece → do and review it → act through Pilot when the outside world must change → confirm the effect → wait or start the next piece → finish only when the outcome's done-bar is met. The full walkthrough with example objectives is in [docs-public/giving-it-work.mdx](./docs-public/giving-it-work.mdx).

## Running it

```bash
yarn install
weaver create --slug my-stream --title "..." --objective "..." [--tag routine]
weaver steer my-stream "context, repo paths, what done looks like"
weaver run                # resident runner: ticks every active workstream (10 in parallel)
weaver watch              # interactive dashboard: the needs-you queue + fleet at a glance
weaver stats              # see whether comparable work is needing less of you
weaver printout [slug]    # catch up on one stream, or omit slug for the fleet
```

- **Printouts**: uppercase `P` in the interactive dashboard follows the selection (`W E A V E R` header = all workstreams + global policy activity), writes an immutable self-contained HTML catch-up, and opens it in the browser; lowercase `p` remains pause. The knowledge inspector (`i`) links to a Printouts hub containing every published window, and each page can copy its complete plain-text report with its button or uppercase `C`. Exact typed before/after sidecars preserve eventless and intermediate changes without bumping organizational revisions. Tool calls can show what a worker looked at, but only typed adoption and deterministic readback prove an external outcome. See [docs-public/printouts.mdx](./docs-public/printouts.mdx).
- **Routines**: tag a workstream `routine` and have it schedule its own next wake — a standing loop (Sentry sweep, evals health, usage reports) that, unlike cron'd prompts, wakes with its decision log, constraints, and learned policies intact. Run #30 inherits the decisions and corrections from runs 1–29.
- **Secrets**: `echo VALUE | weaver secret set NAME [--ws slug]`. Models only ever see *names*; the engine injects values into approved action shells and scrubs them from everything captured back. The store refuses any write that embeds a known secret value.
- **Operator access**: workers inherit the MCP servers you've registered for the directories they touch. Approved action workers get the full surface plus your real CLIs — they act as you, on your machine, with every call pilot-supervised. Research workers get the same servers behind a deterministic read-only gate — retrieval calls work, mutating calls are denied — plus a shell gated to history-reading commands (`git log`, `gh pr view`, …), because your commit messages and PR threads are where you recorded your thinking, and re-deriving a decision you already wrote down is the intervention Weaver exists to prevent. Querying and reading is research; changing anything is an action.
- Auth rides one ambient operator principal from the local Claude Code login; exported API credentials and long-lived OAuth tokens are stripped from every spawned Agent SDK process, and Weaver never stores tokens, pools credentials, or cycles accounts. Agent SDK work uses its separate monthly plan credit (plus operator-enabled usage credits with provider spend caps); capacity failures park work durably until a recovery probe succeeds. Cost figures are SDK-reported estimates, used only as a runaway backstop. See [Claude capacity & billing](./docs-public/claude-capacity.mdx).

## Docs

- [docs/harness.md](./docs/harness.md) — where each kernel invariant lives in code
- [docs/learning.md](./docs/learning.md) — the learning loop, and why it's deliberately shaped as an RL substrate
- [docs-public/stats.mdx](./docs-public/stats.mdx) — the outcome scoreboard and the limits of what it currently measures
- [CLAUDE.md](./CLAUDE.md) — the kernel rules and working agreements

## Provenance

Weaver is the fast falsification vehicle for the Workstream thesis being built properly inside [erdo](https://erdo.ai) (erdoai/erdo#1812). It holds none of erdo's internals and never grows into a second platform; findings flow back as plan changes. The longitudinal acceptance proof has passed with real model runs (see [demo/TRANSCRIPT.md](./demo/TRANSCRIPT.md)); durability and authority rails are covered by a deterministic test suite (`yarn test`, no model calls) — model quality can never make a durability test pass.
