/**
 * `weaver ask "<question>"` — interrogate the fleet's history in plain
 * language: has anything picked X up, what happened with Y, why wasn't Z done.
 *
 * The answer is grounded in typed state only: a deterministic digest of every
 * workstream (live and archived) anchors the model, and read-only tools over
 * WEAVER_HOME let it pull full decisions, events, and artifacts before
 * answering. It has no mutation surface — asking can never change course —
 * and state is secret-free by construction (redaction at every write path),
 * so nothing here can leak a credential.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sdkEnv } from './secrets.js';
import { listWorkstreams, weaverHome, workstreamDir } from './store.js';
import type { WorkstreamDoc } from './types.js';
import { workerModel } from './worker.js';

function digestOne(slug: string, dir: string): string {
  let doc: WorkstreamDoc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(dir, 'workstream.json'), 'utf8')) as WorkstreamDoc;
  } catch {
    return `## ${slug}\n(unreadable)`;
  }
  const ws = doc.workstream;
  const decisions = doc.decisions.slice(-4).map((d) => `  - [${d.id}${d.status === 'superseded' ? ', superseded' : ''}] ${d.title.replace(/\s+/g, ' ').slice(0, 160)}`);
  const attention = doc.attention.filter((a) => a.status === 'open').map((a) => `  - OPEN [${a.id}] ${a.summary.replace(/\s+/g, ' ').slice(0, 120)}`);
  const adopted = doc.deliverables.filter((d) => d.adopted).slice(-4).map((d) => `  - [${d.id}] ${d.title.slice(0, 100)}`);
  const events = doc.events.slice(-5).map((e) => `  - ${e.at.slice(0, 16)} ${e.type}: ${e.summary.replace(/\s+/g, ' ').slice(0, 110)}`);
  return [
    `## ${slug} [${ws.status}] — ${ws.title}`,
    `objective: ${ws.objective.replace(/\s+/g, ' ').slice(0, 220)}`,
    ...(decisions.length ? ['recent decisions:', ...decisions] : []),
    ...(attention.length ? ['open attention:', ...attention] : []),
    ...(adopted.length ? ['adopted deliverables:', ...adopted] : []),
    ...(events.length ? ['recent events:', ...events] : []),
  ].join('\n');
}

/** Deterministic anchor: every workstream, live then archived. */
export async function buildFleetDigest(): Promise<string> {
  const parts: string[] = [];
  for (const slug of await listWorkstreams()) parts.push(digestOne(slug, workstreamDir(slug)));
  const archive = path.join(weaverHome(), '_archive');
  try {
    for (const slug of fs.readdirSync(archive)) {
      if (fs.existsSync(path.join(archive, slug, 'workstream.json'))) {
        parts.push(digestOne(`${slug} (archived)`, path.join(archive, slug)));
      }
    }
  } catch { /* no archive yet */ }
  return parts.join('\n\n');
}

const ASK_SYSTEM = `You are the historian of a fleet of durable workstreams. The operator asks what happened, whether something was picked up, or why something was not done. Answer from RECORDED STATE ONLY — the digest below plus the state files you can Read/Grep (each workstream dir holds workstream.json: decisions, events, passes with summaries, assignments, attention; artifacts/ holds deliverable content).

Rules:
- Ground every claim in a citation: (slug, decision/event/deliverable id, timestamp). No id, no claim.
- "Why wasn't X done" has exactly three honest answers: a recorded decision chose otherwise (cite it); it was tried and failed (cite the attempts); or NOTHING picked it up — say that plainly, name the closest existing stream if one fits, and give the exact command to start it (weaver do "..." or weaver steer <slug> "...").
- Distinguish claimed from verified: a worker's submission is a claim; adoption and readback-confirmed actions are facts. Prefer facts.
- Answer the question first, in 2-5 sentences, then the evidence. No speculation dressed as history.`;

export async function ask(question: string): Promise<string> {
  const digest = await buildFleetDigest();
  const home = weaverHome();
  let text = '';
  for await (const msg of query({
    prompt: [`# Fleet digest`, digest, ``, `# Operator's question`, question].join('\n'),
    options: {
      model: process.env.WEAVER_ASK_MODEL ?? workerModel(),
      systemPrompt: ASK_SYSTEM,
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      cwd: home,
      additionalDirectories: [home],
      permissionMode: 'dontAsk',
      maxTurns: 25,
      persistSession: false,
      env: sdkEnv(),
    },
  })) {
    if (msg.type === 'result' && 'result' in msg && typeof msg.result === 'string' && !msg.is_error) text = msg.result;
  }
  return text || '(no answer produced — model call failed; try again)';
}
