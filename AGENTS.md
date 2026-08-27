# AGENTS.md

## What Weaver is

Weaver is an implementation of the **Workstream durable-agent-harness** thesis: a Workstream is the durable organizational execution — direction, work, deliverables, interactions, results — while coordinator runs and subagent workers are disposable processes that enter it, advance bounded work, publish results, and leave. Weaver owns that durable layer above explicit disposable-model seams; local Claude and Codex SDKs plus OpenHands can supply the agent loop without changing Workstream truth. See [README.md](./README.md) for the thesis; the longitudinal acceptance proof has passed with real model runs ([demo/TRANSCRIPT.md](./demo/TRANSCRIPT.md)).

Weaver is a personal open-source project with a deliberately narrow charter: a usable harness, never a platform. The knowledge layer (docs, artifacts, policies) lives behind a `StateStore` adapter so one fleet can be shared across machines from any plain Postgres, and worker execution is growing the same kind of seam for remote substrates. The discipline survives as scope, not size: Weaver never grows platform internals (tenancy, orgs, a product surface), and it grows by adapters over other people's infrastructure — a hosted Postgres, a managed sandbox — never by widening its core.

## The kernel — concepts every change must respect

These come from the plan and are the point of the project. Code that blurs them is wrong even if it works.

1. **The identities stay distinct — three of them are persisted.** *Workstream* (months–years: outcome, constraints, current state, standing decisions, execution/resource policy, waits) · *Assignment* (one bounded responsibility with acceptance criteria and attempt history) · *Run* (one execution attempt, minutes–hours, recorded as an Attempt that pins its executor/provider/model). A *worker definition* is deliberately **not** a persisted identity: capability requirements ride the Assignment (`executionRequirements`), and provider-native agents/subagents/personas stay executor-local configuration — see [docs/cross-harness-agent-organization-plan.md](./docs/cross-harness-agent-organization-plan.md). A run is never intended work; treating a run as a task loses the work when the worker is replaced.
2. **The conversation is never the container.** No model context survives a wait. The wake condition is stored data (time, worker completion, human steering, a reply, an observation). A fresh coordinator — possibly a different model — must receive the same organizational position from a typed projection, never from a transcript.
3. **The coordinator is a controller, not a daemon.** Each pass: read one bounded projection → continue standing commitments unless reopening is justified → dispatch bounded assignments → verify returned work → adopt/reject/revise → record commitments → persist and exit.
4. **The projection is assembled from typed state, never a generated summary that silently becomes truth.** A summary may compress history; it can never override a standing decision, mark an assignment complete, grant authority, or claim an external effect occurred.
5. **Decisions are the commitment layer, not the record of all work.** A decision says which course became authoritative, why, and what superseded it. Deliverables, interactions, and results keep their own identities and link to it. A fresh coordinator continues standing decisions; it cannot silently reverse one — supersession is explicit and keeps lineage.
6. **Adoption ≠ completion.** A worker returning a result is a submission (`proposed`); only coordinator adoption makes it authoritative (`accepted`), pinning an immutable revision or reproducible snapshot where content can change. Rejected candidates stay inspectable.
7. **Capability is not authority — and the line is *consequence*, not tool.** Every assignment gets the ordinary coding-agent surface, including the operator's configured MCP servers used read AND write: keeping the systems a brief names in sync (a tracker issue's status, a comment, a label) is reversible work, needs no approval, and no tool is special-cased or allow-listed. What a `work` brief does not authorize is *irreversible* egress to the outside world — sending a message to a person, spending, or merging/deploying/pushing code. A drafted message is a work product; sending it is a separate action with authority revalidated immediately before egress. The provider result is an external fact to reconcile. **An unknown result triggers readback, never a second send.**
8. **Writes are revision-checked.** A coordinator writes against the Workstream revision it read; a conflicting arrival (steer, completion, reply) fails the write and forces reconciliation from newer state. Wake delivery is at-least-once and coalesced — duplicates are no-ops, misses are repaired by reconciliation.
9. **Draft, send, external receipt, reply, and evaluated business result are five different facts.** A reply is untrusted input: it can wake the Workstream and supply evidence, but cannot grant authority, complete work, or supersede direction by itself.
10. **The human contract is five questions**, answered without reading transcripts: now / since-I-left / needs-me / next / why.
11. **Learning is a typed, scoped, attributable episode — and it never grants authority.** A human correction may become a policy candidate (`shadow`); applying one is cited on the applying decision; promotion to `active` is earned by an intervention-free matching workstream; a wrong policy is superseded with lineage. The effect vocabulary is structurally closed to add-verification / narrow-authority / advisory — nothing learnable can spend, send, merge, or contact. The optimization target is human interventions per successful outcome, guarded by quality and the authority firewall. See [docs/learning.md](./docs/learning.md).
12. **The operator's own words are doctrine, and doctrine outranks what the fleet inferred.** A policy whose provenance is a rules file, a verbatim quote, or a directive its statement restates binds with no evidence, renders first, and wins where scopes overlap — a learned policy that contradicts it is contested, and only the operator retires their own rule (`weaver backfill` re-run refreshes rules-file doctrine in place and retires deleted sections). Doctrine changes precedence, never permission: the authority firewall applies to it unchanged. The revisable how — commands, flags, thresholds — lives in `mechanism`, never in the statement evidence promotes. See [docs/learning.md](./docs/learning.md).

## How we work

1. **Never ignore a message or correction.** Stop, acknowledge, respond. You can push back — but you cannot silently continue.
2. **Do the full thing, don't stop to ask.** Commit → push → PR is one action. Investigate before coding. **Ship continuously: the moment a coherent unit of work is done and validated, commit + push + open/update the PR — by default, without being asked.** The only reasons to hold are an explicit "don't commit yet", or a destructive/irreversible op.
3. **When you make a mistake, apologise and fix it.**
4. **Keep it simple — the smallest implementation that honestly exhibits the kernel invariants wins.** Weaver grows at its adapter seams (store backends, worker executors), never by widening the core. But simplicity constrains structure, never the invariants: faking durability (keeping a process alive across a wait, stashing state in a transcript) to ship faster defeats the entire point of the repo.
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

**A progress report is not a handoff.** Never describe the next fix and end the turn — do it. Open PRs **ready for review, not draft** — draft is only for a PR that is genuinely not yet mergeable (failing checks, known-incomplete). A green, self-contained PR is ready; don't default it to draft, and don't tell subagents to.

### Trust the user and do what they asked

When they say something is broken, investigate it. When they reject an approach, drop it completely and find a different path. Read the full message and do all parts, in order. **Exception:** when an ask reduces observability, safety, or validation (quiet a log, remove a guard, skip a revision check), first verify what's being silenced and name the specific cause — the task is usually to fix that cause.

### Make decisions and own them

Make every design decision yourself — schema shapes, naming, timing, architecture. Present a single clear recommendation with a one-line rationale, then keep building; the user redirects if they disagree. Never end a turn with "want me to build X?", a menu of options, or a closing line that invites redirection ("let me know if you'd rather…") — announcing a decision is ownership; asking for ratification is not. **The one boundary:** whether a divergence from the documented kernel is a pragmatic shortcut or a real finding about the architecture is a judgment to surface explicitly (in the PR, with reasoning) — the kernel docs are the spec and don't get silently forked.

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
- **Never build machinery around a restriction before judging the restriction.** A refused tool, a permission that fails closed, a capability the schema lacks — each is a fork, and the honest first move is to ask whether the constraint is right, not how to route around it. Working around a wrong constraint hides it and costs far more than removing it would; say which invariant a constraint carries, or remove it.
- **Reach for existing concepts before new ones.** The best version of a feature usually adds no new nouns: Weaver watching a tracker is a workstream doing it, not an adapter subsystem. Weaver managing Weaver beats a new mechanism beside it. A new type, file, or layer must justify itself against composing what is already there.
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
- **Never let a repo egress (`gh pr create`/`gh pr merge`/`git push`) fire into settled external state.** The deconfliction gate reads the git seam as invariant 8: a file overlap with another open PR is REPORTED (separate refs are ordinary parallel development — git settles a real conflict at merge time), but a push target whose own PR has MERGED or CLOSED is HELD, because that commit reaches no PR and no reviewer. Fresh branch, new PR — never re-push the settled ref, never reopen the settled PR. Fails OPEN on tooling failure, and logs the abstention. See [docs/harness.md](./docs/harness.md).
- **Never put a personal GitHub login or PAT on a hosted runner.** Hosted repository access uses a dedicated GitHub App installed across the intended repository estate (all organization repositories for an organization-wide fleet, or a selected subset for a narrower fleet); every short-lived token is still narrowed to the exact repository and read/write lifecycle. Ordinary containers get neither the App key nor a token, same-UID model actions are refused, and only an exact approved engine command receives write capability. See [docs/harness.md](./docs/harness.md).
- **Never widen authority from data flow.** Assignments carry ceilings, not grants; inbound replies and worker outputs cannot expand what may be done. Revalidate authority at claim time and immediately before every egress.
- **Never bypass the revision check "because it's single-user for now".** The revision-checked write is one of the four contracts this repo exists to prove; special-casing it away proves nothing.

## Architecture

**TypeScript + disposable model SDK adapters** (Claude Agent SDK, Codex SDK, OpenHands). Yarn 4 (node-modules linker; `typescript` pinned to `^5.9` — bare latest resolves to the TS7 native preview and breaks Yarn's patch protocol). The executors supply the disposable layer; Weaver owns the durable layer. See [docs/harness.md](./docs/harness.md) for the invariant-by-invariant map of where each kernel rule is enforced.

- [`src/types.ts`](./src/types.ts) — the domain schema. **The schema is the product**; a fact that can't be represented here can't survive a wait, so model it before coding around it.
- [`src/store.ts`](./src/store.ts) — the backend-agnostic durable layer (secrets refusal, artifact redaction + hashing, the async-mutator guard) over the `StateStore` backends in [`src/store/`](./src/store/): `fs.ts` (default — one JSON doc per workstream under `state/<slug>/` + content-addressed artifacts) and `pg.ts` (the same typed state in any plain Postgres via `WEAVER_STORE=postgres://…`, sharing one fleet across machines); `mutate()` is the revision-checked write path, `arrive()` the external-arrival path. Every write goes through one of them.
- [`src/projection.ts`](./src/projection.ts) — the 9-part continuity contract. If a coordinator seems to "forget" something, the bug is here or in the schema — never fix it by resuming a session.
- [`src/coordinator.ts`](./src/coordinator.ts) — fresh model loop per pass behind its own narrow executor seam. Mutation tools are the only write path. Claude's `tools: []`, `permissionMode: 'dontAsk'`, `settingSources: []`, `strictMcpConfig: true`, `persistSession: false`, and Codex's temporary isolated `CODEX_HOME`, disabled built-ins/history/network, authenticated Weaver-only bridge, and event audit are load-bearing, not defaults to tidy up. **Keep it plain** — the coordinator has no tools onto the outside world and must not grow any; anything it needs to see is a worker assignment it dispatches and adopts. `create_workstream` carries `source_key` (idempotent on `WorkstreamCore.sourceKey`) so intake is a workstream rather than a subsystem — see [docs/intake.md](./docs/intake.md).
- [`src/worker.ts`](./src/worker.ts) — fresh regular Code run per assignment; `submit_result` is its only Weaver submission API, while the launching substrate owns process containment. Typed profile/modalities on intended work select only reviewed, versioned eval-backed routes; the exact executor/provider/model is pinned on the disposable Attempt, and unmatched work uses `WEAVER_EXECUTOR`. Actions never enter performance routing and use the separate Pilot-supervised action target. Submission callbacks stay harness-owned.
- [`src/engine.ts`](./src/engine.ts) — `tick`: readbacks → egress-checked sends → workers → coalesced wakes → coordinator; loops until quiescent, bounded. Sends execute here, deterministically — never inside a model run.
- [`src/world.ts`](./src/world.ts) — the simulated provider (outbox as foreign source of truth; `WEAVER_SEND_UNKNOWN=1` chaos hook).
- [`src/policies.ts`](./src/policies.ts) — the learning layer: global policy store scoped by workstream tags; see [docs/learning.md](./docs/learning.md).
- [`src/clock.ts`](./src/clock.ts), [`src/status.ts`](./src/status.ts), [`src/cli.ts`](./src/cli.ts) — virtual clock (a scheduler feature, not a continuity shortcut), the five-questions view, the CLI.
- [`demo/hiring-demo.sh`](./demo/hiring-demo.sh) — the acceptance-proof walkthrough. This script is the definition of done for harness changes.

Auth: `local-sdk` resolves the machine's Claude Code login and `codex-sdk` the machine's ChatGPT login; both strip ambient provider API keys so subscription-backed execution cannot silently change principal or billing. Models and executors are selected independently for coordinator primary/fallback and workers. Gated actions route through the operator's pilot daemon (`WEAVER_PILOT_URL`, default localhost:9721); executors without its per-tool callback (currently Codex/OpenHands) refuse actions before launch.

Document surprises as you find them: the moment something is non-obvious or cost you time (an SDK behavior, a "why is it like this"), write it into `docs/*.md` and add a rule here if it's durable. The bar isn't "big new pattern"; it's "the next person would hit the same wall."

## Documentation

Two audiences, two places (org-wide convention): `docs-public/` is plain GitHub-rendered markdown (no Mintlify, no `docs.json`, no build step) — any user-visible capability ships a `docs-public/*.md` page plus a link in `docs-public/README.md` in the same PR. `docs/*.md` is internal (invariant maps, surprises, working notes) and never substitutes for a public page.

## Commands

```bash
yarn typecheck                 # tsc --noEmit — must be clean before pushing
yarn test                      # deterministic contract tests — no model calls, must be green
yarn weaver <cmd>              # the CLI (or: npx tsx src/cli.ts)
bash demo/hiring-demo.sh       # full acceptance-proof run (real model calls, ~$10+)
WEAVER_HOME=<dir>              # state root (default ./state, gitignored)
```

Testing discipline (ported from the relay experiment): every durability/authority invariant gets a deterministic test in `src/*.test.ts` — model quality must never be able to make a durability test pass or fail. The live demo proves the model-driven layer; the tests prove the rails. A new invariant ships with its test in the same PR.

## Validation before pushing

1. `yarn typecheck` — clean.
2. Run the smallest validation that proves the change; for anything touching the continuity contract, run the relevant pass-and-wake cycle end to end and confirm the fresh coordinator's projection.
3. **For UI markup or Tailwind-class changes:** run `yarn build:ui` and commit `src/ui/inspect/tailwind.generated.css`; the server reads that checked-in bundle and does not compile classes at runtime. See [docs/operator-workspace.md](./docs/operator-workspace.md).
4. **When asked to fix tests/lint/build:** run the exact command, read every failure, fix them all, re-run, confirm zero failures. Never report success on a subset.

## Git practices

- **Do your work in a git worktree — the user's checkout is theirs, not yours.** `git worktree add -b <branch> "$SCRATCHPAD/wt-<name>" main`, work there, remove it when merged.
- **Always `git fetch` a PR branch before reading, reviewing, or pushing to it.** Work from `origin/<branch>`; reconcile bot commits by rebasing, never clobbering.
- **Merge green, self-contained PRs by default — don't stop at "opened".** Commit → push → open the PR → verify it's green and self-contained → merge it with a regular merge commit — `gh pr merge <n> --merge`, **never `--squash` or `--rebase`** (squash-/rebase-merge is forbidden; it rewrites history and discards the per-commit trail) — then keep main green. The PR is still the unit (one coherent change, its own tests, a real description) — you just don't wait for a merge nod. Rebase onto latest main and re-run the suite before merging a branch that others touched. **Hold the merge only for** a genuinely destructive/irreversible op (force-push main, resetting shared state, a real-world send), a PR that isn't actually green/self-contained, or an explicit "don't merge yet". When several PRs stack, merge in a sensible order, rebasing each and keeping the suite green at every step.
- **The human's standing self-merge bar (2026-08-04) is merge-commit only.** Workstreams merging their own DevBot-clean, CI-green PRs in repos covered by the grant use `gh pr merge <n> --merge` — never squash or rebase, which the repo settings reject. The grant itself lives in the fleet's authority policy with its provenance; this line records its merge method and that no-merge rules elsewhere are scoped to humans' assistants, not to that grant.
- **Rebase, don't merge, to keep a feature branch current — but only when it matters.** Force-push a feature branch after a rebase with `--force-with-lease`; never force-push main.
- **Rename non-descriptive branches before the first push.** Check `git status` and `git log -1` before amending; pushed commits get a new commit instead.
- **Preserve other people's changes.** Unexpected edits in a file → ask before reverting.

## Updating these rules

Durable rules belong in both this file and `AGENTS.md` — the two are kept in sync; a change to one updates the other in the same commit. Keep rules concise (2–4 lines + a link to a real `docs/*.md` when one exists); put detailed examples in the doc. Docs are reasoned prose in Weaver's vocabulary (workstreams, assignments, adoptions, wakes) — never consultant abstractions or telegraph fragments.
