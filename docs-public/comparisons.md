# How Weaver compares

*The layer above individual coding agents is getting crowded — here is where Weaver sits, and where it doesn't compete*

A layer is forming above the coding agents themselves: tools whose starting point is that an agent session is disposable, and that whatever matters must live outside it. Weaver shares that diagnosis, so it gets compared to these tools — but the families in this layer persist very different things, and the differences are structural, not cosmetic. This page is a snapshot as of August 2026; the space moves fast.

## The three families

**Parallel-session managers and agentic development environments.** [Spotify's Xirp](https://xirp.spotify.com/) is the most prominent (more below); Conductor-style multi-worktree UIs and Claude Code's own cloud sessions are the same shape. These orchestrate *coding sessions*: many concurrent agents in isolated worktrees, a shared context layer so each session starts informed, model-neutral so you can switch between Claude, Codex, and Gemini mid-project. The human is still the coordinator — the tool makes the sessions they drive faster and more parallel.

**Durable execution engines gaining agent features.** Temporal and its relatives have real durability discipline: typed state, replayable histories, progress that survives any process death. What they don't have is organizational semantics. A workflow engine can guarantee your function resumes after a crash; it has no concept of a decision that supersedes another, a submission awaiting adoption, or an authority ceiling on an external send. Those have to be built on top — which is roughly what Weaver is, minus the generic workflow engine underneath.

**Agent memory layers.** Letta (MemGPT) and similar systems persist *model-shaped* context — memories, summaries, conversational state — so an agent seems to remember across sessions. This is precisely the continuity mechanism Weaver rejects: a generated summary that silently becomes truth. In Weaver, compression may carry supporting history, but it can never flip a decision, complete an assignment, or claim a send happened; the projection a fresh coordinator receives is assembled from typed facts, not remembered prose.

## Xirp, specifically

Xirp (launched August 2026) is worth a closer look because its pitch sounds closest: decouple what matters from any single agent or harness, stay vendor-neutral, persist context between sessions. At Spotify's scale it validates the core thesis — sessions are disposable, the durable layer is the product.

The divergence is in what the durable layer *is*:

- **Context versus commitments.** Xirp persists a retrieval layer — services, ownership, docs, work items, living documentation auto-generated from coding sessions — fed back into future sessions. Weaver persists typed organizational state: workstreams, assignments, decisions with supersession lineage, adoptions that pin immutable revisions. Xirp's auto-generated living documentation is, in Weaver's terms, a summary on its way to becoming truth; Weaver's kernel forbids exactly that.
- **No commitment or authority layer.** Xirp has no adoption-versus-completion distinction, no decision record a fresh agent must continue rather than re-litigate, no egress gate, no separation of capability from authority. It doesn't need them — a human drives every session. Weaver's coordinator acts autonomously across waits measured in days or months, which is why all of that machinery has to exist.
- **Unit of work and horizon.** Xirp's unit is a coding session against a codebase: minutes to hours, human in the seat. Weaver's unit is a Workstream: months to years, where runs are disposable attempts and the hard problems are waits, wakes, external sends with unknown results, and untrusted replies.
- **Posture.** Xirp is a team platform — a Portal plugin, workspaces, org rollout. Weaver's charter is the opposite: a narrow harness that grows by adapters over other people's infrastructure, never a platform surface.

If a session manager ever grows a coordinator that acts across waits on its own authority, it will need to invent a decision layer, an adoption boundary, and an authority firewall — nothing in a context-retrieval architecture supplies them.

## The empty intersection

Weaver sits where these families don't overlap: durable-execution rigor applied to organizational semantics rather than to code sessions or memories.

| | Session managers (Xirp) | Workflow engines (Temporal) | Memory layers (Letta) | Weaver |
|---|---|---|---|---|
| What persists | Context for retrieval | Execution state | Model-shaped memory | Typed decisions, assignments, adoptions |
| Who coordinates | The human | Your code | The agent itself | A disposable coordinator, fresh each pass |
| Horizon | A session | A workflow run | A relationship | An outcome, months to years |
| Authority model | The human's | None needed | None | Ceilings, gated egress, verified readback |
| A summary can become truth | Yes (by design) | N/A | Yes (by design) | Never |

None of these tools is doing it wrong — they solve different problems, and Weaver happily coexists with all three (a Weaver worker could run inside a Xirp-style session; a Weaver store could ride a workflow engine). What Weaver refuses to concede is the middle row of that table: the thing that survives every agent run is a set of commitments with authority attached, not a pile of context, and no amount of retrieval quality substitutes for it.

For the invariants behind these claims, see [The harness](./harness.md) and [What's actually new](./whats-new.md).
