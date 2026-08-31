/** Deterministic contracts for the React/Tailwind inspect surface. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, test } from 'node:test';

import { virtualNow } from './clock.js';
import { recordCapacityBackoff } from './capacity.js';
import {
  fleetBoard,
  passIntegrityWarnings,
  policiesForWorkstream,
  renderLearnedHtml,
  renderOverviewHtml,
  renderWorkstreamHtml,
  runInspect,
} from './inspect.js';
import { loadPolicies, proposePolicy } from './policies.js';
import { setSecret } from './secrets.js';
import { arrive, createWorkstream, load, weaverHome, workstreamDir, writeArtifact } from './store.js';
import type { Assignment, WorkstreamDoc } from './types.js';

function freshHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-inspect-'));
  process.env.WEAVER_HOME = directory;
  return directory;
}

async function makeWorkstream(slug: string, title = slug): Promise<WorkstreamDoc> {
  return createWorkstream({
    slug,
    title,
    objective: `Deliver ${title}`,
    tags: ['product'],
    successCriteria: ['A reviewer can verify the result'],
    constraints: ['Keep authority explicit'],
    autonomy: { sendsRequireApproval: true },
  });
}

function assignment(
  id: string,
  state: Assignment['state'],
  adoption: Assignment['adoption']['state'] = 'none',
): Assignment {
  return {
    id,
    objective: `Complete ${id}`,
    briefing: `Bounded brief for ${id}`,
    kind: 'work',
    acceptanceCriteria: [`Verify ${id}`],
    dependsOn: [],
    state,
    attempts: [],
    adoption: { state: adoption },
    createdAtVirtual: virtualNow().toISOString(),
  };
}

const CAPACITY_ENV_NAMES = [
  'WEAVER_COORDINATOR_EXECUTOR',
  'WEAVER_COORDINATOR_MODEL',
  'WEAVER_COORDINATOR_FALLBACKS',
  'WEAVER_RUNNER_EXECUTORS',
] as const;

type CapacityEnvironment = Record<(typeof CAPACITY_ENV_NAMES)[number], string>;

async function withCapacityEnvironment(
  values: CapacityEnvironment,
  run: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(CAPACITY_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of CAPACITY_ENV_NAMES) process.env[name] = values[name];
  try {
    await run();
  } finally {
    for (const name of CAPACITY_ENV_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function withoutTechnicalDetails(html: string): string {
  return html.replace(
    /<details[^>]*>\s*<summary[^>]*>Technical details<\/summary>[\s\S]*?<\/details>/g,
    '',
  );
}

beforeEach(() => freshHome());

test('workstream page is a React/Tailwind assignment board over durable work', async () => {
  await makeWorkstream('visual-work', 'Visual work');
  const artifact = await writeArtifact('visual-work', 'candidate.md', 'candidate');
  await arrive('visual-work', (doc) => {
    doc.decisions.push({
      id: 'dec_direction',
      title: 'Lead with the durable outcome',
      rationale: 'Sessions are execution provenance, not intended work.',
      madeBy: 'human',
      status: 'standing',
      decidedAtVirtual: virtualNow().toISOString(),
    });
    const planned = assignment('asg_planned', 'queued');
    const working = assignment('asg_working', 'running');
    working.attempts.push({ runId: 'run_disposable', model: 'sonnet', startedAt: new Date().toISOString() });
    const review = assignment('asg_review', 'awaiting_review', 'proposed');
    review.submission = { summary: 'Candidate ready for review', deliverableId: 'del_candidate' };
    const accepted = assignment('asg_accepted', 'completed', 'accepted');
    const unadopted = assignment('asg_unadopted', 'completed', 'proposed');
    doc.assignments.push(planned, working, review, accepted, unadopted);
    doc.deliverables.push({
      id: 'del_candidate',
      title: 'Candidate document',
      kind: 'document',
      path: artifact.relPath,
      contentHash: artifact.hash,
      producedByAssignment: review.id,
      createdAtVirtual: virtualNow().toISOString(),
    });
  });

  const html = renderWorkstreamHtml(await load('visual-work'), []);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /tailwindcss v4/);
  assert.match(html, />Planned</);
  assert.match(html, />Working</);
  assert.match(html, />Review</);
  assert.match(html, />Accepted</);
  assert.match(html, /asg_planned/);
  assert.match(html, /asg_working/);
  assert.match(html, /run_disposable/);
  assert.match(html, /Candidate ready for review/);
  assert.match(html, /Proposed result/);
  assert.match(html, /Assignment archive/);
  assert.match(html, /asg_unadopted/);
  assert.match(html, /Lead with the durable outcome/);
  assert.doesNotMatch(html, /SDK estimate|totalCostUsd|~\$/);
  assert.doesNotMatch(html, /<svg|decision-data|--panel/);
  assert.doesNotMatch(
    withoutTechnicalDetails(html),
    /\b(?:asg|dec|steer|pass|run|del|wake|att|int|obs|reply|pol|ws)_[a-z0-9_-]+\b/i,
    'storage identifiers stay inside Technical details',
  );
});

test('typed human direction is visible above timestamped current course and survives the event tail', async () => {
  await makeWorkstream('course-clarity', 'Course clarity');
  await arrive('course-clarity', (doc) => {
    doc.decisions.push({
      id: 'dec_recorded',
      title: 'Keep the current implementation narrow',
      rationale: 'Continue after asg_old unless steer_latest changes the course.',
      madeBy: 'coordinator',
      status: 'standing',
      decidedAtVirtual: '2026-08-14T09:40:00.000Z',
    });
    doc.steering.push(
      {
        id: 'steer_read',
        body: 'Start from the smallest honest design.',
        by: 'niall',
        at: '2026-08-14T09:41:00.000Z',
        consumedByPass: 'pass_read',
      },
      {
        id: 'steer_withdrawn',
        body: 'Send this obsolete direction.',
        by: 'niall',
        at: '2026-08-14T09:42:00.000Z',
        revokedAt: '2026-08-14T09:42:30.000Z',
        revokedBy: 'niall',
      },
      {
        id: 'steer_latest',
        body: 'Step back and decide whether the extra field should exist.',
        by: 'niall',
        at: '2026-08-14T09:45:00.000Z',
      },
    );
    doc.events = [];
  });

  const html = renderWorkstreamHtml(await load('course-clarity'), []);
  assert.ok(html.indexOf('Your direction') < html.indexOf('Current recorded commitment'));
  assert.match(html, /Step back and decide whether the extra field should exist/);
  assert.match(html, /Waiting for Weaver/);
  assert.match(html, /Read by Weaver/);
  assert.match(html, /Withdrawn before Weaver read it/);
  assert.match(html, /<time dateTime="2026-08-14T09:45:00.000Z"/);
  assert.match(html, /snapshot r\d+ generated/);
  assert.match(html, /Continue after the assignment unless the human direction changes the course/);
  assert.doesNotMatch(withoutTechnicalDetails(html), /\b(?:asg|dec|steer|pass|run|del|wake|att|int|obs|reply|pol|ws)_[a-z0-9_-]+\b/i);
});

test('fleet page groups Workstreams by current position and folds concluded outcomes', async () => {
  await Promise.all([
    makeWorkstream('needs-human', 'Needs human'),
    makeWorkstream('in-motion', 'In motion'),
    makeWorkstream('scheduled', 'Scheduled'),
    makeWorkstream('ready', 'Ready'),
    makeWorkstream('finished', 'Finished'),
  ]);
  await arrive('needs-human', (doc) => {
    doc.attention.push({
      id: 'att_1',
      kind: 'blocker',
      summary: 'Choose the launch boundary',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
  });
  await arrive('in-motion', (doc) => {
    doc.assignments.push(assignment('asg_running', 'running'));
  });
  await arrive('scheduled', (doc) => {
    doc.wakes.push({
      id: 'wake_later',
      reason: 'Check the provider reply',
      condition: { type: 'time', dueAtVirtual: new Date(virtualNow().getTime() + 3_600_000).toISOString() },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  });
  await arrive('ready', (doc) => {
    doc.assignments.push(assignment('asg_queued', 'queued'));
  });
  await arrive('finished', (doc) => {
    doc.workstream.status = 'done';
    doc.workstream.conclusion = {
      passId: 'pass_done',
      atVirtual: virtualNow().toISOString(),
      summary: 'The outcome is verified',
      evidenceIds: ['dec_done'],
    };
  });

  const docs = await Promise.all(['needs-human', 'in-motion', 'scheduled', 'ready', 'finished'].map(load));
  const html = renderOverviewHtml(docs, []);
  assert.match(html, />Needs you</);
  assert.match(html, />In motion</);
  assert.match(html, />Waiting</);
  assert.match(html, />Ready</);
  assert.match(html, /Choose the launch boundary/);
  assert.match(html, /Check the provider reply/);
  assert.match(html, /Complete the assignment/);
  assert.match(html, /The outcome is verified/);
  assert.match(html, /data-board-search/);
  assert.doesNotMatch(html, /Since you left/);
});

test('fleet projection keeps runs nested and puts queued work in Ready', async () => {
  await makeWorkstream('card-state');
  await arrive('card-state', (doc) => {
    const queued = assignment('asg_queue', 'queued');
    queued.attempts.push({
      runId: 'run_old',
      startedAt: '2026-08-14T08:00:00.000Z',
      endedAt: '2026-08-14T08:10:00.000Z',
      terminalReason: 'no_submission',
    });
    doc.assignments.push(queued);
  });
  const doc = await load('card-state');
  const view = fleetBoard([doc], [], new Map());
  assert.equal(view.lanes.ready.length, 1);
  assert.equal(view.lanes.ready[0]!.slug, 'card-state');
  assert.equal(Object.values(view.lanes).flat().length, 1, 'one Workstream is one fleet card');
});

test('a due wake is Ready while a future wake is Waiting', async () => {
  await makeWorkstream('due-wake');
  await makeWorkstream('future-wake');
  await arrive('due-wake', (doc) => {
    doc.wakes.push({
      id: 'wake_due',
      reason: 'Reconcile now',
      condition: { type: 'immediate' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  });
  await arrive('future-wake', (doc) => {
    doc.wakes.push({
      id: 'wake_future',
      reason: 'Check later',
      condition: { type: 'wall_time', dueAt: new Date(Date.now() + 3_600_000).toISOString() },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  });
  const view = fleetBoard([await load('due-wake'), await load('future-wake')], [], new Map());
  assert.deepEqual(view.lanes.ready.map((card) => card.slug), ['due-wake']);
  assert.deepEqual(view.lanes.waiting.map((card) => card.slug), ['future-wake']);
});

test('fleet capacity renders a limited primary with an available fallback as degraded, not Waiting', async () => {
  await withCapacityEnvironment({
    WEAVER_COORDINATOR_EXECUTOR: 'local-sdk',
    WEAVER_COORDINATOR_MODEL: 'claude-primary',
    WEAVER_COORDINATOR_FALLBACKS: 'codex-sdk:gpt-fallback',
    WEAVER_RUNNER_EXECUTORS: 'local-sdk,codex-sdk',
  }, async () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    await makeWorkstream('degraded-capacity');
    await arrive('degraded-capacity', (doc) => {
      const wait = {
        kind: 'rate_limit' as const,
        recovery: 'automatic_retry' as const,
        source: 'coordinator' as const,
        sourceId: 'pass_primary',
        executor: 'local-sdk',
        provider: 'anthropic',
        model: 'claude-primary',
        detectedAt: now.toISOString(),
        retryAt: new Date(now.getTime() + 3_600_000).toISOString(),
      };
      recordCapacityBackoff(doc, wait);
      doc.wakes.push({
        id: 'wake_primary',
        reason: 'Retry the primary coordinator',
        condition: { type: 'time', dueAtVirtual: wait.retryAt },
        status: 'pending',
        createdAt: now.toISOString(),
        infrastructure: wait,
      });
    });

    const view = fleetBoard([await load('degraded-capacity')], [], new Map(), [], now, now);
    assert.equal(view.lanes.waiting.length, 0);
    assert.equal(view.lanes.ready[0]!.state, 'Degraded');
    assert.match(view.lanes.ready[0]!.next, /fallback gpt-fallback available/);
  });
});

test('fleet capacity does not let overdue or unconfigured raw provider wakes park a card', async () => {
  await withCapacityEnvironment({
    WEAVER_COORDINATOR_EXECUTOR: 'local-sdk',
    WEAVER_COORDINATOR_MODEL: 'claude-primary',
    WEAVER_COORDINATOR_FALLBACKS: 'codex-sdk:gpt-fallback',
    WEAVER_RUNNER_EXECUTORS: 'local-sdk,codex-sdk',
  }, async () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    await Promise.all([
      makeWorkstream('overdue-capacity'),
      makeWorkstream('unconfigured-capacity'),
    ]);
    await arrive('overdue-capacity', (doc) => {
      const wait = {
        kind: 'rate_limit' as const,
        recovery: 'automatic_retry' as const,
        source: 'coordinator' as const,
        sourceId: 'pass_overdue',
        executor: 'local-sdk',
        provider: 'anthropic',
        model: 'claude-primary',
        detectedAt: new Date(now.getTime() - 7_200_000).toISOString(),
        retryAt: new Date(now.getTime() - 3_600_000).toISOString(),
      };
      recordCapacityBackoff(doc, wait);
      doc.wakes.push({
        id: 'wake_overdue',
        reason: 'Reconcile the overdue provider retry',
        condition: { type: 'time', dueAtVirtual: wait.retryAt },
        status: 'pending',
        createdAt: wait.detectedAt,
        infrastructure: wait,
      });
    });
    await arrive('unconfigured-capacity', (doc) => {
      const wait = {
        kind: 'rate_limit' as const,
        recovery: 'automatic_retry' as const,
        source: 'coordinator' as const,
        sourceId: 'pass_retired',
        executor: 'pi',
        provider: 'openrouter',
        model: 'retired-model',
        detectedAt: now.toISOString(),
        retryAt: new Date(now.getTime() + 3_600_000).toISOString(),
      };
      recordCapacityBackoff(doc, wait);
      doc.wakes.push({
        id: 'wake_retired',
        reason: 'Retry a model no longer configured',
        condition: { type: 'time', dueAtVirtual: wait.retryAt },
        status: 'pending',
        createdAt: now.toISOString(),
        infrastructure: wait,
      });
    });

    const docs = await Promise.all(['overdue-capacity', 'unconfigured-capacity'].map(load));
    const view = fleetBoard(docs, [], new Map(), [], now, now);
    assert.equal(view.lanes.waiting.length, 0);
    assert.equal(view.lanes.ready.find((card) => card.slug === 'overdue-capacity')!.state, 'Ready to reconcile');
    assert.equal(view.lanes.ready.find((card) => card.slug === 'unconfigured-capacity')!.state, 'No next step');
  });
});

test('fleet capacity waits only when the shared projection reports a block', async () => {
  await withCapacityEnvironment({
    WEAVER_COORDINATOR_EXECUTOR: 'local-sdk',
    WEAVER_COORDINATOR_MODEL: 'claude-primary',
    WEAVER_COORDINATOR_FALLBACKS: 'codex-sdk:gpt-fallback',
    WEAVER_RUNNER_EXECUTORS: 'local-sdk,codex-sdk',
  }, async () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    await makeWorkstream('capacity-blocked');
    await arrive('capacity-blocked', (doc) => {
      const primary = {
        kind: 'rate_limit' as const,
        recovery: 'automatic_retry' as const,
        source: 'coordinator' as const,
        sourceId: 'pass_primary',
        executor: 'local-sdk',
        provider: 'anthropic',
        model: 'claude-primary',
        detectedAt: now.toISOString(),
        retryAt: new Date(now.getTime() + 3_600_000).toISOString(),
      };
      recordCapacityBackoff(doc, primary);
      recordCapacityBackoff(doc, {
        ...primary,
        sourceId: 'pass_fallback',
        executor: 'codex-sdk',
        provider: 'openai',
        model: 'gpt-fallback',
        retryAt: new Date(now.getTime() + 1_800_000).toISOString(),
      });
      doc.wakes.push({
        id: 'wake_primary',
        reason: 'Retry the coordinator chain',
        condition: { type: 'time', dueAtVirtual: primary.retryAt },
        status: 'pending',
        createdAt: now.toISOString(),
        infrastructure: primary,
      });
    });

    const view = fleetBoard([await load('capacity-blocked')], [], new Map(), [], now, now);
    assert.equal(view.lanes.waiting[0]!.state, 'Temporarily blocked');
    assert.match(view.lanes.waiting[0]!.next, /^coordinator OpenAI gpt-fallback rate limited/);
  });
});

test('fleet capacity waits when the selected target needs a differently capable runner', async () => {
  await withCapacityEnvironment({
    WEAVER_COORDINATOR_EXECUTOR: 'codex-sdk',
    WEAVER_COORDINATOR_MODEL: 'gpt-only',
    WEAVER_COORDINATOR_FALLBACKS: 'codex-sdk:gpt-only',
    WEAVER_RUNNER_EXECUTORS: 'local-sdk',
  }, async () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    await makeWorkstream('executor-blocked');
    await arrive('executor-blocked', (doc) => {
      doc.wakes.push({
        id: 'wake_now',
        reason: 'Coordinate now',
        condition: { type: 'immediate' },
        status: 'pending',
        createdAt: now.toISOString(),
      });
    });

    const view = fleetBoard([await load('executor-blocked')], [], new Map(), [], now, now);
    assert.equal(view.lanes.waiting[0]!.state, 'Temporarily blocked');
    assert.match(view.lanes.waiting[0]!.next, /gpt-only waits for a runner declaring codex-sdk/);
  });
});

test('gated actions and pending sends are human attention, not execution state', async () => {
  await makeWorkstream('egress');
  await arrive('egress', (doc) => {
    const gated = assignment('asg_action', 'gated');
    gated.kind = 'action';
    gated.exec = { cwd: '/repo', verify: 'gh pr view 7', ask: 'Approve publishing the release?', approvalMode: 'human-only' };
    doc.assignments.push(gated);
    doc.attention.push({
      id: 'att_action',
      kind: 'approval',
      refId: gated.id,
      summary: 'Same approval, with coordinator commentary',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
    doc.interactions.push({
      id: 'int_1',
      kind: 'email_send',
      to: 'person@example.com',
      subject: 'Release ready',
      deliverableId: 'del_1',
      status: 'awaiting_approval',
      replies: [],
    });
  });
  const view = fleetBoard([await load('egress')], [], new Map());
  assert.equal(view.lanes['needs-you'].length, 1);
  assert.equal(view.needs.length, 2);
  assert.deepEqual(view.needs.map((need) => need.kind), ['action', 'send']);
});

test('a routine gated action waiting for Pilot is not human attention', async () => {
  await makeWorkstream('pilot-pending');
  await arrive('pilot-pending', (doc) => {
    const gated = assignment('asg_action', 'gated');
    gated.kind = 'action';
    gated.exec = { cwd: '/repo', verify: 'gh pr view 7', ask: 'Open the reviewed pull request?', approvalMode: 'pilot-or-human' };
    gated.exec.pilotUnavailableSince = new Date().toISOString();
    doc.assignments.push(gated);
    doc.attention.push({
      id: 'att_legacy_pilot_timeout',
      kind: 'approval',
      refId: gated.id,
      summary: 'Pilot has been unavailable; the action remains gated.',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
  });
  const view = fleetBoard([await load('pilot-pending')], [], new Map());
  assert.equal(view.needs.length, 0);
  assert.equal(view.lanes['needs-you'].length, 0);
  assert.equal(view.lanes.waiting[0]?.state, 'Approval service unavailable');
  assert.match(view.lanes.waiting[0]?.next ?? '', /remains safe/);

  await arrive('pilot-pending', (doc) => { doc.workstream.status = 'paused'; });
  const paused = fleetBoard([await load('pilot-pending')], [], new Map());
  assert.equal(paused.needs.length, 0);
  assert.equal(paused.lanes.waiting[0]?.state, 'Paused');
  assert.doesNotMatch(paused.lanes.waiting[0]?.next ?? '', /approval service/i);
});

test('human attention keeps a concluded Workstream out of the folded Done list', async () => {
  await makeWorkstream('done-needs-human');
  await arrive('done-needs-human', (doc) => {
    doc.workstream.status = 'done';
    doc.workstream.conclusion = {
      passId: 'pass_done',
      atVirtual: virtualNow().toISOString(),
      summary: 'The implementation concluded but still needs an operator decision',
      evidenceIds: ['dec_done'],
    };
    doc.attention.push({
      id: 'att_done',
      kind: 'blocker',
      summary: 'Choose whether to publish the result',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
  });
  const view = fleetBoard([await load('done-needs-human')], [], new Map());
  assert.deepEqual(view.lanes['needs-you'].map((card) => card.slug), ['done-needs-human']);
  assert.equal(view.done.length, 0);
});

test('pausing defers human attention without discarding it', async () => {
  await makeWorkstream('paused-decision');
  await arrive('paused-decision', (doc) => {
    doc.workstream.status = 'paused';
    doc.attention.push({
      id: 'att_paused',
      kind: 'review',
      summary: 'Choose the eventual publication policy',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
  });

  const pausedDoc = await load('paused-decision');
  const paused = fleetBoard([pausedDoc], [], new Map());
  assert.equal(paused.needs.length, 0);
  assert.equal(paused.lanes['needs-you'].length, 0);
  assert.equal(paused.lanes.waiting[0]?.state, 'Paused');
  assert.equal(pausedDoc.attention[0]?.status, 'open');

  await arrive('paused-decision', (doc) => { doc.workstream.status = 'active'; });
  const resumed = fleetBoard([await load('paused-decision')], [], new Map());
  assert.deepEqual(resumed.lanes['needs-you'].map((card) => card.slug), ['paused-decision']);
});

test('a Workstream page states its next move when no human decision is pending', async () => {
  await makeWorkstream('routine-position');
  await arrive('routine-position', (doc) => {
    doc.workstream.tags.push('routine');
    doc.wakes.push({
      id: 'wake_routine',
      reason: 'Check the support inbox',
      condition: { type: 'time', dueAtVirtual: new Date(virtualNow().getTime() + 3_600_000).toISOString() },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  });
  const html = renderWorkstreamHtml(await load('routine-position'), []);
  assert.match(html, />Next check scheduled</);
  assert.match(html, />Waiting for</);
  assert.match(html, /Check the support inbox · in 1h/);
});

test('policy pages preserve scoped learning while keeping the fleet page quiet', async () => {
  await makeWorkstream('policy-source');
  const policy = await proposePolicy({
    statement: 'Verify the evidence before adopting the result',
    tags: ['product'],
    effectKind: 'add_verification',
    effectDescription: 'adds an evidence check',
    workstreamSlug: 'policy-source',
    passId: 'pass_policy',
    interventionSummary: 'the first result was not verified',
  });
  const doc = await load('policy-source');
  const policies = (await loadPolicies()).policies;
  assert.deepEqual(policiesForWorkstream(policies, doc).map((item) => item.id), [policy.id]);
  assert.doesNotMatch(renderOverviewHtml([doc], policies), /Verify the evidence before adopting/);
  const learned = renderLearnedHtml(policies);
  assert.match(learned, /Verify the evidence before adopting/);
  assert.match(learned, /Shadow unproven/);
});

test('site generation publishes all linked pages, managed relationships, and redacts secrets', async () => {
  await makeWorkstream('manager', 'Manager');
  await createWorkstream({
    slug: 'child',
    title: 'Child',
    objective: 'Finish child work',
    tags: ['product'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    managedBy: { slug: 'manager', sinceVirtual: virtualNow().toISOString() },
  });
  await arrive('child', (doc) => {
    doc.observations.push({
      id: 'obs_secret',
      source: 'test',
      summary: 'Observed needle-secret-value',
      atVirtual: virtualNow().toISOString(),
    });
  });
  // Legacy/imported state may predate a value becoming secret. Rendering still
  // applies the current secret lens even though new writes refuse the value.
  await setSecret('DASHBOARD_TOKEN', 'needle-secret-value');

  const entry = await runInspect();
  assert.equal(entry, path.join(weaverHome(), 'inspect.html'));
  for (const target of [
    entry,
    path.join(weaverHome(), 'learned.html'),
    path.join(workstreamDir('manager'), 'inspect.html'),
    path.join(workstreamDir('child'), 'inspect.html'),
  ]) assert.ok(fs.existsSync(target), target);

  const fleet = fs.readFileSync(entry, 'utf8');
  const manager = fs.readFileSync(path.join(workstreamDir('manager'), 'inspect.html'), 'utf8');
  const child = fs.readFileSync(path.join(workstreamDir('child'), 'inspect.html'), 'utf8');
  assert.doesNotMatch(fleet + manager + child, /needle-secret-value/);
  assert.match(manager, /coordinates 1 related Workstream/);
  assert.match(child, /coordinated by manager/);
  assert.ok(!fs.existsSync(path.join(weaverHome(), 'inspect-viewed.json')), 'generation is not a viewing receipt');
});

test('requested Workstream failure is loud while unreadable fleet members stay named', async () => {
  await makeWorkstream('healthy');
  await assert.rejects(runInspect('missing'), /missing/);
  const html = renderOverviewHtml([await load('healthy')], [], new Map(), ['broken-state']);
  assert.match(html, /Unreadable: broken-state/);
});

test('React escapes stored content and the page has no network dependency', async () => {
  await makeWorkstream('escaping', '<script>alert(1)</script>');
  const html = renderWorkstreamHtml(await load('escaping'), []);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
});

test('mature Workstreams fold older evidence instead of growing an unbounded page', async () => {
  await makeWorkstream('mature');
  await arrive('mature', (doc) => {
    for (let index = 0; index < 12; index += 1) {
      doc.decisions.push({
        id: `dec_${index}`,
        title: `Decision ${index}`,
        rationale: `Rationale ${index}`,
        madeBy: 'coordinator',
        status: index === 11 ? 'standing' : 'superseded',
        decidedAtVirtual: new Date(virtualNow().getTime() + index).toISOString(),
      });
      doc.deliverables.push({
        id: `del_${index}`,
        title: `Deliverable ${index}`,
        kind: 'document',
        path: `artifact-${index}.md`,
        contentHash: `${index}`.padEnd(64, '0'),
        producedByAssignment: `asg_${index}`,
        createdAtVirtual: new Date(virtualNow().getTime() + index).toISOString(),
      });
    }
  });
  const html = renderWorkstreamHtml(await load('mature'), []);
  assert.match(html, /4 older deliverables/);
  assert.match(html, /2 older decisions/);
});

test('pass integrity warnings remain visible typed diagnostics', () => {
  const doc = {
    passes: [
      { id: 'pass_bad', outcome: 'completed' },
      { id: 'pass_good', outcome: 'completed', summary: 'landed' },
    ],
  } as unknown as WorkstreamDoc;
  assert.deepEqual(passIntegrityWarnings(doc), [
    'pass_bad: completed without a summary — the record needs repair',
  ]);
});
