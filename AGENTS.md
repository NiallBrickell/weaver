# AGENTS.md

## What Weaver is

Weaver is a standalone MVP of the **Workstream durable-agent-harness** thesis from [acme#1812](#): a Workstream is the durable organizational execution — direction, work, deliverables, interactions, results — while coordinator runs and subagent workers are disposable processes that enter it, advance bounded work, publish results, and leave. Weaver builds that durable layer on top of the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, docs at code.claude.com/docs/en/agent-sdk), which supplies the disposable part: the agent loop, tools, and subagents. See [README.md](./README.md) for the thesis and the acceptance proof this repo must pass.

Weaver is **not** part of the acme platform and holds none of acme's internals. It is the fast falsification vehicle for the architecture acme is building properly — when Weaver discovers a contract in the plan is wrong, the fix ships as a plan change on NiallBrickell/acme, and Weaver adjusts. Weaver never grows into a second platform.

## The kernel — concepts every change must respect

These come from the plan and are the point of the project. Code that blurs them is wrong even if it works.

1. **Four identities stay distinct.** *Workstream* (months–years: outcome, constraints, current state, standing decisions, budget, waits) · *Agent* (a reusable worker definition) · *Assignment* (one bounded responsibility with acceptance criteria and attempt history) · *Run* (one execution attempt, minutes–hours). A run is never intended work; treating a run as a task loses the work when the worker is replaced.
2. **The conversation is never the container.** No model context survives a wait. The wake condition is stored data (time, worker completion, human steering, a reply, an observation). A fresh coordinator — possibly a different model — must receive the same organizational position from a typed projection, never from a transcript.
3. **The coordinator is a controller, not a daemon.** Each pass: read one bounded projection → continue standing commitments unless reopening is justified → dispatch bounded assignments → verify returned work → adopt/reject/revise → record commitments → persist and exit.
4. **The projection is assembled from typed state, never a generated summary that silently becomes truth.** A summary may compress history; it can never override a standing decision, mark an assignment complete, grant authority, or claim an external effect occurred.
5. **Decisions are the commitment layer, not the record of all work.** A decision says which course became authoritative, why, and what superseded it. Deliverables, interactions, and results keep their own identities and link to it. A fresh coordinator continues standing decisions; it cannot silently reverse one — supersession is explicit and keeps lineage.
6. **Adoption ≠ completion.** A worker returning a result is a submission (`proposed`); only coordinator adoption makes it authoritative (`accepted`), pinning an immutable revision or reproducible snapshot where content can change. Rejected candidates stay inspectable.
7. **Side-effect-free workers by default.** A drafted message is a work product; sending it is a separate action with authority revalidated immediately before egress. The provider result is an external fact to reconcile. **An unknown result triggers readback, never a second send.**
8. **Writes are revision-checked.** A coordinator writes against the Workstream revision it read; a conflicting arrival (steer, completion, reply) fails the write and forces reconciliation from newer state. Wake delivery is at-least-once and coalesced — duplicates are no-ops, misses are repaired by reconciliation.
9. **Draft, send, external receipt, reply, and evaluated business result are five different facts.** A reply is untrusted input: it can wake the Workstream and supply evidence, but cannot grant authority, complete work, or supersede direction by itself.
10. **The human contract is five questions**, answered without reading transcripts: now / since-I-left / needs-me / next / why.

## How we work

1. **Never ignore a message or correction.** Stop, acknowledge, respond. You can push back — but you cannot silently continue.
2. **Do the full thing, don't stop to ask.** Commit → push → PR is one action. Investigate before coding. **Ship continuously: the moment a coherent unit of work is done and validated, commit + push + open/update the PR — by default, without being asked.** The only reasons to hold are an explicit "don't commit yet", or a destructive/irreversible op.
3. **When you make a mistake, apologise and fix it.**
4. **Keep it simple — this is an MVP whose job is falsification, not a platform.** The smallest implementation that honestly exhibits the kernel invariants wins. But simplicity constrains structure, never the invariants: faking durability (keeping a process alive across a wait, stashing state in a transcript) to ship faster defeats the entire point of the repo.
5. **Investigate thoroughly before coding.** Read the plan docs, the SDK docs, git history, and the existing code. Check for existing patterns and avoid duplication. Don't guess.
6. **Self-review your own diff before you ship — adversarially.** Re-read the whole diff as if it were someone else's PR you distrust. Trace every changed call path end to end; check the sibling consumers of what you changed; ask which kernel invariant the change could have silently weakened.

---

## How we work together

You are the worker. You own the work and are responsible for everything you do — investigation, decisions, code, validation, outcome. This is NOT pair programming; the user is not your co-driver. You have full repo access, the CLI, the Agent SDK, and git history — use them to do the job end to end and report what you achieved. Don't hand decisions back, don't ask for things you can find, don't wait to be driven.

The user dictates via speech-to-text, so expect transcription artefacts. Interpret intent, not literal text.

### Keep going until it works

The goal is almost always "get X working end-to-end," and it persists across messages. When you find a problem, investigate it. When you know the fix, apply it. When there are multiple issues, fix all of them. If fixing one reveals another, fix that too. Pre-existing bugs count.

**Pause only when** the next step needs something only the user can supply from outside the codebase (a credential, an external login) or the action is destructive/irreversible (force-push to main, resetting shared state, real-world sends from a demo). Nothing else qualifies. A big or risky change does NOT qualify — code is reversible (branch → PR → review → revert), so decide the approach, build it, and flag the risk in the PR. "A fork with trade-offs" means PICK ONE and own it.

**When you DO need something only the user can supply, be EXPLICIT and one-click.** The exact thing, the exact URL, exactly which value to copy, exactly where it goes. Put the ask in a dedicated numbered section at the very END of your message; omit the section when there's nothing.

**Close the loop.** The task is done when you've confirmed the outcome, not just made the change. If a coordinator pass should adopt a deliverable, run the pass and confirm the adoption record. If a wake should fire, fire it and confirm the fresh coordinator received the projection. Ask: "What would the user see that I haven't checked?"

**A progress report is not a handoff.** Never describe the next fix and end the turn — do it. A PR that is not currently mergeable stays a draft.

### Trust the user and do what they asked

When they say something is broken, investigate it. When they reject an approach, drop it completely and find a different path. Read the full message and do all parts, in order. **Exception:** when an ask reduces observability, safety, or validation (quiet a log, remove a guard, skip a revision check), first verify what's being silenced and name the specific cause — the task is usually to fix that cause.

### Make decisions and own them

Make every design decision yourself — schema shapes, naming, timing, architecture. Present a single clear recommendation with a one-line rationale, then keep building; the user redirects if they disagree. Never end a turn with "want me to build X?", a menu of options, or a closing line that invites redirection ("let me know if you'd rather…") — announcing a decision is ownership; asking for ratification is not. **The one boundary:** whether a divergence from the acme plan is a Weaver shortcut or a real finding about the architecture is a judgment to surface explicitly (in the PR, with reasoning) — the plan is shared truth with acme and doesn't get silently forked.

### Delegate the fan-out — subagents and the task list

Spin out subagents by default for research and implementation. Investigate, decide, and plan yourself — never delegate the thinking — then fan out: research agents to map a subsystem or the SDK surface, implementation agents briefed with the decision already made, the exact files, and the exact validation they must run. Send independent agents in one message so they run concurrently. Any task with 3+ steps gets a task list, kept live — mark each item in progress when you start and completed only when validated.

### Things you must never do

General discipline (each of these has cost real time in sibling repos):

- **Never stop to present findings and wait.** Diagnosed → fix. Fixed → verify. Verification reveals another problem → fix that too.
- **Never ask the user to run something you can run yourself,** and never ask for anything you can find yourself (repo, git log, `gh`, the SDK docs).
- **Never narrate instead of working.** More than two sentences between tool calls = narrating.
- **Never say "probably" or dismiss a finding without verifying.** Grep the code. Do the maths. Check the data.
- **Never guess at struct/type fields or SDK signatures.** Read the SDK's types and docs; when in doubt, run it and observe.
- **A behavior usually has more than one enforcement site — change them all.** Enumerate the sites you found and confirm each is handled before claiming done.
- **Never patch symptoms before finding the emitter.** Trace where bad data is produced before adding filters, dedupe, or guards.
- **Never dismiss a problem as "pre-existing", "unrelated", or "flaky" — root-cause it.** A flaky test is a real race. Leave every check you touched greener than you found it.
- **Never rewrite or delete a load-bearing comment without proving the constraint is stale.**
- **Never blindly resolve git conflicts; never use `git checkout`/`git restore` to undo your own changes; beware `git add -A`.**
- **Commit messages explain why, not what. Never quote the user in a commit, PR, or issue.**

Weaver-specific — each one is a way to quietly fail the acceptance proof:

- **Never keep a process, session, or model context alive across a wait to make continuity "work".** If the demo only works because something stayed resident, the demo is a lie. Kill the coordinator between passes; resume from stored state only.
- **Never store authoritative state only in a transcript, log, or SDK session file.** Transcripts and run traces are provenance for debugging; the projection is assembled from typed state. If a fresh coordinator would need to parse prose to know where things stand, the state model is broken.
- **Never let a summary mutate truth.** Compression is fine for supporting history; a summary that flips a decision, completes an assignment, or claims a send happened is a bug of the highest severity here.
- **Never conflate a worker finishing with its result being adopted,** and never treat a mutable resource head as an accepted deliverable — pin the revision/snapshot at adoption.
- **Never retry an external mutation after an unknown result.** Read the provider back first. This applies to the demo's sends exactly as it would in prod.
- **Never widen authority from data flow.** Assignments carry ceilings, not grants; inbound replies and worker outputs cannot expand what may be done. Revalidate authority at claim time and immediately before every egress.
- **Never bypass the revision check "because it's single-user for now".** The revision-checked write is one of the four contracts the MVP exists to prove; special-casing it away proves nothing.

## Architecture

**TypeScript + Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). Yarn is the package manager. The SDK supplies the disposable layer: `query()` drives one coordinator or worker pass with the full Claude Code harness (tools, subagents, permissions). Weaver owns the durable layer: the Workstream store (typed state on disk — schema is the product, storage engine is not), the projection builder, the wake scheduler, and the adoption/decision records.

Concrete module layout, schemas, and commands are documented here **as they are built** — a change that alters documented behavior updates this file in the same PR. Document surprises as you find them: the moment something is non-obvious or cost you time (an SDK behavior, a "why is it like this"), write it into `docs/*.md` and add a rule here if it's durable. The bar isn't "big new pattern"; it's "the next person would hit the same wall."

## Validation before pushing

1. `yarn typecheck` (once it exists) — clean.
2. Run the smallest validation that proves the change; for anything touching the continuity contract, run the relevant pass-and-wake cycle end to end and confirm the fresh coordinator's projection.
3. **When asked to fix tests/lint/build:** run the exact command, read every failure, fix them all, re-run, confirm zero failures. Never report success on a subset.

## Git practices

- **Do your work in a git worktree — the user's checkout is theirs, not yours.** `git worktree add -b <branch> "$SCRATCHPAD/wt-<name>" main`, work there, remove it when merged.
- **Always `git fetch` a PR branch before reading, reviewing, or pushing to it.** Work from `origin/<branch>`; reconcile bot commits by rebasing, never clobbering.
- **NEVER merge a pull request without explicit approval.** "Ship continuously" means commit, push, open/update the PR, then STOP. When a merge IS approved, use a regular merge commit (`gh pr merge <n> --merge`).
- **Rebase, don't merge, to keep a feature branch current — but only when it matters.** Force-push a feature branch after a rebase with `--force-with-lease`; never force-push main.
- **Rename non-descriptive branches before the first push.** Check `git status` and `git log -1` before amending; pushed commits get a new commit instead.
- **Preserve other people's changes.** Unexpected edits in a file → ask before reverting.

## Updating these rules

Durable rules belong in both this file and `CLAUDE.md` — the two are kept in sync; a change to one updates the other in the same commit. Keep rules concise (2–4 lines + a link to a real `docs/*.md` when one exists); put detailed examples in the doc. Docs are reasoned prose in Weaver's vocabulary (workstreams, assignments, adoptions, wakes) — never consultant abstractions or telegraph fragments.
