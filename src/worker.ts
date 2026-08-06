/**
 * The worker runner: one fresh, side-effect-free Agent SDK run per assignment.
 *
 * A worker sees ONLY its briefing plus the declared inputs (deliverables of
 * its dependency assignments) — never the coordinator's reasoning, never the
 * projection, never a transcript. Its only write path is the submit tool,
 * which produces an artifact + submission record. Completion stores a wake.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { virtualNow } from './clock.js';
import { armWall } from './wall.js';
import { infrastructureWaitSummary, SdkFailureTracker } from './capacity.js';
import { loadSecrets, redactSecrets, sdkEnv } from './secrets.js';
import { arrive, load, newId, readArtifact, writeArtifact } from './store.js';
import { tailMessage } from './tail.js';
import type { InfrastructureWait, WorkstreamDoc } from './types.js';

export function workerModel(): string {
  return process.env.WEAVER_WORKER_MODEL ?? 'sonnet';
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
 * The read-only gate for non-action workers' MCP access. MCP servers are not
 * inherently read-only (Sentry can update issues, Axiom can delete monitors),
 * but retrieval IS research — so instead of withholding the servers entirely,
 * the harness allows methods whose name states a read intent and denies
 * everything else. Deliberately deterministic and fail-closed: an unmatched
 * verb is denied, and no model (worker or pilot) is consulted — the
 * side-effect-free guarantee for research workers stays structural.
 */
const MCP_READ_VERBS = ['describe', 'search', 'status', 'export', 'fetch', 'query', 'check', 'count', 'watch', 'list', 'find', 'show', 'read', 'get'];

export function isReadOnlyMcpTool(toolName: string): boolean {
  const parts = toolName.split('__');
  if (parts[0] !== 'mcp' || parts.length < 3) return false;
  const method = parts.slice(2).join('__');
  const lower = method.toLowerCase();
  // The verb must be the whole method or be followed by a case/underscore
  // boundary: `getIssue`/`get_issue`/`get` pass, `gettysburg` does not.
  return MCP_READ_VERBS.some(
    (v) => lower === v || (lower.startsWith(v) && /[^a-z]/.test(method.charAt(v.length))),
  );
}

/**
 * Read-only shell commands for non-action workers: the operator's recorded
 * thinking lives in git history and PR discussions ("I went back and forth on
 * this in the PR"), and Read/Grep cannot open either. So read-only workers get
 * Bash gated to an exact allowlist of history-reading git/gh forms — plain
 * single commands only: any shell metacharacter (chaining, redirection,
 * substitution) or output-writing flag fails the gate. Fail-closed like the
 * MCP gate: unmatched means denied, no model consulted.
 */
const READ_SHELL_FORMS = [
  /^git(\s+(-C\s+\S+|--no-pager))*\s+(log|show|diff|blame|shortlog|describe|status|grep|ls-files|rev-parse)\b/,
  /^gh\s+(pr\s+(list|view|diff|checks|status)|issue\s+(list|view|status)|release\s+(list|view)|run\s+(list|view)|search\s+(prs|issues|commits|code))\b/,
];
const SHELL_META = /[;&|<>`$\\]/;

export function isReadOnlyShellCommand(command: string): boolean {
  const c = command.trim();
  if (SHELL_META.test(c) || c.includes('\n') || c.includes('--output')) return false;
  return READ_SHELL_FORMS.some((r) => r.test(c));
}

function readOnlyMcpSupervisor() {
  return async (toolName: string, input: Record<string, unknown>): Promise<
    { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
  > => {
    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (isReadOnlyShellCommand(command)) return { behavior: 'allow', updatedInput: input };
      return {
        behavior: 'deny',
        message: `read-only workers may only run plain history-reading commands (git log/show/diff/blame/status/grep, gh pr|issue list/view, gh search) with no pipes, chaining, or redirection. Rephrase as one such command, or state the need in your submission.`,
      };
    }
    if (isReadOnlyMcpTool(toolName)) return { behavior: 'allow', updatedInput: input };
    return {
      behavior: 'deny',
      message: `${toolName} is not a read operation and you are a read-only worker. Do not look for another way to perform this act. If the assignment genuinely needs it, state that in your submission so the coordinator can dispatch a supervised action.`,
    };
  };
}

/**
 * MCP servers the OPERATOR already registered for the directories an action
 * touches (global + every ~/.claude.json project entry that is an ancestor of
 * the action's dirs, closest last so it wins). Workers act as the operator on
 * this machine, so they get the operator's MCPs — same servers, same stored
 * auth — instead of asking the human to re-plumb access that already exists.
 * Action workers get the full surface under live pilot supervision; read-only
 * workers get the same servers behind the deterministic read-only gate below.
 */
export function operatorMcpServers(dirs: string[]): Record<string, unknown> {
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
    return merged;
  } catch {
    return {};
  }
}

const SHARED_RULES = `
Rules:
1. Produce exactly what the assignment asks for, judged against its acceptance criteria — the coordinator will review your submission against them literally.
2. Your submission is a PROPOSAL. It becomes real only if the coordinator adopts it, so make the artifact self-contained and reviewable.
3. For anything longer than ~150 lines, build the artifact incrementally: call append_section repeatedly (each call adds one section, in order), then call submit_result ONCE with an empty or short closing content — the appended sections are prepended automatically. Never submit a placeholder: an empty or stub artifact is worse than no submission, and the coordinator will reject it.
4. Call submit_result exactly once. Do not end without submitting.`;

const WORKER_SYSTEM = `You are an isolated worker executing ONE bounded assignment inside a larger workstream you cannot see. You have no memory of anything outside this brief and no ability to affect the world: your single output channel is the submit_result tool. If the assignment declares read-only directories, you may Read/Grep/Glob within them to ground your work in the real source — cite real file paths and line numbers, never invented ones. You may also have the operator's MCP tools (error trackers, log stores, …) available in READ-ONLY mode: retrieval calls (get/list/search/query/…) work, anything that would mutate external state is denied by the harness — if the assignment needs such a mutation, say so in your submission rather than working around the denial. When investigating a system, MINE THE RECORDED THINKING before forming your own theory: Bash is available for plain history-reading commands only (git log/show/diff/blame/grep, gh pr|issue list/view, gh search) — the operator's commit messages, PR bodies and review discussions, and in-repo docs often contain the exact rationale, prior attempts, and constraints your assignment is about to rediscover. Cite what you find by commit/PR number.
${SHARED_RULES}`;

const ACTION_SYSTEM = `You are an isolated worker executing ONE human-approved real-world ACTION inside a larger workstream you cannot see. You have Bash in your working directory and real CLIs. Perform EXACTLY the act the briefing describes — nothing beyond it, nothing on targets the briefing does not name, and every "do not" the briefing states is absolute. If a step fails, report the failure honestly via submit_result; never improvise a different action to "make it work". If the briefing lists credential environment variables, use them via the shell (\`$NAME\`) — never echo, print, or persist their values anywhere. Your submission is a report of what you did with exact references (identifiers, URLs, command output) — the harness will independently verify the effect, so precision matters and embellishment will be caught.
${SHARED_RULES}`;

export function finalizeWorkerRun(
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
): void {
  arrive(slug, (d, event) => {
    const a = d.assignments.find((x) => x.id === assignmentId)!;
    const attempt = a.attempts.find((t) => t.runId === runId);
    if (attempt) {
      attempt.endedAt = attempt.endedAt ?? new Date().toISOString();
      attempt.costUsd = outcome.costUsd;
      if (outcome.sessionId) attempt.sessionId = outcome.sessionId;
      if (outcome.infrastructure) attempt.infrastructure = outcome.infrastructure;
    }
    d.spend.totalCostUsd += outcome.costUsd;
    if (outcome.submitted) return;

    if (outcome.infrastructure) {
      const infrastructure = outcome.infrastructure;
      const explanation = infrastructureWaitSummary(infrastructure);
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
      if (infrastructure.recovery === 'reauthenticate') {
        const existing = d.attention.find(
          (item) => item.status === 'open' && item.summary.startsWith('Claude authentication needs attention'),
        );
        if (existing) {
          existing.refId = wakeId;
        } else {
          d.attention.push({
            id: newId('att'),
            kind: 'blocker',
            summary: explanation,
            refId: wakeId,
            status: 'open',
            createdAt: new Date().toISOString(),
          });
        }
      }
      event('worker.backoff', `${assignmentId} attempt ${runId} parked on ${infrastructure.kind} until ${infrastructure.retryAt}`, [assignmentId, runId, wakeId]);
      return;
    }

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

export async function runWorker(slug: string, assignmentId: string): Promise<void> {
  const doc = load(slug);
  const asg = doc.assignments.find((a) => a.id === assignmentId);
  if (!asg) throw new Error(`no assignment ${assignmentId}`);
  if (asg.state !== 'queued') throw new Error(`${assignmentId} is ${asg.state}, not queued`);

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
      inputs.push(`### Input from ${depId} — "${del.title}"\n\n${readArtifact(slug, del.path)}`);
    }
  }

  const runId = newId('run');
  arrive(slug, (d, event) => {
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

  let submitted = false;
  const sections: string[] = [];
  // Action workers get secret VALUES as env vars only; every path back into
  // durable state is scrubbed so a value can never outlive the process.
  const secrets = asg.kind === 'action' ? loadSecrets(slug) : {};

  const server = createSdkMcpServer({
    name: 'weaver',
    version: '0.1.0',
    tools: [
      tool(
        'append_section',
        'Append one section of a long artifact, in order. Use for any deliverable longer than ~150 lines, then finish with submit_result (whose content may be empty — appended sections are included automatically).',
        { content: z.string().min(1) },
        async (a) => {
          if (submitted) {
            return { content: [{ type: 'text' as const, text: 'already submitted — stop' }], isError: true };
          }
          sections.push(a.content);
          return { content: [{ type: 'text' as const, text: `section ${sections.length} appended (${a.content.length} chars, total ${sections.reduce((n, s) => n + s.length, 0)})` }] };
        },
      ),

      tool(
        'submit_result',
        'Finalize your submission. If you used append_section, the appended sections form the artifact body and content may be empty. Call exactly once.',
        {
          summary: z.string().describe('2-3 sentence faithful summary of what the artifact contains'),
          artifact: z.object({
            title: z.string(),
            kind: z.string().describe('e.g. report, job_description, outreach_email'),
            file_name: z.string(),
            content: z.string().describe('full content, or closing content / empty when sections were appended'),
          }),
        },
        async (a) => {
          if (submitted) {
            return { content: [{ type: 'text' as const, text: 'already submitted — stop' }], isError: true };
          }
          const fullContent = [...sections, a.artifact.content].filter(Boolean).join('\n\n');
          if (fullContent.trim().length < 200) {
            return {
              content: [{ type: 'text' as const, text: `REFUSED: artifact content is ${fullContent.trim().length} chars — that is a stub, not a deliverable. Build the real artifact with append_section calls, then submit_result again.` }],
              isError: true,
            };
          }
          submitted = true;
          const cleanContent = redactSecrets(fullContent, secrets);
          const cleanSummary = redactSecrets(a.summary, secrets);
          const { relPath, hash } = writeArtifact(slug, a.artifact.file_name, cleanContent);
          arrive(slug, (d, event) => {
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
          return { content: [{ type: 'text' as const, text: 'submitted — you are done' }] };
        },
      ),
    ],
  });

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
    const readDirs = asg.readDirs ?? [];
    const isAction = asg.kind === 'action';
    if (isAction) {
      // Structural gate, independent of the engine's scheduling: an action
      // worker must never start without its recorded human approval.
      if (!asg.exec?.approval) throw new Error(`${assignmentId} is an action without human approval — refusing to run`);
      mkdirSync(asg.exec.cwd, { recursive: true });
    }
    // Actions get real Bash inside their approved cwd — the model drives real
    // CLIs (git, gh, ...) directly; there is no per-channel adapter layer.
    // Everything else stays side-effect-free.
    const baseTools = isAction
      ? ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit']
      : readDirs.length
        ? ['Read', 'Grep', 'Glob', 'Bash'] // Bash gated to read-only history commands below
        : [];
    const operatorMcp = operatorMcpServers(isAction ? [asg.exec!.cwd, ...readDirs] : readDirs);
    for await (const message of query({
      prompt,
      options: {
        model: workerModel(),
        systemPrompt: isAction ? ACTION_SYSTEM : WORKER_SYSTEM,
        tools: baseTools,
        env: sdkEnv(secrets),
        ...(isAction
          ? {
              cwd: asg.exec!.cwd,
              additionalDirectories: readDirs,
              // Confine the action's Bash to its approved cwd: without this,
              // a misbriefed or injected worker could write anywhere the OS
              // user can — including forging its own workstream state. If the
              // sandbox blocks something the act genuinely needs, the failure
              // is LOUD (the act fails, readback fails, attention is raised);
              // WEAVER_NO_SANDBOX=1 is the explicit, human-owned override.
              ...(process.env.WEAVER_NO_SANDBOX
                ? {}
                : { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: false } }),
            }
          : readDirs.length
            ? { cwd: readDirs[0], additionalDirectories: readDirs }
            : {}),
        mcpServers: { ...operatorMcp, weaver: server } as never,
        // Action workers: ONLY the submit surface is auto-allowed — every
        // real tool call (Bash, edits, operator MCPs) routes through the live
        // pilot supervisor, judged at execution time exactly like the
        // operator's own sessions. Read-only workers auto-allow their file
        // tools + submit surface; operator MCP calls fall through to the
        // deterministic read-only gate.
        // Bash is NOT auto-allowed for read-only workers — it must fall
        // through to the supervisor's command allowlist.
        allowedTools: isAction
          ? ['mcp__weaver__*']
          : [...baseTools.filter((t) => t !== 'Bash'), 'mcp__weaver__*'],
        permissionMode: 'default',
        canUseTool: (isAction ? pilotSupervisor(asg.exec!.cwd, slug) : readOnlyMcpSupervisor()) as never,
        maxTurns: isAction || readDirs.length || Object.keys(operatorMcp).length ? 80 : 30,
        persistSession: false,
        abortController: abort,
      },
    })) {
      tailMessage(slug, 'worker', assignmentId, message);
      sdkFailure.observe(message);
      if (message.type === 'result') {
        sessionId = message.session_id;
        costUsd = 'total_cost_usd' in message ? message.total_cost_usd : 0;
        if (message.subtype !== 'success') resultSubtype = message.subtype;
      }
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

  finalizeWorkerRun(slug, assignmentId, runId, {
    submitted,
    costUsd,
    ...(sessionId ? { sessionId } : {}),
    infrastructure,
    ...(resultSubtype ? { terminalReason: resultSubtype } : {}),
  });
}
