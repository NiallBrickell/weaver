# Linear intake: how issues become workstreams

`weaver linear sweep` ([`src/linear.ts`](../src/linear.ts)) is Weaver's first external intake. It is **intake only** — the sanctioned outbound path (gated `kind:'action'` assignments with deterministic readback, [harness.md](./harness.md)) is untouched, and that is the design, not a shortcut.

## The shape

- **Inbound is an adapter; outbound is not.** A `weaver`-labeled issue becomes a workstream; a new comment becomes an observation with an `ingressKey`; both push an immediate wake. Posting back (progress comments, moving the issue to Done) is the coordinator authoring gated actions against the GraphQL API with `$LINEAR_API_KEY` — exactly how the GitHub PR lifecycle already works. A Jira/Sheets/Docs intake would be a sibling module with the same three duties: fetch deltas, arrive them idempotently, wake.
- **Deterministic, no model.** The sweep can run on any cadence (routine, cron, by hand). Slug/title/objective derive mechanically from the issue — unlike `weaver do`, there is no model derivation pass, so tests fully cover it and a sweep costs one HTTP request when nothing changed.
- **Fleet-level typed state** lives in `WEAVER_HOME/linear.json`: the `updatedAt` cursor and the issue-uuid → workstream mirror map. Comment/state dedupe does NOT rely on this file — it checks `ingressKey` against the target workstream's own observations, so a lost mirror file cannot duplicate arrivals. (A lost mirror file WILL make the sweep mirror an issue into a suffixed sibling workstream — non-destructive and detectable; pinned by test.)
- **An idle sweep writes nothing.** Arrivals bump the revision and would conflict an in-flight pass (that's the contract), so the sweep only calls `arrive()` when it actually has new facts.

## The marker firewall

Every comment Weaver posts to Linear must end with a `[weaver <slug> <token>]` marker (enforced by the mirror workstream's constraints). The marker does double duty:

1. **Readback key** — after an unknown result, `exec.verify` finds the comment by its marker; the send is never blindly retried (kernel rule 7).
2. **Echo filter** — the sweep skips marker-bearing comments, so Weaver's own egress never re-enters as input. Without this, posting a comment bumps the issue's `updatedAt`, the next sweep would mirror the comment back in as an observation, and every post would wake the stream that made it.

The API key is the operator's personal key for now, so author identity cannot distinguish Weaver from the human — the marker, not the author, is the discriminator.

## Replies vs observations

Inbound comments arrive as **observations**, not `Reply` records: replies attach to a sent interaction, and the mirror stream's Linear traffic doesn't route through the email-shaped `Interaction` machine. The invariant that matters is preserved either way — an observation is untrusted evidence that wakes the stream and can't complete work or grant authority.

## The upgrade path we deliberately didn't take (yet)

Linear's real agent surface (an assignable "Weaver" app user with agent sessions) requires an OAuth app with a **public webhook URL and a 10-second acknowledgment deadline** — a resident listener. That fits the hosted direction, not the laptop-tick deployment; when it lands, webhooks become a lower-latency trigger for the same arrival path and nothing about the state model changes. Until then the sweep polls, which is honest at-least-once delivery with stored-data wakes.
