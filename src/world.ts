/**
 * The simulated external world: an email provider with an outbox we can read
 * back. The provider record (the outbox file) is the source of truth for
 * whether a send happened — exactly like a real provider's sent-mail API.
 *
 * Chaos hook: WEAVER_SEND_UNKNOWN=1 makes the next send "crash" after egress
 * (the provider received it, but we never saw the acknowledgement). The
 * harness must then resolve the unknown by readback, never by re-sending.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { workstreamDir } from './store.js';

function outboxDir(slug: string): string {
  return path.join(workstreamDir(slug), 'world', 'outbox');
}

function ledgerPath(slug: string): string {
  return path.join(workstreamDir(slug), 'world', 'ledger.jsonl');
}

export interface ProviderRecord {
  ref: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

/** The provider's own append-only log. It separates the two facts an outbox
 * file conflates: an INVOCATION attempt (the harness called providerSend) and
 * an external EFFECT (a message the provider actually holds). At-most-one
 * effect per interaction is the idempotency-key guarantee; multiple attempts
 * are allowed and expected under retry/crash recovery. This is what lets a
 * test prove "the unknown-result protocol never produced a second effect"
 * rather than inferring it from outbox-file cardinality. */
export interface LedgerEntry {
  kind: 'attempt' | 'effect';
  interactionId: string;
  ref: string;
  at: string;
}

function appendLedger(slug: string, entry: LedgerEntry): void {
  fs.mkdirSync(path.dirname(ledgerPath(slug)), { recursive: true });
  fs.appendFileSync(ledgerPath(slug), `${JSON.stringify(entry)}\n`);
}

export function readLedger(slug: string): LedgerEntry[] {
  const p = ledgerPath(slug);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

export class SendCrashedAfterEgress extends Error {
  constructor() {
    super('crashed after egress: provider may or may not have the message — result unknown');
    this.name = 'SendCrashedAfterEgress';
  }
}

/**
 * Egress, protected by the interaction idempotency key. Every call is logged
 * as an attempt; the external effect is created at most once per interaction —
 * a second call for the same key returns the existing record and creates NO
 * new effect, exactly like a provider deduplicating on a client idempotency
 * key. Throws SendCrashedAfterEgress under chaos AFTER the effect is recorded.
 */
export function providerSend(
  slug: string,
  interactionId: string,
  msg: { to: string; subject: string; body: string },
): ProviderRecord {
  const dir = outboxDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const ref = `prov_${interactionId}`;
  const effectPath = path.join(dir, `${ref}.json`);
  appendLedger(slug, { kind: 'attempt', interactionId, ref, at: new Date().toISOString() });
  // Idempotency key = the interaction. If the effect already exists, this is a
  // duplicate invocation (a retry that should never have happened, or a
  // recovery race): honour the key, create no second effect.
  if (fs.existsSync(effectPath)) {
    return JSON.parse(fs.readFileSync(effectPath, 'utf8')) as ProviderRecord;
  }
  const record: ProviderRecord = { ref, ...msg, sentAt: new Date().toISOString() };
  fs.writeFileSync(effectPath, JSON.stringify(record, null, 2));
  appendLedger(slug, { kind: 'effect', interactionId, ref, at: record.sentAt });
  if (process.env.WEAVER_SEND_UNKNOWN === '1') {
    throw new SendCrashedAfterEgress();
  }
  return record;
}

/** Readback: ask the provider whether it has a record for this interaction. */
export function providerLookup(slug: string, interactionId: string): ProviderRecord | undefined {
  const p = path.join(outboxDir(slug), `prov_${interactionId}.json`);
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as ProviderRecord;
}
