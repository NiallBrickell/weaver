/**
 * The worker runner: one fresh, full-capability Agent SDK run per assignment.
 *
 * A worker sees ONLY its briefing plus the declared inputs (deliverables of
 * its dependency assignments) — never the coordinator's reasoning, never the
 * projection, never a transcript. Its only Weaver state API is the submit
 * tool, which produces an artifact + submission record. Completion stores a
 * wake. Its ordinary coding tools are supplied by the execution substrate.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { virtualNow } from './clock.js';
import { LocalSdkExecutor } from './executor/localSdk.js';
import type { SubmitReply, SubmitSurface, WorkerExecutor } from './executor/types.js';
import { armWall } from './wall.js';
import {
  clearCapacityBackoff,
  ensureCapacityAttention,
  infrastructureWaitSummary,
  recordCapacityBackoff,
  resolveCapacityAttention,
  SdkFailureTracker,
} from './capacity.js';
import { loadSecrets, redactSecrets, sdkEnv } from './secrets.js';
import { arrive, load, mutate, newId, readArtifact, RevisionConflictError, writeArtifact } from './store.js';
import { tailMessage } from './tail.js';
import type { InfrastructureWait, WorkstreamDoc } from './types.js';
import { secureMcpHeaderCredentials, type SecuredMcpConfiguration } from './mcpConfig.js';

export function workerModel(): string {
  return process.env.WEAVER_WORKER_MODEL ?? 'sonnet';
}

/**
 * Which substrate runs the worker's model loop. The seam exists so remote
 * executors can slot in later; the authority model does not change with the
 * substrate — every executor gets the same harness-owned supervision and
 * submit callbacks. Unknown values fail hard: silently falling back to local
 * execution would make a misconfigured remote fleet look healthy.
 */
export function selectExecutor(): WorkerExecutor {
  const name = process.env.WEAVER_EXECUTOR ?? 'local-sdk';
  if (name === 'local-sdk') return new LocalSdkExecutor();
  throw new Error(`unknown WEAVER_EXECUTOR '${name}' — supported: local-sdk`);
}

/**
 * Live per-command supervision for action workers: every tool call is judged
 * by the operator's PILOT daemon at execution time — exactly how their own
 * interactive sessions are supervised — instead of a human pre-approving a
 * plan. Pilot unreachable or non-approve ⇒ deny (fail closed); the worker
 * reports the denial honestly and readback/coordinator handle the fallout.
 */
function pilotSupervisor(cwd: string, slug: string) {
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
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    const merged: Record<string, unknown> = { ...(cfg.mcpServers ?? {}) };
    const paths = Object.keys(cfg.projects ?? {}).sort((a, b) => a.length - b.length);
    for (const p of paths) {
      if (dirs.some((d) => d === p || d.startsWith(p.endsWith('/') ? p : `${p}/`))) {
        Object.assign(merged, cfg.projects![p]!.mcpServers ?? {});
      }
    }
    return secureMcpHeaderCredentials(merged);
  } catch {
    return { servers: {}, env: {} };
  }
}

const SHARED_RULES = `
Rules:
1. Produce exactly what the assignment asks for, judged against its acceptance criteria — the coordinator will review your submission against them literally.
2. Your submission is a PROPOSAL. It becomes real only if the coordinator adopts it, so make the artifact self-contained and reviewable.
3. For anything longer than ~150 lines, build the artifact incrementally: call append_section repeatedly (each call adds one section, in order), then call submit_result ONCE with an empty or short closing content — the appended sections are prepended automatically. Never submit a placeholder: an empty or stub artifact is worse than no submission, and the coordinator will reject it.
4. Call submit_result exactly once. Do not end without submitting.
5. If something refuses you — a denied tool, a missing permission, an input the brief assumed exists — do not engineer a longer route around it. Say exactly what refused you and what the brief needs it for. A workaround that quietly preserves a wrong constraint is worse than an honest blockage: the coordinator can change the constraint or dispatch an approved action, but only if it learns the refusal happened.`;

const WORKER_SYSTEM = `You are one regular Claude Code worker executing ONE bounded assignment inside a larger workstream you cannot see. You have normal coding tools — including Bash, file editing, web access, and the operator's configured MCP servers — and may use them as needed to complete the assignment. The directories in the brief are working context, not a reduced read-only tool mode. Follow their repository instructions and use a fresh worktree for repository changes. Your only authoritative output to Weaver is submit_result: files or external state you inspect or change do not become accepted Workstream truth merely because you report them. A non-action assignment is not authorization for an intentional external effect such as pushing, merging, deploying, sending, or changing a remote service; if the requested outcome needs one, report the exact required act so the coordinator can dispatch it through the action lifecycle. MINE THE RECORDED THINKING before forming your own theory: inspect git history, PR bodies and review threads, and in-repo docs, then cite what you find by commit/PR number.
${SHARED_RULES}`;

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
    terminalReason?: string;
  },
): Promise<void> {
  await arrive(slug, (d, event) => {
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
      clearCapacityBackoff(d, workerModel());
      resolveCapacityAttention(d, workerModel(), 'worker');
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

    clearCapacityBackoff(d, workerModel());
    resolveCapacityAttention(d, workerModel(), 'worker');
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
  model: string,
  now: string,
): void {
  for (const wake of doc.wakes) {
    if (
      wake.status === 'pending' &&
      wake.infrastructure?.source === 'worker' &&
      wake.infrastructure.model === model &&
      (wake.condition.type === 'immediate' || wake.condition.dueAtVirtual <= now)
    ) {
      wake.status = 'cancelled';
    }
  }
}

export async function runWorker(
  slug: string,
  assignmentId: string,
  providedExecutor?: WorkerExecutor,
): Promise<boolean> {
  const doc = await load(slug);
  if (doc.workstream.status !== 'active') return false;
  const asg = doc.assignments.find((a) => a.id === assignmentId);
  if (!asg) throw new Error(`no assignment ${assignmentId}`);
  if (asg.state !== 'queued') throw new Error(`${assignmentId} is ${asg.state}, not queued`);
  // A misconfigured WEAVER_EXECUTOR fails here, before any state moves.
  const executor = providedExecutor ?? selectExecutor();

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
  try {
    await mutate(slug, current.revision, (d, event) => {
      const a = d.assignments.find((x) => x.id === assignmentId)!;
      const now = virtualNow().toISOString();
      // A due infrastructure wake is a retry permit, not separate intended
      // work. This fresh attempt consumes matching permits; success creates its
      // submission wake, while another outage creates one new future permit.
      consumeDueWorkerInfrastructureWakes(d, workerModel(), now);
      a.state = 'running';
      a.attempts.push({
        runId,
        model: workerModel(),
        runnerPid: process.pid,
        startedAt: new Date().toISOString(),
      });
      event('worker.started', `${assignmentId} attempt ${runId}`, [assignmentId]);
    });
  } catch (error) {
    if (error instanceof RevisionConflictError) return false;
    throw error;
  }

  let submitted = false;
  const sections: string[] = [];
  const readDirs = asg.readDirs ?? [];
  const isAction = asg.kind === 'action';
  // Ordinary workers inherit the operator's normal Claude Code settings.
  // Actions get an explicit secured MCP map while filesystem settings are
  // disabled, keeping their tool calls behind Pilot.
  const operatorMcp = isAction && asg.exec
    ? operatorMcpServers([asg.exec.cwd, ...readDirs])
    : { servers: {}, env: {} };
  // Action workers get secret VALUES as env vars only; every path back into
  // durable state is scrubbed so a value can never outlive the process.
  const secrets = isAction ? loadSecrets(slug) : {};
  // Ephemeral MCP header credentials join the redaction set: they ride the
  // executor's env, never durable state — whatever substrate ran the loop.
  const redactionSecrets = { ...secrets, ...operatorMcp.env };

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
      const { relPath, hash } = await writeArtifact(slug, a.artifact.file_name, cleanContent);
      await arrive(slug, (d, event) => {
        const asg2 = d.assignments.find((x) => x.id === assignmentId)!;
        const delId = newId('del');
        d.deliverables.push({
          id: delId,
          title: a.artifact.title,
          kind: a.artifact.kind,
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
        event('worker.submitted', `${assignmentId} → ${delId} "${a.artifact.title}" (${hash.slice(0, 8)})`, [assignmentId, delId]);
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
      mkdirSync(asg.exec.cwd, { recursive: true });
    }
    const outcome = await executor.execute({
      workstreamSlug: slug,
      assignmentId,
      prompt,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: isAction ? ACTION_SYSTEM : WORKER_SYSTEM,
      },
      model: workerModel(),
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
            ...(readDirs.length ? { cwd: readDirs[0] } : {}),
            additionalDirectories: readDirs,
          }),
      // The SECURED server map: header credentials already moved into env
      // placeholders by the harness for action workers. Ordinary workers load
      // their normal on-disk Code configuration instead.
      operatorMcpServers: operatorMcp.servers,
      // Every worker is a normal Code worker. A declared action remains
      // special only because Pilot supervises its calls and the engine reads
      // the external effect back before Weaver can adopt it as fact.
      allowedTools: ['mcp__weaver__*'],
      permissionMode: isAction ? 'default' : 'bypassPermissions',
      settingSources: isAction ? [] : ['user', 'project', 'local'],
      strictMcpConfig: isAction,
      ...(isAction ? { supervise: pilotSupervisor(asg.exec!.cwd, slug) } : {}),
      submit,
      maxTurns: 80,
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

  const infrastructure = sdkFailure.classify({
    source: 'worker',
    sourceId: runId,
    model: workerModel(),
    now: virtualNow(),
    wallNow: new Date(),
    wallFired: wall.fired(),
  });

  await finalizeWorkerRun(slug, assignmentId, runId, {
    submitted,
    costUsd,
    ...(sessionId ? { sessionId } : {}),
    infrastructure,
    ...(resultSubtype ? { terminalReason: resultSubtype } : {}),
  });
  return true;
}
