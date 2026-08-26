# Operator workspace and fleet integration plan

Weaver already has the right durable objects and a substantial read-only work
board. The next product step is not another workflow model. It is a private,
live workspace over the existing typed fleet: somewhere a non-technical
teammate can start work, understand why it is or is not moving, add evidence,
and receive the evidenced answer without learning the CLI.

The board and the workspace are separate jobs:

- the **board** answers where every outcome stands;
- the **workspace** is where a person starts or selects one outcome, adds
  information, watches its typed progress, and reads its answer and evidence.

The browser may look conversational, but a conversation is never the
container. Creating a new UI “thread” creates a Workstream. Its centre feed is
a projection of typed direction, observations, decisions, Assignments,
adoptions, attention and conclusions. Reloading it from the store must recover
the same organizational position without reading chat prose.

## Retrospective evidence

This plan follows a read-only fleet audit on 25 August 2026:

- 61 Workstreams: 34 concluded, 22 active and five explicitly human-paused;
- 1,132 completed Assignments and 904 adopted Deliverables;
- 93.1% of completed Assignments finished on their first attempt, and 78 of
  the 86 terminal Assignments that needed a retry recovered (90.7%);
- successful outcomes reached conclusion in a median 23.5 hours (p90 4.6
  days);
- since 19 August, 1,039 coordinator passes completed, 831 were typed provider
  backoffs, 42 were revision conflicts, and one was a logical failure;
- the current 17 approval cards all came from one unavailable Pilot instance,
  affecting 13 active Workstreams; the fleet remained safe, but one shared
  incident appeared as many unrelated requests;
- no active Workstream was silently abandoned, but one objective-complete
  Workstream remained active and dormant solely because an unrelated,
  explicitly non-blocking credential-review card prevented conclusion.

The harness is therefore doing the hard part well: intended work survives
provider failures, retries recover, results are adopted separately from worker
completion, and outcomes conclude on evidence. The weak point is operator
comprehension. Shared infrastructure failures fragment into per-Workstream
noise, remediation is written for a CLI operator, and the static inspector
cannot accept work or show a live position.

## Product contract

### Fleet board

The existing Needs you / In motion / Waiting / Ready / Done model remains the
fleet index. Replace the four equal-width browser lanes with a persistent,
collapsible Workstream list for the live workspace, while retaining the board
as a separate overview route.

The list groups rather than tabs:

1. Needs you;
2. Working;
3. Waiting;
4. Ready;
5. Done, folded after a bounded recent set.

An urgent item in another group must never be hidden behind a selected tab.
Each row needs a one-line title, state and compact age. The group count is
labelled as jobs; a per-row count is labelled as asks so those two quantities
cannot look contradictory. Runs, sessions, pass counts and model tokens remain
detail, not work identity. Empty groups do not consume space.

### Workstream workspace

Selecting a Workstream opens a two-level workspace with one visual centre:

- **Left — Jobs.** The grouped fleet list, an explicit shared/local scope
  label, overview, and “New job”.
- **Main — One job.** A URL-addressable Overview / Work & results / Activity /
  Details navigation renders one bounded job mode at a time. Scrolling is for
  reading the selected mode, never for finding another unrelated part of the
  workspace.

The former persistent right inspector was removed after live use showed that
standing course, Assignments, and Deliverables formed a competing second
centre. It also repeated the same current attention through Current position,
Now, Needs you, Next, the timeline, and the sidebar. The durable state had one
Attention item; the repetition was entirely a view-composition defect.

The five-question contract remains a comprehension test, not five mandatory
cards: the header/objective answers why; Overview answers now, needs me and
next; Activity provides a bounded catch-up without pretending that opening the
page was a read receipt. The exact open attention appears once. If it contains
labelled A/B/C choices, Overview separates them into real form controls without
mutating the source fact; each can carry a condition, and a custom answer is
always available. Its full text remains folded. Routine Wakes and the current
attention do not repeat in the primary catch-up.

Work & results leads with a bounded human reading: the objective and the first
sentence of an accepted result. Exact worker prose remains available under a
per-result disclosure, and older accepted results are grouped under one more.
Details keeps record metadata visible while all Assignments and the full typed
chronology remain separate disclosures. This preserves agent-useful evidence
without making it the default human interface.

Approval-needed outranks “working” in every activity label because the person,
not the agent, is then the blocker. The main surface is not a model chat
session. Decisions remain the commitment layer, an Assignment submission
remains proposed, adoption remains explicit, and a conclusion remains the
evidenced answer.

### Starting and continuing work

The minimum intake is one text area: **What needs doing?** A second field says
**Done means**; composition under a parent is an Advanced control. A source URL or external identifier, when present,
becomes the stable source key so repeated intake returns the same Workstream.

Intake must remain available when every model provider is unavailable. The
request is first stored deterministically with the machine's house constraints
and an immediate wake. Naming and brief refinement may use the existing
derivation path, but failure can affect only presentation; it cannot lose or
delay the request.

There are two different continuation acts:

- a teammate contributes **an Observation**: untrusted evidence which wakes
  the Workstream but cannot change direction or grant authority;
- an operator contributes **Steering**: authoritative human direction, with an
  explicit actor and the existing revision-checked mutation path.

The UI must label them differently. Reusing `onboard()` unchanged for every
teammate would be wrong because its de-duplication path attaches a message as
human Steering. Team intake should use `createOrGetWorkstream()` and
`recordObservation()`; operator intake may use the full derivation and Steering
path.

A browser decision response remains in the Observation lane. The server binds
the form to the exact typed source id, need kind, and raw-summary digest, then
rebuilds the current need and validates a labelled option from the server-side
parser before writing. Each rendered form has its own retry id: an exact retry
deduplicates inside the serialized arrival mutation, while a newly rendered
form may intentionally add a further condition. Closed, changed, ambiguous, or
tampered needs fail closed. The shared Basic-auth username is caller-supplied
provenance, so it must never be promoted into Steering or action authority.

Priority remains human resource policy. A reporter may state that an incident
is urgent, but that statement is an Observation unless the authenticated actor
has the explicit priority capability. The coordinator cannot promote its own
Workstream above the fleet.

## Fleet health

Health must be a deterministic projection so it continues to explain an
outage when no model can run. Add one shared `fleetHealth` read model over:

- `capacityPresentation()` for every active Workstream and every configured
  coordinator/worker target;
- fresh provider-reported headroom, with missing telemetry rendered as unknown;
- the runner heartbeat, only when the UI is collocated with that runner;
- unreadable Workstream documents;
- Pilot unavailability grouped from gated Assignments by the shared dependency
  and first-failure window;
- stale attention whose underlying typed condition has already recovered.

The output describes one incident once, then names affected Workstreams. It
must answer:

1. Is Weaver itself running?
2. Can a coordinator and worker start now, including fallbacks?
3. Is intended work safe and queued, or could an external effect be unknown?
4. How many outcomes are affected?
5. What single human action, if any, can change the position?
6. What evidence will prove recovery?

For example, one unavailable approval service should render as one fleet
incident with 13 affected outcomes, not 17 unrelated approval failures. A
limited primary with a usable fallback is degraded, not down. A provider usage
or billing limit may link to that provider's settings, but Weaver never changes
billing, rotates credentials or retries a capacity pool without recovery
evidence.

The browser board currently derives waits directly from Wakes while the
terminal/status surfaces use `capacityPresentation()`. Extract a shared
organizational-position projector before making the browser live so all three
surfaces make the same capacity claim.

Store scope and runner liveness are separate claims. A Postgres-backed UI is
reading the **Shared fleet**; absence of a machine-local runner PID on that web
service must render execution as **Worker heartbeat · Not visible here**, not
as running, separate, or offline. Filesystem storage renders **Local fleet**
and may measure its local runner. A worker can be called offline only from
provider evidence or a heartbeat source that the UI can actually observe.

The same boundary applies to attention. Pilot unavailability is one typed fleet
incident derived from `pilotUnavailableSince` markers, with affected action and
Workstream counts plus recovery evidence. It is not one approval decision per
gated action. Human-only actions and explicit Pilot deny/ask verdicts remain
individual consequence decisions.

The retrospective also exposed a lifecycle defect to settle before the UI is
trusted: an explicitly non-blocking review unrelated to an already-evidenced
objective must not keep the Workstream active forever. Concluded Workstreams
may still carry a needs-you overlay; conclusion and housekeeping attention are
different facts.

## Delivery architecture

Add a separate `weaver ui` process. Do not widen `weaver serve`.

`serve` is deliberately a machine-ingress boundary: create-or-get a
Workstream, post an untrusted Observation, and read compact status. It has no
Steering, approval or adoption route. Sharing that bearer token with a browser
must never hand a bot the human's authority.

`weaver ui` should:

1. read the same `StateStore` as the runner;
2. server-render the existing React/Tailwind views on each request;
3. refresh on a narrow revision-change event or bounded poll, with every pane
   reloaded from one coherent revision rather than several independent timers;
4. use explicit redacted view DTOs or server-rendered HTML, never serialize a
   whole `WorkstreamDoc` into the browser;
5. pass every response and downloadable artifact through secret redaction;
6. resolve an artifact by typed Deliverable id, verify its stored hash, and
   serve it as an attachment;
7. keep the live tail optional and clearly labelled best-effort observability,
   never authority;
8. leave printout delivery as the only acknowledged “since I last received a
   catch-up” checkpoint. Opening a page is not a read receipt.

The initial deployment stays private behind infrastructure the operator
already owns: a private tunnel, VPN or authenticating reverse proxy. Weaver
does not grow user accounts, tenancy, organizations or an identity database.
The proxy supplies a stable actor and capability set to `weaver ui`.

Request-scoped actor identity is a prerequisite for writes. Today
`humanActs.ts` reads process-global `WEAVER_ACTOR`, which cannot safely vary
between concurrent HTTP requests. Mutation functions must accept an explicit
actor (or a request-scoped equivalent), while the CLI continues to supply its
environment-derived actor. Browser writes call those first-class mutations;
they never accept an arbitrary document patch.

## Cross-system status

Weaver should be the generic durable status spine, not the implementation of
every adjacent system and not a product-specific control plane.

The review service, session-scoped merge automator, CI/deploy workflows and
live evaluation service keep owning their work and provider facts. Each gets a
thin publisher over the existing ingress contract:

1. call create-or-get with a stable source key;
2. post an idempotent Observation when its source fact changes;
3. include the exact source revision and a provider link in the summary;
4. let a fresh coordinator evaluate the untrusted fact and update the standing
   course;
5. verify any irreversible effect through its provider before it is recorded
   as real.

Source-key conventions should be boring and provider-scoped, for example:

```text
git:<owner>/<repo>:pr:<number>
git:<owner>/<repo>:deploy:<commit>
eval:<suite>:run:<id>
ticket:<provider>:<id>
```

The key includes its real scope. A bare PR number collides across repositories;
a suite slug can collide across organizations; a retry attempt id is not the
identity of intended work. Attempts and retries therefore observe the source
Workstream keyed by the composite intended-work identity instead of each
minting another Workstream.

A PR or remediation that has become a durable multi-step outcome is a managed
child Workstream keyed by that external object. Review, CI, merge, deploy and
evaluation publishers all observe the same child; its manager receives typed
needs-attention and conclusion notices. This composes `sourceKey`, managed
Workstreams, Observations and manager notices instead of adding a resource
graph or connector framework.

The first publisher contracts are:

- **Review:** repository, PR number, exact head SHA, completed review verdict,
  unresolved-thread count and provider URL.
- **CI:** repository, head SHA, required check states and workflow URL.
- **Merge:** named authority, verified pre-merge head, provider merge state,
  merge commit SHA and readback time. An unknown result triggers provider
  readback, never another merge.
- **Deploy:** environment, deployed commit, provider status and independent
  health/readback timestamp.
- **Evaluation:** suite, run id, tested deployment revisions, status,
  case-level failure identity and result URL.

The source adapters must publish raw facts, not convenient but weaker source
labels. A review service's derived `ready` state is not a merge bar when checks
may still be pending. A completed evaluation run is not a pass when one case
failed. Absence of a no-impact evaluation run is not a failure. The merge path
still re-reads exact-head review, unresolved threads and required CI immediately
before egress.

An interim notification bridge may put these facts in the existing Observation
summary, labelled external and untrusted. The unified status slice must not
ship on that representation: revision, lifecycle, links and relationships
would be trapped in prose. The first three adapters already demonstrate the
minimum optional structured payload to add to `Observation`:

```ts
interface SourceSnapshot {
  kind: 'execution_attempt' | 'code_change' | 'evaluation_run' | 'fleet_health';
  externalKey: string;
  version: string; // source revision or canonical-content hash
  observedAt: string;
  phase: 'queued' | 'running' | 'terminal' | 'unknown';
  outcome?: 'succeeded' | 'failed' | 'error' | 'cancelled';
  url?: string;
  relatedKeys?: string[];
}
```

Kind-specific data carries only the fields listed in the publisher contracts
above. `ingressKey` combines source, kind, external key and version, so a poll
is an idempotent no-op until the source fact changes. A canonical content hash
supplies `version` for running sources without `updated_at`. The snapshot is
still untrusted Observation data: it may wake and render as a source signal,
but it cannot grant authority, complete work or supersede a Decision.

Prefer sources pushing through the existing machine-ingress boundary. A pull
adapter may use only a dedicated read-only source credential. It must never
reuse a broad worker credential which can claim jobs, report results, restart
workers or otherwise mutate the source system.

The “status of X” query is then a source-key lookup followed by the ordinary
Workstream projection. It can show the latest external signals immediately and
the authoritative current course separately. If no Workstream stands for the
key, intake may create one; it must not fabricate a status by searching model
transcripts.

The session merge automator is useful evidence for this boundary. Its merge
bar is exact-head review plus unresolved-thread and CI checks, then provider
merge and deploy readback. GitHub remains the source of those facts. A
session-long monitor is not durable organizational execution, so recurring
fleet ownership should ultimately be a Weaver routine whose disposable worker
uses that same skill and publishes/consumes the same source-keyed facts. The
skill can remain the mechanism; the Workstream supplies continuity. A merge
grant made to one interactive session does not transfer with the mechanism:
the routine needs its own durable authority ceiling and revalidates it at claim
time and immediately before every merge.

## Implementation slices

### 0. Align the truth projections

- extract one organizational-position projection shared by status, terminal
  dashboard and browser;
- make browser lanes use `capacityPresentation()`;
- add the fleet-health grouping described above;
- allow evidenced conclusion to coexist with explicitly non-blocking
  housekeeping attention;
- cover all of these with deterministic state fixtures.

### 1. Live read-only workspace

- add `weaver ui` with private binding and authentication delegated to the
  hosting layer;
- reuse the existing fleet and Workstream render models in the sidebar and
  single-centre shell;
- add revision refresh, runner/capacity health and verified artifact download;
- prove that an unreadable Workstream is loud and an old browser revision is
  labelled stale.

### 2. Team intake and answers

- add model-independent “New job” intake with stable source-key de-duplication
  and house constraints;
- add teammate Observations inside a Workstream;
- render the concluded answer and adopted evidence prominently;
- keep create and observe available through a complete model-provider outage.

### 3. Operator controls

- add request-scoped actor/capability handling;
- add Steering, attention resolution, pause/resume and priority through existing
  mutation functions;
- keep action/send approval and human adoption out until the operator
  authentication path is explicitly tested;
- later add those privileged acts as separate capabilities with immediate
  authority revalidation.

### 4. Fleet operations

- keep `/fleet` separate from `/board` and every Workstream workspace;
- show three bounded claims: shared data, execution observability, and human
  attention, followed by grouped shared-dependency incidents;
- provision the optional attention steward as an ordinary source-keyed routine
  Workstream. Each worker gets a fresh model-free input scoped to open human
  asks, approval-service waits, grouped incidents, counts, and source revisions;
  unrelated objectives, decisions, artifacts, event history, and database
  credentials stay outside the worker boundary. It repairs reversible causes
  and may create bounded repair Workstreams, but it cannot resolve or approve
  another Workstream's external effect;
- preserve the operator-side delegate skill as a mechanism and doctrine source,
  never as transferable authority. Worker output remains a proposal.

### 5. Source publishers and “status of X”

- publish review, CI/deploy and evaluation facts through `weaver serve`;
- standardize source keys and idempotency keys;
- add the minimal structured Observation snapshot above before treating source
  status as a unified read model;
- expose source-key lookup to the workspace search;
- model durable PR/remediation ownership as managed child Workstreams;
- keep source-specific payloads at the adapter edge.

## Acceptance scenarios

### Urgent report during total provider exhaustion

1. A teammate pastes the report and source URL into New job.
2. The request is stored immediately and de-duplicates on retry without any
   model call.
3. The workspace says all configured execution seats are unavailable, the
   outcome is safely queued, no external action occurred, and names the one
   operator recovery path.
4. Recovery is accepted only from an exact target's successful call or provider
   reset/readback; the Workstream then advances automatically.
5. Assignments, proposed results, adoption, verified external effects and the
   final evidenced answer become visible without the teammate reading a model
   transcript.

### One change across review, merge, deploy and live evaluation

1. A source-keyed child Workstream represents the PR/release outcome.
2. The review publisher reports a verdict at the exact head SHA.
3. CI reports its required checks; the merge mechanism re-reads both at claim
   time.
4. The merge receipt is recorded only after provider readback.
5. Deployment and evaluation publishers report the exact deployed/tested
   revisions.
6. The parent Workstream concludes only when its own success criteria cite the
   adopted and verified facts. Searching the PR, ticket, eval run or parent
   outcome leads to the same durable position or its explicit managed lineage.

## Non-goals

- no fifth durable “Thread” identity;
- no resumed model session or transcript-derived truth;
- no replacement for issue trackers, source control, review, CI, deploy or
  evaluation systems;
- no generic connector framework, event bus or resource graph;
- no tenancy, organization model, product administration surface or public
  multi-user auth system;
- no billing mutation, credential rotation or blind capacity retry;
- no progress percentages inferred from prose, run counts or elapsed time;
- no widening of `weaver serve` into an operator authority API.

The smallest implementation that passes these scenarios is enough. The UI is
an adapter over Weaver's durable layer; it is not a new layer of truth above it.
