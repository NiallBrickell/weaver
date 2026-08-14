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

The contract:

- **Set once, everywhere.** Secrets are global by default — every workstream's action workers see the name and every exec shell gets the value; `--ws` scoping is the exception for a credential only one stream should hold.
- **Least privilege is a rule, not a preference.** Give workstreams the narrowest credential that does the job — a dedicated read-only database role, a scoped token — never an owner/admin credential that happens to be lying around on disk. The gates supervise commands; the credential itself is the real blast-radius ceiling.
- **Models only ever see names.** The coordinator's projection lists which credentials exist so it can plan acts that use them; action briefings tell the worker "use `$SENTRY_AUTH_TOKEN`" — never the value.
- **Shells get values.** The engine injects secrets as environment variables into approved action workers and into the deterministic `verify`/`run` commands.
- **Nothing captured keeps a value.** Everything that flows back — command output, artifacts, submissions — is scrubbed (`«secret:NAME»`), and the store's single write path refuses any document write that embeds a known secret value. A pasted credential fails loudly with the fix (`reference it as $NAME`) instead of persisting forever.

Values live in `0600` env files inside the gitignored state directory.

Executor-only secrets are a stricter sibling scope. An adapter loads them
directly; `secretNames`, projections, action environments, and deterministic
shells do not. Their values still join the shared store-refusal and every
output-redaction boundary. For OpenHands, the durable provider key stays in a
host-side inference proxy and serializable MCP credentials stay in host-side
relays, while the disposable container receives only random per-run bearers.

## Operator access

An approved action acts *as you, on your machine* — so it gets what you have:

- **Your CLIs**: real Bash in the approved working directory; `gh`, `git`, `sentry-cli`, whatever is on your PATH.
- **Your MCP servers**: workers inherit the MCP servers you've registered for the directories the action touches, with the same stored auth your own sessions use. No re-plumbing access that already exists.

Operator MCP authentication headers are never placed literally in Agent SDK process arguments. Weaver replaces static header values with generated environment placeholders before spawning Claude Code, using the [runtime expansion supported by Claude Code MCP configuration](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson). The generated environment copy joins the disposable worker's output-redaction set, then disappears with the process; Weaver never writes it into workstream state.

For OpenHands, Weaver does not serialize upstream MCP URLs, commands,
arguments, headers, or environment blocks into the container at all. A
host-side relay connects each supported stdio/HTTP/SSE server and gives the run
a disposable URL and bearer; credential values and relay tokens are scrubbed
from catalogs, calls, results, errors, submissions, and telemetry. Claude
Code's private OAuth tokens, dynamic `headersHelper`, project/plugin/managed
scopes, and Claude.ai connectors are not copied or extracted. Those surfaces
remain an explicit remote-executor limitation and keep automatic OpenHands
routing closed.

The standing order is: exhaust the machine's existing access (MCP auth, CLI logins) before ever asking the human for a credential — and when an ask is genuinely necessary, it arrives as a one-click card naming the exact secret to set (`weaver secret set <name>`), with chasing the external service as the fallback option, never the lead. A card that sends you to a status page while a credential you hold would unblock the work is the workstream doing its remediation wrong.

Every assignment is a regular coding-agent worker. The default Claude executor gets Bash, file editing, web tools, and the MCP servers and repository instructions already configured for its working directory, used read AND write; alternative executors expose their ordinary native surface. A worker has two lifecycles — `work` (bounded, reversible work that proposes a result) and `action` — but neither selects a smaller runtime. Executors that cannot expose Pilot's live per-tool supervision refuse `action` before launch. A command such as `git log --pretty=format:'%h|%s'` therefore goes through the executor's normal shell, with normal quoting, rather than a Weaver parser or a parallel set of Git wrappers.

Weaver does not add a second process sandbox in this MVP; the environment that launches the local executor owns containment. Capability still does not grant action authority, and the line is consequence, not tool: a `work` brief is not permission for *irreversible* egress — pushing, merging or deploying code, spending, or sending a message to a person. Reversible MCP writes (a tracker's status, a comment, a label) stay ordinary work. The coordinator directs the irreversible effects through a typed action, where Pilot supervises the live calls, Weaver secrets are injected only for the approved run, and deterministic readback decides whether the effect happened.

## Billing

Everything rides one ambient operator principal: the local Claude Code login. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` are stripped from every spawned session, so a stray exported credential cannot silently switch billing or identity. Weaver never mints or stores Claude tokens, pools credentials, or cycles accounts around a usage limit.

Anthropic's proposed separate Agent SDK allowance is currently paused, so SDK work continues to draw from shared Claude plan limits. Weaver does not present SDK-reported dollar estimates because they are neither provider billing nor plan headroom. See [Claude capacity & billing](./claude-capacity.md) for current provider guidance and [Execution safety](./execution-safety.md) for Weaver's rolling runaway guard.

Capacity is durable typed state, indexed by model. Authentication raises one recovery card immediately; usage, session, rate, and provider limits raise one only after twelve consecutive backoffs, giving expected resets time to self-clear. Weaver retries at the stored reset, probes once when credential metadata changes, or makes a wait due after `weaver capacity retry`; a successful real run clears the matching state and card.
