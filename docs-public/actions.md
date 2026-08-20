# Actions

*How intentional external effects are gated, executed with normal tools, and confirmed by deterministic readback*

Weaver has no channel adapters, no integration layer, no per-service plumbing. Every assignment is a regular coding-agent worker with real tools. A worker has exactly two lifecycles. Most work is `work`: bounded, reversible work that proposes a result, with its executor's ordinary toolset — including the operator's configured MCP servers used read AND write where supported. Moving a tracker issue's status, commenting, or labelling to keep the systems a brief names in sync is ordinary `work`, not an action; the line is drawn by consequence, not by whether the write goes to a remote service.

An `action` assignment is reserved for one *irreversible* egress to the outside world — merging or deploying a PR, spending money, sending a message to a person: `gh pr merge`, a payment API call with `curl`, a real send. Weaver's contribution is the gate before and the deterministic readback after; merely having a capable tool does not grant authority or make the worker's claim true.

## Where Pilot fits

[Pilot](https://github.com/NiallBrickell/pilot) keeps a live agent from bringing every routine tool decision back to you. Weaver decides why an action is needed, whether it advances the outcome, and what must happen after it. Pilot supervises the command while it runs; Weaver stays responsible for the outcome until the outside world confirms the effect.

## The lifecycle

1. **Gated**

   Every action is created gated with a mandatory plain-language approval request — what approving allows, why the workstream wants it, the blast radius. The operator's pilot reviews routine actions first: safe ones may auto-approve (recorded as `by:pilot`, so the audit trail names who let it run), while a Pilot denial or sustained Pilot outage opens a needs-you card and fails closed to the human. When an operator directive or workstream constraint explicitly reserves an action for founder/manual approval, Weaver records it as `human-only` and opens the card immediately; Pilot cannot clear that gate, though it still supervises the approved run's individual calls. Either way the gate is checked structurally in both the scheduler and the worker — nothing runs under the wrong authority.

2. **Executed**

   The approved worker performs exactly the briefed act with the same normal Code surface as other workers, plus the workstream's action-only secrets and live Pilot supervision. The local MVP relies on its launching environment for containment rather than adding a second sandbox. When a human authored the exact command, the engine executes it verbatim instead — no model in the loop: models judge, humans decide, code executes.

3. **Read back**

   The assignment carries a `verify` command — a deterministic shell check the engine runs (`gh pr view --json state`, `test -f evidence.md`, ...). Exit 0 is the only thing that can call the effect real. A non-zero result, a missing verifier, or a verifier that cannot run is **unknown**, not proof that the effect is absent; the worker's own report of success settles nothing.

4. **Adopted**

   Both coordinator adoption and the human override refuse an action whose readback has not run or did not confirm the effect. Adoption cannot outrank physics.

## Crashes and idempotency

A worker that dies or loses its model/provider mid-action is never blindly re-run — re-inspecting the world is always safe; re-doing the act is not. The attempt is durably held `failed` before readback. A confirming readback moves it to review; any non-confirming or un-runnable readback leaves the outside-world result unknown and raises one blocker for human/provider reconciliation.

Actions are one-shot under their assignment and approval: persisted queued state with any prior attempt cannot run through either the model-worker or engine-command path. If reconciliation proves another attempt is needed, Weaver creates a new action with a fresh approval. Briefings still name stable external keys (a branch name, a file path, an external ID) as defense in depth; idempotency is not permission to auto-retry.

## Repo deconfliction

Weaver conflict-checks its own state on every write; the same discipline extends across the git-repo seam. Before an action does an irreversible repo egress (`gh pr create`, `gh pr merge`, `git push`), Weaver looks at the shared state the egress is about to write into, and it draws a line between two very different findings.

Another *open* PR changing the same files is **reported, not blocked**. Two branches touching one file is ordinary parallel development: they are separate refs, git merges them, and a real textual conflict surfaces at merge time where a rebase settles it. So the overlap is recorded on the workstream — which PR, whose, and the exact overlapping paths — where the author and the reviewer can see who else is in these files, and the action ships.

A push target whose own PR has already **merged or closed is held**. That one is not a conflict git can settle: the commits are in the trunk, the PR is done, and a push lands a commit no PR carries — it shows up only as GitHub's "had recent pushes" banner and reaches no reviewer. It happens when a workstream starts a follow-up before the merge and finishes after it. Weaver holds the action and wakes the stream with what the situation calls for: move the work to a fresh branch cut from the current base and open a new PR, rather than re-pushing the settled branch or reopening the settled PR.

Both checks fail open on tooling failure — no `gh`, not a repo, an unreadable checkout — so a broken tool never wedges legitimate work; the abstention is logged rather than passed off as a clean bill of health.
