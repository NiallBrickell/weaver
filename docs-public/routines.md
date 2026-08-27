# Routines

*Standing loops that wake with their decision log, constraints, and learned policies intact*

A routine is an outcome that never ends after one report. It does the current cycle, checks what actually happened, records what the next cycle must know, and schedules its own next wake — an error-triage sweep every 12 hours, an evals-health check daily, a usage report weekly.

```bash
weaver create --slug sentry-sweep --tag routine \
  --title "Sentry sweep" \
  --objective "Each cycle: triage recent issues, root-cause the real ones, open PRs for clear fixes. Schedule the next wake ~12h out. Report only deltas."
```

## Why this beats a cron'd prompt

A scheduled prompt can produce a fresh piece of work on a timer, but the responsibility between cycles still belongs to you. A Weaver routine owns that recurring outcome and wakes up with:

- **Its decision log** — the *standing* judgments that still bind: what counts as noise, which approaches are ruled out. A per-cycle plan is closed once its cycle is done (it stays as inspectable lineage, not a live commitment), and what a cycle *found* is kept as a result/deliverable — so the decision log stays a short list of commitments rather than a cycle-by-cycle transcript, however many hundreds of cycles run.
- **Its constraints** — the hard rules you set once ("open PRs, never merge", "targeted tests only").
- **Learned policies** — every correction you made in *any* matching workstream, already applied, still auditable.
- **Verified history** — what it claims it did last cycle was confirmed by readback, so this cycle builds on facts.

Cycle 30 inherits the decisions and corrections from cycles 1–29, then continues the outcome from there. There is no lifetime pass/dollar ceiling waiting to kill a healthy routine. The [rolling execution guard](./execution-safety.md) pauses only rapid model-start churn and resumes automatically. The compact dashboard row shows current in-flight time, last-decision age, and next wake — not a lifetime activity tally. [`weaver stats`](./stats.md) is where intervention load is compared across qualified outcomes with the context needed to judge whether supervision is actually moving away from you.

## Mechanics

- Wakes are stored data, not sleeping processes — the resident runner discovers what's due. Kill the runner for a week; the routine picks up exactly where it stopped.
- A superseded cycle does not leave its old organizational checks behind. Every new check names the exact decision or work item it serves; the coordinator can cancel it only when typed facts directly close or supersede that same course. The cancellation and basis remain in history, and large backlogs are read in bounded pages rather than dumped into every pass. Infrastructure recovery, execution-safety, immediate-arrival, wall-time, and fired wakes cannot be cancelled individually; validated workstream conclusion retires the remaining waits by pass reference.
- The dashboard shows routines in their own `↻ ROUTINES` section with the next-run time.
- `weaver pause <slug>` stops a routine with its state and scheduled wakes intact; `weaver resume <slug>` restarts it. Run `weaver pause` with no slug to pause every currently active workstream. [Pausing work](./pausing.md) explains the fleet boundary. `weaver tag <slug> add routine` converts an existing workstream.
