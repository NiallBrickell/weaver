/**
 * Backend-shared document semantics. The initial doc shape, the bounded event
 * tail, id minting, and content hashing are part of the StateStore CONTRACT —
 * every backend must produce byte-identical docs for the same operations — so
 * they live beside the interface, not inside a backend where a second
 * implementation would fork them.
 */

import { createHash, randomUUID } from 'node:crypto';
import { virtualNow } from '../clock.js';
import { diffPrintoutFields } from '../printoutJournal.js';
import type { EventRecord, PrintoutMutationReceipt, WorkstreamCore, WorkstreamDoc } from '../types.js';
import type { EventHelper } from './types.js';

export const EVENT_TAIL_LIMIT = 200;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The `event` helper handed to mutators: appends to the doc's bounded
 * narrative tail. Identical across backends so the tail cap is a contract,
 * not an fs quirk. `emitted` (when given) additionally collects this
 * mutation's own events for its printout receipt. */
export function eventHelperFor(doc: WorkstreamDoc, emitted?: EventRecord[]): EventHelper {
  return (type, summary, refs) => {
    const rec: EventRecord = {
      at: new Date().toISOString(),
      atVirtual: virtualNow().toISOString(),
      type,
      summary,
      ...(refs ? { refs } : {}),
    };
    emitted?.push(rec);
    doc.events.push(rec);
    if (doc.events.length > EVENT_TAIL_LIMIT) {
      doc.events.splice(0, doc.events.length - EVENT_TAIL_LIMIT);
    }
  };
}

/** The initial WorkstreamDoc every backend's create() persists. */
export function initialDoc(core: Omit<WorkstreamCore, 'id' | 'createdAt' | 'status'>): WorkstreamDoc {
  return {
    schemaVersion: 1,
    revision: 0,
    workstream: {
      ...core,
      id: newId('ws'),
      status: 'active',
      createdAt: new Date().toISOString(),
    },
    decisions: [],
    assignments: [],
    deliverables: [],
    interactions: [],
    observations: [],
    wakes: [],
    steering: [],
    attention: [],
    passes: [],
    events: [
      {
        at: new Date().toISOString(),
        atVirtual: virtualNow().toISOString(),
        type: 'workstream.created',
        summary: `Workstream '${core.title}' created`,
      },
    ],
    spend: { coordinatorPasses: 0, totalCostUsd: 0, humanInterventions: 0 },
    capacity: null,
    lease: null,
  };
}

/** The revision-0 printout receipt for a freshly created doc — identical
 * across backends, so a printout's exact-transition history starts at birth
 * regardless of where the head is persisted. */
export function creationReceipt(doc: WorkstreamDoc): PrintoutMutationReceipt {
  const created = doc.events[0]!;
  return {
    revision: 0,
    at: created.at,
    atVirtual: created.atVirtual,
    changes: [
      { kind: 'workstream', fields: diffPrintoutFields(undefined, doc.workstream) },
      { kind: 'spend', fields: diffPrintoutFields(undefined, doc.spend) },
      { kind: 'capacity', fields: diffPrintoutFields(undefined, doc.capacity) },
      { kind: 'lease', fields: diffPrintoutFields(undefined, doc.lease) },
    ],
    events: [created],
  };
}

export function emptyPolicyStore(): { schemaVersion: 1; revision: number; policies: never[] } {
  return { schemaVersion: 1, revision: 0, policies: [] };
}
