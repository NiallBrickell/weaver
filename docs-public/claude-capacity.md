# Claude capacity & billing

*How Weaver keeps durable work moving through Claude usage limits without changing billing or identity*

The job is simple: give Weaver an outcome once, and do not lose the work or babysit retries when Claude temporarily has no capacity.

Weaver uses the one ambient operator identity already logged into Claude Code on the machine. It does not mint, extract, copy, store, pool, or rotate Claude authentication tokens. It also never enables paid usage or changes a provider spending limit.

## What “usage” means

Claude plans do not expose a transferable wallet of tokens for Weaver to divide up. Available usage depends on factors such as the model, conversation length, tools, and current provider limits. Claude remains the source of truth: use `/usage` in Claude Code and Claude **Settings > Usage** to inspect the account's current position.

The Claude subscription SDK can also emit a plan-window utilization and reset during a run. Weaver stores that typed observation and, while it is less than 30 minutes old, shows fleet headroom such as `⚠ Claude 5h 18% left · resets in 2h`; the warning mark is the provider's `allowed_warning` state. It is a recent observation, not a reservation: another Claude session can consume the same plan between Weaver runs. API-key, Bedrock, Vertex, OpenHands/Kimi, and other providers may not expose an equivalent signal through Weaver's executor seam. Their missing percentage is shown as unknown in detailed status and omitted from the compact header—never inferred from tokens, estimated dollars, or model starts.

Anthropic announced a separate monthly Agent SDK allowance, then paused that change. Anthropic's current notice says Agent SDK, `claude -p`, and third-party usage continue to draw from the Claude plan's shared limits for now. Check the current [Agent SDK with a Claude plan guide](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [Claude Code plan guide](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) before making a billing decision.

If a supported paid plan offers usage credits or a usage bundle, the operator can explicitly enable it and set a provider-side spending limit in Claude **Settings > Usage**. Anthropic documents those controls in [Manage usage credits for paid Claude plans](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) and [Buy usage bundles](https://support.claude.com/en/articles/14246112-buy-usage-bundles).

> **Warning:** Enabling usage credits authorizes additional spend with Anthropic. Weaver never does this for you. Weaver's dollar figure is diagnostic SDK telemetry, not an Anthropic bill, balance, spending limit, or execution gate. [Execution safety](./execution-safety.md) is a billing-neutral rolling model-start guard.

## What Weaver does when capacity runs out

A usage, session, rate-limit, overload, or authentication failure is infrastructure state—not evidence that the workstream failed:

1. Weaver closes the disposable model attempt without accepting any claimed work.
2. The assignment and organizational position remain in durable typed state. No SDK session or model context stays alive.
3. Weaver records a typed backoff wake and executor/provider/model-scoped `WorkstreamDoc.capacity` entry. A Claude wait cannot park or be cleared by an OpenHands/Kimi run that happens to use the same model label.
4. A limited primary coordinator degrades down its ordered fallback chain — `claude-opus-5` by default, or the seats in `WEAVER_COORDINATOR_FALLBACKS` (legacy `WEAVER_COORDINATOR_FALLBACK_MODEL` while the chain is unset) — to the first seat whose pool is not limited. Each pass records the model it actually used. Every seat in the chain limited means genuine parking; fallback never cascades into account or credential rotation.
5. Weaver retries the limited execution target at the earliest future reset reported by its provider. If the provider supplies no usable reset, Weaver uses a bounded fallback delay.
6. A fresh process continues from the stored projection when the wake becomes due. Another rejection parks it again; a successful real run clears the matching capacity state and restores the primary when it is available.

There are no periodic model probes: polling a limited account would consume scarce capacity and amplify an outage. Weaver performs one bounded, model-specific Claude SDK probe when Claude credential-file metadata changes, without reading the credential. Non-Claude executor waits are never sent through that probe. After changing usage or billing settings, make the stored wait due explicitly:

```bash
weaver capacity retry <slug>
# or, when only one model changed:
weaver capacity retry <slug> --model sonnet
```

This command does not claim recovery, change billing, or count as human steering. The next real coordinator or worker run proves whether capacity recovered.

The five-question status view shows the typed wait immediately. `WAITING` means the current configured execution path is genuinely blocked: a primary coordinator using its fallback continues normally, a retry that is already due is eligible rather than parked, and an old wait for a model no longer configured stays only in the full record. Authentication opens one needs-you card on the first clear failure because only the operator can log in. Usage, session, rate, and provider waits get twelve consecutive backoffs to self-clear before Weaver opens one deduplicated capacity card.

## Supported recovery paths

- **Plan or session limit:** inspect `/usage`, then wait for Claude's reset. Weaver resumes from durable state.
- **Explicit paid continuation:** enable usage credits or a usage bundle in Claude **Settings > Usage**, set the provider spending limit, then run `weaver capacity retry <slug>`.
- **Login expired or changed:** run `claude auth login`. File-backed credential metadata triggers one recovery probe; `weaver capacity retry <slug>` is the fallback when credentials live elsewhere.
- **Deliberate production billing:** use an Anthropic Platform account and API-key deployment designed for the organization. Weaver's local subscription mode never silently switches to an exported API credential.

Multiple paid accounts are an uncommon operator situation, not the product model. Whatever entitlements an operator holds, Weaver does not aggregate them into a transferable balance or automate account cycling around limits. That keeps the ordinary recovery path legible and avoids building behavior that could bypass provider controls. Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) also require account credentials to remain private and prohibit bypassing protective measures.
