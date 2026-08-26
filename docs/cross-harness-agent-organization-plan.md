# Weaver-managed team composition with cross-harness workers — consolidated plan

Status: proposed for discussion. This document changes no runtime behaviour.

Date: 26 August 2026

This plan consolidates the team-organization questions behind PRs
[#122](https://github.com/NiallBrickell/weaver/pull/122) and
[#123](https://github.com/NiallBrickell/weaver/pull/123). It starts from
Weaver's existing durable facts rather than the nouns exposed by one agent
harness.

## Recommendation

Do not add `Team`, `Agent`, persona, roster, mailbox, or peer-message records
now.

Use the three execution layers Weaver already has; only managed Workstream
links compose recursively:

- a **Workstream** owns an outcome or enduring function and may directly manage
  more Workstreams;
- an **Assignment** is one bounded responsibility inside one Workstream; and
- an **Attempt** is one disposable execution attempt. Model-backed Attempts pin
  their executor, provider, and model; deterministic engine actions are Attempts
  too.

That gives one modeling rule:

> If it owns an ongoing outcome, may wait, or may delegate again, make it a
> Workstream. If it is one bounded responsibility, make it an Assignment. The
> process or engine command that executes it is an Attempt.

The ordinary manager → lead → worker shape is:

```text
Engineering manager Workstream
└── Project lead Workstream
    ├── implementation Assignment → disposable Attempt
    └── security-review Assignment → disposable Attempt
```

An enduring Security function may instead be another Workstream. Only its
direct manager can inspect or direct it, so a sibling Project lead cannot
dispatch to it directly; their common manager must mediate. There is no sibling
dispatch or cross-Workstream Assignment dependency today.

“Manager”, “lead”, and “security” are human-facing names, not mandatory
personas. A single Workstream with generic Assignments remains complete and
normal.

This models organizational responsibility and individual work. It does not
provide a reusable `SecurityReviewer` worker configuration that a human defines
once and selects across unrelated Assignments. Today every Assignment must
materialize its complete specialist instructions in its briefing and acceptance
criteria. The acceptance trigger for changing that is stated below.

Weaver does not normalize or require provider-native subagents. Where a worker
harness independently exposes them, their activity is opaque inside the
top-level Attempt and is not portable topology or Workstream truth.

## Why no Agent identity now

The kernel currently calls Agent “a reusable worker definition”, but Weaver has
never persisted one. The initial schema and every schema since reconstruct
continuity without an Agent record, from typed `WorkstreamDoc` state including
Decisions, Assignments and Attempts, Deliverables, Interactions, Wakes,
Steering, and cited evidence.

The review found no Agent-specific fact required by manager → lead → bounded
worker delegation:

| Required fact | Existing home |
| --- | --- |
| Longitudinal objective, constraints, decisions, waits | Workstream |
| Learning | Fleet policy store, selected through Workstream tags |
| Recursive responsibility | One direct `managedBy` edge; no transitive visibility or control |
| Specialist instructions and acceptance bar for one job | Assignment briefing and acceptance criteria |
| Dependency and adopted-artifact hand-off inside one Workstream | Assignment dependency and Deliverable |
| Capability needed from a worker | Assignment execution requirements |
| Target, session, timing, cost, terminal reason for one run | Attempt |
| History of an enduring specialist function | The specialist Workstream |

A reusable Agent definition designed correctly would not own authority,
intended work, acceptance criteria, organizational ownership, or result history.
It would still add a fleet registry, immutable versions, Assignment linkage,
projection rules, and cross-harness resolution without a current acceptance
scenario consuming those semantics.

There is one honest unresolved boundary. If “set up a security agent” means a
human must define one stable worker/tool configuration once, select it across
unrelated Assignment shapes and Workstreams, switch top-level harnesses, and
later prove exactly which revision ran after every process exited, then an
Agent reference may be earned. The role label alone does not establish that
stronger contract. This plan requires writing and accepting that scenario
before adding the noun.

If the no-Agent recommendation is adopted after that discussion, kernel rule 1
must be reconciled explicitly across `AGENTS.md`, the matching harness and work
board documentation, and PRs #122/#123. The persisted execution identities
would be Workstream, Assignment, and Run (represented by an Attempt carrying a
`runId`); provider agent definitions would remain executor-local configuration,
not Weaver schema identities.

## Existing non-Agent gaps

Recursive composition works, but it does not imply arbitrary graph semantics:

- inspection and manager direction are one hop; direction is advisory and
  never grants the child authority;
- Assignment dependencies and adopted-artifact injection stay within one
  Workstream;
- a parent receives a bounded conclusion/blocker notice, not the child's
  adopted artifact or an evidence snapshot it can adopt as its own input; and
- managed Workstreams are independent outcomes, not a mechanism for splitting
  one Assignment across documents.

Agent identity would solve none of these. The completion-notice path also needs
one missing end-to-end proof: existing deterministic tests call notice delivery
directly, while the engine calls it before the coordinator that may conclude a
child. A real child `tick` must be shown to conclude, persist the parent notice,
and wake the parent without a manual delivery call.

## What humans can configure

The runtime already proves A managing B while B manages C, with one-hop
inspection and advisory direction at each edge. The missing part is
deterministic human authorship:

- `weaver create`, `weaver do`, and browser intake create roots;
- only a coordinator may currently call `create_workstream` and set
  `managedBy`; and
- there is no supported reparenting operation.

The smallest configuration change is a human create-under-parent path using the
existing managed creation semantics. Its contract should be precise:

- the selected parent exists and is active;
- child creation atomically writes the child's single `managedBy` pointer
  through the existing backend create/source-key uniqueness path;
- parent state is never mirrored or transactionally rewritten;
- no fields, policy, capability, or authority inherit implicitly;
- self-parenting is refused;
- retries are idempotent on the request/source key; and
- an existing Workstream is never reparented.

Do not add membership, seats, rosters, reporting graphs, or transitive manager
control. Existing roots remain valid; no Workstream has to belong to a team.

“Flat” must consistently mean one-hop inspection and advisory direction, not
“links cannot compose”. The TUI already renders read-only indentation, while
older public copy says Weaver never renders a tree. Documentation should
describe the contract rather than its current display bound: visual composition
is a read-only projection of direct edges and never adds inspection, control,
or authority at another edge.

## Dashboard verdict

The recent dashboard work is the right foundation. It is Workstream-first,
keeps Assignments as intended work, nests Attempts as provenance in the static
inspector, and answers the five human questions from typed state.

The current split is narrower than “the dashboard lacks teams”:

- the shared view model already carries `managedBy`, direct children,
  Assignment acceptance criteria, and Attempts;
- the static browser fleet and detail pages render relationship labels and the
  complete Assignment/Attempt record;
- the live operator board and Workstream workspace do not render their
  already-present manager/child fields; and
- live intake cannot create beneath a selected parent.

The team-facing UI slice should therefore add parent selection at creation,
direct relationship badges/links, and either show acceptance criteria, Attempts,
and the Assignment archive or link clearly to the complete static record. Do
not build Agent cards, an org-chart source of truth, or recursive nesting across
status lanes.

## Relationship to PR #122: execution profiles

Keep the core of PR #122: profiles are closed Assignment capability/routing
keys, orthogonal to organizational role, and the chosen top-level target is
pinned on the Attempt.

Revise it before merge:

- replace “Agent definitions were absorbed” with the narrower fact that Weaver
  has no portable Agent catalogue and profiles do not create one;
- state that only checked-in registry convention keeps `general` unrouted —
  current `routeMatches` would accept it;
- describe profile → route as a reviewed registry declaration, not a typed
  schema join, because eval results do not carry an Assignment profile; and
- say the auditor enforces each route's declared `evidence.minRuns`; active
  routes declare ten, but there is no separate global minimum.

Profiles answer “what capability does this Assignment need?”, never “who is
this team member?”.

## Relationship to PR #123: Assignment templates

Do not implement PR #123 as team setup. Templates solve a separate possible
requirement: a named, versioned work contract reused across future Assignments.
That requirement has not been established by the topology itself.

The proposed plan also promises `templateRef` provenance while leaving
`create_assignment` unchanged, gives template tags no Assignment destination,
and introduces a new store, version history, CLI, projection section, and
import/export path before its acceptance trigger is agreed.

Hold templates behind a concrete trigger: an operator needs to enforce and
audit one named work standard across Workstreams, including which immutable
version each Assignment materialized. If that case arrives, the existing
Assignment mutation path must expand or validate the template, copy every
template-owned field plus the per-instance contract into the Assignment, and
write the explicit `templateRef`. The result remains an authoring/provenance
feature, not a worker identity.

This later template decision gates nothing else in this plan. Human composition,
dashboard completion, cross-harness worker portability, and the named-specialist
question proceed independently.

Until then, the self-contained Assignment brief is the only cross-harness work
contract guaranteed today. Workstream constraints, standing decisions,
doctrine, and repository rules are sources a coordinator may use to compose
that brief, not portable substitutes for it.

## Cross-harness boundary

> Current portability means the same semantic `work` Assignment contract can
> run on four worker substrates. It does not mean coordinator, action, MCP, or
> native-team parity.

Weaver launches one top-level worker loop per model-backed Attempt, supplies the
materialized Assignment contract, and records that top-level
executor/provider/model target. It does not record the identities or targets of
harness-native children.

Upstream Claude teams, Claude SDK subagents, Codex custom agents, and Pi
extension-defined subagents expose different configuration and lifecycle
models. Weaver does not currently normalize or acceptance-test them as an
in-Attempt team mechanism. See the official
[Claude teams](https://code.claude.com/docs/en/agent-teams),
[Claude SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents),
[Codex custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[Pi SDK](https://pi.dev/docs/latest/sdk), and
[Pi subagent extension](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
documentation.

Managers currently run through Weaver's Claude or Codex coordinator adapters;
Claude, Codex, Pi, and OpenHands can run reversible worker Assignments. Adding
another coordinator adapter is an executor-seam change, not a reason to add
Agent state.

## Delivery sequence after discussion

No step below is authorized by this plan PR. Implementation begins only after
the architecture discussion closes.

1. **Reconcile the kernel terminology and plan PRs.** Correct the “flat” wording
   and PR #122's routing claims, publish one composition recipe using Workstream
   → managed Workstream → Assignment → Attempt, and hold PR #123 behind its
   named/versioned-contract trigger. Amend the Agent line only if the no-Agent
   recommendation is accepted.
2. **Prove one human composition path.** Add CLI create-under-parent first,
   backed by the shared managed-creation path and deterministic filesystem and
   Postgres tests for all invariants above. Reuse that primitive in browser
   intake only afterwards, preserving its auth, CSRF, and request-idempotency
   protections.
3. **Finish the live view.** Render the already-derived direct relationships in
   the live operator UI and expose or link its omitted Assignment acceptance,
   Attempt, and archive evidence. Do not rebuild the static inspector or TUI.
4. **Prove the rails deterministically.** Test recursive creation, one-hop
   access, no inheritance/reparenting, and an actual child-tick conclusion that
   stores a notice and wake on its parent. Model quality must not decide these
   tests.
5. **Prove executor portability separately.** Run the same stored `work`
   Assignment scenario as a live smoke/eval under Claude, Codex, Pi, and
   OpenHands workers. Separately run the same stored topology first with a
   Claude coordinator and then a fresh Codex coordinator. Disposable model
   processes and sessions must not resume; the resident Weaver runner need not
   be killed.
6. **Resolve named-specialist configuration from a failing scenario.** Before
   adding schema, specify the define-once/select-across-Workstreams/harnesses
   scenario above and the attribution it requires. Add a minimal Agent
   definition only if that requirement is accepted and cannot be represented
   without competing truth. This decision is not blocked on templates.
7. **Revisit other relations only from evidence.** A failing real scenario may
   instead require sibling dispatch, a cross-Workstream adopted-artifact
   hand-off, or direct manager review of child work. None should be smuggled in
   as Agent or Team machinery.

## Non-goals

- no Team, user, organization, membership, RBAC, roster, or matrix-reporting
  entity;
- no persistent coordinator or worker session;
- no provider-native mailbox or shared task list as durable truth;
- no persona requirement for ordinary work;
- no exact model/provider choice on Workstream or Assignment; and
- no implementation or migration in this plan PR.
