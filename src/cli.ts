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

  weaver create --slug <s> --title <t> --objective <o> [--tag <t>]... [--success <c>]... [--constraint <c>]... [--max-passes N] [--max-cost USD]
  weaver list
  weaver status <slug>
  weaver log <slug>                          full event tail
  weaver show <slug> <deliverableId>         print a deliverable's content
  weaver steer <slug> <message>              durable human steering (wakes the workstream)
  weaver approve <slug> <interactionId>      approve a pending send
  weaver reject-send <slug> <interactionId>  reject a pending send
  weaver approve-action <slug> <asgId>       approve a gated real-world action (runs on next tick, confirmed by readback)
  weaver reject-action <slug> <asgId> [why]  reject a gated action
  weaver assign-action <slug> --objective <o> --briefing <b> --cwd <dir> --verify <cmd> [--run <cmd>] [--depends-on id]...   author a real-world action yourself (pre-approved; --run = engine executes the exact command deterministically, no model)
  weaver constraint <slug> add <text>        add a hard constraint (human-owned direction)
  weaver constraint <slug> remove <match>    remove the constraint containing <match>
  weaver reply <slug> --interaction <id> --from <who> --body <text> [--key <idempotency>]   simulate an inbound reply
  weaver policies                            list learned policies (shadow/active/superseded)
  weaver secret set <NAME> [--ws slug]       store a secret (value read from stdin, never argv); global unless --ws
  weaver secret list [--ws slug]             list secret NAMES (values are never printed)
  weaver secret rm <NAME> [--ws slug]        remove a secret
  weaver watch [--plain]                     interactive dashboard: ↑↓ select, a approve, x reject, d resolve, s steer, p pause, q quit
  weaver observe <slug> --source <s> --summary <text>                 record an external observation
  weaver advance <duration>                  advance the virtual clock (5d, 3h, 30m)
  weaver tick <slug> [--max-passes N]        reconcile: sends, workers, due wakes → coordinator
  weaver run [--interval N]                  resident runner: tick every active workstream every N seconds (default 30)
  weaver pause <slug> | resume <slug>        stop/restart a workstream being ticked (state is kept)
  weaver resolve <slug> <attentionId> [note] mark an attention item handled (human act)
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
        tags: optAll(rest, 'tag'),
        successCriteria: optAll(rest, 'success'),
        constraints: optAll(rest, 'constraint'),
        autonomy: { sendsRequireApproval: true },
        budget: {
          // Backstops against runaway loops, not spend management — high by
          // default so the human never thinks about them in normal operation.
          maxCoordinatorPasses: Number(opt(rest, 'max-passes') ?? 60),
          maxCostUsd: Number(opt(rest, 'max-cost') ?? 150),
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
      const { addSteering } = await import('./humanActs.js');
      addSteering(slug, body);
      process.stdout.write(`steering recorded — run: weaver tick ${slug}\n`);
      break;
    }

    case 'approve': {
      const slug = rest[0] ?? fail('slug required');
      const intId = rest[1] ?? fail('interaction id required');
      const { approveSend } = await import('./humanActs.js');
      approveSend(slug, intId);
      process.stdout.write(`approved — the harness will execute it on the next tick\n`);
      break;
    }

    case 'assign-action': {
      // A human-AUTHORED real-world action. The coordinator model declines to
      // authorize certain acts (e.g. merging) on the grounds that they are
      // human decisions — this command is the structural answer: the human IS
      // the author, so the act arrives already approved. Execution and
      // readback still belong to the harness like any other action.
      const slug = rest[0] ?? fail('slug required');
      const objective = opt(rest, 'objective') ?? fail('--objective required');
      const briefing = opt(rest, 'briefing') ?? fail('--briefing required');
      const cwd = opt(rest, 'cwd') ?? fail('--cwd required');
      if (!(await import('node:path')).isAbsolute(cwd)) fail(`--cwd must be absolute, got '${cwd}'`);
      const verify = opt(rest, 'verify') ?? fail('--verify required');
      const run = opt(rest, 'run');
      const deps = optAll(rest, 'depends-on');
      {
        // Commands are stored in typed state forever — a pasted secret VALUE
        // would outlive every redaction layer. Reference secrets as $NAME.
        const { assertNoSecretValues, loadSecrets } = await import('./secrets.js');
        const secrets = loadSecrets(slug);
        for (const text of [verify, run ?? '', briefing, objective]) {
          assertNoSecretValues(text, secrets);
        }
      }
      const asgId = newId('asg');
      arrive(slug, (d, event) => {
        d.assignments.push({
          id: asgId,
          objective,
          briefing,
          kind: 'action',
          exec: { cwd, verify, ...(run ? { run } : {}), approval: { by: 'human', at: new Date().toISOString() } },
          acceptanceCriteria: ['Perform exactly the act in the briefing; report exact references; the harness verifies by readback'],
          dependsOn: deps,
          state: 'queued',
          attempts: [],
          adoption: { state: 'none' },
          createdAtVirtual: virtualNow().toISOString(),
        });
        d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
        event('action.human_authored', `${asgId} authored AND approved by human: "${objective}"`, [asgId]);
      });
      process.stdout.write(`${asgId} created (human-authored, pre-approved) — it will run on the next tick and be confirmed by readback\n`);
      break;
    }

    case 'constraint': {
      // Constraints are human-owned direction: only this first-class human
      // mutation may change them — never a coordinator, never a hand-edit.
      const slug = rest[0] ?? fail('slug required');
      const verb = rest[1] ?? fail('add or remove required');
      const text = rest.slice(2).join(' ') || fail('constraint text required');
      arrive(slug, (d, event) => {
        if (verb === 'add') {
          d.workstream.constraints.push(text);
          event('constraint.added', `human added constraint: "${text}"`);
        } else if (verb === 'remove') {
          const i = d.workstream.constraints.findIndex((c) => c.toLowerCase().includes(text.toLowerCase()));
          if (i < 0) fail(`no constraint matching "${text}"`);
          const [gone] = d.workstream.constraints.splice(i, 1);
          event('constraint.removed', `human removed constraint: "${gone}"`);
        } else {
          fail(`unknown verb ${verb} (add|remove)`);
        }
        d.wakes.push({
          id: newId('wake'),
          reason: `human ${verb === 'add' ? 'added' : 'removed'} a constraint: ${text}`,
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
      });
      process.stdout.write(`constraint ${verb === 'add' ? 'added' : 'removed'} — the coordinator will reconcile on the next tick\n`);
      break;
    }

    case 'approve-action': {
      const slug = rest[0] ?? fail('slug required');
      const asgId = rest[1] ?? fail('assignment id required');
      {
        const { approveAction } = await import('./humanActs.js');
        approveAction(slug, asgId);
      }
      process.stdout.write(`approved — the action will run on the next tick and be confirmed by readback\n`);
      break;
    }

    case 'reject-action': {
      const slug = rest[0] ?? fail('slug required');
      const asgId = rest[1] ?? fail('assignment id required');
      const reason = rest.slice(2).join(' ') || 'rejected by human';
      const { rejectAction } = await import('./humanActs.js');
      rejectAction(slug, asgId, reason);
      process.stdout.write(`rejected — the coordinator will reconcile on the next tick\n`);
      break;
    }

    case 'reject-send': {
      const slug = rest[0] ?? fail('slug required');
      const intId = rest[1] ?? fail('interaction id required');
      const { rejectSend } = await import('./humanActs.js');
      rejectSend(slug, intId);
      process.stdout.write(`rejected — the coordinator will reconcile on the next tick\n`);
      break;
    }

    case 'reply': {
      const slug = rest[0] ?? fail('slug required');
      const intId = opt(rest, 'interaction') ?? fail('--interaction required');
      const from = opt(rest, 'from') ?? fail('--from required');
      const body = opt(rest, 'body') ?? fail('--body required');
      const ingressKey = opt(rest, 'key');
      if (ingressKey) {
        const existing = load(slug).interactions.flatMap((i) => i.replies).find((r) => r.ingressKey === ingressKey);
        if (existing) {
          process.stdout.write(`duplicate ingress key '${ingressKey}' — already recorded as ${existing.id}; no-op\n`);
          break;
        }
      }
      arrive(slug, (d, event) => {
        const int = d.interactions.find((i) => i.id === intId) ?? fail(`no interaction ${intId}`);
        if (!['sent', 'confirmed'].includes(int.status)) {
          fail(`${intId} is ${int.status} — replies only arrive on sent/confirmed interactions`);
        }
        const id = newId('reply');
        int.replies.push({
          id,
          ...(ingressKey ? { ingressKey } : {}),
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
      const obsKey = opt(rest, 'key');
      if (obsKey) {
        const existing = load(slug).observations.find((o) => o.ingressKey === obsKey);
        if (existing) {
          process.stdout.write(`duplicate ingress key '${obsKey}' — already recorded as ${existing.id}; no-op\n`);
          break;
        }
      }
      arrive(slug, (d, event) => {
        const id = newId('obs');
        d.observations.push({ id, ...(obsKey ? { ingressKey: obsKey } : {}), source, summary, atVirtual: virtualNow().toISOString() });
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
      const { adoptSubmission } = await import('./humanActs.js');
      adoptSubmission(slug, asgId, reason);
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
        d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
        event('budget.updated', `human set budget to ${d.workstream.budget.maxCoordinatorPasses} passes / $${d.workstream.budget.maxCostUsd}`);
      });
      process.stdout.write(`budget updated\n`);
      break;
    }

    case 'policies': {
      const { loadPolicies } = await import('./policies.js');
      for (const p of loadPolicies().policies) {
        process.stdout.write(
          `${p.id} [${p.status}/${p.effect.kind}] tags=[${p.scope.tags.join(',')}] "${p.statement}"\n` +
          `    from ${p.provenance.workstreamSlug} (${p.provenance.interventionSummary.slice(0, 100)})\n` +
          `    evidence: ${p.evidence.length} (${p.evidence.filter((e) => e.interventionFree).length} intervention-free)${p.supersededBy ? ` superseded by ${p.supersededBy}` : ''}\n`,
        );
      }
      break;
    }

    case 'secret': {
      const { removeSecret, secretNames, setSecret } = await import('./secrets.js');
      const [sub, ...f] = rest;
      const ws = opt(f, 'ws');
      switch (sub) {
        case 'set': {
          const name = f[0] && !f[0].startsWith('--') ? f[0] : fail('secret NAME required');
          const { readFileSync } = await import('node:fs');
          if (process.stdin.isTTY) {
            process.stderr.write(`paste the value for ${name} and press Ctrl-D:\n`);
          }
          const value = readFileSync(0, 'utf8').trim();
          setSecret(name, value, ws);
          process.stdout.write(`secret ${name} stored (${ws ? `workstream ${ws}` : 'global'})\n`);
          break;
        }
        case 'list': {
          const names = secretNames(ws);
          process.stdout.write(names.length ? names.map((n) => `${n}\n`).join('') : '(none)\n');
          break;
        }
        case 'rm': {
          const name = f[0] && !f[0].startsWith('--') ? f[0] : fail('secret NAME required');
          process.stdout.write(
            removeSecret(name, ws) ? `secret ${name} removed\n` : `no secret ${name}\n`,
          );
          break;
        }
        default:
          fail('secret subcommand must be set|list|rm');
      }
      break;
    }

    case 'run': {
      // The resident runner: durability still lives in the store — this loop
      // holds no state and can be killed/restarted at any moment. A tick with
      // nothing due is free (no model call), so polling is cheap. Workstreams
      // tick CONCURRENTLY (default 3) so one long worker never queues the
      // whole fleet; the per-workstream tick lock keeps same-stream ticks
      // exclusive across processes.
      const interval = Number(opt(rest, 'interval') ?? '30') * 1000;
      const concurrency = Math.max(1, Number(opt(rest, 'concurrency') ?? '3'));
      process.stdout.write(`weaver run — ticking active workstreams every ${interval / 1000}s, ${concurrency} in parallel (Ctrl-C to stop)\n`);
      const inFlight = new Set<string>();
      for (;;) {
        const due = listWorkstreams().filter((slug) => {
          if (inFlight.has(slug)) return false;
          try {
            return load(slug).workstream.status === 'active';
          } catch {
            return false;
          }
        });
        for (const slug of due) {
          if (inFlight.size >= concurrency) break;
          inFlight.add(slug);
          void tick(slug, {})
            .then((report) => {
              if (report.workersRun.length || report.passes.length || report.sendsExecuted || report.unknownsResolved) {
                process.stdout.write(
                  `[${new Date().toTimeString().slice(0, 8)}] ${slug}: workers=[${report.workersRun.join(',')}] passes=${report.passes.length} sends=${report.sendsExecuted}\n`,
                );
              }
            })
            .catch((e) => {
              process.stderr.write(`[run] ${slug}: ${e instanceof Error ? e.message : e}\n`);
            })
            .finally(() => inFlight.delete(slug));
        }
        await new Promise((r) => setTimeout(r, interval));
      }
    }

    case 'resolve': {
      // Attention items are addressed TO the human; only the human closes
      // them. The note (if any) lands in the event tail for the next pass.
      const slug = rest[0] ?? fail('slug required');
      const attId = rest[1] ?? fail('attention id required');
      const note = rest.slice(2).join(' ');
      const { resolveAttention } = await import('./humanActs.js');
      resolveAttention(slug, attId, note);
      process.stdout.write(`${attId} resolved\n`);
      break;
    }

    case 'pause':
    case 'resume': {
      const slug = rest[0] ?? fail('slug required');
      const { setPaused } = await import('./humanActs.js');
      setPaused(slug, cmd === 'pause');
      process.stdout.write(`${slug} is now ${cmd === 'pause' ? 'paused' : 'active'}\n`);
      break;
    }

    case 'watch': {
      if (rest.includes('--plain')) {
        const { runWatch } = await import('./watch.js');
        await runWatch();
      } else {
        const { runTui } = await import('./tui.js');
        await runTui();
      }
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
