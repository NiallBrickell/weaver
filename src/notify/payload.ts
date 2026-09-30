/**
 * What a push about one open need says. The copy is the REST API's own
 * (`ApiNeed.title` / `text`, built by presentNeed/displayText), so the
 * notification, the card in the app and the browser card read the same.
 */

import { excerpt, type ApiNeed } from '../restApi.js';

export const NEED_CATEGORY = 'NEED';
export const APPROVE_DECLINE_CATEGORY = 'NEED_APPROVE_DECLINE';
const MAX_BODY = 180;
const MAX_TITLE = 100;

/** The notifier's claim key for one need at one card version. */
export function needKey(need: Pick<ApiNeed, 'workstream' | 'source_type' | 'source_id' | 'version'>): string {
  return `${need.workstream}|${need.source_type}|${need.source_id}|${need.version}`;
}

// Leading words only: a choice "clearly means" approve or decline when it
// opens with it. "Continue on green tests" versus "Ask for another review" is
// a real two-way decision, not a yes/no, and must keep both labels visible.
const APPROVE = /^(?:yes\b|approve[ds]?\b|go ahead\b|proceed\b|accept\b|confirm\b|allow\b|do it\b|ok\b|okay\b|ship it\b|merge it\b|lgtm\b)/;
const DECLINE = /^(?:no\b|decline[ds]?\b|reject\b|deny\b|don['’]t\b|do not\b|stop\b|cancel\b|abort\b|hold off\b|not now\b|skip it\b|leave it\b)/;

function meaning(choice: { label: string; text: string }): 'approve' | 'decline' | null {
  const text = choice.text.trim().toLowerCase().replace(/^[\s"'“‘(]+/, '');
  const approve = APPROVE.test(text);
  const decline = DECLINE.test(text);
  if (approve === decline) return null;
  return approve ? 'approve' : 'decline';
}

/**
 * The approve and decline labels of a two-way yes/no card, or null when the
 * card is anything else (one choice, three, two alternatives, or two that
 * mean the same thing). Labels are returned exactly as the card has them,
 * because they are what a response posts as `choice`.
 */
export function approveDeclineChoices(choices: ApiNeed['choices']): { approve: string; decline: string } | null {
  if (choices.length !== 2) return null;
  const [first, second] = choices as [ApiNeed['choices'][number], ApiNeed['choices'][number]];
  const a = meaning(first);
  const b = meaning(second);
  if (a === 'approve' && b === 'decline') return { approve: first.label, decline: second.label };
  if (a === 'decline' && b === 'approve') return { approve: second.label, decline: first.label };
  return null;
}

/** The need's headline plus as much of the rest of its text as fits. */
export function needBody(need: Pick<ApiNeed, 'title' | 'text'>): string {
  const title = need.title.trim();
  const text = need.text.trim();
  const at = title ? text.indexOf(title) : -1;
  const rest = (at >= 0 ? text.slice(at + title.length) : title ? '' : text).trim();
  const body = title && rest ? `${title} ${rest}` : title || rest || 'Something needs you.';
  return excerpt(body, MAX_BODY);
}

export interface NeedPushPayload {
  aps: {
    alert: { title: string; body: string };
    sound: 'default';
    'thread-id': string;
    category: string;
  };
  need: {
    workstream: string;
    source_type: ApiNeed['source_type'];
    source_id: string;
    version: string;
    approve_choice?: string;
    decline_choice?: string;
  };
}

export function needPayload(workstreamTitle: string, need: ApiNeed): NeedPushPayload {
  const pair = approveDeclineChoices(need.choices);
  return {
    aps: {
      alert: { title: excerpt(workstreamTitle || need.workstream, MAX_TITLE), body: needBody(need) },
      sound: 'default',
      'thread-id': need.workstream,
      category: pair ? APPROVE_DECLINE_CATEGORY : NEED_CATEGORY,
    },
    need: {
      workstream: need.workstream,
      source_type: need.source_type,
      source_id: need.source_id,
      version: need.version,
      ...(pair ? { approve_choice: pair.approve, decline_choice: pair.decline } : {}),
    },
  };
}
