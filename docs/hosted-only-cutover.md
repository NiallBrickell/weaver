# Operator-only workstation cutover

Task: finish the hosted execution boundary without discarding durable work or
silently moving it back to the operator's workstation when a provider fails.

## Task list

- [x] Stop and disable the unwanted trading dashboard and exact runaway Chrome renderer.
- [x] Disable obsolete local sweep schedules and local Weaver launchd entrypoints.
- [x] Verify no local actions were running; drain and unload the Mac runner.
- [x] Trace prior hosting direction against transcript evidence and current typed placement.
- [x] Remove Mac placement/fallback from non-concluded shared work; preserve paused state and action history.
- [x] Add and validate a machine-local execution-off posture covering runners, manual ticks, and embedded watch promotion (805 deterministic tests passed; two optional Postgres tests skipped).
- [x] Correct the operator skill's automatic local restart instructions across Codex, Claude, and Pi.
- [ ] Ship the tested change and verify the deployed local posture and hosted fleet readback.

## Cause

Hosting shared state and the browser did not itself move every worker. The
fleet contained hosted-preferred coordinators paired with workstation-pinned
Assignments. Provider recovery changed host placement instead of preserving
the operator's chosen execution boundary. Legacy launchd sweeps also remained
independent of Weaver, and the watch UI could promote itself into a local runner.

The fix must cover all three: machine startup, durable intended-work placement,
and the instructions used by future operator sessions. Model/provider fallback
is not permission to change execution host. Historical Attempts retain the
runner that actually executed them.

## Verification boundary

Fresh shared heartbeats prove the hosted runner is polling, not that its model
allowances or every repository capability are healthy. Pending actions whose
approved commands refer to workstation-only artifacts cannot just have paths
rewritten: preserve their state and require a hosted readback/replanning step.
Cloud CLI reauthentication failures must be reported as an access limitation,
not as a missing VM or a reason to restart a workstation runner.

The 10 September cutover reconciled 52 non-concluded Workstreams through the
existing placement and lifecycle APIs. All 27 remaining active Workstreams
were verified with hosted-only coordinator and Assignment bindings. Existing
paused work stayed paused. Eight additional workstreams were held because
their pending actions require workstation-local source artifacts; the ninth
hold is the genuinely machine-local Encore maintenance routine. No action
command or historical Attempt was rewritten to pretend execution moved.

Local launchd runner, maintenance, old issue/Sentry sweeps, daily tick and
needs-you schedules were disabled and unloaded. Trading research, supervisor,
monitor and dashboard were also disabled; the read-only usage dashboard was
retained. The hosted runner continued publishing a fresh shared heartbeat,
while cloud CLI access required operator reauthentication. Direct host repair
and transferring/verifying the held source artifacts remain separate work
from proving local execution is off.
