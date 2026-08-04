# Product TODOs

## Goal-first invocation

Starting a Workstream should feel like stating an outcome, not filling in its database record.

Target interaction:

```bash
weaver "find and fix why production syncs are unhealthy" \
  --workspace ~/work/product
```

The command should:

- derive a stable slug and useful title from the goal;
- accept repeatable `--workspace` paths as initial operating context, without requiring a follow-up
  `steer` command;
- apply ordinary defaults for tags, constraints, and runaway backstops;
- create the durable Workstream and queue its first reconciliation in one operation; and
- leave `weaver create` available as the explicit, automation-friendly form.

The everyday path is successful when a person can start useful work by supplying only the outcome
and, when Weaver cannot infer them, the relevant working directories. This is invocation simplicity,
not a different Workstream model: Weaver is already goal-first internally.
