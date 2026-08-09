# Actions

*How intentional external effects are gated, executed with normal tools, and confirmed by deterministic readback*

Weaver has no channel adapters, no integration layer, no per-service plumbing. Every assignment is a regular Claude Code worker with real tools. A kind-`action` assignment is how a workstream directs and accounts for an intentional external effect: open the PR with `gh`, update Sentry through the operator's MCP, call the API with `curl`. Weaver's contribution is the gate before and the readback after; merely having a capable tool does not grant authority or make the worker's claim true.

## Where Pilot fits

[Pilot](https://github.com/NiallBrickell/pilot) keeps a live agent from bringing every routine tool decision back to you. Weaver decides why an action is needed, whether it advances the outcome, and what must happen after it. Pilot supervises the command while it runs; Weaver stays responsible for the outcome until the outside world confirms the effect.

## The lifecycle

1. **Gated**

   Every action is created gated with a mandatory plain-language approval card — what approving allows, why the workstream wants it, the blast radius. The operator's pilot reviews the exact commands first: routine-safe ones auto-approve (recorded as `by:pilot`, so the audit trail names who let it run), and anything with real blast radius fails closed to the human. Either way the gate is checked structurally in both the scheduler and the worker — nothing runs unapproved.

2. **Executed**

   The approved worker performs exactly the briefed act with the same normal Code surface as other workers, plus the workstream's action-only secrets and live Pilot supervision. The local MVP relies on its launching environment for containment rather than adding a second sandbox. When a human authored the exact command, the engine executes it verbatim instead — no model in the loop: models judge, humans decide, code executes.

3. **Read back**

   The assignment carries a `verify` command — a deterministic shell check the engine runs (`gh pr view --json state`, `test -f evidence.md`, ...). Its exit status is the only thing that can call the effect real. The worker's own report of success settles nothing.

4. **Adopted**

   Both coordinator adoption and the human override refuse an action whose readback hasn't run or failed. Adoption cannot outrank physics.

## Crashes and idempotency

A worker that dies mid-action is never blindly re-run — re-inspecting the world is always safe; re-doing the act is not. The crashed attempt is failed, the readback runs, and the truth (did the effect land?) comes from the world itself.

Actions are designed idempotent: the briefing names a stable external key (a branch name, a file path, an external ID) so that even a deliberate re-run cannot duplicate the effect.
