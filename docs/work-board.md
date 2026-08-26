# The work board

The browser surface is a visual index of Weaver's durable work, not a monitor
for agent sessions. One fleet card is one Workstream. Inside that home, one
work card is one Assignment. Attempts remain provenance on an Assignment and
never become intended work.

## Evidence audit

The redesign was checked against the live fleet on 14 August 2026, not only
against fixtures:

- 76 Workstreams: 20 active, four paused, and 52 concluded;
- 933 Assignments, of which only three were open and running at the snapshot;
- 726 adopted Deliverables and 232 standing Decisions;
- one item genuinely needed a person and 67 Wakes were pending;
- the fleet inspector flattened the live Workstreams into a table and exposed
  ordinary Assignments nowhere;
- the removed activity feed advanced one global cursor whenever any inspector
  page was generated, before browser delivery was known, and omitted
  assignment, attention, steering, wake, reply, and recovery transitions;
- SDK dollar estimates had already been removed from the compact terminal
  board but were still presented in status, inspector, printout, stats, and a
  manager projection.

The previous two inspector passes reduced a 666 KB wall of cards and then
folded long rows. They improved density, but the page still exposed Weaver's
schema as sections explained by prose rather than giving the work a visual
home.

## Reference patterns

- [OpenAI Symphony](https://github.com/openai/symphony) uses durable work items
  as the orchestration control plane, lets dependencies unlock dispatch, and
  returns proof for review. Weaver borrows the board and proof-packet shape,
  not a tracker status as authoritative state.
- [Spotify Xirp](https://xirp.spotify.com/) puts work, ownership, documents,
  and context around one recognized object. Weaver borrows that object home,
  not a broad internal-developer-portal charter.
- [Scape Argus](https://www.scape.work/docs/argus) makes manager/child status,
  routines, and cadence visually scannable. Weaver borrows the scan pattern,
  not its session-backed continuity: every Weaver coordinator still exits and
  resumes only from typed state.

Linear's transferable interaction pattern is the same narrow one: stable card
identity, filters, and a detail view that does not lose the board position.
None of these references changes Weaver's identities or authority model.

## Root failure

The browser information architecture was organized around records (decision
lineage, actions, deliverables, policies, interventions) and a global activity
feed. The recognized durable objects—Workstreams and their Assignments—were
not the primary visual structure. Consequently the page needed sentences to
explain each internal noun, ordinary work was invisible, and a returning
person had to reconstruct the current position from counts and history.

## User jobs

### Return to the fleet

When I reopen Weaver, I need to distinguish outcomes moving, waiting, needing
me, or deliberately paused, so I can recover the organizational position in a
glance.

Evidence required: Workstream identity, current course or bounded work, exact
wait or human decision, next timing, and recent typed movement. It does not
require session, model, token, pass, or SDK-cost telemetry.

### Inspect one outcome

When a Workstream matters, I need one home for its objective, current truth,
bounded Assignments, accepted evidence, and next safe move, so I do not have to
reconstruct it from a transcript or lifecycle tabs.

### Review bounded work

When an Assignment reaches review, I need to see its acceptance state and
evidence without confusing worker completion with coordinator adoption.
Attempts may explain execution but cannot define the card's lane.

### Trust a routine

When a recurring Workstream is quiet, I need its next wake and latest
substantive position, so an empty pulse does not become attention.

## Entity and truth model

### Workstream

- canonical identity: `WorkstreamCore.slug`;
- home: `<slug>/inspect.html`;
- index card: fleet board;
- board lifecycle: needs you / in motion / waiting / ready / done; pause is a
  visible waiting state, while ready distinguishes planned from unscheduled;
- child records: Assignments, Decisions, Deliverables, Wakes, Attention,
  Interactions, and typed evidence;
- manager lineage is a label and link, never authority roll-up.

### Assignment

- canonical identity: `(workstream slug, assignment id)`;
- home: the Work section of its Workstream;
- lanes: planned (`queued`), working (`running`), review
  (`awaiting_review` or gated approval), accepted (`completed` plus accepted
  adoption);
- failed, cancelled, rejected, superseded, and completed-but-not-accepted work
  remains archived and inspectable, never green;
- Attempts attach as provenance and cannot move the Assignment to Accepted.

The reusable Agent identity is not persisted today, so the UI does not invent
an Agents or Sessions destination.

## Attention contract

Needs-you remains a filtered overlay over its owning Workstream, admitted only
for an open Attention item, a human-gated Action, or a Send awaiting approval.
It does not copy or mutate the owning record. The terminal dashboard remains
the control surface and its first-class human mutations remain the only action
path.

## Surface contracts

| Surface | Answers | Owns | Excludes |
| --- | --- | --- | --- |
| Fleet board | Which outcomes need me, are moving, are waiting, or have no scheduled move? | Workstream cards, compact human decisions, waits, manager/routine labels | Runs, raw policy inventory, SDK estimates, generic activity feed |
| Workstream home | What is this outcome, what bounded work exists, what is accepted, and why? | Assignment board, current course, conclusion/evidence, history disclosures | Other Workstreams' truth, duplicate global controls |
| Learned | What reusable policy evidence exists? | Policy store | Fleet status |
| Printouts | What exact organizational window was delivered? | Immutable acknowledged catch-up archive | Live board state and SDK estimate telemetry |
| Stats | Is intervention load improving without weakening quality? | Outcome and intervention evidence | SDK dollar estimates as spend or progress |

## Implemented ownership map

- Fleet table → Workstream board.
- Global activity feed → recent typed movement highlighted on the Workstream
  that owns it; the acknowledged printout remains the exact catch-up document.
- Task section → Workstream header and Position panel.
- Hidden ordinary Assignments → Work board.
- Decision lineage, Deliverables, Actions, Policies, Interventions → Evidence
  and History disclosures below current work.
- Global policy cards → existing Learned page.
- SDK estimates → retained only as raw stored diagnostic provenance, not
  rendered in operator, managed-Workstream, printout, or stats views.

## Read-model contract

The Assignment board is a pure projection over one `WorkstreamDoc`. It groups
by Assignment and adoption state, resolves dependency acceptance from the same
document, carries typed submission/action/readback facts, and keeps Attempts
as metadata. It never mutates state or infers success from prose.

The fleet board derives each lane from stored needs, Assignment state, leases,
Wakes, pause, and conclusion. Running, review, pilot-approved dispatch, and a
live lease count as In motion. Queued work is Ready: intended work exists, but
no execution has begun. Paused or scheduled work is Waiting. A Workstream can
no longer render unscheduled while the terminal dashboard says bounded work
exists.

### Plain-language projection

The primary surface names the person's position, not the schema. A fleet card
has one **Now** sentence derived from typed attention, the active Assignment,
or the next Wake; one timestamped **Course** line; and, when recent, the latest
human direction or substantive typed movement. It does not show aggregate
open/accepted/pinned counts because those are record inventory rather than a
next move. The same acceptance boundary is named consistently: a worker offers
a **Proposed result**, and coordinator adoption makes it a **Result accepted**
or **Accepted work**.

Storage ids (`asg_*`, `dec_*`, `pass_*`, `run_*`) remain available only under a
closed **Technical details** disclosure. Compact prose replaces references to
those ids with recognized nouns while preserving PR numbers, branches, issue
numbers, and commit hashes. This is a display-only projection; it never rewrites
stored evidence or becomes coordinator input.

Human steering is projected from `WorkstreamDoc.steering`, never the bounded
event tail. The newest unwithdrawn direction sits above the recorded course
with its exact physical timestamp and says **Waiting for Weaver** or **Read by
Weaver**. Read is deliberately weaker than applied: `consumedByPass` proves a
pass received the steer, not that a particular decision implemented it.
Withdrawn direction remains in typed history. Decisions retain their separate
organizational timestamps, and the two clocks are never naively sorted into one
authority timeline.

The inspector is a static artifact, so every Workstream page names the source
revision and generation time. An already-open tab does not claim to be live;
regenerating it remains read-only and never advances the printout checkpoint.

## Implemented architecture

`src/inspect.ts` is now only the store, redaction, and publication boundary.
Pure view models and React server-rendered components live under
`src/ui/inspect/`; Tailwind v4 is compiled into the self-contained static HTML.
There is no web server or browser-side state authority, and the existing
terminal mutations remain the only control path.

The implementation:

1. projects the fleet as Workstream cards in Needs you, In motion, Waiting,
   and Ready, with search, recent/routine filters, bounded lanes, and Done
   folded below the live board;
2. projects each Workstream's Assignments as Planned, Working, Review, and
   Accepted, using a pure read model with deterministic fixtures;
3. makes current work primary and keeps Decisions, Deliverables, Actions,
   Interactions, Policies, archived Assignments, and Attempts inspectable as
   evidence and history;
4. removes the inspector read cursor entirely—generating a page never claims a
   person viewed it, while the acknowledged printout remains the exact
   catch-up boundary; and
5. removes SDK dollar estimates from status, tail, tick, inspector, printout,
   stats, and manager projections while retaining backward-compatible stored
   telemetry for diagnostics. Evaluation-only cost reporting is unchanged.

## Acceptance walkthrough

The result is complete only when a person can point to the UI and answer:

1. Which Workstream needs me, and what decision is it waiting for?
2. Which outcomes need me, are in motion, waiting, or ready for a next move?
3. What bounded Assignment is currently planned, working, in review, or
   accepted inside one Workstream?
4. Why is an accepted card authoritative, and where is its pinned evidence?
5. What will a routine do next and when?
6. What changed on a particular outcome without reading a global event feed?
7. Where are failed/rejected work and disposable Attempts available without
   becoming current inventory?
8. Can every page be understood without SDK-cost, pass-count, or session
   telemetry posing as progress?
9. What did I most recently tell this Workstream, when, and has Weaver read it?
10. Which recorded commitment currently controls, and when was it set?

## Next surface

The implemented board remains the fleet overview. A live workspace for
starting work, contributing evidence, reading answers and correlating adjacent
systems is planned separately in [Operator workspace and fleet integration
plan](./operator-workspace.md); it remains a projection over the same typed
Workstreams rather than a conversation-backed workflow.
