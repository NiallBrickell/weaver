# Actions

*How intentional external effects are gated, executed with normal tools, and confirmed by deterministic readback*

Weaver has no channel adapters, no integration layer, no per-service plumbing. Every assignment is a regular coding-agent worker with real tools. A worker has exactly two lifecycles. Most work is `work`: bounded, reversible work that proposes a result, with its executor's ordinary toolset — including the operator's configured MCP servers used read AND write where supported. Moving a tracker issue's status, commenting, or labelling to keep the systems a brief names in sync is ordinary `work`, not an action; the line is drawn by consequence, not by whether the write goes to a remote service.

An `action` assignment is reserved for one *irreversible* egress to the outside world — merging or deploying a PR, spending money, sending a message to a person: `gh pr merge`, a payment API call with `curl`, a real send. Weaver's contribution is the gate before and the deterministic readback after; merely having a capable tool does not grant authority or make the worker's claim true.

## Where Pilot fits

[Pilot](https://github.com/NiallBrickell/pilot) keeps a live agent from bringing every routine tool decision back to you. Weaver decides why an action is needed, whether it advances the outcome, and what must happen after it. Pilot supervises the command while it runs; Weaver stays responsible for the outcome until the outside world confirms the effect.

On a hosted execution machine, Pilot's approval surface must itself be
authenticated: register `WEAVER_PILOT_TOKEN` with `weaver secret set
WEAVER_PILOT_TOKEN --executor`. Weaver sends that bearer on objective checks,
engine-command evaluation, live per-tool supervision, and liveness probes, but
never exposes it to a worker or Workstream state. Run `weaver pilot-auth-check`
as the runner's startup preflight; it fails closed unless the same client gets
HTTP 204 from Pilot's authenticated `/internal/auth-check`. Tokenless access is
retained only for a loopback Pilot used by existing local installations.

## The lifecycle

1. **Gated**

   Every action is created gated with a mandatory plain-language approval request — what approving allows, why the workstream wants it, the blast radius. The operator's pilot reviews routine actions first: safe ones may auto-approve (recorded as `by:pilot`, so the audit trail names who let it run), while a Pilot denial or sustained Pilot outage opens a needs-you card and fails closed to the human. When an operator directive or workstream constraint explicitly reserves an action for human/manual approval, Weaver records it as `human-only` and opens the card immediately; Pilot cannot clear that gate, though it still supervises the approved run's individual calls. Either way the gate is checked structurally in both the scheduler and the worker — nothing runs under the wrong authority.

2. **Executed**

   The approved worker performs exactly the briefed act with the same normal Code surface as other workers, plus the workstream's action-only secrets and live Pilot supervision. The local MVP relies on its launching environment for containment rather than adding a second sandbox. When a human authored the exact command, the engine executes it verbatim instead — no model in the loop: models judge, humans decide, code executes.

   Before an exact engine command runs, Weaver normally treats its verifier as
   a **postcondition preflight**: if the intended effect already exists, the
   verifier passes and Weaver submits that existing fact for review without
   repeating the command. A deterministic observation is different when the
   command's fresh stdout is itself the required result and the verifier merely
   proves that the source remains readable. Such an action may explicitly use
   `always-execute`; Weaver then omits only the pre-execution verifier call and
   runs the approved command once. This mode is not a claim that the command is
   side-effect-free and does not change its approval, one-shot execution claim,
   post-execution readback, or unknown-result handling. It is valid only for an
   exact deterministic engine command, never a model-driven action.

   An operator can author and pre-approve one of these exact actions directly:

   ```bash
   weaver assign-action <workstream> \
     --objective "Read the nightly daemon status" \
     --briefing "Run exactly the supplied observation command." \
     --cwd /absolute/working/directory \
     --run "daemon status --json" \
     --verify "daemon status --check" \
     --runner-id niall-mac-encore \
     --preflight-mode always-execute
   ```

   `--runner-id` is an exact placement constraint: only a runner with the same
   `WEAVER_RUNNER_ID` may claim the assignment. Omit it for ordinary
   fleet-wide scheduling. `--preflight-mode` is accepted only with `--run`;
   omit it for the normal `postcondition` behavior. These options change where
   or how the already approved command executes, never who authorized it.

3. **Read back**

   The assignment carries a `verify` command — a deterministic shell check the engine runs (`gh pr view --json state`, `test -f evidence.md`, ...). Exit 0 is the only thing that can call the effect real. A non-zero result, a missing verifier, or a verifier that cannot run is **unknown**, not proof that the effect is absent; the worker's own report of success settles nothing.

4. **Adopted**

   Both coordinator adoption and the human override refuse an action whose readback has not run or did not confirm the effect. Adoption cannot outrank physics.

## Crashes and idempotency

A worker that dies or loses its model/provider mid-action is never blindly re-run — re-inspecting the world is always safe; re-doing the act is not. The attempt is durably held `failed` before readback. A confirming readback moves it to review; any non-confirming or un-runnable readback leaves the outside-world result unknown and raises one blocker for human/provider reconciliation.

Actions are one-shot under their assignment and approval: persisted queued state with any prior attempt cannot run through either the model-worker or engine-command path. If reconciliation proves another attempt is needed, Weaver creates a new action with a fresh approval. Briefings still name stable external keys (a branch name, a file path, an external ID) as defense in depth; idempotency is not permission to auto-retry.

Deterministic engine commands and their readbacks are bounded as complete process trees. If a timeout expires, Weaver terminates the shell and its descendants before recording the attempt result; a background subprocess cannot continue after the action has moved to readback and reconciliation.

## Which code changes always need a person

The fleet reads text it did not write — support threads, error payloads, issues — and some of that text will try to steer it. So the decision about which pushes, pull requests, merges, and deploys need a person is not left to the coordinator or to Pilot. Weaver's engine makes it from facts neither of them can write, and it only ever makes an act *more* gated, never less.

Before any push, `gh pr create`, `gh pr merge`, or deploy, the engine works out what the act changes itself: the commits a push sends, the branch a PR opens, or the merged PR's own file list read through a read-only token. The act needs a person, whatever approval mode the coordinator chose, when:

- **It touches a sensitive path.** By default: `.github/**`, `**/auth/**`, `**/*auth*.{ts,go,py}`, `**/billing/**`, `**/payments/**`, `**/migrations/**`, `infra/**`, `deploy/**`, `**/Dockerfile*`, `**/*.tf`, and the files that brief every later agent run — `.claude/**`, `**/CLAUDE.md`, `**/AGENTS.md`, `**/.mcp.json`. Set `WEAVER_HUMAN_REVIEW_PATHS` to a comma-separated list of globs to replace the set. The card says exactly why: *touches .github/workflows/deploy.yml, a sensitive path: needs a person*.
- **The engine cannot tell what it changes.** A missing checkout, a branch with no base, or a PR too large for GitHub's file list fails closed to a person.
- **The engine cannot classify the command.** A raw `gh api` write it does not recognise, `curl` or a script calling the GitHub API, `hub`, an aliased or `--mirror` push, or a push that also runs `eval`, a nested shell, or a network client alongside it.
- **It merges or deploys from an untrusted workstream.** A workstream that a coordinator created, or that a bot registered through `weaver serve`, is *untrusted*, and so is everything created under it. It can still push branches and open pull requests, so the fleet does the work; merging and deploying are yours. A push straight onto `main` counts as a merge, and a tag push or a package publish counts as a deploy. Workstreams you create yourself — `weaver create`, `weaver do`, the browser — are *operator* workstreams and keep the normal path on non-sensitive changes. `weaver status` and the printout show a workstream's origin.

The untrusted-workstream rule is the one part of this you can relax without a code change, because most fleet jobs start from a ticket, an error or a customer thread, and it takes self-merge away from all of them. Set `WEAVER_UNTRUSTED_MERGE=pilot` on the runner and merges and deploys from untrusted workstreams go through Pilot again — but only when nothing else needs you. A sensitive path, a change the engine cannot compute, or a command it cannot classify still comes to you, and the fleet still cannot touch workflow files. The default, `person`, is what the card says: *merges from customer-derived jobs need a person (WEAVER_UNTRUSTED_MERGE=person)*. `weaver status` shows which is active, and any other value stops the runner from starting rather than guessing. Relaxing it does not release actions already waiting for you, which you still approve as usual; tightening it back to `person` catches even a Pilot-approved merge, because the engine checks again immediately before it runs.

When the engine routes an act to you, Pilot is never asked. Your approval records exactly what you were shown, and the engine checks again immediately before the act runs: if the branch or PR has moved since you approved, the action comes back to you with the new reason instead of running. Model-driven actions get the same judgment one command at a time, so a worker cannot reach a merge through a different command shape or a connector.

Constraints a coordinator writes for a workstream it creates are shown to that workstream as suggestions from an untrusted author, never as rules. The new workstream inherits its parent's real constraints, and can never be looser than its parent about sending.

The fleet's GitHub token has no permission to change workflow files. A push that touches `.github/workflows` is refused by GitHub, and Weaver tells you so plainly: a person pushes or merges workflow changes, and the fleet never retries them.

## Repo deconfliction

Weaver conflict-checks its own state on every write; the same discipline extends across the git-repo seam. Before an action does an irreversible repo egress (`gh pr create`, `gh pr merge`, `git push`), Weaver looks at the shared state the egress is about to write into, and it draws a line between two very different findings.

Another *open* PR changing the same files is **reported, not blocked**. Two branches touching one file is ordinary parallel development: they are separate refs, git merges them, and a real textual conflict surfaces at merge time where a rebase settles it. So the overlap is recorded on the workstream — which PR, whose, and the exact overlapping paths — where the author and the reviewer can see who else is in these files, and the action ships.

A push target whose own PR has already **merged or closed is held**. That one is not a conflict git can settle: the commits are in the trunk, the PR is done, and a push lands a commit no PR carries — it shows up only as GitHub's "had recent pushes" banner and reaches no reviewer. It happens when a workstream starts a follow-up before the merge and finishes after it. Weaver holds the action and wakes the stream with what the situation calls for: move the work to a fresh branch cut from the current base and open a new PR, rather than re-pushing the settled branch or reopening the settled PR.

Both checks fail open on tooling failure — no `gh`, not a repo, an unreadable checkout — so a broken tool never wedges legitimate work; the abstention is logged rather than passed off as a clean bill of health.
