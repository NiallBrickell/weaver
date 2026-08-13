# Giving it work

*The shapes of work a workstream can hold, and the arc every workstream follows from objective to verified effect*

A workstream is any bounded outcome you would otherwise have to supervise: something with a nameable "done", a reason to exist for longer than one sitting, and judgment calls along the way that are worth recording. If you can say what done looks like and what must stay under your control, Weaver can carry it.

Give Weaver the thing you want to become true, not merely the first work product. "Investigate why uploads stall" can end with a report. "Fix the upload failure" carries the same investigation through a code change, review, merge, tests, and evidence that the fix worked. Weaver is useful precisely where the outcome crosses those boundaries or has to wait before the next piece of work can begin.

## The one-sentence way

Most workstreams should start as a sentence, not a form:

```bash
weaver do "The EDP nightly syncs keep silently stalling — figure out why and make failures loud."
```

Everything a `create` invocation would ask for is derived from the message — slug, title, an expanded brief that preserves every concrete detail you gave, checkable done-criteria — and your standing house constraints are applied automatically. Phrasing that implies recurrence ("every week, clean up…") makes it a routine with a self-scheduling cadence. The sections below exist for when you want to hand-set any of that.

The house pack is machine-local config, not source: put a `house.json` under `WEAVER_HOME` (default `./state`) to set the standing `constraints` every onboarded workstream carries, a free-text `repoMap` describing this machine's repos so a one-liner that only implies its repo still derives a brief that names it, and the default policy-scoping `tags`. A missing or malformed file falls back to conservative defaults and never blocks onboarding:

```json
{
  "constraints": ["Open pull requests only — merging is the founder's act"],
  "repoMap": "Known repos under ~/work:\n- shop — the storefront (Next.js). Default guess for product features.\n- shop-api — the backend.",
  "tags": ["myapp"]
}
```

An optional second argument overrides the done-bar when the default (fixed, merged through review, evidence in the PR) isn't what you mean — `weaver do "<message>" "verified live in the product afterwards, read-only"`. Production is never touched during verification unless that second sentence explicitly asks, and then only read-only.

For anything longer than a sentence, run **`weaver do` with no arguments**: it prompts for the message and reads it raw from stdin — type or paste freely across lines, finish with Ctrl-D (or a line containing only `.`). This is the safe path for real messages, because a shell-quoted argument is parsed by the shell first: `$36.69` inside double quotes becomes `.69`, an embedded quote ends the argument. Stdin has no such grammar — what you paste is what the brief preserves. Either way, derivation is one model pass (20–60s) with a progress spinner, so thinking never looks like a hang.

Intake is the CLI's default action, so `weaver "…"` (and bare `weaver`, which drops into the same stdin prompt) is shorthand for `weaver do`. That makes a one-letter alias comfortable — `alias w=weaver` gives you `w` to capture, `w watch` to watch, and `w steer <slug> "<msg>"` to redirect, all dispatching to the real subcommand. Alias `w` to `weaver`, not `weaver do`: the latter swallows every subcommand as a message, so `w steer …` would silently onboard a *new* workstream instead of steering the one you named. (Weaver guards against that mistake — a management command that reaches intake with a real slug is redispatched, never onboarded — but the plain `weaver` alias avoids the ambiguity entirely.)

## Four shapes

### Build something

A feature, a migration, a redesign — work whose deliverable is a diff. The objective names the outcome and the evidence; the constraints name what stays yours.

```bash
weaver create --slug lead-follow-up \
  --title "Follow up with new leads by email" \
  --objective "When a lead submits the form, send a follow-up email with a scheduling link. Design it, build it, open a PR with before/after evidence." \
  --constraint "Repository work happens in a fresh worktree; opening, merging, and deploying remain gated actions" \
  --constraint "Open pull requests only — merging is the founder's act"
```

The coordinator researches the current code first, records the chosen design, then keeps the feature moving through implementation, review and revision, merge when authorized, the required tests, and any agreed post-change check. It concludes only when the done-bar is met. Weeks later, "why is it built this way?" still has an answer rather than a guess.

Orchestration is sized to the ask. A feature like the one above earns phases; a small, scoped job — fix the review comments on one PR, bump a dependency, one clear bug with a known site — runs as a single worker briefed end-to-end: investigate, change, and test in the same run, with the push as its gated follow-up. A separate research pass has to be justified by unknowns that would change what gets dispatched, so quick jobs stay quick while the record they leave behind is the same.

### Keep something healthy

Standing loops: an error-triage sweep, an evals-health check, a weekly usage report. Tag the workstream `routine` and it schedules its own next wake after each cycle — waking with its decision log, constraints, and learned policies intact, so run #30 surfaces only what run #30 genuinely can't settle alone. See [Routines](./routines.md).

### Find something out

An audit, a subsystem map, a root-cause investigation. If the objective is to fix something, investigation is one stage and the same workstream continues into the change and its verification. If the report itself is the outcome, the coordinator verifies it against the acceptance criteria and pins the accepted version so the result cannot silently change later.

### Run a real-world process

A hiring pipeline, a growth experiment, an outreach sequence — work where the world talks back. Drafts are work products; sending is a separate, gated act with authority revalidated at egress; a reply is untrusted input that can wake the workstream and supply evidence but can never grant authority or complete work by itself. This is the shape where durability earns its keep: the process runs for weeks, people reply on their own schedule, and every coordinator that picks it up knows exactly which candidate was rejected, when, and why.

## The arc every workstream follows

Whatever the shape, Weaver keeps responsibility while the outcome moves through the same stages:

1. **Understand the next piece** (`WORKING`). A fresh regular Code worker investigates the bounded assignment and submits what it found.
2. **Do and review it.** The coordinator checks the submission against its acceptance criteria, accepts or rejects it, records the chosen course, and dispatches the next bounded assignment. One worker finishing does not hand the outcome back to you.
3. **Change the world through Pilot.** Only *irreversible* egress — merging or deploying a pull request, spending, or sending a message to a person — is a separate action; using the operator's MCP servers read and write to keep a tracker in sync is ordinary work, no gate. [Pilot](https://github.com/NiallBrickell/pilot) approves routine-safe commands inside the live run; anything with real blast radius arrives on your [needs-you queue](./dashboard.md). Your constraints remain hard ceilings.
4. **Confirm the effect.** A deterministic check, run with no model in the loop, verifies what actually happened outside Weaver. A model saying "done" is not evidence. See [Actions](./actions.md).
5. **Wait and resume** (`WAITING`). The workstream records what it is waiting for — a reply, a scheduled wake, your verdict — and everything exits. A fresh coordinator resumes from that position when the wake condition arrives.
6. **Finish only at the done-bar.** Weaver closes the workstream when the whole outcome is evidenced, not when an agent produced the first plausible work product.

The done-bar also makes improvement measurable: across comparable workstreams, Weaver should reach the evidenced outcome with fewer avoidable human interventions — not by stopping earlier, weakening verification, or taking more authority.

## What a good objective looks like

The `create` command is the contract, and steering supplies the context:

- **Objective**: the outcome and its evidence, not the steps. "Find why signups stall at step 3, fix it, open a PR with before/after numbers" — not a task list.
- **Constraints**: the ceilings that are yours alone — what may never happen without you (merges, sends, spend), which paths are read-only, which tests must pass.
- **Steering**: the local knowledge a fresh coordinator needs — repo paths, where the dashboards live, what done looks like in your world. Steering is durable: it wakes the workstream, must be acknowledged, and a steering that *corrects* course becomes a candidate [policy](./learning.md) every future matching workstream inherits.
