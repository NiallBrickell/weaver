/**
 * The worker runner: one fresh, full-capability Agent SDK run per assignment.
 *
 * A worker sees ONLY its briefing plus the declared inputs (deliverables of
 * its dependency assignments) — never the coordinator's reasoning, never the
 * projection, never a transcript. Its only Weaver state API is the submit
 * tool, which produces an artifact + submission record. Completion stores a
 * wake. Its ordinary coding tools are supplied by the execution substrate.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { virtualNow } from './clock.js';
import { LocalSdkExecutor } from './executor/localSdk.js';
import { OpenHandsExecutor } from './executor/openHands.js';
import { CodexExecutor } from './executor/codex.js';
import type { SubmitReply, SubmitSurface, WorkerExecutor } from './executor/types.js';
import { armWall } from './wall.js';
import {
  clearCapacityBackoff,
  ensureCapacityAttention,
  infrastructureWaitSummary,
  recordCapacityBackoff,
  recordProviderCapacityObservations,
  resolveCapacityAttention,
  selectWorkerCapacityTarget,
  SdkFailureTracker,
} from './capacity.js';
import { noteFleetRecovery } from './fleetCapacity.js';
import {
  workerCapacityTarget,
  workerExecutorName,
  workerModel,
  type CapacityTarget,
} from './modelConfig.js';
import { runnerExecutorCapabilities } from './modelRouting.js';
import { loadRedactionSecrets, loadSecrets, redactSecrets, sdkEnv } from './secrets.js';
import { arrive, load, mutate, newId, readArtifact, RevisionConflictError, writeArtifact } from './store.js';
import { tailMessage } from './tail.js';
import {
  assertExecutionStartAllowed,
  ExecutionSafetyLimitedError,
  parkIfExecutionLimited,
} from './executionSafety.js';
import type { InfrastructureWait, ProviderCapacityObservation, WorkstreamDoc } from './types.js';
import { secureMcpHeaderCredentials, type SecuredMcpConfiguration } from './mcpConfig.js';

export { workerModel } from './modelConfig.js';

/**
 * Which substrate runs the worker's model loop. The seam exists so remote
 * executors can slot in later; the authority model does not change with the
 * substrate — every executor gets the same harness-owned supervision and
 * submit callbacks. Unknown values fail hard: silently falling back to local
 * execution would make a misconfigured remote fleet look healthy.
 *
 * `openhands` runs the worker's loop inside a pinned OpenHands Agent Server
 * container (see src/executor/openHands.ts) — the first remote substrate. It
 * needs Docker plus WEAVER_MODEL_API_KEY (or LLM_API_KEY); an action
 * assignment fails closed there, because container tool calls cannot yet be
 * routed through Pilot supervision.
 */
export function selectExecutor(name = workerExecutorName()): WorkerExecutor {
  if (name === 'local-sdk') return new LocalSdkExecutor();
  if (name === 'codex-sdk') return new CodexExecutor();
  if (name === 'openhands') return new OpenHandsExecutor();
  throw new Error(`unknown worker executor '${name}' from WEAVER_EXECUTOR/WEAVER_ACTION_EXECUTOR — supported: local-sdk, codex-sdk, openhands`);
}

/**
 * Live per-command supervision for action workers: every tool call is judged
 * by the operator's PILOT daemon at execution time — exactly how their own
 * interactive sessions are supervised — instead of a human pre-approving a
 * plan. Pilot unreachable or non-approve ⇒ deny (fail closed); the worker
 * reports the denial honestly and readback/coordinator handle the fallout.
 */
export function pilotSupervisor(cwd: string, slug: string) {
  const base = process.env.WEAVER_PILOT_URL ?? 'http://127.0.0.1:9721';
  return async (toolName: string, input: Record<string, unknown>): Promise<
    { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
  > => {
    try {
      const res = await fetch(`${base}/internal/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtime: 'claude',
          tool_name: toolName,
          tool_input: JSON.stringify(input),
          cwd,
          session_id: `weaver-${slug}`,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) return { behavior: 'deny', message: `pilot HTTP ${res.status} — failing closed` };
      const body = (await res.json()) as { decision?: string; reason?: string };
      if (body.decision === 'approve') return { behavior: 'allow', updatedInput: input };
      // 'passthrough' is pilot reporting the operator's OWN Claude Code
      // settings allow this call in this cwd (its settings deny/ask outcomes
      // arrive as 'deny'). Interactive sessions then proceed without a prompt;
      // a headless worker has no interactive layer to pass through TO, so the
      // settings allow IS the decision. Treating it as a refusal inverted the
      // operator's own rules — workers lost Edit/Write/tests wherever the
      // operator had explicitly allowed them.
      if (body.decision === 'passthrough') return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: `pilot ${body.decision ?? 'unknown'}: ${body.reason ?? 'no reason'} — do not retry this exact call; adapt or report the blocker via submit_result` };
    } catch (e) {
      return { behavior: 'deny', message: `pilot unreachable (${e instanceof Error ? e.message : e}) — failing closed` };
    }
  };
}

/**
 * MCP servers the operator already registered for directories an approved
 * action touches. Ordinary workers load the same access through Claude Code's
 * normal settings. Actions use this explicit secured copy with filesystem
 * settings disabled so every live call still reaches Pilot.
 */
export function operatorMcpServers(dirs: string[]): SecuredMcpConfiguration {
  return operatorMcpConfiguration(dirs, false);
}

/** OpenHands cannot fall back to Claude Code's hidden on-disk settings loader.
 * The serializable user/local subset discovered in ~/.claude.json must
 * therefore fail before launch when malformed, rather than quietly becoming
 * an empty tool surface. Local Claude keeps its historical tolerant discovery
 * because its own settingSources remain authoritative. */
function operatorMcpConfiguration(
  dirs: string[],
  strict: boolean,
): SecuredMcpConfiguration {
  try {
    const configPath = join(homedir(), '.claude.json');
    if (!existsSync(configPath)) return { servers: {}, env: {} };
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    if (cfg.mcpServers !== undefined && !plainObject(cfg.mcpServers)) {
      throw new Error('user mcpServers is not an object');
    }
    if (cfg.projects !== undefined && !plainObject(cfg.projects)) {
      throw new Error('projects is not an object');
    }
    const merged: Record<string, unknown> = { ...(cfg.mcpServers ?? {}) };
    const paths = Object.keys(cfg.projects ?? {}).sort((a, b) => a.length - b.length);
    for (const p of paths) {
      if (dirs.some((d) => d === p || d.startsWith(p.endsWith('/') ? p : `${p}/`))) {
        const projectServers = cfg.projects![p]?.mcpServers;
        if (projectServers !== undefined && !plainObject(projectServers)) {
          throw new Error(`project mcpServers is not an object for ${p}`);
        }
        Object.assign(merged, projectServers ?? {});
      }
    }
    return secureMcpHeaderCredentials(merged, process.env);
  } catch (caught) {
    if (strict) {
      throw new Error(
        `OpenHands could not load the operator MCP configuration: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
    return { servers: {}, env: {} };
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SHARED_RULES = `
Rules:
1. Produce exactly what the assignment asks for, judged against its acceptance criteria — the coordinator will review your submission against them literally.
2. Your submission is a PROPOSAL. It becomes real only if the coordinator adopts it, so make the artifact self-contained and reviewable.
3. For anything longer than ~150 lines, build the artifact incrementally: call append_section repeatedly (each call adds one section, in order), then call submit_result ONCE with an empty or short closing content — the appended sections are prepended automatically. Never submit a placeholder: an empty or stub artifact is worse than no submission, and the coordinator will reject it.
4. Call submit_result exactly once. Do not end without submitting.
5. If something refuses you — a denied tool, a missing permission, an input the brief assumed exists — do not engineer a longer route around it. Say exactly what refused you and what the brief needs it for. A workaround that quietly preserves a wrong constraint is worse than an honest blockage: the coordinator can change the constraint or dispatch an approved action, but only if it learns the refusal happened.
6. On an incident, alert, or user-visible failure, separate trigger, failed recovery, and escape. If the evidence says retries, fallbacks, or an aggregate such as "all models failed", enumerate every configured attempt and verify each against runtime evidence; missing telemetry is a finding, not a successful investigation. If the briefing or acceptance criteria cover containment only, perform that bounded work but state plainly that it does not fix the upstream failure and name the unverified layers in your submission.`;

const WORKER_SYSTEM = `You are one regular coding-agent worker executing ONE bounded assignment inside a larger workstream you cannot see. You have normal coding tools — including Bash, file editing, web access, and the runtime's configured MCP servers — and may use them as needed to complete the assignment. The directories in the brief are working context, not a reduced read-only tool mode. Follow their repository instructions and use a fresh worktree for repository changes unless those instructions explicitly say the directory is already an isolated disposable worktree. Your only authoritative output to Weaver is submit_result: files or external state you inspect or change do not become accepted Workstream truth merely because you report them. Use the configured MCP servers FULLY — read AND write — to do the work: whatever server the runtime exposes (issue tracker, docs, project board, …), moving an issue's status, commenting, labelling, or otherwise keeping the systems your brief names in sync is ordinary work that needs no approval. No tool is special-cased or allow-listed; there is no "read-only" MCP mode. What a work assignment does NOT authorize is IRREVERSIBLE egress to the outside world — pushing or merging code, deploying, spending, or sending a message to a person. Those are separate human-approved actions: if the requested outcome needs one, report the exact required act so the coordinator can dispatch it through the action lifecycle rather than engineering a route around the gate. MINE THE RECORDED THINKING before forming your own theory: inspect git history, PR bodies and review threads, and in-repo docs, then cite what you find by commit/PR number. When a source your brief names has IMAGES — a screenshot on a ticket, a diagram in a doc, a rendered page — open and look at them rather than reading around them; people put the specifics in the picture, and MCP servers expose them (e.g. extract_images on a tracker description or comment). If you could not see an image the work depends on, say so in your submission instead of guessing what it showed.
${SHARED_RULES}`;

/**
 * The target repo's standing agent instructions, for injection into ACTION
 * worker prompts (their settingSources: [] skips the SDK's own CLAUDE.md
 * loading). Walks from the action cwd up to the enclosing git root so a
 * worktree subdirectory still finds the repo-level file. Bounded per file:
 * these are conventions, not the briefing.
 */
/** A stable, repo-context-free cwd for workers with no declared directories.
 * Persistent per stream, so clones made there survive across assignments. */
export function neutralWorkspace(slug: string): string {
  const dir = join(homedir(), '.weaver', 'workspaces', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function repoConventions(cwd: string): string[] {
  const out: string[] = [];
  let dir = cwd;
  for (let i = 0; i < 8; i += 1) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const file = join(dir, name);
      try {
        const text = readFileSync(file, 'utf8').slice(0, 30_000);
        out.push(``, `## Target repository instructions (${file}) — these bind you like the briefing`, text);
      } catch { /* not present at this level */ }
    }
    if (out.length || existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

const ACTION_SYSTEM = `You are a fresh worker executing ONE human-approved real-world ACTION inside a larger workstream you cannot see. You have Bash in your working directory and real CLIs. Perform EXACTLY the act the briefing describes — nothing beyond it, nothing on targets the briefing does not name, and every "do not" the briefing states is absolute. If a step fails, report the failure honestly via submit_result; never improvise a different action to "make it work". If the briefing lists credential environment variables, use them via the shell (\`$NAME\`) — never echo, print, or persist their values anywhere. Your submission is a report of what you did with exact references (identifiers, URLs, command output) — the harness will independently verify the effect, so precision matters and embellishment will be caught.
${SHARED_RULES}`;

export async function finalizeWorkerRun(
  slug: string,
  assignmentId: string,
  runId: string,
  outcome: {
    submitted: boolean;
    costUsd: number;
    sessionId?: string;
    infrastructure: InfrastructureWait | null;
    capacityTarget?: CapacityTarget;
    capacityObservations?: ProviderCapacityObservation[];
    terminalReason?: string;
  },
): Promise<void> {
  const target = outcome.capacityTarget ?? workerCapacityTarget();
  // Reaching the provider at all — submitted or not — proves that pool has
  // capacity, which is an account-level fact every parked stream can use. An
  // ordinary work failure still clears capacity below; only an infrastructure
  // wait means we never got through.
  if (!outcome.infrastructure) noteFleetRecovery(target, new Date().toISOString());
  await arrive(slug, (d, event) => {
    recordProviderCapacityObservations(d, outcome.capacityObservations ?? []);
    const a = d.assignments.find((x) => x.id === assignmentId)!;
    const attempt = a.attempts.find((t) => t.runId === runId);
    if (attempt) {
      attempt.endedAt = attempt.endedAt ?? new Date().toISOString();
      attempt.costUsd = outcome.costUsd;
      if (outcome.sessionId) attempt.sessionId = outcome.sessionId;
      if (outcome.infrastructure) attempt.infrastructure = outcome.infrastructure;
    }
    d.spend.totalCostUsd += outcome.costUsd;
    if (outcome.submitted) {
      clearCapacityBackoff(d, target);
      resolveCapacityAttention(d, target, 'worker');
      return;
    }

    if (outcome.infrastructure) {
      const infrastructure = outcome.infrastructure;
      const explanation = infrastructureWaitSummary(infrastructure, slug);
      a.state = 'queued';
      if (attempt) attempt.terminalReason = 'infrastructure_backoff';
      const wakeId = newId('wake');
      d.wakes.push({
        id: wakeId,
        reason: explanation,
        condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
        status: 'pending',
        createdAt: new Date().toISOString(),
        infrastructure,
      });
      const capacity = recordCapacityBackoff(d, infrastructure);
      ensureCapacityAttention(d, capacity, wakeId, () => newId('att'));
      event('worker.backoff', `${assignmentId} attempt ${runId} parked on ${infrastructure.kind} until ${infrastructure.retryAt}`, [assignmentId, runId, wakeId]);
      return;
    }

    clearCapacityBackoff(d, target);
    resolveCapacityAttention(d, target, 'worker');
    a.state = 'failed';
    const why = outcome.terminalReason ?? 'no_submission';
    if (attempt) attempt.terminalReason = why;
    // No attention here: a flaky worker is the COORDINATOR's problem — the
    // wake below hands it the failure to retry or rework. Attention is for
    // judgment only the human can supply; it escalates only if the
    // coordinator itself decides the assignment is truly stuck.
    d.wakes.push({
      id: newId('wake'),
      reason: `assignment ${assignmentId} failed without a submission (${why})${why === 'error_max_turns' ? ' — the brief exceeded the worker turn ceiling; split it into smaller assignments rather than re-dispatching the same shape' : ''}`,
      condition: { type: 'immediate' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    event('worker.failed', `${assignmentId} attempt ${runId} ended without submission (${why})`, [assignmentId]);
  });
}

/** A due worker-originated wait is a fleet-capacity retry permit. One fresh
 * worker attempt consumes all matching permits, but never a coordinator's
 * independent commitment to reconcile the stream. */
export function consumeDueWorkerInfrastructureWakes(
  doc: WorkstreamDoc,
  targetOrModel: CapacityTarget | string,
  now: string,
): void {
  const target = typeof targetOrModel === 'string' ? null : targetOrModel;
  const model = typeof targetOrModel === 'string' ? targetOrModel : targetOrModel.model;
  for (const wake of doc.wakes) {
    if (
      wake.status === 'pending' &&
      wake.infrastructure?.source === 'worker' &&
      wake.infrastructure.model === model &&
      (!target || (
        wake.infrastructure.executor === target.executor &&
        wake.infrastructure.provider === target.provider
      )) &&
      (wake.condition.type === 'immediate' ||
        (wake.condition.type === 'time' && wake.condition.dueAtVirtual <= now))
    ) {
      wake.status = 'cancelled';
    }
  }
}

export async function runWorker(
  slug: string,
  assignmentId: string,
  providedExecutor?: WorkerExecutor,
  executorCapabilities?: ReadonlySet<string>,
): Promise<boolean> {
  const declaredExecutors = executorCapabilities ??
    (providedExecutor ? undefined : runnerExecutorCapabilities());
  const doc = await load(slug);
  if (doc.workstream.status !== 'active') return false;
  const asg = doc.assignments.find((a) => a.id === assignmentId);
  if (!asg) throw new Error(`no assignment ${assignmentId}`);
  if (asg.state !== 'queued') throw new Error(`${assignmentId} is ${asg.state}, not queued`);
  // Requirements choose one exact target before state moves. An explicitly
  // injected executor (the eval harness and deterministic tests) remains an
  // explicit target rather than being silently re-routed.
  const routedTarget = providedExecutor?.id
    ? workerCapacityTarget(workerModel(), providedExecutor.id)
    : selectWorkerCapacityTarget(doc, asg, virtualNow().toISOString(), declaredExecutors);
  if (!routedTarget) return false;
  const executorName = providedExecutor?.id ?? routedTarget.executor;
  if (declaredExecutors && !declaredExecutors.has(executorName)) return false;
  // Pinned for the whole disposable attempt: the durable record, launch,
  // failure classification, and capacity clearing must describe one target,
  // even if a long-lived process changes its environment while the run is in
  // flight. Custom/injected executors inherit the configured identity only
  // when they do not publish their own stable id.
  const capacityTarget = routedTarget;

  // Declared inputs: ADOPTED deliverables of dependency assignments only — a
  // rejected candidate never becomes another worker's input.
  const inputs: string[] = [];
  for (const depId of asg.dependsOn) {
    const dep = doc.assignments.find((a) => a.id === depId);
    if (dep?.adoption.state !== 'accepted') continue;
    const del = dep.submission?.deliverableId
      ? doc.deliverables.find((d) => d.id === dep.submission!.deliverableId)
      : undefined;
    if (del) {
      inputs.push(`### Input from ${depId} — "${del.title}"\n\n${await readArtifact(slug, del.path)}`);
    }
  }

  const runId = newId('run');
  const current = await load(slug);
  if (current.workstream.status !== 'active') return false;
  const currentAssignment = current.assignments.find((a) => a.id === assignmentId);
  if (currentAssignment?.state !== 'queued') return false;
  const currentTarget = providedExecutor?.id
    ? capacityTarget
    : selectWorkerCapacityTarget(
        current,
        currentAssignment,
        virtualNow().toISOString(),
        declaredExecutors,
      );
  if (
    !currentTarget ||
    currentTarget.executor !== capacityTarget.executor ||
    currentTarget.provider !== capacityTarget.provider ||
    currentTarget.model !== capacityTarget.model
  ) return false;
  const readDirs = asg.readDirs ?? [];
  const isAction = asg.kind === 'action';
  const workCwd = isAction ? asg.exec!.cwd : (readDirs[0] ?? neutralWorkspace(slug));
  // Local Claude and Codex inherit their complete configured MCP surface from
  // their own runtimes. OpenHands cannot read the host settings, so Weaver
  // explicitly discovers the serializable ~/.claude.json user/local subset
  // for a host relay. Do this before the attempt CAS: malformed remote config
  // must not leave a durable attempt stuck in `running` without a process.
  const operatorMcp = (isAction || executorName === 'openhands')
    ? operatorMcpConfiguration([workCwd, ...readDirs], executorName === 'openhands')
    : { servers: {}, env: {} };
  const executor = providedExecutor ?? selectExecutor(executorName);
  const startedAt = new Date();
  try {
    await mutate(slug, current.revision, (d, event) => {
      // One CAS both checks the fleet-independent rolling ceiling and records
      // the attempt, so no direct/concurrent claim can slip through it.
      if (declaredExecutors && !declaredExecutors.has(capacityTarget.executor)) {
        throw new Error(`runner does not declare worker executor '${capacityTarget.executor}'`);
      }
      assertExecutionStartAllowed(d, startedAt);
      const a = d.assignments.find((x) => x.id === assignmentId)!;
      const now = virtualNow().toISOString();
      // A due infrastructure wake is a retry permit, not separate intended
      // work. This fresh attempt consumes matching permits; success creates its
      // submission wake, while another outage creates one new future permit.
      consumeDueWorkerInfrastructureWakes(d, capacityTarget, now);
      a.state = 'running';
      a.attempts.push({
        runId,
        executor: capacityTarget.executor,
        provider: capacityTarget.provider,
        model: capacityTarget.model,
        runnerPid: process.pid,
        startedAt: startedAt.toISOString(),
      });
      event('worker.started', `${assignmentId} attempt ${runId}`, [assignmentId]);
    });
  } catch (error) {
    if (error instanceof ExecutionSafetyLimitedError) {
      await parkIfExecutionLimited(slug, startedAt);
      return false;
    }
    if (error instanceof RevisionConflictError) return false;
    throw error;
  }

  let submitted = false;
  const sections: string[] = [];
  // Action workers get secret VALUES as env vars only; every path back into
  // durable state is scrubbed so a value can never outlive the process.
  const secrets = isAction ? loadSecrets(slug) : {};
  // Ephemeral MCP header credentials join the redaction set: they ride the
  // executor's env, never durable state — whatever substrate ran the loop.
  const redactionSecrets = { ...loadRedactionSecrets(slug), ...operatorMcp.env };

  // The Weaver submission surface stays in the harness: whatever substrate
  // runs the model loop, only these closures can propose a submission through
  // Weaver's API. Process containment itself belongs to that substrate.
  const submit: SubmitSurface = {
    async appendSection(content): Promise<SubmitReply> {
      if (submitted) return { text: 'already submitted — stop', isError: true };
      sections.push(content);
      return { text: `section ${sections.length} appended (${content.length} chars, total ${sections.reduce((n, s) => n + s.length, 0)})` };
    },

    async submitResult(a): Promise<SubmitReply> {
      if (submitted) return { text: 'already submitted — stop', isError: true };
      const fullContent = [...sections, a.artifact.content].filter(Boolean).join('\n\n');
      if (fullContent.trim().length < 200) {
        return {
          text: `REFUSED: artifact content is ${fullContent.trim().length} chars — that is a stub, not a deliverable. Build the real artifact with append_section calls, then submit_result again.`,
          isError: true,
        };
      }
      submitted = true;
      const cleanContent = redactSecrets(fullContent, redactionSecrets);
      const cleanSummary = redactSecrets(a.summary, redactionSecrets);
      const cleanTitle = redactSecrets(a.artifact.title, redactionSecrets);
      const cleanKind = redactSecrets(a.artifact.kind, redactionSecrets);
      const cleanFileName = redactSecrets(a.artifact.file_name, redactionSecrets);
      const { relPath, hash } = await writeArtifact(slug, cleanFileName, cleanContent);
      await arrive(slug, (d, event) => {
        const asg2 = d.assignments.find((x) => x.id === assignmentId)!;
        const delId = newId('del');
        d.deliverables.push({
          id: delId,
          title: cleanTitle,
          kind: cleanKind,
          path: relPath,
          contentHash: hash,
          producedByAssignment: assignmentId,
          createdAtVirtual: virtualNow().toISOString(),
        });
        asg2.submission = { summary: cleanSummary, deliverableId: delId };
        asg2.state = 'awaiting_review';
        asg2.adoption = { state: 'proposed' };
        const attempt = asg2.attempts.find((t) => t.runId === runId);
        if (attempt) attempt.endedAt = new Date().toISOString();
        d.wakes.push({
          id: newId('wake'),
          reason: `assignment ${assignmentId} submitted a result for review`,
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('worker.submitted', `${assignmentId} → ${delId} "${cleanTitle}" (${hash.slice(0, 8)})`, [assignmentId, delId]);
      });
      return { text: 'submitted — you are done' };
    },
  };

  const prompt = [
    `# Assignment ${asg.id} (${asg.kind})`,
    ``,
    `Objective: ${asg.objective}`,
    ``,
    `## Briefing`,
    asg.briefing,
    ``,
    `## Acceptance criteria (you will be judged against these literally)`,
    ...asg.acceptanceCriteria.map((c) => `- ${c}`),
    ...(readDirs.length
      ? [
          ``,
          isAction ? `## Additional source directories` : `## Working/source directories`,
          isAction
            ? `These are additional project context; your action working directory is ${asg.exec!.cwd}:`
            : `The first directory is your working directory; the others are additional project context:`,
          ...readDirs.map((dir) => `- ${dir}`),
        ]
      : []),
    ...(Object.keys(secrets).length
      ? [
          ``,
          `## Credentials`,
          `These secrets are set as environment variables in your shell — use them directly (e.g. \`$${Object.keys(secrets).sort()[0]}\`), never echo their values or write them into files or your submission:`,
          ...Object.keys(secrets)
            .sort()
            .map((n) => `- ${n}`),
        ]
      : []),
    ...(inputs.length ? [``, `## Declared inputs`, ...inputs] : []),
    // Action workers run with settingSources: [] so filesystem allow-rules can
    // never shadow the pilot supervisor — but that also strips the SDK's
    // CLAUDE.md loading, so the target repo's own conventions (PR labels,
    // commit style, test requirements) silently vanished from exactly the
    // workers that open PRs. Inject them deterministically instead.
    ...(isAction ? repoConventions(asg.exec!.cwd) : []),
  ].join('\n');

  let costUsd = 0;
  let sessionId: string | undefined;
  let resultSubtype: string | undefined;
  const sdkFailure = new SdkFailureTracker();
  // Hard wall under the 45m stale/slot horizons: a hung SDK call must fail
  // (→ no_submission → coordinator retries) rather than starve the runner.
  // Sleep-aware: laptop-lid suspension doesn't count toward the wall.
  const abort = new AbortController();
  const wall = armWall(abort, 40 * 60_000, 'worker');
  try {
    if (isAction) {
      // Structural gate, independent of the engine's scheduling: an action
      // worker must never start without its recorded human approval.
      if (!asg.exec?.approval) throw new Error(`${assignmentId} is an action without human approval — refusing to run`);
    }
    // The worker cwd MUST exist before the SDK spawns the child process: a
    // non-existent cwd fails the spawn with ENOENT, which the SDK surfaces as
    // the misleading "native binary … failed to launch". Action cwds and the
    // neutralWorkspace() fallback self-create, but a coordinator-declared WORK
    // workspace (readDirs[0] — e.g. a /tmp scratch dir the brief says to clone
    // into) did not, so every such worker crashed cryptically before it could
    // create it.
    mkdirSync(workCwd, { recursive: true });
    const outcome = await executor.execute({
      workstreamSlug: slug,
      assignmentId,
      prompt,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: isAction ? ACTION_SYSTEM : WORKER_SYSTEM,
      },
      model: capacityTarget.model,
      tools: { type: 'preset', preset: 'claude_code' },
      // Ephemeral MCP header credentials ride the subprocess env with the
      // action secrets — never SDK process arguments, never durable state.
      env: sdkEnv({ ...secrets, ...operatorMcp.env }),
      ...(isAction
        ? {
            cwd: asg.exec!.cwd,
            additionalDirectories: readDirs,
          }
        : {
            // The first declared directory decides which repo's instructions,
            // settings, and MCPs shape the session. With none declared, a
            // NEUTRAL per-stream workspace — never the runner's own checkout,
            // whose CLAUDE.md and settings would leak into unrelated work.
            cwd: workCwd,
            additionalDirectories: readDirs,
          }),
      // The SECURED server map: header credentials already moved into env
      // placeholders by the harness. Local ordinary workers load their normal
      // on-disk runtime configuration; OpenHands receives this map through its
      // authenticated host relay because the container cannot read host settings.
      operatorMcpServers: operatorMcp.servers,
      // Every worker is a normal coding-agent worker. A declared action remains
      // special only because Pilot supervises its calls and the engine reads
      // the external effect back before Weaver can adopt it as fact.
      allowedTools: ['mcp__weaver__*'],
      permissionMode: isAction ? 'default' : 'bypassPermissions',
      settingSources: isAction ? [] : ['user', 'project', 'local'],
      strictMcpConfig: isAction,
      ...(isAction ? { supervise: pilotSupervisor(asg.exec!.cwd, slug) } : {}),
      submit,
      // 80 turns killed a routine clone-fix-test brief on a large repo before
      // it could submit (11 wasted minutes + a re-split). Repo-scale setup
      // alone eats dozens of turns; the real runaway bounds are the assignment
      // rolling start guard and the engine's supervision, not a tight turn count.
      maxTurns: Number(process.env.WEAVER_WORKER_MAX_TURNS) || 200,
      abort,
      onMessage: (message) => {
        tailMessage(slug, 'worker', assignmentId, message, operatorMcp.env);
        sdkFailure.observe(message);
        if (message.type === 'result') {
          if (message.subtype !== 'success') resultSubtype = message.subtype;
        }
      },
    });
    costUsd = outcome.costUsd;
    sessionId = outcome.sessionId;
    if (outcome.error) {
      // The loop failed inside the substrate: same classification path as a
      // local throw — capture for the capacity tracker, keep the message.
      sdkFailure.capture(new Error(outcome.error));
      process.stderr.write(`worker ${runId} error: ${outcome.error}\n`);
      resultSubtype = resultSubtype ?? `exception: ${outcome.error.slice(0, 80)}`;
    }
  } catch (e) {
    sdkFailure.capture(e);
    process.stderr.write(`worker ${runId} error: ${e instanceof Error ? e.message : e}\n`);
    resultSubtype = resultSubtype ?? `exception: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`;
  } finally {
    wall.disarm();
  }

  const wallFired = wall.fired();
  if (wallFired && !submitted) resultSubtype = 'wall_timeout';

  const capacitySource = {
    source: 'worker',
    sourceId: runId,
    model: capacityTarget.model,
    executor: capacityTarget.executor,
    provider: capacityTarget.provider,
    now: virtualNow(),
    wallNow: new Date(),
    wallFired,
  } as const;
  const infrastructure = sdkFailure.classify(capacitySource);
  const capacityObservations = sdkFailure.capacityObservations(capacitySource);

  await finalizeWorkerRun(slug, assignmentId, runId, {
    submitted,
    costUsd,
    ...(sessionId ? { sessionId } : {}),
    infrastructure,
    capacityTarget,
    capacityObservations,
    ...(resultSubtype ? { terminalReason: resultSubtype } : {}),
  });
  return true;
}
