# Operator workspace

`weaver ui` is a small browser surface for starting work and following it without learning the CLI. It reads and writes the same durable store as every other Weaver process; it is not a second source of truth.

```bash
# Terminal 1: serve the operator workspace
weaver ui

# Terminal 2: execute active workstreams
weaver run
```

The workspace listens on `127.0.0.1:9724` by default. Open the URL printed by the command. `--host` and `--port` change the listener:

```bash
weaver ui --host 0.0.0.0 --port 9724
```

## Jobs overview and workspace

The **Jobs** page is the work overview: scan how many jobs need attention, are
working, are waiting, or are done. **Fleet** is a separate compact system view
for shared data, execution visibility, and grouped operational incidents; those
facts do not become more sections inside a job. On desktop the left sidebar uses the
same groups and stays available when you open a job; on mobile **All jobs**
returns to that list without repeating it above the selected job.

Each job has four task-oriented tabs. Only the selected tab body is rendered,
so scrolling is never the way you navigate between unrelated parts of a job:

- **Overview** shows one current decision or one next-state card. Labelled
  choices are clickable, and every response can carry an optional condition;
  **Something else** accepts a different answer. The complete decision question
  and each complete option wrap rather than being cut off; long diagnostic
  context stays folded until you ask for it.
- **Work & results** shows live assignments and evidenced outputs. Accepted
  work leads with a short human summary; the exact agent-facing result stays
  under **Full technical result**. Older accepted results are folded as a group.
- **Activity** keeps the context composer and a bounded human-readable catch-up.
  Routine scheduler checkpoints and the current decision are not repeated.
- **Details** retains revisions and the standing course, with all Assignments
  and the full typed chronology in separate disclosures.

The active tab is part of the URL, so a link, reload, or live revision refresh
returns to the same view. On narrow screens the tab row scrolls horizontally
rather than turning into another tall section list.

These are two views over typed Workstream state. The workspace may look conversational, but a conversation is never the durable container and its prose cannot silently change authoritative state.

## Start new work

Use **New job** to describe an outcome. Weaver creates a durable Workstream for it, then the separate runner picks it up. Creating a Workstream does not keep a browser request or model session alive; fresh coordinator and worker runs continue from stored state. The optional parent selector is under **Advanced** because most requests are standalone jobs.

The UI server does not execute model runs. Keep `weaver run` running against the same `WEAVER_STORE` on this or another machine. Without that runner, the board remains usable and new work is safely stored, but no agent advances it.

## Add follow-up

Text entered under **Add context or answer a question**, and answers sent from
a **Decision needed** card, are recorded as untrusted **Observations** and wake
the Workstream. A decision response records the exact server-side option plus
any condition, or a custom answer. Stale or changed cards fail closed instead
of applying an answer to a different request.

These inputs can add evidence or context for the next fresh coordinator, but
they cannot grant authority, complete work, adopt a submission, approve an
action, or supersede standing direction by themselves. The shared browser
sign-in identifies a verified teammate for attribution; identity still does
not turn their input into authority.

Use the existing CLI for explicit human acts such as steering, adoption, attention resolution, or action approval. Keeping those acts separate prevents a convenient browser input from becoming an accidental authority channel.

## Access and identity

The default loopback listener is available only on the local machine. A shared
deployment should use Clerk. Four settings form one atomic, fail-closed
configuration:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_…' \
CLERK_SECRET_KEY='sk_…' \
WEAVER_UI_ALLOWED_EMAIL_DOMAINS='company.example' \
WEAVER_UI_PUBLIC_ORIGIN='https://weaver.example.com' \
weaver ui --host 0.0.0.0
```

Every non-health request must then carry a valid Clerk session. Weaver fetches
the signed-in Clerk user server-side and requires at least one **verified**
email whose domain exactly matches `WEAVER_UI_ALLOWED_EMAIL_DOMAINS` (a
comma-separated allowlist). `person@sub.company.example` does not match
`company.example` unless the subdomain is listed separately. The normalized
verified email is recorded as the actor on browser input.
This authorization is revalidated on every request, so removing or unverifying
the allowed-domain email revokes access without waiting for an application cache.

`WEAVER_UI_PUBLIC_ORIGIN` is also the Clerk token's authorized party. Weaver
does not derive it from request or proxy headers, so a forged host cannot turn
a leaked subdomain cookie into a valid workspace session. Authenticated browser
mutations must carry that same complete HTTPS origin; a plaintext same-host
origin is not accepted. If any Clerk setting
is present while another is missing, the UI refuses to start; it never falls
back to a weaker mode. The secret key is server-only. The publishable key is
the only key rendered into the sign-in page.

On Railway, `WEAVER_UI_PUBLIC_ORIGIN` may be omitted: Weaver derives the exact
HTTPS origin from Railway's provider-owned `RAILWAY_PUBLIC_DOMAIN`. An explicit
origin remains available for custom domains and other hosts.

For a private self-hosted listener where Clerk is intentionally absent,
`WEAVER_UI_TOKEN` remains a fallback:

```bash
WEAVER_UI_TOKEN='use-a-long-random-value' weaver ui --host 0.0.0.0
```

That mode uses HTTP Basic authentication. The caller-supplied username is only
a provenance label and does not prove an individual's identity. A complete
Clerk configuration takes exclusive precedence over a stale Basic token.

All browser changes also require a same-origin request. Weaver normally checks
that the request's `Origin` matches the workspace host before reading the form
body or changing durable state. The page's `no-referrer` policy makes Chromium
serialize `Origin` as `null` on an ordinary same-origin form navigation; only
that case may use browser-controlled Fetch Metadata proving a same-origin
document navigation. Missing both signals, malformed origins, and cross-site
requests fail closed. This is the CSRF
boundary that prevents a different site from replaying a browser's Clerk
session or cached Basic credentials to create work, add follow-up, or force a
sign-out.

When Clerk is absent and `WEAVER_UI_TOKEN` is set, Basic authentication applies
on loopback too.

Basic authentication must be carried over a trusted network or HTTPS reverse
proxy because it does not encrypt traffic itself. Responses advertise a
one-year HTTP Strict Transport Security policy to HTTPS clients. Use Clerk,
not the Basic fallback, for a public shared workspace.

For a shared deployment, use the [Railway guide](./railway.md): the UI and
Postgres are hosted together while the initially separate execution host reads
and writes the same durable fleet.

The sidebar states which store the page is reading:

- **Shared fleet** means the workspace reads the shared team Postgres. The Fleet
  page reports **Worker heartbeat · Not visible here** when this web service has
  no observable runner. That is unknown, never an invented topology or
  running/offline claim.
- **Local fleet** means the page reads the local filesystem store and can
  measure the runner on the same machine.

A shared UI cannot measure a heartbeat that is not published to its store. That
is not evidence that an execution worker is running, separate, or offline.

## Fleet attention

The Fleet page groups a shared dependency once. If the approval service is
unavailable, every affected external action stays safely gated, while one
incident names the affected action/job counts and the evidence that will prove
recovery. Those actions do not become repeated **Needs you** cards. A human-only
action or an explicit deny/ask verdict remains an individual decision because
its consequence genuinely requires authority or judgment.

Only active jobs contribute to a live approval-service incident. Pausing a job
also pauses its retries, so its last outage marker remains durable history until
the job resumes; it is not evidence that the shared service is still down.

**Start attention steward** creates one source-keyed routine Workstream. Each
cycle audits typed attention state, groups related symptoms, repairs reversible
causes or delegates a bounded repair outcome, and asks a person only for
irreducible judgment. Before each steward worker starts, the harness writes a
fresh read-only input containing only open human asks, approval-service waits,
grouped incidents, counts, and source revisions. It does not expose unrelated
objectives, decisions, artifacts, event history, or database credentials. The
steward does not inherit operator authority: it cannot approve or resolve sends,
merges, deploys, spending, or any other external effect, and its worker output
is still only a proposal until adopted. This read-and-submit role is also capped
at 16 model turns and a ten-minute wall: it cannot turn a small approval queue
into an open-ended coding-agent investigation.

## Authority limits

The operator workspace deliberately exposes intake, inspection, and untrusted follow-up. It does not turn browser access into permission to send messages, spend money, merge or deploy code, approve actions, or claim an external effect occurred. Those consequences remain behind Weaver's existing typed authority, approval, and deterministic readback boundaries.
