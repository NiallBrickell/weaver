# Support threads in Plain

*How support workstreams keep a Plain thread current, and why a reply to a customer is the one thing they cannot just do*

erdo mirrors every Help Request into [Plain](https://app.plain.com), and its
webhook copies whatever is sent on a Plain thread back into the customer's erdo
thread. So a Plain thread is two things at once: the support team's tracker for
the request, and a line to the customer. Weaver treats those two halves
differently, for the same reason it treats a tracker label differently from an
email.

## What a support workstream does in Plain

Each `support-help-request-*` workstream the intake routine opens works one
Plain thread. Its workers hold the `PLAIN_API_KEY` credential and do the
tracker half themselves, with no approval, because every one of these changes
is internal and can be undone:

- **When work starts**, the thread is marked as being worked on: status
  *Investigating* (`markThreadAsTodo` with `statusDetail: IN_PROGRESS`) and agent
  status `IN_PROGRESS` (`updateThreadAgentStatus`), plus an internal note linking
  the Weaver workstream. Investigating is internal to Plain; erdo does not show
  it to the customer.
- **While it works**, internal notes (`createNote`) can carry anything the
  support team should know: pull requests, root causes, repository names, what
  was tried. Notes never reach the customer.
- **When the workstream concludes**, the thread is marked done
  (`markThreadAsDone`) and agent status `HANDLED`. erdo shows the customer that
  their request is resolved when a thread moves to Done, so this happens at the
  end, after any reply has been sent or a person has decided against one. Done
  is reversible: Plain moves a thread back to Todo when the customer writes
  again.

The Plain thread id (`th_…`) is in erdo's support status for the request
(`plain_thread_id`). Workers call Plain's GraphQL API at
`https://core-api.uk.plain.com/graphql/v1` with `Authorization: Bearer
$PLAIN_API_KEY`. For example, the start-of-work status:

```bash
curl -s https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"query":"mutation($id: ID!) { markThreadAsTodo(input: {threadId: $id, statusDetail: IN_PROGRESS}) { error { message } } updateThreadAgentStatus(input: {threadId: $id, agentStatus: IN_PROGRESS}) { error { message } } }","variables":{"id":"th_..."}}'
```

A note needs the thread's customer id, which `thread(threadId) { customer { id } }`
returns:

```bash
curl -s https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"query":"mutation($in: CreateNoteInput!) { createNote(input: $in) { error { message } } }","variables":{"in":{"customerId":"c_...","threadId":"th_...","text":"Weaver workstream support-help-request-1234abcd is on this."}}}'
```

## A reply to the customer is a send

Writing to the customer is different. Once a reply lands it cannot be taken
back, so a support workstream never replies from an ordinary worker. The reply
is an **action**: the coordinator drafts it, the action's command is exactly

```bash
weaver plain reply th_... <<'WEAVER_REPLY'
Hi Sam,

Thanks for flagging this. ...
WEAVER_REPLY
```

and its readback is the same text through `weaver plain reply-sent th_...`.
The engine runs that command once, verbatim, after approval. Nothing else can
send: a curl call to Plain's `replyToThread`, a script holding the key, or a
reply in any other shape is something the engine cannot inspect, so it always
goes to a person. An action whose command is anything other than the
recognised reply does not receive `PLAIN_API_KEY` at all.

**Who approves a reply** is decided by the engine from Plain itself. At
approval time, and again immediately before the send, it reads the thread's
customer back from Plain with `PLAIN_API_KEY`:

- a **verified `@erdo.ai` address**, exactly that domain, goes to Pilot, which
  approves it under the operator's rules (below);
- **every other customer** needs a person, and the card says so: *customer
  replies need a person unless the customer is a verified erdo.ai address
  (this one is at example.com)*;
- if Plain **cannot be read**, the reply needs a person too.

Nothing a model wrote can change that answer. The customer's address is never
taken from the brief, the draft, or the command. A person's approval covers
this exact text to this exact customer: if either changes before the send,
the reply comes back for approval again.

**If the result is unknown** (the connection drops mid-send), the engine never
sends again. It runs the readback, which looks for the reply on the thread's
timeline from the machine user. Found, the reply happened; not found or
unreadable, the outcome stays unknown and a person reconciles it.

**Replies read as customer support.** They speak to the customer about their
problem and what changed for them. They never mention pull requests,
repository names, internal tools, Weaver, workstreams, or how the fleet
works; that detail goes in an internal note.

## Setting it up

1. **A Plain machine user** (Settings → Machine users) with an API key. The
   public name is what customers see on a reply, so name it for support. The
   fleet's is *Weaver*, shown to customers as *Erdo Support*. Its key has
   exactly these permissions:

   | Permission | Used for |
   | - | - |
   | `thread:read` | reading the thread, its customer, and its status |
   | `thread:search` | finding a thread when only erdo's ids are known |
   | `thread:edit` | Investigating / Done status and agent status |
   | `thread:reply` | the approved reply (`replyToThread`) |
   | `note:create` | internal notes |
   | `note:read` | reading the notes already on a thread |
   | `customer:read` | reading the customer the engine decides the approver from |
   | `timeline:read` | the reply readback |

   No impersonation: replies come from the machine user, never as the customer.

2. **Store the key as a worker secret** (the fleet's is already stored and
   installed on the hosted runner), then install it on the hosted runner
   with the rest of the worker secrets (the list replaces the host's set
   exactly, so name every secret it should keep):

   ```bash
   weaver secret set PLAIN_API_KEY
   bin/weaver-gcp.sh push-worker-secrets <every worker secret name> PLAIN_API_KEY
   ```

   Ordinary work receives it only when its assignment selects it by name.

3. **Teach Pilot the reply rule** and push the rules file to the hosted Pilot
   with `bin/weaver-gcp.sh push-pilot-config ~/.pilot/pilot.toml`. The rule
   only matters for erdo.ai customers, because the engine never asks Pilot
   about anyone else. It approves a `weaver plain reply` whose text reads as
   customer support and sends anything mentioning PRs, repositories, internal
   tools or Weaver back to the operator. It is one entry in the approval
   prompt's deny list:

   ```text
   - A message to a customer through Plain (support replies). A `weaver plain reply <thread> <<'WEAVER_REPLY' … WEAVER_REPLY` command is APPROVED when the reply text reads as customer support: it speaks to the customer about their problem and what changed for them. DENY it when the text mentions a pull request or PR link, a repository or repo name, a branch or commit, an internal tool (Weaver, workstreams, Pilot, Sentry, Axiom, Linear, GitHub), or how the fleet works — that belongs in an internal note. Weaver's engine only sends this command to you when it has read the thread's customer back from Plain and found a verified erdo.ai address; every other customer already goes to a person, so do not second-guess the recipient. Any other route to a Plain customer message — `replyToThread`, `sendNewEmail`, `replyToEmail` or `sendChat` through curl, a script or the API — is DENIED. `weaver plain reply-sent` is a read; approve it. Plain status changes and internal notes (`markThreadAsTodo`, `markThreadAsDone`, `updateThreadAgentStatus`, `createNote`) are not messages to anyone; approve them.
   ```

4. **Tell the intake routine** so every new support workstream's brief carries
   these rules: `weaver steer support-intake-routine "<the rules above>"`.
