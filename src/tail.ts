/**
 * The live activity tail: `<slug>/tail.jsonl`, one compact JSONL line per
 * notable SDK message from a worker or coordinator run, so a human can watch
 * a run work instead of staring at an opaque attempt row.
 *
 * The tail is observability, never truth: nothing reads it back into typed
 * state, and a broken tail must never break a pass — every write error is
 * swallowed. Every detail is redacted against the workstream's known secrets
 * (global + overlay) BEFORE it touches disk, because a tool input can embed
 * an injected secret value. Session ids stay provenance on the attempt/pass
 * records as before — the tail replaces nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadSecrets, redactSecrets } from './secrets.js';
import { workstreamDir } from './store.js';

export interface TailEvent {
  at: string;
  source: 'worker' | 'coordinator';
  /** assignmentId for workers, passId for coordinator passes. */
  ref: string;
  kind: 'tool' | 'text' | 'result';
  detail: string;
}

/** Old tail files may contain the SDK estimate that result lines once showed. */
export function withoutSdkEstimate(event: TailEvent): TailEvent {
  if (event.kind !== 'result') return event;
  return { ...event, detail: event.detail.replace(/ \(\$-?\d+(?:\.\d+)?\)$/, '') };
}

/** Rotation threshold: one overwritten `.1` generation, never unbounded growth. */
const ROTATE_BYTES = 5 * 1024 * 1024;
const POLL_MS = 500;
const BACKLOG = 40;

export function tailPath(slug: string): string {
  return path.join(workstreamDir(slug), 'tail.jsonl');
}

/** Collapse to one line; the tail is a feed, never a place to read documents. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The short human-scannable half of a tool call: which tool, on what. */
function toolDetail(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const arg =
    s(input.command) ??
    s(input.file_path) ??
    s(input.path) ??
    s(input.pattern) ??
    s(input.url) ??
    JSON.stringify(input ?? {});
  return `${name} ${oneLine(arg, 120)}`;
}

export function emitTail(
  slug: string,
  source: TailEvent['source'],
  ref: string,
  kind: TailEvent['kind'],
  detail: string,
  extraSecrets: Record<string, string> = {},
): void {
  // Non-fatal by construction: a full disk, a missing dir, a permissions
  // hiccup — none of it may cost a pass. Redaction happens INSIDE the guard,
  // before any byte reaches disk.
  try {
    const p = tailPath(slug);
    try {
      if (fs.statSync(p).size > ROTATE_BYTES) fs.renameSync(p, `${p}.1`);
    } catch {
      // no file yet — first append creates it
    }
    const event: TailEvent = {
      at: new Date().toISOString(),
      source,
      ref,
      kind,
      detail: redactSecrets(detail, { ...loadSecrets(slug), ...extraSecrets }),
    };
    fs.appendFileSync(p, JSON.stringify(event) + '\n');
  } catch {
    // swallowed by design — tailing must never break a run
  }
}

/**
 * Summarize one SDK stream message into tail events. Only the three shapes a
 * human watching the run cares about — tool calls, assistant prose, the
 * terminal result — everything else in the stream is noise here.
 */
export function tailMessage(
  slug: string,
  source: TailEvent['source'],
  ref: string,
  message: SDKMessage,
  extraSecrets: Record<string, string> = {},
): void {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        emitTail(slug, source, ref, 'text', oneLine(block.text, 200), extraSecrets);
      } else if (block.type === 'tool_use') {
        emitTail(slug, source, ref, 'tool', toolDetail(block.name, block.input as Record<string, unknown>), extraSecrets);
      }
    }
  } else if (message.type === 'result') {
    const detail =
      message.subtype === 'success'
        ? `${message.is_error ? 'ended with error' : 'done'} in ${message.num_turns} turns`
        : `${message.subtype} after ${message.num_turns} turns`;
    emitTail(slug, source, ref, 'result', detail, extraSecrets);
  }
}

// ---------------------------------------------------------------------------
// `weaver tail` — pretty-print the backlog, then follow.

const R = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const AMBER = '\x1b[33m';
const CYAN = '\x1b[36m';

function parseLines(lines: string[]): TailEvent[] {
  const out: TailEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(withoutSdkEstimate(JSON.parse(line) as TailEvent));
    } catch {
      // a torn or corrupt line is skipped, never fatal — this is a feed
    }
  }
  return out;
}

function render(e: TailEvent): string {
  const time = e.at.slice(11, 19);
  const label = e.source === 'worker' ? CYAN : AMBER;
  const body =
    e.kind === 'text' ? `${DIM}${e.detail}${R}` : e.kind === 'result' ? `${GREEN}${e.detail}${R}` : e.detail;
  return `${DIM}${time}${R} ${label}${e.ref}${R} ${body}\n`;
}

/**
 * Follow the tail file with a stat-based poll: fs.watch is unreliable across
 * platforms/editors, and 500ms of latency on an observability feed costs
 * nothing. Byte offsets, with a carry buffer so a line (or a multi-byte char)
 * torn across polls is reassembled, and an offset reset on shrink (rotation).
 */
export async function runTail(slug: string, opts: { all: boolean }): Promise<void> {
  const p = tailPath(slug);
  const wanted = (e: TailEvent) => opts.all || e.source === 'worker';
  const out = process.stdout;
  out.write(
    `${DIM}tailing ${slug} — ${opts.all ? 'workers + coordinator' : 'workers only (--all adds coordinator passes)'}; Ctrl-C to exit${R}\n`,
  );

  let offset = 0;
  let carry = Buffer.alloc(0);
  const consume = (chunk: Buffer): TailEvent[] => {
    let buf = Buffer.concat([carry, chunk]);
    const lines: string[] = [];
    for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10)) {
      lines.push(buf.subarray(0, nl).toString('utf8'));
      buf = buf.subarray(nl + 1);
    }
    carry = buf;
    return parseLines(lines);
  };

  // Backlog: the whole current file, filtered, last BACKLOG shown.
  try {
    const raw = fs.readFileSync(p);
    offset = raw.length;
    const backlog = consume(raw).filter(wanted);
    for (const e of backlog.slice(-BACKLOG)) out.write(render(e));
  } catch {
    out.write(`${DIM}no activity yet — waiting${R}\n`);
  }

  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let size: number;
    try {
      size = fs.statSync(p).size;
    } catch {
      continue;
    }
    if (size < offset) {
      // Rotation (or truncation): start over from the top of the new file.
      offset = 0;
      carry = Buffer.alloc(0);
    }
    if (size === offset) continue;
    let chunk: Buffer;
    const fd = fs.openSync(p, 'r');
    try {
      chunk = Buffer.alloc(size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    offset = size;
    for (const e of consume(chunk).filter(wanted)) out.write(render(e));
  }
}
