/**
 * The virtual clock — a scheduler feature, not a continuity shortcut.
 *
 * Demos need "five days later" without waiting five days. The clock stores a
 * persistent offset; wakes compare their dueAt against virtual now. Nothing
 * stays resident: advancing the clock only changes stored data, and the next
 * tick discovers what became due.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function clockPath(): string {
  const home = process.env.WEAVER_HOME ?? path.resolve(process.cwd(), 'state');
  return path.join(home, 'clock.json');
}

interface ClockState {
  offsetMs: number;
}

function readClock(): ClockState {
  try {
    return JSON.parse(fs.readFileSync(clockPath(), 'utf8')) as ClockState;
  } catch {
    return { offsetMs: 0 };
  }
}

export function virtualNow(): Date {
  return new Date(Date.now() + readClock().offsetMs);
}

/** Parse durations like "5d", "3h", "45m", "90s". */
export function parseDuration(spec: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m|s)$/.exec(spec.trim());
  if (!m) throw new Error(`bad duration '${spec}' — use e.g. 5d, 3h, 45m, 90s`);
  const n = Number(m[1]);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[m[2] as 'd' | 'h' | 'm' | 's'];
  return n * unit;
}

export function advanceClock(spec: string): Date {
  const state = readClock();
  state.offsetMs += parseDuration(spec);
  fs.mkdirSync(path.dirname(clockPath()), { recursive: true });
  fs.writeFileSync(clockPath(), JSON.stringify(state, null, 2) + '\n');
  return virtualNow();
}

export function inVirtual(msFromNow: number): Date {
  return new Date(virtualNow().getTime() + msFromNow);
}
