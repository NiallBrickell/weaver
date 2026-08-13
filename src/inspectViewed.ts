/**
 * When a human last looked at the knowledge pages.
 *
 * "Since I left" is one of the five questions, and answering it needs a left
 * edge. Generating the pages is always a human act — `weaver inspect` from the
 * CLI, [i] from the dashboard — so the moment of the LAST generation is the
 * moment the human last looked, and the window runs from there to now.
 *
 * Both clocks are stamped because Weaver keeps facts on both: a decision is
 * dated on the organizational (virtual) timeline while a policy is written in
 * physical time, and comparing one against the other would silently mis-window
 * the whole section whenever the demo clock has been advanced.
 *
 * The reader is deliberately tolerant: a missing, truncated, or hand-edited
 * stamp means "we don't know when you last looked", which renders as the
 * honest first-visit line — never as a claim that nothing changed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { virtualNow } from './clock.js';
import { weaverHome } from './store.js';

export interface InspectViewed {
  schemaVersion: 1;
  /** Physical time — compare wall-stamped facts (policy createdAt, evidence at). */
  wallAt: string;
  /** Virtual time — compare organizational facts (decisions, adoptions, sends). */
  virtualAt: string;
}

export function inspectViewedPath(): string {
  return path.join(weaverHome(), 'inspect-viewed.json');
}

function isUsableIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** The previous stamp, or null when there isn't a usable one. */
export function readInspectViewed(): InspectViewed | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(inspectViewedPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const stamp = raw as Partial<InspectViewed>;
  if (stamp.schemaVersion !== 1) return null;
  if (!isUsableIso(stamp.wallAt) || !isUsableIso(stamp.virtualAt)) return null;
  return { schemaVersion: 1, wallAt: stamp.wallAt, virtualAt: stamp.virtualAt };
}

/** Stamp "a human looked just now". Returns what was written. */
export function writeInspectViewed(): InspectViewed {
  const stamp: InspectViewed = {
    schemaVersion: 1,
    wallAt: new Date().toISOString(),
    virtualAt: virtualNow().toISOString(),
  };
  fs.mkdirSync(path.dirname(inspectViewedPath()), { recursive: true });
  fs.writeFileSync(inspectViewedPath(), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}
