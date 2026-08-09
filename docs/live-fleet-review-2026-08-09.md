# Weaver live-fleet review — 9 August 2026

## Status and purpose

This is an implementation handoff from a read-only audit of Weaver after its first several days of sustained use. It evaluates whether the harness is useful, whether it is genuinely advancing work autonomously, whether the decision and policy layers are helping, and where the implementation falls short of the kernel claims.

The intended reader is an implementation agent. Findings therefore include affected enforcement sites, evidence, repair requirements, deterministic acceptance tests, and sequencing. The evidence is a live-state snapshot, not a timeless benchmark: the runner continued to advance work while the audit ran.

Snapshot time: approximately `2026-08-09T18:52:09Z`.

## Executive verdict

Weaver is already useful and genuinely autonomous for bounded engineering and operational work. It is not merely retaining tasks: it decomposes objectives, dispatches disposable workers, reviews and rejects submissions, retries with different assignment shapes, performs authorized external acts, verifies provider state, adopts results, concludes workstreams, schedules later reconciliation, and creates managed child workstreams.

The durable execution thesis is substantially proven. The learning thesis is not.

| Dimension | Assessment | Why |
| --- | --- | --- |
| Real-world usefulness | Strong | It has opened and merged real PRs, fixed review feedback, published updates, investigated production systems, and safely stopped when authority or business direction said stop. |
| Operational autonomy | Strong but bounded | Most recorded actions were Pilot-approved, active workstreams all had durable future wakes, and multi-step work continued across fresh model sessions. Pilot is delegated authority, not learned authority. |
| Durable continuation | Strong | Fresh coordinator and worker sessions, immutable adopted artifacts, stored wakes, crash recovery, and managed children are all visible in live state. |
| Adoption and action readback | Mixed | At the snapshot, every accepted action's latest persisted readback was successful and candidate rejection was real. However, the “readback” command is model-authored shell executed with secrets and without Pilot supervision, so the verifier itself is not structurally read-only. |
| Reliability and efficiency | Weak to mixed | Provider capacity dominated coordinator errors, genuine worker failures remained material, routine projections and wakes grew large, and recorded spend reached roughly $2.34k across six calendar days. |
| Decision lineage | Strong | Supersession references are complete, symmetric, same-workstream, and attributable to passes. |
| Decision hygiene | Deteriorating | Long-running routines use standing decisions as cycle reports, leaving stale and contradictory commitments in every fresh projection. |
| Policy usefulness | Promising in a small core | Several decomposition, read-only recovery, direct-link, and merge-bar policies visibly changed later plans. |
| Policy learning validity | Not trustworthy yet | Application IDs are not validated, evidence is model-self-reported, first positive evidence promotes, negative evidence does not retire policies, and active contradictions remain. |
| Unattended production readiness | Not yet | The send path has an egress/rejection race, pass conflicts can be recorded as completed, the interaction/reply lifecycle has no live longitudinal evidence, and the local executor does not structurally contain non-action workers. |

The right description today is **a high-agency durable engineering harness under supervision**, not yet a trustworthy self-improving organizational controller.

## Audit scope and method

The audit was read-only. It covered:

- All 41 current workstream documents and four archived workstream documents available in the primary checkout.
- The global policy store at revision 537.
- Assignment, attempt, adoption, action-readback, pass, wake, attention, steering, conclusion, decision, policy-citation, and policy-evidence records.
- Representative end-to-end traces for roadmap intake and ERDO-410–417, PR review repair, daily engineering updates, approvals cleanup, Sentry sweeps, session replay review, Axiom health, and production incident work.
- The coordinator, worker, engine, projection, policy, status, stats, store, action, conclusion, and managed-workstream enforcement paths.
- Current runner process and logs.
- Recent git history, which showed approximately 166 commits during the audited six calendar dates.
- Current GitHub state for representative PRs.

Validation performed:

- `yarn typecheck`: clean.
- `yarn test`: 213 passed, zero failed.
- Filesystem and SQLite store contracts passed.
- PostgreSQL contracts were skipped because `WEAVER_TEST_PG_URL` was unset.
- All 400 adopted artifacts were independently hashed: zero missing files, hash mismatches, or inconsistent pins.

Counts and timestamps below are observed. Text classifications such as “PR opening action” are conservative inference from action objectives and deterministic readback because `Assignment.kind === "action"` does not carry a closed external-effect subtype.

## Live-fleet evidence

### Inventory

| Fact | Snapshot |
| --- | ---: |
| Current workstreams | 41 |
| Workstreams done / active / paused | 25 / 15 / 1 |
| Managed child workstreams | 13 |
| Assignments | 527 |
| Completed / failed / cancelled assignments | 455 / 65 / 7 |
| Worker attempts | 638 |
| Deliverables | 447 |
| Immutably adopted deliverables | 400 |
| Accepted assignments | 402 |
| Rejected submissions | 53 |
| Action assignments | 311 |
| Passing / failing / absent latest action readback | 243 / 67 / 1 |
| Accepted actions | 225 |
| Coordinator pass records | 1,274 |
| Completed / error / no-finish / running pass records | 694 / 578 / 1 / 1 |
| Durable wakes | 1,798 |
| Fired / cancelled / pending wakes | 1,678 / 86 / 34 |
| Attention records | 399, all resolved at snapshot |
| Steering records | 70 |
| Typed conclusions | 18 |
| Total recorded spend | approximately `$2,337.36` |
| Lifetime intervention counter | 272 |

Seven older done workstreams lack the newer typed `conclusion` field. Four done workstreams dispatched no assignments, but the reasons differ: `lossless-concurrent-arrivals`, `remote-mcp-inheritance`, and `remove-ambient-mcps` were implemented elsewhere and later closed by steering; `weaver-do-smoke-test` was a deliberately coordinator-only smoke test. The smoke test is also one of the seven missing typed conclusions, so these are overlapping qualifications rather than eleven distinct weak outcomes.

### Fresh-run continuity is real

The live state contained 1,208 coordinator session IDs and 531 worker session IDs with zero duplicates. Coordinator and worker execution both use `persistSession: false`; session IDs are provenance only. Continuity is coming from typed state rather than resumed model context.

Every active workstream had a future typed wake at the snapshot. There was no active workstream silently dependent on a resident model session or in-memory timer.

### Adoption and external-fact separation are working

Workers submit candidates; the coordinator decides adoption. Of 311 action assignments, 243 had successful latest persisted readback, but only 225 were accepted. Ten actions whose latest readback passed were rejected and others remained unadopted, demonstrating that provider readback and business acceptance are separate facts.

At the snapshot, no accepted action had a failed or absent latest readback. The schema stores the latest verification rather than an immutable verification sequence, so this is not a claim that an action accepted later had never failed an earlier readback. Two accepted crash-recovery actions intentionally had no deliverable because deterministic external readback was the authoritative result.

The 18 typed conclusions cited 80 evidence IDs. Every reference passed the current gate: 54 adopted deliverables, 21 standing decisions, and five accepted readback-confirmed actions. “Passed the gate” is not the same as qualified outcome evidence: any coordinator-authored standing decision currently qualifies, so the 21 decision references can resolve without independently proving success.

## Evidence of useful autonomous work

### Roadmap intake and managed children

`roadmap-intake` is the strongest proof that Weaver is managing work rather than merely running prompts. Accepted worker reports show repeated Linear inspection; typed parent state proves that it kept a bounded number of child workstreams in flight, created children idempotently from source keys, inspected child conclusions, and topped the fleet back up. GitHub outcomes were independently checked; Linear was not independently re-read during this audit.

Eight ERDO-410–417 children concluded over roughly 31 hours. Parent and children together recorded about `$186` of spend, produced 33 adopted deliverables, and counted seven interventions: one `niall`, three `niall-via-claude-session`, and three `claude-session`. These are not seven direct-founder interruptions. The children opened eight verified PRs:

- [ERDO-410 / PR #1957](https://github.com/erdoai/erdo/pull/1957)
- [ERDO-411 / PR #1958](https://github.com/erdoai/erdo/pull/1958)
- [ERDO-412 / PR #1956](https://github.com/erdoai/erdo/pull/1956)
- [ERDO-413 / PR #1971](https://github.com/erdoai/erdo/pull/1971)
- [ERDO-414 / PR #1976](https://github.com/erdoai/erdo/pull/1976)
- [ERDO-415 / PR #1968](https://github.com/erdoai/erdo/pull/1968)
- [ERDO-416 / PR #1973](https://github.com/erdoai/erdo/pull/1973)
- [ERDO-417 / PR #1972](https://github.com/erdoai/erdo/pull/1972)

ERDO-410 demonstrates assignment-over-run durability particularly well. A monolithic implementation exhausted its turn budget. A fresh coordinator recorded the failure, split the implementation into two sequential assignments, adopted both outputs, and then opened the PR with SHA and body readback. The intended work survived replacement of the failed run.

ERDO-414 stopped at a legal-copy boundary, accepted founder-supplied wording, verified semantics, and continued. ERDO-416 stopped for a missing Google Maps credential, resumed after provisioning, and completed. These are appropriate authority boundaries rather than failures of autonomy.

### Other representative outcomes

- `upload-stuck-composer` progressed from production incident research through implementation, DevBot correction, green CI, and verified merge of [PR #1898](https://github.com/erdoai/erdo/pull/1898), recording approximately `$40.67` and one intervention.
- `growth-engine-pause-strategy` found a genuine pause-first optimizer defect, incorporated three substantive review corrections, merged [PR #1924](https://github.com/erdoai/erdo/pull/1924), updated knowledge through the supported surface, and verified the next optimizer run behaved differently.
- `fix-pr-1942-comments` inventoried one unresolved DevBot thread, recovered from an oversized implementation by splitting fix and tests, pushed the fix, replied, resolved the thread, and verified the result in about 42 minutes.
- `daily-engineering-update` produced accepted submissions reporting exactly-once publication, with deterministic readback proving the dated posts were present. The verifier checked presence rather than cardinality, so exact-once is not independently proven. On a later cycle the worker reported that another process had already published and posted, and Weaver made no new egress.
- `approvals-cleanup` eventually gathered read-only production counts and proposed a purge. When the founder declined, Weaver performed no mutation. The result was safe and useful decision support, although expensive.

A manual conservative classification found at least 46 explicit readback-confirmed PR-opening submissions by requiring a successful latest readback and submission/objective text that explicitly said the action opened or created a PR/pull request. Because external effect subtype is not structured, this count is evidence rather than a reproducible schema query. Broader text classification found more; 46 is the defensible lower bound.

## Limits of the autonomy claim

### Pilot absorbs approvals; it does not create authority

Exactly 269 action assignments were Pilot-approved and 42 human-approved. Among the 225 accepted actions, 191 were Pilot-approved and 34 human-approved. The full ratio includes rejected/unadopted and read-only actions; the accepted-action split is the stronger evidence that successful supervised operation usually continued without an immediate human approval.

It does not mean Weaver learned permission to act. The actions were consistent with projected workstream constraints and standing human direction, while Pilot/human approval was the actual enforcement/delegation point. Current constraints are plain strings rather than a structural gate. Policy evidence must not take credit for approval-ratio improvements caused by Pilot rules.

### The intervention metric is not founder-interruption burden

The lifetime counter was 272, but only 138 intervention acts could be placed on the durable timeline:

| Actor | Dated acts |
| --- | ---: |
| `niall` | 12 |
| `claude-session` | 83 |
| `niall-via-claude-session` | 21 |
| unattributed | 22 |

The durable data cannot reconstruct direct-founder interruption burden. Session actors operate on the founder's behalf and may embody founder supervision, while nearly half the lifetime numerator is residual and undated. The table establishes attribution labels, not how many times the founder was personally interrupted.

### Communication and evaluated-business-result continuity are unproven

The live fleet contained zero `Interaction` and zero `Reply` records. Slack and GitHub effects occurred as action assignments, but the five distinct facts—draft, send, provider receipt, reply, evaluated business result—have not had a longitudinal live proof. No claim about autonomous outreach or reply handling should be made from this cohort.

## Decision-layer assessment

### What works

The current fleet had 424 decisions: 353 standing and 71 superseded. Including archives, every `supersedes` / `supersededBy` edge resolved, was symmetric, and stayed within one workstream. All decisions had pass provenance and nearly all had review conditions.

The lineage helped in concrete cases:

- `mail-reply-routing` preserved the sequence from local-test failure, through daemon recovery and a CI pivot, to a DevBot semantic correction and eventual merge.
- `approvals-cleanup` explicitly replaced “ask the founder to run counts” with read-only retrieval, then replaced the purge course when the founder declined it.
- `growth-engineer-e2e` preserved why the manual-merge/outage course changed.
- `managed-workstreams` retained lineage while oversized research and implementation shapes were corrected.

This is valuable organizational continuity. A fresh coordinator can see which course became authoritative and why an earlier course stopped being authoritative.

### What is breaking down

The seven active routine workstreams held 214 decisions, of which 193—90.2%—remained standing. Examples:

- `sentry-sweep`: 53 standing decisions and roughly 168k characters of decision titles/rationales.
- `session-replay-review`: 39 standing decisions and roughly 107k characters.
- `thread-review`: 38 standing decisions and roughly 102k characters.

Old sweep baselines, cycle-stage reports, CI polls, and obsolete merge postures remain standing beside newer courses. `sentry-sweep` and `evals-health` both retained standing “merge remains human” or deny-list decisions after later verified autonomous merges.

The projection amplifies the problem:

- [`src/projection.ts`](../src/projection.ts) renders every adopted and candidate deliverable.
- It renders every standing decision with the full rationale and every superseded decision title.
- It renders every non-cancelled assignment, including completed and failed assignments.
- Only event history and shadow-policy display are meaningfully bounded.

The live `sentry-sweep` projection was 293,426 characters. Decisions occupied 193,651 characters. Fleet-wide standing rationales contained about 732k characters; 317 exceeded 1,000 characters and 60 exceeded 3,000.

This is typed state, but it behaves like an ever-growing transcript. It violates the intended discipline that decisions are commitments rather than the record of all work. Longitudinal success currently depends partly on the model absorbing an enormous prompt, not on a crisp bounded organizational position.

## Policy-layer assessment

### Population and use

The stable policy store contained:

| Fact | Count |
| --- | ---: |
| Policies | 357 |
| Active / shadow / superseded | 25 / 331 / 1 |
| Backfilled from rules | 276 |
| Backfilled from sessions | 48 |
| Learned live | 33 |
| Policies with any evidence | 26 |
| Evidence rows | 178 |
| Evidence marked intervention-free | 167 |
| Negative evidence rows | 11 |
| Policies ever cited, including four archived workstreams | 35 |

The 41 current workstreams cited 31 distinct policy IDs; the including-archives count is 35. The top ten policies accounted for 84.1% of all citation references. Three hundred and nineteen currently matching policies had never been cited. Three hundred and forty-four policies carried the broad `erdo` tag, causing a typical erdo workstream to match nearly the entire policy store even though the projection only renders all active matches plus the newest 25 shadow matches.

The practical system is therefore a useful core of a few dozen rules surrounded by hundreds of inert or overlapping candidates.

### Case evidence consistent with a few policies helping

- `pol_2659a75b`: after four multi-issue Sentry workers exhausted their turn budget, five one-issue workers submitted first try. Later decisions cited the split in another workstream. It had 19 coordinator-authored intervention-free evidence rows across seven workstreams.
- `pol_23d7f506`: after one eight-repository gather died after 49 turns without submission, four per-repository gathers produced durable adoptable evidence. The approach was later reused.
- `pol_c4b51480`: read-only questions should be retried through supervised actions before raising an access card. Twelve evidence rows across eight workstreams include successful PostHog, Axiom, and DevBot probes.
- `pol_114df4c4`: when a workstream already had the relevant founder grant and the evidence bar was satisfied, 14 exact `gh pr merge` executions across eight workstreams were readback-confirmed and adopted.
- `pol_75582bdb`: direct verifiable links were repeatedly required across 17 workstreams, although most of its evidence is coordinator-authored self-attestation rather than a before/after failure trace.

The assignment traces show a sequence in which `pol_2659a75b` and `pol_23d7f506` were cited as work shape changed after concrete failures, followed by successful submissions. That is stronger case evidence than repeated coordinator-authored outcome notes, but a citation does not prove the policy caused the coordinator to choose the shape rather than independently reaching the same plan. The decomposition and read-only-recovery rules are the best evidence consistent with improvement; none of these episodes is a controlled causal comparison.

### Promotion is self-attested, not structurally earned

[`record_decision`](../src/coordinator.ts) accepts arbitrary `applied_policy_ids` without checking existence, status, or scope. [`recordPolicyOutcome`](../src/policies.ts) accepts a caller-supplied workstream, pass, prose note, and Boolean, then promotes a shadow policy on the first `interventionFree: true`.

Proposal provenance is equally permissive: `steering_id` is optional, and neither proposal code nor the coordinator tool validates that the referenced workstream, pass, steering record, correction relationship, or scope exists. Both policy proposal and outcome currently mutate the global policy store before attempting the workstream event write; a workstream revision conflict can therefore leave globally persisted policy state from a stale pass with no corresponding workstream record.

It does not verify:

- The workstream or pass exists.
- The workstream matches the policy scope.
- An applying decision cited the policy.
- The cited application preceded the claimed outcome.
- The workstream met a typed success criterion.
- No correction occurred on the policy's point after application.
- The policy scope matched the workstream at application time rather than merely matching mutable current tags when evidence was later inspected.

Observed consequences:

- One decision cited a nonexistent policy ID after confusing a decision ID for a policy ID.
- Seven evidence rows had no cited application anywhere in that workstream.
- Seven evidence rows were mismatched against the workstreams' current tags; historical application-time tag snapshots do not exist, so retrospective mismatch is not conclusive by itself.
- Eight evidence rows lacked a policy citation before or during the evidence pass: seven were never cited in that workstream and one was cited only later. Evidence may validly be recorded in a later pass than application, so same-pass absence alone is not a defect.
- `pol_615bacd8` became active without a matching source-workstream tag or any applying decision citation there.
- Seven of 25 active policies—including `pol_615bacd8`—had intervention-free evidence only from their source workstream.
- Six active policies had negative evidence but remained active.

### Correction and authority semantics are incomplete

`supersedePolicy` exists internally but is not exposed as a coordinator tool or CLI operation. Only one policy out of 357 was superseded.

The clearest contradiction is:

- `pol_3aed62cd` actively says automated erdo PR merging is always forbidden. Its own evidence contains two negative rows saying that blanket rule is wrong.
- `pol_114df4c4` actively says an eligible erdo workstream may self-merge at the evidence bar.

Both remain projected. Some applying decisions explicitly state that the former is knowingly not followed.

The authority firewall is structurally closed only at the field-shape level. All policies use allowed effect kinds and `widensAuthority: false`, but `pol_114df4c4` literally says a workstream “MAY merge its own PR” and describes “Founder-granted merge authority.” Live policy proposal does not run the authority-text refusal used by import/backfill.

Actual merges were consistent with recorded workstream constraints and remained gated by Pilot/human approval and deterministic readback; action creation does not structurally validate those constraint strings. Nevertheless, authority-shaped policy prose is representable and can influence a coordinator, contrary to the stronger documentation claim.

### No fleet-level causal result yet

The current headline is approximately 0.68 interventions per adopted deliverable. The recoverable dated cumulative ratio moved from 0.600 on 4 August to 0.311 on 8 August, then approximately 0.346 on 9 August.

That is encouraging but not causal evidence:

- Forty-nine percent of the intervention numerator is undated.
- An adopted work product is not a successful outcome.
- Workstreams differ substantially in difficulty and lifecycle stage.
- Policy-citing workstreams were at approximately 0.679 interventions/adoption.
- Non-citing workstreams were at approximately 0.688.
- Eight roadmap child workstreams matched no policies but produced roughly 33 adoptions with four interventions.

The correct claim is: **several policy episodes were followed by improved execution and are consistent with helping; the fleet data does not yet prove that the policy system reduced human intervention per comparable successful outcome.**

## Reliability, cost, and operational churn

### Coordinator errors

Of 1,274 pass records, 578—45.4%—were errors:

- 476 were provider-capacity or temporary infrastructure failures.
- 17 recorded coordinator-process death with later wake restoration.
- 85 had empty or unclassified summaries.

Durability recovered from much of this, which is a strong result. It remains operational churn that consumes time, state, and attention.

### Worker attempts

Of 638 worker attempts:

- 424 had no exceptional terminal reason.
- 75 crashed.
- 50 ended without submission.
- 45 were infrastructure backoffs.
- 22 were deterministic engine-executed actions.
- 18 exhausted the turn limit.
- Three lacked the native SDK binary.
- One had a command failure.

Forty-four accepted assignments required more than one attempt. Recent code raised the worker ceiling from 80 to 200 turns and changed the default orchestration shape, so this cohort combines materially different harness versions.

### Cost centres

- Total recorded spend was approximately `$2,337.36` over about 5.3 elapsed days, spanning six calendar dates.
- `sentry-sweep` alone recorded about `$512`, with 159 pass records, 83 error passes, 105 assignments, 15 failed assignments, 78 accepted assignments, 12 rejected submissions, and 37 interventions.
- `approvals-cleanup` recorded about `$51`, 59 coordinator passes, and 22 interventions to gather read-only counts and ultimately perform no purge after founder direction.

These are lower bounds on model usage: 100 worker attempts and 18 coordinator pass records lacked `costUsd`; engine actions legitimately have no model cost, but crashed/dead processes may have consumed unrecorded usage. The nominal recorded `$5.84` per adopted deliverable is a leading process indicator, not cost per outcome. Research notes, intermediate evidence, implementation artifacts, and external effects are not equivalent units.

## Contract and implementation findings

### P0 — approved send can race with human rejection

**Enforcement sites:**

- [`src/engine.ts`](../src/engine.ts), `executeApprovedSends`.
- [`src/humanActs.ts`](../src/humanActs.ts), `rejectSend`.
- [`src/engine.test.ts`](../src/engine.test.ts), send lifecycle tests.
- [`docs/harness.md`](./harness.md), immediate egress-revalidation claim.

The engine loads one snapshot of approved interactions, verifies pin and artifact integrity, then re-reads only the workstream status immediately before `providerSend`. It never rechecks or atomically claims the interaction's approval state. `rejectSend` accepts any current interaction status.

A concurrent rejection can therefore land after the engine snapshot; the engine can still send and then overwrite `rejected` with `sent`. Existing tests are sequential.

No live `Interaction` records existed, so the race has not caused an observed live send. The code contradicts the advertised contract nonetheless.

**Required repair:**

1. Introduce an atomic, revision-checked egress claim that linearizes `approved` against rejection immediately before the provider call.
2. Revalidate workstream status, current interaction status, pinned adopted revision, and immutable artifact identity in that claim.
3. Make rejection state-sensitive. A rejection that wins before the claim prevents egress; a rejection after the claim must not falsely claim it stopped the send.
4. Durably move the interaction out of a rejectable/sendable `approved` state before the provider call. A pre-call crash after the claim must also enter readback recovery rather than execute from the stale approved snapshot.
5. Preserve the unknown-result rule. A crash after claim must reconcile by provider readback and must never blindly resend.
6. Instrument the simulated provider with an append-only ledger that distinguishes invocation attempts from external effects/receipts. `providerSend` currently overwrites `prov_<interaction>.json`, so two calls still leave one file and the existing cardinality assertion cannot prove the unknown-result protocol. Protect the external effect with the stable interaction idempotency key.
7. Update the harness documentation only after the race test proves the claim.

**Deterministic acceptance tests:**

- Use a barrier between artifact verification and the egress claim. A rejection that crosses first produces zero provider records.
- When the claim crosses first, a later rejection is refused or recorded as too late; provider state and interaction state remain consistent.
- Crash before, during, and after the provider call obey the closed protocol: never retry while the result remains unknown; retry only after authoritative readback proves absence; and produce at most one external effect/receipt under the idempotency key. The ledger may show a later invocation attempt after a prior ambiguous attempt was proven effect-free, and the assertion must distinguish attempts from effects rather than rely on outbox-file cardinality.
- Pausing the workstream before the claim prevents egress.

### P0 — conflicted `finish_pass` can be recorded as completed

**Enforcement sites:**

- [`src/coordinator.ts`](../src/coordinator.ts), `finish_pass` and final pass provenance.
- [`src/engine.ts`](../src/engine.ts), stale lease/pass recovery.
- Coordinator revision-conflict and crash-recovery tests.

`finish_pass` sets the process-local `finished = true` before its revision-checked state change succeeds. If an arrival advances the revision, the finish mutation fails but finalization still computes `outcome = completed`. Because the outcome is considered completed, no reconciliation wake is restored.

This happened in live state:

- 35 passes were `completed` with no summary.
- `pass_06071527` made three writes and never landed its finish summary.
- `pass_a2400021` made four writes and never landed its finish summary.
- `pass_88d4d14c` was woken by founder steering, made zero writes, and was still recorded completed.
- `edp-sync-health/pass_1e6a5df1` remained `running` without a lease; current crash recovery only repairs the pass referenced by a present expired lease.

Later arrivals and backstops repaired progress in the observed examples, but provenance is false and steering can be delayed.

**Required repair:**

1. Set `finished` only after the revision-checked finish mutation succeeds.
2. Latch revision conflicts for the pass so a tool error cannot later be mistaken for successful completion.
3. Add an explicit `conflicted` pass outcome rather than treating an expected external arrival as a model failure or ordinary `no_finish`. It must always create an immediate reconciliation wake and must not contribute to the three-logical-failures attention card.
4. Do not consume steering or manager directions unless the successful finish mutation records that consumption.
5. Sweep orphan `running` passes independently of the currently stored lease.
6. Add an inspect/audit signal for impossible pass combinations such as `completed` without a summary.
7. Update the pass outcome schema plus stats, status, and inspection renderers for the new conflict outcome.

**Deterministic acceptance tests:**

- Inject an arrival between projection read and `finish_pass`; the pass is not completed and an immediate wake exists.
- Three consecutive revision conflicts do not increment the logical failure streak or page the human.
- Inject founder steering immediately before `finish_pass`; the steering remains unconsumed for the next fresh pass.
- A later successful pass consumes the steering exactly once.
- A `running` pass without a current lease is repaired on the next tick.
- A `running` pass with a matching unexpired live lease is not repaired by the orphan sweep.

### P0 — model-authored action verification is an unsupervised egress path

**Enforcement sites:**

- [`src/engine.ts`](../src/engine.ts), `verifyAction`, action auto-approval, and the post-worker verification call.
- Action creation schema/tooling in [`src/coordinator.ts`](../src/coordinator.ts).
- [`src/engine.test.ts`](../src/engine.test.ts), including the current test that calls verification on a gated unapproved action.
- The action/readback contract in [`docs/harness.md`](./harness.md).

`verifyAction` executes the model-authored `exec.verify` shell string with workstream secrets. It does not require approval, a claimed/executed action state, or Pilot supervision. Existing tests call it successfully on an action that is still gated and unapproved. Worker-action auto-approval only proves Pilot was alive because the worker's tool calls are supervised later; the separate verification shell does not pass through that supervision.

A mutating command can therefore masquerade as deterministic readback. No live bypass incident was established, but this breaks the claim that verification merely observes an external fact.

**Required repair:**

1. Refuse verification unless the action was approved and has a durable execution/attempt state that legitimately requires readback, including crash-after-possible-egress recovery.
2. Require a typed read-only provider adapter or a genuinely read-only execution substrate and credential set. Pilot approval supplies authority but does not make arbitrary shell observational: a verifier must be unable to create the fact it later “observes.” If legacy shell verification remains, supervise it through Pilot as an additional gate and document it explicitly as a trust boundary rather than calling readback structurally read-only.
3. Do not load or expose action secrets until the eligibility and supervision checks pass.
4. Keep verification separate from adoption: passing supervised readback still only establishes an external fact candidate.
5. Record enough verifier provenance to show what was approved, what ran, and which read-only/provider result supported the Boolean.

**Deterministic acceptance tests:**

- A gated, unapproved, Pilot-denied, or never-attempted action cannot execute its verifier.
- A deliberately mutating verifier is denied by the read-only adapter/substrate and produces no external/local mutation; the test must not rely only on one Pilot command rule.
- A valid read-only verifier after an approved attempt runs once, redacts secrets, and records its result.
- Crash recovery can verify a possibly executed action without re-running the action itself.

### P0 — conclusion evidence can self-certify success

**Enforcement sites:**

- [`src/conclusion.ts`](../src/conclusion.ts), `conclusionEvidenceLabels`.
- The `conclude_workstream` tool in [`src/coordinator.ts`](../src/coordinator.ts).
- Conclusion schema, inspection, stats, and conclusion tests.

Any standing decision currently qualifies as conclusion evidence. Production `record_decision` always creates coordinator-authored decisions, so a coordinator can create an ordinary standing decision and immediately cite it to conclude its own workstream. The 21 live decision references passed this permissive gate; the audit did not independently prove that each was a legitimate “decide not to act” business outcome.

This also makes a “qualified typed conclusion” unsafe as the denominator for policy promotion or outcome metrics until the gate is repaired.

**Required repair:**

1. Remove generic standing decisions from the success-evidence vocabulary.
2. Require a typed evaluation against the workstream's success criteria. Adopted deliverables and accepted, successfully verified actions are supporting evidence, not success by themselves; a research note or intermediate PR-open action cannot self-certify an unmet objective.
3. Represent legitimate non-action closure—such as a human decision not to purge, or an evaluated finding that no change is required—with a typed evaluated closure/result carrying source and authority provenance. Do not infer it from a coordinator-authored decision title.
4. Audit all existing conclusions and preserve their historical references. Mark conclusions that only pass the old standing-decision rule—or lack criterion-by-criterion evaluation—for review rather than rewriting or deleting them.
5. Prevent policy promotion and successful-outcome stats from treating a legacy/unqualified conclusion as success.

**Deterministic acceptance tests:**

- A newly recorded ordinary standing decision cannot conclude a workstream.
- A generic adopted research note or intermediate accepted action cannot conclude an unmet objective.
- A criterion-by-criterion typed evaluation can conclude when its supporting adopted/verified evidence satisfies the declared workstream criteria.
- A typed human/evaluated “no action” closure can qualify without fabricating an external effect.
- Legacy conclusion references remain inspectable and are classified as qualified or review-required under the new evidence version.

### P0 — policy application and promotion are not structurally attributable

**Enforcement sites:**

- [`src/coordinator.ts`](../src/coordinator.ts), `record_decision` and `record_policy_outcome` tools.
- [`src/policies.ts`](../src/policies.ts), proposal, evidence, promotion, and supersession.
- Policy-store schema/versioning, all three store backends (filesystem, SQLite, and PostgreSQL), and policy journal/printout compatibility.
- [`src/policies.test.ts`](../src/policies.test.ts), migration tests, and printout/inspection tests.
- [`docs/learning.md`](./learning.md) and public claims.

**Required repair:**

1. Validate every applied policy ID at decision-write time: existence, non-superseded status, and application-time scope match. Persist enough policy revision and workstream-tag provenance to keep that judgment stable if tags or policy scope later change.
2. Make live proposal provenance mandatory and structural: resolve the source workstream/pass and a real correction record, distinguish correction from fact supply and routine approval, and reject dangling or mismatched proposal scope. The relationship must be inspectable; a free-text intervention summary is not enough.
3. Make the applying decision ID mandatory in policy evidence.
4. Define an idempotent cross-store handshake/reconciler for workstream decision state and the independently revisioned global policy store, or explicitly extend every backend with a joint transaction. Do not simulate atomicity with two writes. The protocol must tolerate crashes, conflicts, and retries at both write boundaries without orphan proposals, duplicate evidence, or false promotion.
5. Require mutation/revision ordering that proves the application preceded the outcome. A decision and later qualified outcome may validly occur sequentially in the same pass.
6. Replace the unqualified model Boolean with a typed, attributable relationship between the policy application point, any correction on that point, and the qualified outcome. Do not treat every later approval, attention resolution, or unrelated steering act as a policy failure; expected authority gates and unrelated direction are not corrections.
7. Link evidence to a typed criterion evaluation, evaluated result, or qualified conclusion after the conclusion gate is repaired. Adopted deliverables and accepted verified actions may support that evaluation but are not successful outcomes by themselves.
8. Decide and document whether promotion requires a different later matching workstream. This would deliberately strengthen the current “a matching workstream” rule; it is recommended because source-only self-validation is weak, but it is a kernel/docs decision rather than an implementation inference.
9. Reject evidence against superseded or nonmatching policies.
10. Add a non-mutating policy integrity audit that reports dangling/mismatched proposal provenance, dangling citations, mismatched scope, impossible pass references, unsupported active status, and contradictory active candidates.

**State remediation:**

- Snapshot and CAS against the global policy revision before any migration. Make the migration staged, idempotent, conflict-safe, and reversible through lineage.
- Preserve all 178 legacy evidence rows unchanged. Add evidence-version and eligibility metadata rather than rewriting their historical Booleans or notes.
- Preserve legacy proposal provenance unchanged and report optional, dangling, or non-correction sources as structurally unverifiable under the new version.
- Produce an operator-review report before changing which policies enter active projections. Automatically demoting global policies can change every active coordinator's input.
- Re-evaluate all 25 active policies under the chosen promotion rule, with unsupported records staged for review rather than silently blessed or destructively rewritten.
- Preserve the decision containing the dangling `pol_1ae2443c` citation. Attach an integrity finding or supersede the bad decision through supported lineage; never edit or delete its historical citation in place.
- Reconcile the seven active source-only policies, including `pol_615bacd8`, without counting it as an eighth case.

**Deterministic acceptance tests:**

- Nonexistent, superseded, and scope-mismatched policy citations fail.
- Evidence without the applying decision, matching pass/workstream, or qualified later outcome fails.
- A proposal without a real attributable correction source fails; fact supply and routine approval do not masquerade as correction.
- Proposal and application-to-evidence protocols recover idempotently from crashes at either side of both workstream/policy-store write boundaries.
- Concurrent outcome recording and policy supersession cannot append evidence to or promote the losing/superseded policy.
- If the strengthened later-workstream rule is adopted, a same-source successful episode alone remains shadow and a different later matching outcome promotes exactly once.
- A correction attributable to the policy's point suspends or reviews an already-active policy and blocks an unsupported pending promotion; unrelated steering and expected approval gates do neither.

### P0 — policy correction and semantic authority firewall are incomplete

**Required repair:**

1. Replace the current two-mutation helper before exposing it: it creates a replacement first and supersedes the old record second, so a crash leaves both active. Build new replacement plus symmetric lineage in one policy-store mutation, or link to an already-existing replacement in one mutation. The old record needs `supersededBy`, the replacement needs `supersedes`, and writes need existence, cycle, status, correction-source, and concurrent-supersession checks.
2. Expose that lineage-preserving operation through a coordinator mutation tool and inspection/CLI surfaces.
3. Add a typed `needs_review` or contested state for negative evidence. Negative evidence must not automatically demote or supersede: some policies have valid positive and negative cases because their preconditions differ. A contested active policy must stop being projected as unqualified active guidance until reviewed.
4. Resolve the active merge contradiction. The replacement policy must say that it applies only when current workstream constraints already grant the authority and the required evidence is present.
5. Add a typed immutable authority-basis reference at the action boundary—likely to constraint provenance or a human approval/grant record—and optionally carry it on the applying decision for explanation. Current constraints are un-IDed strings and all observed decisions were coordinator-made, so “cite the standing human decision” is not implementable today.
6. Use the typed action authority basis as the primary semantic firewall and prevent an applied policy ID from satisfying it. Apply an improved lexical refusal to live proposals as defense in depth; the current `grantsAuthority` regex would not reject `pol_114df4c4` because its wording includes “only.”
7. Preserve actual action gating through Pilot and readback; policy status must never bypass it.

**Deterministic acceptance tests:**

- Live proposals containing grant-shaped language are refused even when their shape says `widensAuthority: false`.
- A policy can advise how to act under an existing immutable grant reference but cannot manufacture the grant or serve as an action's authority-basis reference.
- Supersession removes the old policy from active projection while preserving lineage in inspection.
- An existing policy can supersede an older policy without creating a duplicate, and cycles are rejected.
- Negative evidence on an active policy produces a contested review path; review may narrow, supersede, or retain the policy with corrected preconditions.

### P1 — projection and decision state are unbounded

**Enforcement sites:**

- [`src/projection.ts`](../src/projection.ts).
- Coordinator tool descriptions and system prompt in [`src/coordinator.ts`](../src/coordinator.ts).
- Decision/deliverable relationships in [`src/types.ts`](../src/types.ts).
- Longitudinal projection tests.

**Required repair:**

1. Keep all typed history authoritative and inspectable; do not replace it with a generated summary.
2. Add typed deliverable lineage/relevance before projecting only current accepted heads. Deliverables currently have adoption but no supersession/head relationship, and decisions do not structurally identify required deliverables; pruning without that schema could hide a required input.
3. Project live assignments, unresolved candidates, and the minimal failed-attempt facts necessary to shape a retry—not every completed assignment forever.
4. Keep only genuinely standing commitments in the authoritative decision section. Decisions currently support only `standing | superseded`, not a generic closed state; require a new routine-cycle course to explicitly supersede the prior course unless closure semantics are deliberately added to the schema.
5. Store sweep reports, poll results, and cycle history as deliverables/results rather than permanent decisions.
6. Render compact lineage pointers for superseded decisions; full rationale stays in inspection state.
7. Make policy projection selective enough that hundreds of broad matching candidates do not consume the coordinator context.
8. Define and enforce a deterministic projection-size budget using a multi-cycle routine fixture.

**Acceptance criteria:**

- A routine can run for hundreds of cycles without projection size growing linearly with completed work.
- A fresh coordinator still receives all current authority, unresolved work, waits, applied-policy obligations, and evidence needed to continue correctly.
- No generated summary can complete work, grant authority, supersede a decision, or claim an external effect.
- Supersession and adoption lineage remain inspectable outside the bounded projection.
- Migration of existing routine decisions uses supported, inspectable transitions; it does not bulk-flip standing state or delete history.

### P1 — rejected dependencies can silently disappear

**Enforcement sites:**

- [`src/engine.ts`](../src/engine.ts), runnable-assignment dependency check.
- [`src/worker.ts`](../src/worker.ts), dependency artifact injection.

The scheduler currently treats a dependency as settled when it is `completed` or `cancelled`, while workers only receive dependency artifacts whose adoption is accepted. It also treats an unknown dependency ID as satisfied. Seven live downstream assignments depended on rejected submissions; three later became accepted. Normal coordinator creation validates dependency IDs, but imported, legacy, or corrupt state fails open.

**Required repair:**

- A normal dependency becomes runnable only when the upstream assignment is completed and accepted.
- If downstream work intentionally needs no accepted artifact, represent that explicitly by cancelling/replacing the dependency or introducing a closed “settled without input” relation. Do not infer it from rejection.
- An unknown dependency blocks execution and raises an integrity/audit signal.
- Add tests for unknown, proposed, rejected, accepted, failed, and cancelled dependencies.

### P1 — managed source identity can race

[`src/managedWorkstreams.ts`](../src/managedWorkstreams.ts) and direct CLI creation both perform source-key dedupe as a scan followed by a separate create. Make uniqueness part of `StateStore.create`, backed by atomic filesystem, SQLite, and PostgreSQL enforcement. Backend contract tests must race two different slugs with the same source key. Current live state had no duplicates.

An unreadable workstream must not be silently skipped when checking source-key uniqueness; corruption cannot make an existing identity disappear.

### P1 — local executor containment is an explicit MVP boundary

Normal workers receive the full Claude Code tool surface with permission prompts bypassed. Their prohibition on push, merge, deploy, send, or other intentional remote mutation is prompt text. The repository correctly says substrate containment is the executor's responsibility, but it also describes kind-`action` as the single route for intentional effects.

No bypass incident was found in live state. The structural claim is nevertheless stronger than the local executor guarantees.

**Required position:**

- Do not add a brittle command parser to the durable core.
- Make containment/supervision a declared `WorkerExecutor` contract and fail closed when a production configuration requires exclusive action routing but the executor cannot provide it. A self-declared capability flag is not proof; executor acceptance must behaviorally exercise the boundary.
- Keep the local executor explicitly labelled as an MVP trust boundary until it supplies that capability.
- Ensure public wording distinguishes the intended lifecycle from substrate-enforced exclusivity.
- Add an executor contract test that actually attempts a controlled representative egress from a non-action worker and observes substrate denial when containment is declared.

### P2 — metrics do not measure successful outcomes

**Enforcement sites:**

- [`src/stats.ts`](../src/stats.ts).
- [`src/status.ts`](../src/status.ts).
- Learning documentation and dashboard wording.

**Required repair:**

1. After the conclusion-evidence P0 is repaired, make a qualified typed conclusion or evaluated business result the success denominator.
2. Report adopted work products as a separate leading indicator.
3. Split direct founder acts, founder-via-session acts, autonomous-agent acts, and unattributed legacy residuals.
4. Separate provider backoff from logical coordinator failure.
5. Report worker first-attempt completion, recovery rate, elapsed time, and cost per successful outcome.
6. Compare policy effects only within comparable workstream tags/shapes and only after a stable application boundary.
7. Report Pilot approval separately from learned-policy effects.

### P2 — wake and routine cost hygiene

- Ensure one live commitment per external wait and cancel redundant polls/backstops when the awaited arrival lands.
- Expire or reconcile past-due capacity facts after a successful later pass.
- Add per-routine spend, pass-error, retry, projection-size, and intervention thresholds.
- Treat recurring routines as value/cost portfolios: detector output, verified fixes, false positives, and spend should be visible together.

### P2 — complete the acceptance surface

- Run a live but reversible Interaction/Reply acceptance scenario covering draft, approval, atomic egress claim, provider receipt, unknown-result readback, untrusted reply, and evaluated result. Do not use a real external send without explicit authority.
- Exercise the PostgreSQL contract suite and a fresh-coordinator pass/wake cycle against Postgres.
- After the repair series, freeze the harness version for a one- to two-week cohort before making trend or policy-causality claims.

## Recommended implementation sequence

Keep each pull request coherent and mergeable. Do not combine the policy schema migration with the egress race or projection redesign.

1. **PR 1 — external-effect safety**
   - Atomic send claim and rejection race.
   - Provider attempt/effect ledger and idempotency proof for unknown-result recovery.
   - Approval/state checks and read-only substrate/adapter for action verification.
   - Deterministic verifier-mutation denial.
2. **PR 2 — pass and conclusion provenance**
   - Conflicted `finish_pass` finalization.
   - Orphan running-pass repair.
   - Explicit non-striking conflict outcome.
   - Qualified conclusion evidence and legacy conclusion audit.
   - Deterministic race/evidence tests and harness documentation corrections.
3. **PR 3 — policy integrity contract**
   - Attributable policy proposal provenance.
   - Validated policy citations.
   - Typed application-linked evidence.
   - Typed correction/application-point attribution rather than a self-reported Boolean.
   - Crash-safe cross-store handshake or backend joint transaction.
   - Explicit decision on whether promotion requires a different later matching workstream.
   - Non-mutating integrity audit and compatibility handling for old evidence.
4. **PR 4 — policy correction and authority semantics**
   - Symmetric policy lineage and coordinator supersession tool, including replacement by an existing policy.
   - Contested/negative-evidence review path.
   - Typed authority-source provenance and live proposal refusal.
   - Reconcile contradictory active policies through the supported mutation path.
5. **PR 5 — bounded organizational projection**
   - Decision lifecycle discipline.
   - Active/relevant assignment and deliverable projection.
   - Compact lineage.
   - Long-running routine size test.
6. **PR 6 — dependency and intake integrity**
   - Accepted dependency requirement.
   - Unknown dependencies fail closed.
   - Atomic source-key uniqueness across all store backends.
7. **PR 7 — outcome metrics and stable evaluation**
   - Successful-outcome denominator.
   - Actor and infrastructure separation.
   - Cost/reliability measures.
   - Stable post-fix cohort protocol.

Each PR must update [`docs/harness.md`](./harness.md) and [`docs/learning.md`](./learning.md) only to claims the implementation and deterministic tests actually prove. User-visible behaviour changes also require the corresponding `docs-public/` update.

## Kernel constraints for every fix

The repair work must not gain simplicity by weakening Weaver's thesis:

- Do not resume coordinator or worker sessions across waits.
- Do not turn a generated summary into authoritative state.
- Do not treat worker completion or action readback as adoption.
- Do not retry an unknown external mutation without provider readback.
- Do not let policy data grant or widen authority.
- Do not bypass revision checks to avoid conflicts.
- Do not make research workers artificially less capable; close authority at the action lifecycle and executor substrate.
- Do not delete rejected candidates or superseded lineage merely to shrink the projection.
- Do not add platform machinery where existing workstream, assignment, result, decision, policy, store, and executor concepts suffice.

## Definition of done for the repair programme

The programme is complete when:

1. A deterministic race proves that rejection and send claim are linearly ordered, provider state cannot contradict durable interaction state, unknown results are never retried before authoritative absence, and the idempotency key permits at most one external effect even when the ledger records multiple invocation attempts.
2. A gated, denied, or never-attempted action cannot execute model-authored verification shell; approved verification runs through a typed read-only adapter/substrate and remains separate from adoption.
3. A revision conflict at `finish_pass` records a non-striking conflict, cannot produce a completed pass, consume steering, or leave the workstream asleep.
4. Generic coordinator-authored standing decisions, adopted research, and intermediate actions cannot self-certify conclusion; success requires criterion-by-criterion typed evaluation, while legitimate no-action outcomes use typed qualified closure evidence.
5. Policy proposal and outcome attribution survive crashes/conflicts across workstream and global-policy writes without orphan proposal/evidence state or duplicate promotion.
6. Every earned-active policy has structurally valid evidence linked to an earlier applying decision and qualified outcome under the deliberately chosen source-vs-later-workstream promotion rule; seeded human rules, if retained, have a distinct and explicit trust basis.
7. Contested policies stop projecting as unqualified active guidance, can be superseded by an existing or new policy with symmetric lineage, and no contradictory active merge policies remain.
8. Live policy proposal cannot encode an authority grant, and applying decisions/actions carry immutable authority-source provenance rather than treating the policy as the grant.
9. A long-running routine's coordinator projection remains within a deterministic bound without losing current commitments or authority.
10. Rejected or unknown dependency output cannot silently unlock downstream work.
11. Conclusion and managed-source identities satisfy their stronger structural checks.
12. The outcome dashboard separates successful outcomes, adopted products, provider backoff, worker failures, Pilot approvals, and direct founder interventions.
13. The full deterministic suite, PostgreSQL store contracts, and a fresh pass-and-wake acceptance cycle are green.
14. A stable post-fix live cohort demonstrates outcome quality, cost, reliability, and intervention trends without mixing materially different harness versions.

## Final assessment

Weaver should be kept and hardened. It has crossed the proof-of-concept threshold: durable continuation, bounded worker delegation, adoption, deterministic action readback, crash recovery, managed fan-out, and useful engineering outcomes are all real.

The immediate threat is not that Weaver does nothing autonomously. It plainly does. The threat is that success obscures accumulated ambiguity: giant projections, work logs masquerading as standing commitments, self-certified policy evidence, unresolved policy contradictions, and two concurrency/provenance claims that the code does not yet uphold.

Fixing those issues would turn a convincing autonomous harness into a substantially more trustworthy one. Until then, claim the durable execution result strongly and describe the self-improving-policy result as promising but unproven.
