/**
 * The worker runner: one fresh, side-effect-free Agent SDK run per assignment.
 *
 * A worker sees ONLY its briefing plus the declared inputs (deliverables of
 * its dependency assignments) — never the coordinator's reasoning, never the
 * projection, never a transcript. Its only write path is the submit tool,
 * which produces an artifact + submission record. Completion stores a wake.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { virtualNow } from './clock.js';
import { arrive, load, newId, readArtifact, writeArtifact } from './store.js';

export function workerModel(): string {
  return process.env.WEAVER_WORKER_MODEL ?? 'sonnet';
}

const WORKER_SYSTEM = `You are an isolated worker executing ONE bounded assignment inside a larger workstream you cannot see. You have no memory of anything outside this brief and no ability to affect the world: your single output channel is the submit_result tool.

Rules:
1. Produce exactly what the assignment asks for, judged against its acceptance criteria — the coordinator will review your submission against them literally.
2. Your submission is a PROPOSAL. It becomes real only if the coordinator adopts it, so make the artifact self-contained and reviewable.
3. Call submit_result exactly once, with the complete artifact content. Do not end without submitting.`;

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
    a.state = 'running';
    a.attempts.push({
      runId,
      model: workerModel(),
      startedAt: new Date().toISOString(),
    });
    event('worker.started', `${assignmentId} attempt ${runId}`, [assignmentId]);
  });

  let submitted = false;

  const server = createSdkMcpServer({
    name: 'weaver',
    version: '0.1.0',
    tools: [
      tool(
        'submit_result',
        'Submit your completed work. artifact.content is the full deliverable. Call exactly once.',
        {
          summary: z.string().describe('2-3 sentence faithful summary of what the artifact contains'),
          artifact: z.object({
            title: z.string(),
            kind: z.string().describe('e.g. report, job_description, outreach_email'),
            file_name: z.string(),
            content: z.string(),
          }),
        },
        async (a) => {
          if (submitted) {
            return { content: [{ type: 'text' as const, text: 'already submitted — stop' }], isError: true };
          }
          submitted = true;
          const { relPath, hash } = writeArtifact(slug, a.artifact.file_name, a.artifact.content);
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
            asg2.submission = { summary: a.summary, deliverableId: delId };
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
    ...(inputs.length ? [``, `## Declared inputs`, ...inputs] : []),
  ].join('\n');

  let costUsd = 0;
  let sessionId: string | undefined;
  try {
    for await (const message of query({
      prompt,
      options: {
        model: workerModel(),
        systemPrompt: WORKER_SYSTEM,
        tools: [],
        mcpServers: { weaver: server },
        allowedTools: ['mcp__weaver__*'],
        permissionMode: 'dontAsk',
        maxTurns: 30,
        persistSession: false,
      },
    })) {
      if (message.type === 'result') {
        sessionId = message.session_id;
        costUsd = 'total_cost_usd' in message ? message.total_cost_usd : 0;
      }
    }
  } catch (e) {
    process.stderr.write(`worker ${runId} error: ${e instanceof Error ? e.message : e}\n`);
  }

  arrive(slug, (d, event) => {
    const a = d.assignments.find((x) => x.id === assignmentId)!;
    const attempt = a.attempts.find((t) => t.runId === runId);
    if (attempt) {
      attempt.endedAt = attempt.endedAt ?? new Date().toISOString();
      attempt.costUsd = costUsd;
      if (sessionId) attempt.sessionId = sessionId;
    }
    d.spend.totalCostUsd += costUsd;
    if (!submitted) {
      a.state = 'failed';
      if (attempt) attempt.terminalReason = 'no_submission';
      d.attention.push({
        id: newId('att'),
        kind: 'blocker',
        summary: `Worker for ${assignmentId} ended without submitting a result`,
        refId: assignmentId,
        status: 'open',
        createdAt: new Date().toISOString(),
      });
      d.wakes.push({
        id: newId('wake'),
        reason: `assignment ${assignmentId} failed without a submission`,
        condition: { type: 'immediate' },
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      event('worker.failed', `${assignmentId} attempt ${runId} ended without submission`, [assignmentId]);
    }
  });
}
