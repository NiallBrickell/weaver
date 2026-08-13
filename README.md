```
██╗    ██╗  ███████╗   █████╗   ██╗   ██╗  ███████╗  ██████╗
██║    ██║  ██╔════╝  ██╔══██╗  ██║   ██║  ██╔════╝  ██╔══██╗
██║ █╗ ██║  █████╗    ███████║  ██║   ██║  █████╗    ██████╔╝
██║███╗██║  ██╔══╝    ██╔══██║  ╚██╗ ██╔╝  ██╔══╝    ██╔══██╗
╚███╔███╔╝  ███████╗  ██║  ██║   ╚████╔╝   ███████╗  ██║  ██║
 ╚══╝╚══╝   ╚══════╝  ╚═╝  ╚═╝    ╚═══╝    ╚══════╝  ╚═╝  ╚═╝
▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚▞▚
```

# Weaver

**Agents can do a task. Weaver manages the outcome until it is actually done.**

Agents are already very good at individual pieces of work: investigate a bug, write a patch, draft a job description, analyse an incident. The trouble starts between those pieces. Research has to become a change; the change has to survive review, get merged, and be tested; a failed check needs another attempt; a candidate needs following up next week. The agent stops, the work comes back to you, and you become the person who remembers what happened and starts the next session.

Weaver handles what happens after and between those sessions. You give it the outcome; it keeps the work moving across fresh agents, reviews, failures, approvals, and waits, and comes back only for judgment or authority that genuinely needs you. A feature is not done because an agent wrote code. It is done when the change is reviewed, merged, tested, and shown to work — and Weaver stays with it until then. Weaver runs standalone; [Pilot](https://github.com/NiallBrickell/pilot) is an optional companion that auto-approves routine tool calls *inside* a live session so fewer of them interrupt you — without it, those approvals simply wait in your queue.

That promise has a simple test: over comparable completed outcomes, does Weaver need you less often without the work getting worse or its authority growing? [`weaver stats`](./docs-public/stats.md) shows the human touches, rejections, approvals, and learned policies behind that trend. The target is not more agent activity; it is good outcomes that need less supervision.

> ### ⚡ Quick start — one sentence is the whole interface
>
> ```bash
> weaver do "A user hit an upload bug yesterday — no progress bar, composer stuck on 'waiting for upload'. Dig in, check PostHog and Axiom, fix it."
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

When a human corrects the course, the correction is distilled into a **policy**: plain language, typed scope, full provenance. New policies run in *shadow*; they're promoted to *active* only by evidence — a later matching workstream applied them and needed no correction on the same point. Wrong policies are superseded with lineage, like decisions. Weaver keeps score with one question: for the same kind of successful outcome, how often did a person have to step in? Fewer interventions count as improvement only while verification stays at least as strong and learning never expands authority. [`weaver stats`](./docs-public/stats.md) makes the evidence and guardrails inspectable.

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

Every shape follows the same arc: understand the next piece → do and review it → act through Pilot when the outside world must change → confirm the effect → wait or start the next piece → finish only when the outcome's done-bar is met. The full walkthrough with example objectives is in [docs-public/giving-it-work.md](./docs-public/giving-it-work.md).

## Running it

```bash
yarn install
weaver create --slug my-stream --title "..." --objective "..." [--tag routine]
weaver steer my-stream "context, repo paths, what done looks like"
weaver run                # resident runner: ticks every active workstream (10 in parallel)
weaver pause [slug]       # pause one stream, or every stream active right now
weaver resume <slug>      # resume one paused stream
weaver watch              # interactive dashboard: the needs-you queue + fleet at a glance
weaver stats              # see whether comparable work is needing less of you
weaver printout [slug]    # catch up on one stream, or omit slug for the fleet
```

- **Printouts**: uppercase `P` in the interactive dashboard follows the selection (`W E A V E R` header = all workstreams + global policy activity), writes an immutable self-contained engineering document, and opens it in the browser; lowercase `p` remains pause. It is one narrow, long-form reading page: every selected workstream and its exact timeline appear directly in normal document flow, with nothing hidden behind cards or disclosure controls. The knowledge inspector (`i`) links to a Printouts hub containing every published window, and each page can copy its complete plain-text report with its button or uppercase `C`. Exact typed before/after sidecars preserve eventless and intermediate changes without bumping organizational revisions. Tool calls can show what a worker looked at, but only typed adoption and deterministic readback prove an external outcome. See [docs-public/printouts.md](./docs-public/printouts.md).
- **One fleet, many machines**: `WEAVER_STORE=postgres://…` points every machine at the same knowledge store (any plain Postgres — Supabase, Neon, RDS, self-hosted): the laptop CLI, the dashboard, and a remote runner then share the same decisions, learned policies, and needs-you queue. For a single machine, `WEAVER_STORE=sqlite:<path>` keeps the same transactional contract in one local file (Node's built-in `node:sqlite`, zero dependencies). The default remains local fs state under `./state`. See [docs-public/hosted-state.md](./docs-public/hosted-state.md).
- **Routines**: tag a workstream `routine` and have it schedule its own next wake — a standing loop (Sentry sweep, evals health, usage reports) that, unlike cron'd prompts, wakes with its decision log, constraints, and learned policies intact. Cycle 30 inherits the decisions and corrections from cycles 1–29.
- **Pausing**: `weaver pause <slug>` preserves one workstream's typed position while runner polls skip it; omit the slug to pause every stream active at that invocation. New workstreams still start active, and `weaver resume <slug>` resumes one. See [docs-public/pausing.md](./docs-public/pausing.md).
- **Secrets**: `echo VALUE | weaver secret set NAME [--ws slug]`. Models only ever see *names*; the engine injects values into approved action shells and scrubs them from everything captured back. The store refuses any write that embeds a known secret value.
- **Operator access**: every assignment is a regular Claude Code worker with Bash, file editing, web tools, and the operator's configured MCP servers used read AND write. A worker has exactly two lifecycles: `work` (bounded, reversible work that proposes a result) and `action` (one approved, Pilot-supervised, readback-verified irreversible egress). Keeping the systems a brief names in sync over those MCP servers — moving a tracker issue's status, commenting, labelling — is ordinary `work`, no approval or allow-list. Workers run with a 200-turn ceiling by default — generous enough for a clone-fix-test brief on a large repo, while the assignment budget and engine supervision bound real runaways; `WEAVER_WORKER_MAX_TURNS` overrides it. Weaver deliberately does not add a second shell parser or sandbox in this MVP; the environment that launches the worker owns containment. Capability still is not authority, and the line is consequence, not tool: irreversible egress — sending a message to a person, spending, or pushing/merging/deploying code — is directed through a typed action whose calls are Pilot-supervised and whose effect is accepted only after deterministic readback. Where that worker loop *runs* is a substrate choice behind the `WorkerExecutor` seam; the [harness bakeoff](./docs/harness-evals.md) measures alternative disposable runtimes without wiring them into production or treating a local container as a production sandbox.
- Auth rides one ambient operator principal from the local Claude Code login; exported API credentials and long-lived OAuth tokens are stripped from every spawned Agent SDK process, and Weaver never stores tokens, pools credentials, or cycles accounts. Capacity failures park only the affected model; the coordinator uses its configured fallback when available, and limited models retry at Claude's reset or after explicit `weaver capacity retry`. Weaver never changes billing, and cost figures are SDK-reported estimates used only as a runaway backstop. See [Claude capacity & billing](./docs-public/claude-capacity.md).

## Docs

- [docs-public/](./docs-public/README.md) — the user-facing docs index (plain GitHub markdown), from quickstart to the harness
- [docs/harness.md](./docs/harness.md) — where each kernel invariant lives in code
- [docs/harness-evals.md](./docs/harness-evals.md) — the harness bakeoff: candidate remote runtimes, the eval contract, and the promotion gates
- [docs/learning.md](./docs/learning.md) — the learning loop, and why it's deliberately shaped as an RL substrate
- [CLAUDE.md](./CLAUDE.md) — the kernel rules and working agreements

## Provenance

Weaver grew from a question about horizontal, longitudinal work: agents are good at one bounded task, so what carries an *outcome* across sessions, workers, failures, and weeks of waiting? The durable layer is the answer this repo defends, and the longitudinal acceptance proof has passed with real model runs (see [demo/TRANSCRIPT.md](./demo/TRANSCRIPT.md)). It is a working harness, not a thought experiment: the knowledge layer can live in any plain Postgres so one fleet spans machines, and execution is growing the same pluggable seam. Durability and authority rails are covered by a deterministic test suite (`yarn test`, no model calls) — model quality can never make a durability test pass.

## Related

- **[Pilot](https://github.com/NiallBrickell/pilot)** — an optional companion for the *inside* of a live agent session: auto-approves routine tool calls under your standing rules and escalates the rest, so a running session interrupts you less. Weaver works without it (gated actions just wait for you); together, Pilot narrows what reaches your queue mid-session and Weaver manages the outcome across sessions.

## License

[FSL-1.1-MIT](./LICENSE.md) (Fair Source): use, modify, and self-host freely, including commercially — just no competing product or service built from it. Each release becomes plain MIT two years after publication.
