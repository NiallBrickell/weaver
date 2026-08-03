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

export interface ProviderRecord {
  ref: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

export class SendCrashedAfterEgress extends Error {
  constructor() {
    super('crashed after egress: provider may or may not have the message — result unknown');
    this.name = 'SendCrashedAfterEgress';
  }
}

/** Egress. Throws SendCrashedAfterEgress under chaos AFTER the provider records it. */
export function providerSend(
  slug: string,
  interactionId: string,
  msg: { to: string; subject: string; body: string },
): ProviderRecord {
  const dir = outboxDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const record: ProviderRecord = {
    ref: `prov_${interactionId}`,
    ...msg,
    sentAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, `${record.ref}.json`), JSON.stringify(record, null, 2));
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
