/**
 * Frozen operator printouts over exact typed revision sidecars.
 *
 * Preparing a report is read-only. Delivery is acknowledged separately, after
 * stdout has flushed or Ink has painted the modal. The journal is supporting
 * operator history only: current WorkstreamDoc facts remain authoritative.
 */

import * as fs from 'node:fs';
import type {
  Assignment,
  Deliverable,
  EventRecord,
  Interaction,
  PassRecord,
  PrintoutChange,
  PrintoutFieldDelta,
  PrintoutMutationReceipt,
  WorkstreamDoc,
} from './types.js';
import {
  loadPolicies,
  policyOrigin,
  policyPrintoutJournalDir,
  type PolicyMutationReceipt,
  type PolicyRecord,
} from './policies.js';
import {
  missingJournalRevisions,
  readJournalReceipts,
  readLatestPrintoutCheckpoint,
  writePrintoutCheckpoint,
} from './printoutJournal.js';
import { loadSecrets, redactSecrets } from './secrets.js';
import { listWorkstreams, load, printoutJournalDir, workstreamDir } from './store.js';
import type { TailEvent } from './tail.js';

export interface WorkstreamPrintout {
  slug: string;
  text: string;
  since?: string;
  through: string;
  throughRevision: number;
  eventCount: number;
}

export interface PolicyPrintout {
  text: string;
  since?: string;
  through: string;
  throughRevision: number;
}

export interface PrintoutReport {
  scope: string;
  text: string;
  through: string;
  workstreams: WorkstreamPrintout[];
  policies?: PolicyPrintout;
  errors: { slug: string; message: string }[];
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function revisionRanges(revisions: number[]): string {
  if (!revisions.length) return '';
  const ranges: string[] = [];
  let start = revisions[0]!;
  let end = start;
  for (const revision of revisions.slice(1)) {
    if (revision === end + 1) { end = revision; continue; }
    ranges.push(start === end ? String(start) : `${start}–${end}`);
    start = end = revision;
  }
  ranges.push(start === end ? String(start) : `${start}–${end}`);
  return ranges.join(', ');
}

function block(text: string, fallback = '(no output)'): string[] {
  return ['```text', text.trim() || fallback, '```'];
}

function readTailFile(file: string): TailEvent[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line) as TailEvent;
        return event?.at && event?.ref && event?.kind ? [event] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

/** Best-effort answer to “what did it look at?”, never evidence of an effect. */
export function observedActivity(slug: string, after: string | undefined, through: string): TailEvent[] {
  const current = `${workstreamDir(slug)}/tail.jsonl`;
  return [...readTailFile(`${current}.1`), ...readTailFile(current)]
    .filter((event) => event.kind !== 'text' && (!after || event.at > after) && event.at <= through)
    .sort((a, b) => a.at.localeCompare(b.at));
}

function attempts(assignment: Assignment): string {
  if (!assignment.attempts.length) return 'not run';
  return assignment.attempts.map((attempt) => {
    const end = attempt.endedAt ? `ended ${attempt.endedAt}` : 'still running';
    return `${attempt.runId}: ${attempt.startedAt} → ${end}${attempt.terminalReason ? `, ${attempt.terminalReason}` : ''}`;
  }).join('; ');
}

function adoptionLine(assignment: Assignment): string {
  const adoption = assignment.adoption;
  if (adoption.state === 'accepted') return `ACCEPTED${adoption.reason ? ` — ${flat(adoption.reason)}` : ''}`;
  if (adoption.state === 'rejected') return `REJECTED — ${flat(adoption.reason ?? 'no reason recorded')}`;
  if (adoption.state === 'superseded') return 'SUPERSEDED';
  if (adoption.state === 'proposed') return 'PROPOSED — submission, not yet authoritative';
  return 'NONE';
}

function renderAction(assignment: Assignment, revision?: number): string[] {
  const exec = assignment.exec;
  const truth = exec?.verified?.ok
    ? 'VERIFIED EXTERNAL EFFECT'
    : exec?.verified
      ? 'READBACK FAILED — EXTERNAL EFFECT NOT CONFIRMED'
      : 'NO READBACK — EXTERNAL EFFECT NOT CONFIRMED';
  const lines = [
    `### ${truth} — ${assignment.id}${revision === undefined ? '' : ` at revision ${revision}`}`,
    flat(assignment.objective),
    `- State: ${assignment.state}`,
    `- Approval: ${exec?.approval ? `${exec.approval.by}${exec.approval.actor ? ` (${exec.approval.actor})` : ''} at ${exec.approval.at}` : 'none'}`,
    `- Attempts: ${attempts(assignment)}`,
  ];
  if (exec?.run) lines.push(`- Engine command: \`${exec.run}\``);
  if (assignment.submission) lines.push(`- Submission: ${flat(assignment.submission.summary)} (a claim until accepted)`);
  lines.push(`- Adoption: ${adoptionLine(assignment)}`);
  if (exec) lines.push(`- Deterministic readback: \`${exec.verify}\``);
  if (exec?.verified) {
    lines.push(`- Readback result: ${exec.verified.ok ? 'PASS' : 'FAIL'} at ${exec.verified.at}`);
    lines.push(...block(exec.verified.output));
  }
  return lines;
}

function renderWork(assignment: Assignment, revision?: number): string[] {
  const label = assignment.adoption.state === 'accepted' ? 'ACCEPTED'
    : assignment.adoption.state === 'rejected' ? 'REJECTED'
      : assignment.adoption.state === 'proposed' ? 'PROPOSED' : assignment.state.toUpperCase();
  const lines = [
    `### ${label} ${assignment.kind} — ${assignment.id}${revision === undefined ? '' : ` at revision ${revision}`}`,
    flat(assignment.objective),
    `- Attempts: ${attempts(assignment)}`,
  ];
  if (assignment.readDirs?.length) lines.push(`- Declared sources: ${assignment.readDirs.join(', ')}`);
  if (assignment.submission) lines.push(`- Submission: ${flat(assignment.submission.summary)}`);
  lines.push(`- Adoption: ${adoptionLine(assignment)}`);
  return lines;
}

function renderDeliverable(deliverable: Deliverable, revision?: number): string {
  return `- ${deliverable.id}${revision === undefined ? '' : ` at revision ${revision}`} “${flat(deliverable.title)}” — ${deliverable.adopted ? `ADOPTED immutable pin ${deliverable.adopted.contentHash}` : `candidate ${deliverable.contentHash}`}`;
}

function renderPass(pass: PassRecord, revision?: number): string[] {
  return [
    `- ${pass.id}${revision === undefined ? '' : ` at revision ${revision}`} [${pass.outcome}] ${pass.startedAt}${pass.endedAt ? ` → ${pass.endedAt}` : ''}`,
    ...(pass.summary ? [`  Coordinator summary (informational): ${flat(pass.summary)}`] : []),
    ...pass.changes.map((change) => `  Recorded change: ${flat(change)}`),
  ];
}

function renderInteraction(interaction: Interaction, revision?: number): string[] {
  const lines = [`- ${interaction.id}${revision === undefined ? '' : ` at revision ${revision}`} [${interaction.status}] email to ${interaction.to}: “${flat(interaction.subject)}”`];
  if (interaction.externalRef) lines.push(`  Provider receipt: ${interaction.externalRef}${interaction.sentAtVirtual ? ` at ${interaction.sentAtVirtual}` : ''}`);
  if (!interaction.externalRef && ['sent', 'unknown'].includes(interaction.status)) {
    lines.push('  Provider receipt: absent — delivery is not confirmed');
  }
  for (const reply of interaction.replies) {
    lines.push(`  Reply ${reply.id} from ${reply.from} at ${reply.receivedAtVirtual}: ${flat(reply.body)}`);
    lines.push(reply.evaluation
      ? `  Evaluation: ${reply.evaluation.countsTowardObjective ? 'counts' : 'does not count'} — ${flat(reply.evaluation.note)}`
      : '  Evaluation: pending — reply is untrusted input');
  }
  return lines;
}

function currentBoundary(doc: WorkstreamDoc): string[] {
  const standing = doc.decisions.filter((decision) => decision.status === 'standing');
  const open = doc.attention.filter((item) => item.status === 'open');
  const live = doc.assignments.filter((assignment) => !['completed', 'failed', 'cancelled'].includes(assignment.state));
  const wakes = doc.wakes.filter((wake) => wake.status === 'pending');
  return [
    `- Status: ${doc.workstream.status}`,
    `- Objective: ${flat(doc.workstream.objective)}`,
    `- Success criteria: ${doc.workstream.successCriteria.length ? doc.workstream.successCriteria.map(flat).join('; ') : 'none recorded'}`,
    `- Constraints: ${doc.workstream.constraints.length ? doc.workstream.constraints.map(flat).join('; ') : 'none recorded'}`,
    `- Tags: ${doc.workstream.tags.length ? doc.workstream.tags.join(', ') : 'none'}`,
    `- Authority: outbound sends ${doc.workstream.autonomy.sendsRequireApproval ? 'require approval' : 'may proceed within assigned authority'}`,
    `- Budget: ${doc.workstream.budget.maxCoordinatorPasses} coordinator passes · $${doc.workstream.budget.maxCostUsd.toFixed(2)} estimated cost`,
    ...(doc.workstream.status === 'done' && doc.workstream.conclusion ? [
      `- Coordinator conclusion account (informational): ${flat(doc.workstream.conclusion.summary)}`,
      `- Typed completion evidence IDs (validated at conclusion): ${doc.workstream.conclusion.evidenceIds.join(', ')}`,
    ] : []),
    `- Usage: ${doc.spend.coordinatorPasses} coordinator passes · $${doc.spend.totalCostUsd.toFixed(3)} estimated · ${doc.spend.humanInterventions ?? 0} human interventions`,
    `- Provider capacity: ${doc.capacity ? Object.entries(doc.capacity.byModel).map(([model, entry]) => `${model} ${entry.wait.kind}, retry ${entry.wait.retryAt}`).join('; ') : 'available'}`,
    `- Standing course: ${standing.length ? standing.map((decision) => `${decision.id} “${flat(decision.title)}”`).join('; ') : 'none recorded'}`,
    `- Open needs-you items: ${open.length ? open.map((item) => `${item.id} ${flat(item.summary)}`).join('; ') : 'none'}`,
    `- Work still live: ${live.length ? live.map((assignment) => `${assignment.id} [${assignment.state}]`).join(', ') : 'none'}`,
    `- Pending wakes: ${wakes.length ? wakes.map((wake) => `${wake.id} ${flat(wake.reason)}`).join('; ') : 'none'}`,
  ];
}

function displayValue(value: unknown): string {
  if (value === undefined) return 'absent';
  return flat(JSON.stringify(value));
}

function fieldDelta(delta: PrintoutFieldDelta): string {
  return `${delta.path} ${displayValue(delta.before)} → ${displayValue(delta.after)}`;
}

function describeChange(change: PrintoutChange): string {
  return `${change.kind}${change.id ? ` ${change.id}` : ''}: ${change.fields.map(fieldDelta).join('; ') || '(no value delta)'}`;
}

function changedIds(receipts: PrintoutMutationReceipt[], kind: PrintoutChange['kind']): Set<string> {
  return new Set(receipts.flatMap((receipt) => receipt.changes
    .filter((change) => change.kind === kind && change.id)
    .map((change) => change.id!)));
}

function currentChanged<T extends { id: string }>(
  current: T[],
  receipts: PrintoutMutationReceipt[],
  kind: PrintoutChange['kind'],
  all: boolean,
): T[] {
  if (all) return current;
  const ids = changedIds(receipts, kind);
  return current.filter((value) => ids.has(value.id));
}

/** Build immutable text from a captured head and its immutable deltas. */
export function renderWorkstreamPrintout(
  doc: WorkstreamDoc,
  receipts: PrintoutMutationReceipt[],
  observed: TailEvent[],
  through: string,
  previous: { throughRevision: number; through: string } | undefined,
  missing: number[],
): string {
  const currentFallback = missing.length > 0;
  const legacyBaseline = !previous && currentFallback;
  const assignments = currentChanged(doc.assignments, receipts, 'assignment', currentFallback);
  const actionValues = assignments.filter((assignment) => assignment.kind === 'action');
  const workValues = assignments.filter((assignment) => assignment.kind !== 'action');
  const deliverables = currentChanged(doc.deliverables, receipts, 'deliverable', currentFallback);
  const decisions = currentChanged(doc.decisions, receipts, 'decision', currentFallback);
  const interactions = currentChanged(doc.interactions, receipts, 'interaction', currentFallback);
  const observations = currentChanged(doc.observations, receipts, 'observation', currentFallback);
  const passes = currentChanged(doc.passes, receipts, 'pass', currentFallback);
  const substantive = receipts.some((receipt) => receipt.changes.length || receipt.events.length) || observed.length || currentFallback;
  const out = [
    `# Weaver printout — ${doc.workstream.title} (${doc.workstream.slug})`,
    `Period: ${previous ? `after ${previous.through}` : 'first printout'} through ${through}`,
    `Boundary: workstream revision ${doc.revision}`,
    '',
    '## At the boundary',
    ...currentBoundary(doc),
  ];
  if (missing.length) {
    out.push('', '## History coverage warning', previous
      ? `Typed revision sidecars are missing for revisions ${revisionRanges(missing)}. Current boundary facts are shown, but this window cannot claim an exact intermediate history.`
      : 'This workstream predates printout journals. The first report shows its current typed record plus the surviving bounded trace; older intermediate steps may be absent.');
    out.push(
      '',
      '## Current typed snapshot (gap fallback)',
      'This is the complete current record, not a reconstruction of the missing intermediate revisions.',
      ...block(JSON.stringify(doc, null, 2)),
    );
  }
  if (!substantive) {
    out.push('', '## Since the last printout', 'Nothing new was recorded.');
    return redactSecrets(out.join('\n'), loadSecrets(doc.workstream.slug));
  }
  if (actionValues.length) out.push('', '## External actions at the boundary', ...actionValues.flatMap((value) => ['', ...renderAction(value)]));
  if (workValues.length) out.push('', '## Work, research, and evidence at the boundary', ...workValues.flatMap((value) => ['', ...renderWork(value)]));
  if (deliverables.length) out.push('', '## Deliverables at the boundary', ...deliverables.map((value) => renderDeliverable(value)));
  if (decisions.length) out.push('', '## Decisions at the boundary', ...decisions.map((decision) => `- ${decision.id} [${decision.status}] “${flat(decision.title)}” — ${flat(decision.rationale)}`));
  if (interactions.length) out.push('', '## Communications and replies at the boundary', ...interactions.flatMap((value) => renderInteraction(value)));
  if (observations.length) out.push('', '## Observations at the boundary', ...observations.map((observation) => `- ${observation.id} from ${observation.source}: ${flat(observation.summary)}${observation.evaluation ? ` — ${observation.evaluation.countsTowardObjective ? 'counts' : 'does not count'}: ${flat(observation.evaluation.note)}` : ' — evaluation pending'}`));
  if (passes.length) out.push('', '## Coordinator passes at the boundary', ...passes.flatMap((value) => renderPass(value)));
  if (observed.length) out.push(
    '',
    '## Observed run activity (best effort, not authoritative)',
    'This rotating trace can show tools and results that were still available. Only typed adoption and deterministic readback prove outcomes.',
    ...observed.map((event) => `- ${event.at} ${event.source} ${event.ref}: ${event.detail}`),
  );
  if (receipts.length) out.push(
    '',
    '## Exact typed mutation timeline',
    ...receipts.flatMap((receipt) => [
      `- revision ${receipt.revision} at ${receipt.at}`,
      ...receipt.changes.map((change) => `  ${describeChange(change)}`),
      ...receipt.events.map((event) => `  Recorded context [${event.type}]: ${flat(event.summary)}`),
    ]),
  );
  if (legacyBaseline && doc.events.length) out.push(
    '',
    '## Surviving pre-journal activity',
    ...doc.events.map((event: EventRecord) => `- ${event.at} [${event.type}] ${flat(event.summary)}`),
  );
  return redactSecrets(out.join('\n'), loadSecrets(doc.workstream.slug));
}

function prepareOne(slug: string): WorkstreamPrintout {
  const doc = load(slug);
  const through = new Date().toISOString();
  const dir = printoutJournalDir(slug);
  const previous = readLatestPrintoutCheckpoint(dir);
  const receipts = readJournalReceipts<PrintoutMutationReceipt>(dir, previous?.throughRevision, doc.revision);
  const missing = missingJournalRevisions(receipts, previous?.throughRevision, doc.revision);
  const observed = observedActivity(slug, previous?.through, through);
  return {
    slug,
    text: renderWorkstreamPrintout(doc, receipts, observed, through, previous, missing),
    ...(previous ? { since: previous.through } : {}),
    through,
    throughRevision: doc.revision,
    eventCount: receipts.reduce((count, receipt) => count + receipt.events.length, 0),
  };
}

function currentPolicy(policy: PolicyRecord): string {
  return `- ${policy.id} [${policy.status}/${policy.effect.kind}] “${flat(policy.statement)}” — tags ${policy.scope.tags.join(', ')}; source ${policyOrigin(policy)}; evidence ${policy.evidence.length}`;
}

function preparePolicies(): PolicyPrintout {
  const store = loadPolicies();
  const through = new Date().toISOString();
  const dir = policyPrintoutJournalDir();
  const previous = readLatestPrintoutCheckpoint(dir);
  // Policy revision 0 is the implicit empty store; the first actual mutation is 1.
  const afterRevision = previous?.throughRevision ?? 0;
  const receipts = readJournalReceipts<PolicyMutationReceipt>(dir, afterRevision, store.revision);
  const missing = missingJournalRevisions(receipts, afterRevision, store.revision);
  const first = !previous;
  const lines = [
    '# Global learning activity',
    `Period: ${previous ? `after ${previous.through}` : 'first printout'} through ${through}`,
    `Boundary: policy revision ${store.revision}`,
  ];
  if (missing.length) lines.push('', `History coverage warning: policy revision sidecars are missing for ${revisionRanges(missing)}; current policy records follow.`);
  const ids = new Set(receipts.flatMap((receipt) => receipt.changes.map((change) => change.id)));
  const current = (missing.length ? store.policies : store.policies.filter((policy) => ids.has(policy.id))).map(currentPolicy);
  const changes = receipts.flatMap((receipt) => receipt.changes.map((change) =>
    `- revision ${receipt.revision} at ${receipt.at}: policy ${change.id}: ${change.fields.map(fieldDelta).join('; ')}`));
  lines.push(
    '',
    '## Current policies changed in this window',
    ...(current.length ? current : ['None.']),
    '',
    '## Exact policy mutation timeline',
    ...(changes.length ? changes : first && store.policies.length ? store.policies.map(currentPolicy) : ['Nothing new was recorded.']),
  );
  if (missing.length) lines.push(
    '',
    '## Current typed policy snapshot (gap fallback)',
    'This is the complete current policy record, not a reconstruction of the missing intermediate revisions.',
    ...block(JSON.stringify(store.policies, null, 2)),
  );
  return { text: lines.join('\n'), ...(previous ? { since: previous.through } : {}), through, throughRevision: store.revision };
}

/** Prepare a frozen report without changing organizational state or acknowledging delivery. */
export function preparePrintout(slug?: string): PrintoutReport {
  const slugs = slug ? [slug] : listWorkstreams();
  const reports: WorkstreamPrintout[] = [];
  const errors: { slug: string; message: string }[] = [];
  for (const current of slugs) {
    try { reports.push(prepareOne(current)); }
    catch (error) {
      if (slug) throw error;
      errors.push({ slug: current, message: error instanceof Error ? error.message : String(error) });
    }
  }
  let policies: PolicyPrintout | undefined;
  if (!slug) {
    try { policies = preparePolicies(); }
    catch (error) { errors.push({ slug: 'global-policies', message: error instanceof Error ? error.message : String(error) }); }
  }
  const through = [...reports.map((report) => report.through), ...(policies ? [policies.through] : [])].sort().at(-1) ?? new Date().toISOString();
  const scope = slug ?? 'fleet';
  const text = slug
    ? reports[0]?.text ?? `# Weaver printout — ${slug}\n\nUnable to read this workstream.`
    : [
        '# Weaver fleet printout',
        `Generated through ${through}; each source has its own delivered-printout boundary.`,
        ...(reports.length ? reports.flatMap((report) => ['', '---', '', report.text]) : ['', '(no workstreams)']),
        ...(policies ? ['', '---', '', policies.text] : ['', '## Unreadable global policy store', `- ${errors.find((error) => error.slug === 'global-policies')?.message ?? 'unknown error'}`]),
        ...(errors.some((error) => error.slug !== 'global-policies') ? ['', '## Unreadable workstreams', ...errors.filter((error) => error.slug !== 'global-policies').map((error) => `- ${error.slug}: ${error.message}`)] : []),
      ].join('\n');
  return { scope, text: redactSecrets(text, loadSecrets()), through, workstreams: reports, ...(policies ? { policies } : {}), errors };
}

/** Acknowledge only after the frozen text has been delivered to the operator. */
export function acknowledgePrintout(report: PrintoutReport): void {
  for (const current of report.workstreams) {
    writePrintoutCheckpoint(printoutJournalDir(current.slug), { throughRevision: current.throughRevision, through: current.through });
  }
  if (report.policies) {
    writePrintoutCheckpoint(policyPrintoutJournalDir(), { throughRevision: report.policies.throughRevision, through: report.policies.through });
  }
}

export type PrintoutWriter = (text: string, callback: (error?: Error | null) => void) => void;

/** Flush the frozen text first; a failed stream write leaves the cursor untouched. */
export async function deliverPrintout(report: PrintoutReport, writer?: PrintoutWriter): Promise<void> {
  const write = writer ?? ((text, callback) => { process.stdout.write(text, callback); });
  await new Promise<void>((resolve, reject) => write(`${report.text}\n`, (error) => error ? reject(error) : resolve()));
  acknowledgePrintout(report);
}
