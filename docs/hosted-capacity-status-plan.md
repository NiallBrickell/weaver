# Hosted capacity visibility and recovery

- [x] Trace the actual hosted provider chain and independently confirm restored OpenRouter key allowance.
- [x] Issue one model-scoped retry on the hosted steward without clearing Claude waits or changing host placement.
- [x] Confirm a real successful hosted fallback pass and recover matching active waits.
- [x] Make operator status use fresh selected-runner coordinator seats, not the viewer's environment.
- [x] Preserve visibility of pending infrastructure retry wakes instead of falsely declaring dormancy.
- [x] Run deterministic regression tests, typecheck, UI build, and self-review before the PR.
- [x] Verify operator readback and document remaining hosted-input/authentication dependencies.

The provider recovery requires no routing rewrite: the existing coordinator chain
already falls back from Claude to OpenRouter. A direct Z.ai key is a separate
integration, not a second pool behind the currently configured OpenRouter route.
Restoring capacity must never restart the operator workstation or resume paused
trading. A fresh heartbeat alone does not prove model success.

## Live recovery evidence

The full hosted coordinator canary completed on 10 September at 11:15:28 UTC.
The existing fleet recovery path then released matching OpenRouter waits in
other Workstreams; an extra manual reset was unnecessary. Claude waits and
host placement were preserved. Both subsequent hosted coordination and isolated
worker execution started. A small independent, bounded hosted model request
also returned HTTP 200 in 540 ms; this diagnostic did not stand in for the full
coordinator proof.

The remaining input failure is distinct from capacity: one routine still named
a nonexistent workstation-era source path. An existing clean hosted checkout
was verified through a deterministic action, and that evidence was delivered
to the owner for replacement of failed ordinary work. Historical action commands
and founder pauses remain untouched.

The final local suite passed 814 tests with two optional PostgreSQL skips (816
total); typecheck, UI build, and diff checks passed. Read-only live status from
the changed code showed the hosted OpenRouter fallback and the actual running
pass while the workstation remained execution-disabled. Shipping and CI are
tracked by the pull request; deployment must not restart the operator runner.
