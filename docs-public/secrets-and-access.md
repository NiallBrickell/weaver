# Secrets & access

*Models see names; shells get values; approved actions inherit the operator's MCP servers and CLIs*

## Secrets

```bash
echo "$MY_TOKEN" | weaver secret set SENTRY_AUTH_TOKEN            # global
echo "$MY_TOKEN" | weaver secret set STRIPE_KEY --ws billing-fix  # per-workstream
weaver secret list

# Model-provider credentials: invisible even by name to every model and shell
weaver secret set OPENROUTER_API_KEY --executor
weaver secret list --executor
```

Interactive `secret set` input disables terminal echo and finishes on Enter; piping a value on
stdin remains supported for automation.

The contract:

- **Set once, available everywhere.** Secrets are global by default; `--ws` scoping is the exception for a credential only one stream should hold. Availability is not injection: ordinary work gets none unless its Assignment explicitly selects the name, while gated actions retain their existing applicable-secret scope.
- **Least privilege is a rule, not a preference.** Give workstreams the narrowest credential that does the job — a dedicated read-only database role, a scoped token — never an owner/admin credential that happens to be lying around on disk. The gates supervise commands; the credential itself is the real blast-radius ceiling.
- **Models only ever see names.** The coordinator's projection lists which credentials exist. An ordinary-work Assignment persists only its exact `credentialNames` selection; a worker briefing tells the worker "use `$SENTRY_AUTH_TOKEN`" — never the value.
- **Only the selected shell gets the value.** Ordinary work receives exactly its declared subset for one disposable attempt. Gated action workers and deterministic `verify`/`run` commands retain their existing applicable-secret environment.
- **Nothing captured keeps a value.** Everything that flows back — command output, artifacts, submissions — is scrubbed (`«secret:NAME»`), and the store's single write path refuses any document write that embeds a known secret value. A pasted credential fails loudly with the fix (`reference it as $NAME`) instead of persisting forever.

Values live in `0600` env files inside the gitignored state directory.

### Credentials for ordinary work

Read-only monitoring, evidence gathering, and reversible API bookkeeping stay
ordinary `work`; they do not become irreversible `action` merely because they
need authentication. The coordinator selects the smallest applicable subset
on `create_assignment`:

```text
credential_names: [SENTRY_AUTH_TOKEN]
```

The durable Assignment stores `credentialNames: ["SENTRY_AUTH_TOKEN"]` and no
value. Immediately before launch the execution host resolves that exact name
from the global/workstream store, strips every unselected applicable secret
name from the child environment (including an accidental ambient export), and
injects the selected value for that attempt only. Executor/model identity
credentials are a separate store and cannot be selected through this field.

Unknown, malformed, duplicate, empty, or revoked selections fail closed. A
launch-time failure records no Attempt and starts no model process; the
Assignment settles failed with one blocker naming the credential to restore,
so the runner cannot hot-loop the invalid contract. A supplied credential that
returns 401/403 is reported as failure of that named access, not mistaken for
an absent personal CLI login. Prompts, artifacts, submissions, tails, errors,
service logs, and typed state all retain names at most and redact values.

On the isolated GCP runner, provision an explicit least-privilege subset of
the operator laptop's global store with:

```bash
bin/weaver-gcp.sh push-worker-secrets SENTRY_AUTH_TOKEN READONLY_DB_URL
```

This is an exact replacement of the host's global `secrets.env`, not a merge:
names omitted from the next invocation are revoked. Values cross SSH only on
stdin and are never accepted as command arguments or printed. The helper
refuses unknown, malformed, duplicate, and empty selections, installs the file
as `weaver` with mode `0600`, and does not restart the runner because each
attempt reloads applicable secrets. Executor-only identity remains a separate
scope managed by `push-env`; personal device or CLI authentication is never a
substitute for either store.

Executor-only secrets are a stricter sibling scope. An adapter loads them
directly; `secretNames`, projections, action environments, and deterministic
shells do not. Their values still join the shared store-refusal and every
output-redaction boundary. For OpenHands and Pi, the durable provider key stays
in a host-side inference proxy and serializable MCP credentials stay in
host-side relays. Their disposable runtimes receive only random per-run
bearers; Pi's extension erases those bearer-bearing environment entries before
its shell tool can run.
The OpenCode eval adapter uses the same provider-key shape: a fresh local server
gets a temporary home, a minimal environment, and only disposable proxy and
submission bearers. Normal OpenCode auth files and Weaver's state path are not
visible to that process.

## Registered execution identity

A headless host has no Claude Code login to borrow, and ambient
`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` exports are stripped from every
SDK subprocess (see [Billing](#billing)). The deliberate exception is identity
the operator **registers** in the executor-only store:

```bash
weaver login                                            # interactive front door
weaver secret set CLAUDE_CODE_OAUTH_TOKEN --executor    # from `claude setup-token`
weaver secret set ANTHROPIC_API_KEY --executor          # or an API key
```

Exactly one registered credential is injected into SDK children — the
subscription token wins when both are registered — so the billing principal
stays unambiguous. Registration is an explicit act against a `0600` file, not
something an exported variable or a worker's output can do, which is why it
does not weaken the anti-hijack strip. Remove it with
`weaver secret rm CLAUDE_CODE_OAUTH_TOKEN --executor` (or pick "use this
machine's Claude login" in `weaver login`, which removes any registered
identity) and the machine's own login applies again.

## Operator access

On an operator-controlled laptop, an approved action uses the machine's
existing CLIs and MCP identity. A hosted runner must use machine principals
instead: GitHub repo egress uses a [dedicated GitHub App](./github-app.md), not
a copied personal `gh` session or PAT.

On the operator-controlled path an action gets what you have:

- **Your CLIs**: real Bash in the approved working directory; `gh`, `git`, `sentry-cli`, whatever is on your PATH.
- **Your MCP servers**: workers inherit the MCP servers you've registered for the directories the action touches, with the same stored auth your own sessions use. No re-plumbing access that already exists.

Operator MCP authentication headers are never placed literally in Agent SDK process arguments. Weaver replaces static header values with generated environment placeholders before spawning Claude Code, using the [runtime expansion supported by Claude Code MCP configuration](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson). The generated environment copy joins the disposable worker's output-redaction set, then disappears with the process; Weaver never writes it into workstream state.

For OpenHands and Pi, Weaver does not serialize upstream MCP URLs, commands,
arguments, headers, or environment blocks into the model runtime at all. A
host-side relay connects each supported stdio/HTTP/SSE server and gives the run
a disposable URL and bearer; credential values and relay tokens are scrubbed
from catalogs, calls, results, errors, submissions, and telemetry. Claude
Code's private OAuth tokens, dynamic `headersHelper`, project/plugin/managed
scopes, and Claude.ai connectors are not copied or extracted. Those surfaces
remain an explicit alternative-executor limitation and keep automatic routing
over that incomplete surface closed.

The standing order is: exhaust the machine's existing access (MCP auth, CLI logins) before ever asking the human for a credential — and when an ask is genuinely necessary, it arrives as a one-click card naming the exact secret to set (`weaver secret set <name>`), with chasing the external service as the fallback option, never the lead. A card that sends you to a status page while a credential you hold would unblock the work is the workstream doing its remediation wrong.

Every assignment is a regular coding-agent worker. The default Claude executor gets Bash, file editing, web tools, and the MCP servers and repository instructions already configured for its working directory, used read AND write; alternative executors expose their ordinary native surface. A worker has two lifecycles — `work` (bounded, reversible work that proposes a result) and `action` — but neither selects a smaller runtime. Executors that cannot expose Pilot's live per-tool supervision refuse `action` before launch. A command such as `git log --pretty=format:'%h|%s'` therefore goes through the executor's normal shell, with normal quoting, rather than a Weaver parser or a parallel set of Git wrappers.

Weaver does not add a second process sandbox in this MVP; the environment that launches the local executor owns containment. Capability still does not grant action authority, and the line is consequence, not tool: a `work` brief is not permission for *irreversible* egress — pushing, merging or deploying code, spending, or sending a message to a person. Reversible MCP writes (a tracker's status, a comment, a label) stay ordinary work. The coordinator directs the irreversible effects through a typed action, where Pilot supervises the live calls, Weaver secrets are injected only for the approved run, and deterministic readback decides whether the effect happened.

## Billing

Everything rides one operator principal: the local Claude Code login, or the one identity the operator registered in the executor store ([above](#registered-execution-identity)). `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` are stripped from every spawned session, so a stray exported credential cannot silently switch billing or identity — only the registered store supplies one, and only one. Weaver never mints or stores Claude tokens beyond that explicit registration, pools credentials, or cycles accounts around a usage limit.

Anthropic's proposed separate Agent SDK allowance is currently paused, so SDK work continues to draw from shared Claude plan limits. Weaver does not present SDK-reported dollar estimates because they are neither provider billing nor plan headroom. See [Claude capacity & billing](./claude-capacity.md) for current provider guidance and [Execution safety](./execution-safety.md) for Weaver's rolling runaway guard.

Capacity is durable typed state, indexed by model. Authentication raises one recovery card immediately; usage, session, rate, and provider limits raise one only after twelve consecutive backoffs, giving expected resets time to self-clear. Weaver retries at the stored reset, probes once when credential metadata changes, or makes a wait due after `weaver capacity retry`; a successful real run clears the matching state and card.
