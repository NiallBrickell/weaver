/**
 * The Weaver CLI. Every command mutates or reads stored state and exits —
 * durability lives in the store, never in a process.
 */

import { advanceClock, virtualNow } from './clock.js';
import { tick } from './engine.js';
import { renderStatus } from './status.js';
import {
  arrive,
  createWorkstream,
  listWorkstreams,
  load,
  newId,
  readArtifact,
} from './store.js';

function args(): string[] {
  return process.argv.slice(2);
}

function opt(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(`--${name}`);
  return i >= 0 ? flags[i + 1] : undefined;
}

function optAll(flags: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === `--${name}` && flags[i + 1]) out.push(flags[i + 1]!);
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

const USAGE = `weaver — durable workstream harness (MVP)

  weaver create --slug <s> --title <t> --objective <o> [--success <c>]... [--constraint <c>]... [--max-passes N] [--max-cost USD]
  weaver list
  weaver status <slug>
  weaver log <slug>                          full event tail
  weaver show <slug> <deliverableId>         print a deliverable's content
  weaver steer <slug> <message>              durable human steering (wakes the workstream)
  weaver approve <slug> <interactionId>      approve a pending send
  weaver reject-send <slug> <interactionId>  reject a pending send
  weaver reply <slug> --interaction <id> --from <who> --body <text>   simulate an inbound reply
  weaver observe <slug> --source <s> --summary <text>                 record an external observation
  weaver advance <duration>                  advance the virtual clock (5d, 3h, 30m)
  weaver tick <slug> [--max-passes N]        reconcile: sends, workers, due wakes → coordinator
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = args();
  switch (cmd) {
    case 'create': {
      const slug = opt(rest, 'slug') ?? fail('--slug required');
      const title = opt(rest, 'title') ?? fail('--title required');
      const objective = opt(rest, 'objective') ?? fail('--objective required');
      const doc = createWorkstream({
        slug,
        title,
        objective,
        successCriteria: optAll(rest, 'success'),
        constraints: optAll(rest, 'constraint'),
        autonomy: { sendsRequireApproval: true },
        budget: {
          maxCoordinatorPasses: Number(opt(rest, 'max-passes') ?? 20),
          maxCostUsd: Number(opt(rest, 'max-cost') ?? 15),
        },
      });
      // The creation itself is the first wake: direction needs establishing.
      arrive(slug, (d, event) => {
        d.wakes.push({
          id: newId('wake'),
          reason: 'workstream created — establish direction and dispatch initial work',
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('wake.scheduled', 'initial reconciliation wake');
      });
      process.stdout.write(`created workstream '${slug}' (${doc.workstream.id})\nrun: weaver tick ${slug}\n`);
      break;
    }

    case 'list': {
      for (const s of listWorkstreams()) process.stdout.write(`${s}\n`);
      break;
    }

    case 'status': {
      const slug = rest[0] ?? fail('slug required');
      process.stdout.write(renderStatus(load(slug)) + '\n');
      break;
    }

    case 'log': {
      const slug = rest[0] ?? fail('slug required');
      for (const e of load(slug).events) {
        process.stdout.write(`[${e.atVirtual}] ${e.type}: ${e.summary}\n`);
      }
      break;
    }

    case 'show': {
      const slug = rest[0] ?? fail('slug required');
      const delId = rest[1] ?? fail('deliverable id required');
      const doc = load(slug);
      const del = doc.deliverables.find((d) => d.id === delId) ?? fail(`no deliverable ${delId}`);
      process.stdout.write(readArtifact(slug, del.path) + '\n');
      break;
    }

    case 'steer': {
      const slug = rest[0] ?? fail('slug required');
      const body = rest.slice(1).join(' ') || fail('message required');
      arrive(slug, (d, event) => {
        const id = newId('steer');
        d.steering.push({ id, body, at: new Date().toISOString() });
        d.wakes.push({
          id: newId('wake'),
          reason: `human steering arrived: "${body.slice(0, 80)}"`,
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('steering.arrived', body, [id]);
      });
      process.stdout.write(`steering recorded — run: weaver tick ${slug}\n`);
      break;
    }

    case 'approve': {
      const slug = rest[0] ?? fail('slug required');
      const intId = rest[1] ?? fail('interaction id required');
      arrive(slug, (d, event) => {
        const int = d.interactions.find((i) => i.id === intId) ?? fail(`no interaction ${intId}`);
        if (int.status !== 'awaiting_approval') fail(`${intId} is ${int.status}, not awaiting_approval`);
        int.status = 'approved';
        int.approvedBy = 'human';
        int.approvedAt = new Date().toISOString();
        for (const a of d.attention) {
          if (a.refId === intId && a.status === 'open') {
            a.status = 'resolved';
            a.resolvedAt = new Date().toISOString();
          }
        }
        event('send.approved', `${intId} approved by human`, [intId]);
      });
      process.stdout.write(`approved — the harness will execute it on the next tick\n`);
      break;
    }

    case 'reject-send': {
      const slug = rest[0] ?? fail('slug required');
      const intId = rest[1] ?? fail('interaction id required');
      arrive(slug, (d, event) => {
        const int = d.interactions.find((i) => i.id === intId) ?? fail(`no interaction ${intId}`);
        int.status = 'rejected';
        for (const a of d.attention) {
          if (a.refId === intId && a.status === 'open') {
            a.status = 'resolved';
            a.resolvedAt = new Date().toISOString();
          }
        }
        d.wakes.push({
          id: newId('wake'),
          reason: `human rejected send ${intId}`,
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('send.rejected', `${intId} rejected by human`, [intId]);
      });
      process.stdout.write(`rejected — the coordinator will reconcile on the next tick\n`);
      break;
    }

    case 'reply': {
      const slug = rest[0] ?? fail('slug required');
      const intId = opt(rest, 'interaction') ?? fail('--interaction required');
      const from = opt(rest, 'from') ?? fail('--from required');
      const body = opt(rest, 'body') ?? fail('--body required');
      arrive(slug, (d, event) => {
        const int = d.interactions.find((i) => i.id === intId) ?? fail(`no interaction ${intId}`);
        if (!['sent', 'confirmed'].includes(int.status)) {
          fail(`${intId} is ${int.status} — replies only arrive on sent/confirmed interactions`);
        }
        const id = newId('reply');
        int.replies.push({
          id,
          from,
          body,
          receivedAtVirtual: virtualNow().toISOString(),
        });
        d.wakes.push({
          id: newId('wake'),
          reason: `reply arrived on ${intId} from ${from}`,
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('reply.arrived', `${id} on ${intId} from ${from}: "${body.slice(0, 80)}"`, [intId, id]);
      });
      process.stdout.write(`reply recorded — run: weaver tick ${slug}\n`);
      break;
    }

    case 'observe': {
      const slug = rest[0] ?? fail('slug required');
      const source = opt(rest, 'source') ?? fail('--source required');
      const summary = opt(rest, 'summary') ?? fail('--summary required');
      arrive(slug, (d, event) => {
        const id = newId('obs');
        d.observations.push({ id, source, summary, atVirtual: virtualNow().toISOString() });
        d.wakes.push({
          id: newId('wake'),
          reason: `new observation from ${source}`,
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('observation.arrived', `${id} [${source}] ${summary}`, [id]);
      });
      process.stdout.write(`observation recorded — run: weaver tick ${slug}\n`);
      break;
    }

    case 'adopt': {
      // Human adoption: the operator can accept a submission directly — e.g.
      // when they authored the content themselves, or to overrule the
      // coordinator. Same pinning semantics as coordinator adoption.
      const slug = rest[0] ?? fail('slug required');
      const asgId = rest[1] ?? fail('assignment id required');
      const reason = opt(rest, 'reason') ?? 'adopted by human';
      arrive(slug, (d, event) => {
        const asg = d.assignments.find((x) => x.id === asgId) ?? fail(`no assignment ${asgId}`);
        if (asg.state !== 'awaiting_review' || !asg.submission) fail(`${asgId} has no submission awaiting review`);
        const del = asg.submission.deliverableId
          ? d.deliverables.find((x) => x.id === asg.submission!.deliverableId)
          : undefined;
        if (del) {
          del.adopted = {
            contentHash: del.contentHash,
            passId: 'human',
            atVirtual: virtualNow().toISOString(),
          };
        }
        asg.adoption = { state: 'accepted', passId: 'human', reason };
        asg.state = 'completed';
        d.wakes.push({
          id: newId('wake'),
          reason: `human adopted ${asgId}`,
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('submission.adopted', `${asgId} adopted by HUMAN${del ? ` (pinned ${del.contentHash.slice(0, 8)})` : ''}: ${reason}`, [asgId]);
      });
      process.stdout.write(`adopted ${asgId}\n`);
      break;
    }

    case 'budget': {
      // Budgets are operator-owned config: the human sets the ceiling, the
      // harness enforces it. This is the only sanctioned way to widen one.
      const slug = rest[0] ?? fail('slug required');
      const maxCost = opt(rest, 'max-cost');
      const maxPasses = opt(rest, 'max-passes');
      if (!maxCost && !maxPasses) fail('--max-cost and/or --max-passes required');
      arrive(slug, (d, event) => {
        if (maxCost) d.workstream.budget.maxCostUsd = Number(maxCost);
        if (maxPasses) d.workstream.budget.maxCoordinatorPasses = Number(maxPasses);
        event('budget.updated', `human set budget to ${d.workstream.budget.maxCoordinatorPasses} passes / $${d.workstream.budget.maxCostUsd}`);
      });
      process.stdout.write(`budget updated\n`);
      break;
    }

    case 'advance': {
      const spec = rest[0] ?? fail('duration required (e.g. 5d)');
      const now = advanceClock(spec);
      process.stdout.write(`virtual clock advanced ${spec} → ${now.toISOString()}\n`);
      break;
    }

    case 'tick': {
      const slug = rest[0] ?? fail('slug required');
      const maxPasses = opt(rest, 'max-passes');
      const report = await tick(slug, maxPasses ? { maxPasses: Number(maxPasses) } : {});
      process.stdout.write(
        `tick done: ${report.cycles} cycle(s), ${report.sendsExecuted} send(s), ` +
          `${report.unknownsResolved} readback(s), workers=[${report.workersRun.join(', ')}], ` +
          `passes=${report.passes.length}\n`,
      );
      for (const p of report.passes) {
        process.stdout.write(`  pass ${p.passId} [${p.outcome}] $${p.costUsd.toFixed(3)}${p.summary ? ` — ${p.summary}` : ''}\n`);
      }
      break;
    }

    default:
      process.stdout.write(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : e}\n`);
  process.exit(1);
});
