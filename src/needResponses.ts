/**
 * Answering an open "needs you" card from outside the terminal — the one
 * implementation shared by the browser workspace form and the bearer REST API.
 *
 * A response is recorded as an untrusted Observation (plus the immediate wake
 * `recordObservation` always adds), never as Steering: it can wake the
 * Workstream and supply evidence, but cannot resolve the card, approve an
 * action, or widen authority (kernel rule 9). The answer is validated against
 * the card exactly as it stands now — the caller names the card's version, and
 * a card that changed or closed since the caller read it refuses the answer —
 * and the ingress key makes an exact retry of one response a no-op.
 */

import { recordObservation } from './ingress.js';
import { load, sha256 } from './store.js';
import { presentNeed, workstreamNeeds, type FleetNeed } from './ui/inspect/model.js';

export const MAX_RESPONSE_FIELD_LENGTH = 50_000;

const NEED_SOURCE_TYPES = new Set<string>(['attention', 'assignment', 'interaction']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A response that cannot be stored: 400 malformed, 409 the card moved on. */
export class NeedResponseError extends Error {
  constructor(readonly status: 400 | 409, message: string) {
    super(message);
    this.name = 'NeedResponseError';
  }
}

/** The version a responder must echo: it changes whenever the card's source,
 * kind, or wording changes, so an answer to superseded wording is refused. */
export function needVersion(need: FleetNeed): string {
  return sha256(JSON.stringify([need.source.type, need.source.id, need.kind, need.summary])).slice(0, 32);
}

export interface NeedResponseInput {
  sourceType: string;
  sourceId: string;
  version: string;
  /** Uuid v4 the client mints once per intended answer (retry-safe). */
  responseId: string;
  /** An option label from the card, or `custom` with `custom` text. */
  choice: string;
  custom?: string;
  note?: string;
}

export interface NeedResponseResult {
  observationId: string;
  /** True when this exact response was already recorded (a retry). */
  duplicate: boolean;
}

/**
 * Validate one answer against the card's current state and record it. The
 * `actor` becomes provenance on the Observation's source
 * (`operator-ui-response:<actor>`), never an authority grant.
 */
export async function recordNeedResponse(
  slug: string,
  input: NeedResponseInput,
  actor: string,
): Promise<NeedResponseResult> {
  const doc = await load(slug);
  const sourceType = input.sourceType.trim();
  const sourceId = input.sourceId.trim();
  const submittedVersion = input.version.trim();
  const responseId = input.responseId.trim();
  if (!NEED_SOURCE_TYPES.has(sourceType) || !sourceId || !submittedVersion) {
    throw new NeedResponseError(400, 'The decision response is malformed');
  }
  if (!UUID_V4.test(responseId)) throw new NeedResponseError(400, 'The response id is malformed');

  const need = workstreamNeeds(doc).find((candidate) =>
    candidate.source.type === sourceType && candidate.source.id === sourceId,
  );
  if (!need || needVersion(need) !== submittedVersion) {
    throw new NeedResponseError(409, 'This decision changed or is no longer open. Reload the job before responding.');
  }

  const presentation = presentNeed(need.summary);
  const labels = presentation.choices.map((choice) => choice.label);
  if (new Set(labels).size !== labels.length) {
    throw new NeedResponseError(409, 'This decision has ambiguous options and cannot be answered from here.');
  }
  const choice = input.choice.trim();
  const custom = (input.custom ?? '').trim();
  const note = (input.note ?? '').trim();
  if (custom.length > MAX_RESPONSE_FIELD_LENGTH || note.length > MAX_RESPONSE_FIELD_LENGTH) {
    throw new NeedResponseError(400, `A response field must be at most ${MAX_RESPONSE_FIELD_LENGTH} characters`);
  }
  let answer: string;
  if (choice === 'custom') {
    if (!custom) throw new NeedResponseError(400, 'A custom response is required');
    answer = `Other — ${custom}`;
  } else {
    const selected = presentation.choices.find((candidate) => candidate.label === choice);
    if (!selected) throw new NeedResponseError(400, 'Choose one of the current options or write a custom response');
    answer = `${selected.label} — ${selected.text}`;
  }
  const summary = `Response to ${need.kind} request: ${answer}${note ? `\nCondition or note: ${note}` : ''}`;
  if (summary.length > MAX_RESPONSE_FIELD_LENGTH) {
    throw new NeedResponseError(400, `The complete response must be at most ${MAX_RESPONSE_FIELD_LENGTH} characters`);
  }
  const result = await recordObservation(slug, {
    source: `operator-ui-response:${actor}`,
    summary,
    ingressKey: `ui-response:${submittedVersion}:${responseId}:${sha256(summary).slice(0, 24)}`,
  });
  return { observationId: result.id, duplicate: result.duplicate };
}
