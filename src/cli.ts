/**
 * The Weaver CLI. Every command mutates or reads stored state and exits —
 * durability lives in the store, never in a process.
 */

import { advanceClock, parseDuration, virtualNow } from './clock.js';
import { KNOWN_COMMANDS, looksLikeUnknownSubcommand, misroutedSubcommand } from './dispatch.js';
import { loadDotenv } from './env.js';
import { tick } from './engine.js';
import { executionSafetyConfig, newExecutionSafety } from './executionSafety.js';
import { renderStatus } from './status.js';
import {
  arrive,
  closeStore,
  createWorkstream,
  listManagedBy,
  listWorkstreams,
  load,
  newId,
  readArtifact,
  SourceKeyConflictError,
} from './store.js';
import { createWorkstreamUnderParent, ManagedWorkstreamError } from './managedWorkstreams.js';
import { assertRunnerId, resolveAssignmentRunnerId } from './runnerIdentity.js';

function args(): string[] {
  return process.argv.slice(2);
}

/**
 * Raw multiline capture from stdin — the safe channel for real messages.
 * Shell-quoted arguments mangle exactly the content operators paste (a
 * double-quoted "$36.69" reached one brief as ".69" after $-expansion, and an
 * embedded quote ends the argument entirely); stdin has no such grammar.
 * Ends at EOF (Ctrl-D) or a line containing only ".".
 */
async function readMultiline(): Promise<string> {
  const { createInterface } = await import('node:readline');
  const lines: string[] = [];
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim() === '.') break;
    lines.push(line);
  }
  rl.close();
  return lines.join('\n').trim();
}

/**
 * Liveness for model-backed commands: `weaver do`/`ask` spend 20-60s in a
 * model pass, and a silent terminal reads as frozen. Spinner + elapsed
 * seconds on a TTY, one plain line otherwise; always stderr so stdout stays
 * clean for the result.
 */
function progress(label: string): () => void {
  if (!process.stderr.isTTY) {
    process.stderr.write(`${label}…\n`);
    return () => {};
  }
  const frames = ['◐', '◓', '◑', '◒'];
  const started = Date.now();
  let i = 0;
  const t = setInterval(() => {
    process.stderr.write(`\r\x1b[2K${frames[i++ % frames.length]} ${label}… ${Math.round((Date.now() - started) / 1000)}s`);
  }, 250);
  t.unref?.();
  return () => {
    clearInterval(t);
    process.stderr.write('\r\x1b[2K');
  };
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

const USAGE = `weaver — manages outcomes across agent runs (MVP)

  weaver do ["<message>"] ["<done means>"]   start work from one sentence — slug, brief, criteria, routine-ness all derived; house constraints applied. Optional 2nd arg overrides the done-bar (e.g. "verified live on the web post-merge, read-only")
                                             NO ARGS = interactive: type/paste a multiline message, finish with Ctrl-D or a "." line — the safe path for long messages ($, quotes, newlines survive verbatim)
  weaver ask "<question>"                    interrogate the fleet's history: "did anything pick up X?", "what happened with Y?", "why wasn't Z done?" — answers cite decisions/events/deliverables from recorded state (read-only)
  weaver create --slug <s> --title <t> --objective <o> [--tag <t>]... [--success <c>]... [--constraint <c>]... [--source-key <k>] [--execution-window <duration>] [--max-model-starts N] [--under <parent-slug>]
  weaver list
  weaver status <slug>
  weaver capacity retry <slug> [--model <model>]   make a parked provider wait due after you change Claude-side usage/auth settings; does not change billing or identity
  weaver log <slug>                          full event tail
  weaver tail <slug> [--all]                 live activity feed: worker tool calls, output snippets, results as they happen
                                             (--all adds coordinator passes; sessionId provenance / \`claude --resume <id>\` is unaffected)
  weaver show <slug> <deliverableId>         print a deliverable's content
  weaver steer <slug> <message>              durable human steering (wakes the workstream)
  weaver steer <slug> revoke [steerId]       withdraw steering no pass has read yet (default: your last)
  weaver priority <slug> <high|normal|low>   rank a stream for the runner's slots when the fleet is saturated
  weaver placement <slug> <runner-id|any>    bind all future and safely pending assignments to one execution host; "any" restores fleet-wide placement
  weaver rename <slug> <new-slug>            move a workstream to a better name — history, artifacts, manager links, and policy attribution all follow; refused mid-tick
  weaver approve <slug> <interactionId>      approve a pending send
  weaver reject-send <slug> <interactionId>  reject a pending send
  weaver approve-action <slug> <asgId>       approve a gated real-world action (runs on next tick, confirmed by readback)
  weaver reject-action <slug> <asgId> [why]  reject a gated action
  weaver assign-action <slug> --objective <o> --briefing <b> --cwd <dir> --verify <cmd> [--run <cmd>] [--runner-id <id>] [--preflight-mode <postcondition|always-execute>] [--depends-on id]...   author a real-world action yourself (pre-approved; --run = engine executes the exact command deterministically, no model)
  weaver constraint <slug> add <text>        add a hard constraint (human-owned direction)
  weaver constraint <slug> remove <match>    remove the constraint containing <match>
  weaver reply <slug> --interaction <id> --from <who> --body <text> [--key <idempotency>]   simulate an inbound reply
  weaver policies                            list policies (doctrine first, then shadow/active/superseded, contested flagged)
  weaver policies mechanism <id> [text]      revise a policy's HOW (command/flag/threshold); empty text clears it. The rule and its evidence are untouched
  weaver policies export [--author name] [--out file]   sanitized team seed: statements/scope/effect only
  weaver policies import <file>              import a teammate's seed — all shadow, dedup, authority refused
  weaver policies supersede <oldId> (--with <id> | --statement <s> --tag <t>... --effect <kind> [--effect-desc <d>]) [--reason <r>]   replace a wrong policy (lineage kept); resolves a contested one
  weaver policies review-clear <id> [note]   clear a contest after review found the policy still sound (no supersession)
  weaver backfill --tags <t1,t2> [--rules <path>]... [--claude-projects <dir>] [--limit N] [--dry-run]
                                             seed shadow policies from existing practice: rules files (CLAUDE.md/AGENTS.md, deterministic) and/or recent Claude Code transcripts (one model pass, default 5 sessions).
                                             Re-running REFRESHES rules-file doctrine: edited rules update in place, deleted sections retire, and a changed rule contests the learned policies scoped to it (--dry-run shows that blast radius first)
  weaver login                               interactive setup: pick this host's executor, register credentials (0600 store, input hidden), choose models → .env
  weaver login --status                      per-executor auth status + model config with sources (names only, never values)
  weaver login --render-remote-env           emit KEY=value lines to provision a headless host (refuses a TTY — pipe it, e.g. over SSH)
  weaver login --render-remote-executor-secrets  emit the exact adapter-only secret store for secure host provisioning (refuses a TTY)
  weaver pilot-auth-check                    production preflight: authenticated Pilot /internal/auth-check must return HTTP 204
  weaver github-app-setup <organization>     browser-confirmed local setup: create, install, verify, and store an all-repositories GitHub App
  weaver github-auth-check                   production preflight: dedicated GitHub App must mint and use a read-only installation token
  weaver github-clone <owner/repo> <absolute-path>   securely bootstrap one installed repository without persisting a token
  weaver link <store-url>                    join this machine to an existing fleet: prove the store is reachable (read-only), then persist WEAVER_STORE into .env
  weaver link                                show where WEAVER_STORE points now (env / .env / default fs) and re-check reachability
  weaver link --unlink                       remove WEAVER_STORE from .env (an ambient env export still wins if set)
  weaver store copy-to-postgres [<url>]      copy the exact filesystem fleet into an empty Postgres store and verify its readback; omit URL for a hidden prompt
  weaver secret set <NAME> [--ws slug | --executor]   store from stdin; --executor is adapter-only and never exposed to workers
  weaver secret list [--ws slug | --executor]         list secret NAMES (values are never printed)
  weaver secret rm <NAME> [--ws slug | --executor]    remove a secret
  weaver watch                               interactive dashboard + embedded runner; keys: ↑↓, a/x/d/s, p pause, P printout, q quit
  weaver watch --plain                       legacy read-only raw dashboard; q quits (use 'weaver printout [slug]' to catch up)
  weaver printout [slug] [--text]            open an HTML catch-up page; --text writes the plain report instead
  weaver inspect [slug]                      visual work board → self-contained HTML: Workstreams, Assignments, evidence, and history
  weaver stats                               outcome scoreboard → self-contained HTML: interventions per adopted work product, approval split, policy evidence, per-workstream stats
  weaver ui [--host H] [--port N]            browser operator workspace (default 127.0.0.1:9724); non-loopback requires Clerk or WEAVER_UI_TOKEN
  weaver observe <slug> --source <s> --summary <text>                 record an external observation
  weaver advance <duration>                  advance the virtual clock (5d, 3h, 30m)
  weaver tick <slug> [--max-passes N]        reconcile: sends, workers, due wakes → coordinator
  weaver tick <slug> --engine-only           placed exact actions/readback only (requires placement-only env)
  weaver run [--interval N]                  resident runner: tick every active workstream every N seconds (default 30)
  weaver serve [--host H] [--port N]         HTTP ingress for external bots (needs WEAVER_SERVE_TOKEN); create-or-get workstreams, post observations, read status
  weaver pause [slug]                        pause every active workstream, or one named workstream (state is kept)
  weaver resume <slug>                       restart one paused or concluded workstream (state and conclusion lineage are kept)
  weaver execution-safety <slug> [--window <duration>] [--max-starts N]   configure the rolling model-start guard; pauses and resumes automatically
  weaver resolve <slug> <attentionId> [note] mark an attention item handled (human act)
`;

async function slugExists(slug: string): Promise<boolean> {
  try {
    return (await listWorkstreams()).includes(slug);
  } catch {
    return false;
  }
}

async function runIntake(message: string, done?: string): Promise<void> {
  message = message.trim();
  if (!message) {
    // No message: interactive/piped capture — the recommended path for anything
    // longer than a sentence (multiline, $, quotes all safe).
    if (process.stdin.isTTY) {
      process.stderr.write('Describe what you want done — multiline and paste are fine; finish with Ctrl-D (or a line containing only "."):\n');
    }
    message = await readMultiline();
  }
  if (!message) fail('usage: weaver do "<what you want done>" ["<what done means>"] — or run `weaver do` with no args and type/paste the message');
  // One command-shaped word aimed at a workstream that exists is a subcommand
  // this CLI does not have, not a message. Onboarding it forks the fleet under
  // a `<slug>-2` name while the operator believes they just managed a stream.
  const tokens = message.split(/\s+/);
  if (await looksLikeUnknownSubcommand(tokens, (s) => slugExists(s))) {
    fail(
      `'${tokens[0]}' is not a weaver command, and '${tokens[1]}' is an existing workstream — refusing to onboard this as a new one.\n` +
      `       Run \`weaver help\` for the command list, or force intake with: weaver do "${message}"`,
    );
  }
  const { onboard } = await import('./onboard.js');
  const stopProgress = progress('deriving the workstream from your message (one model pass)');
  let r;
  try {
    r = await onboard(message, done?.trim());
  } finally {
    stopProgress();
  }
  if (r.action === 'steered') {
    process.stdout.write(
      [
        `↪ ${r.slug}${r.reopened ? '  (reopened)' : ''} — ${r.title}`,
        ``,
        `An existing workstream already owns this — your message arrived there as steering${r.reopened ? ', and the workstream was reopened with its history intact' : ''}.`,
        ``,
        `It's running. Watch: weaver watch · weaver status ${r.slug}`,
        ``,
      ].join('\n'),
    );
    return;
  }
  if (r.fallbackReason) {
    process.stderr.write(
      `⚠ model derivation failed (${r.fallbackReason}) — slug and title are the deterministic fallback (first words of your message)\n`,
    );
  }
  const d = r.derived;
  process.stdout.write(
    [
      `▶ ${d.slug}${d.routine ? '  (routine)' : ''} — ${d.title}`,
      ``,
      d.objective,
      ...(d.successCriteria.length ? [``, `done when:`, ...d.successCriteria.map((c) => `  - ${c}`)] : []),
      ``,
      `It's running. Watch: weaver watch · redirect anytime: weaver steer ${d.slug} "<msg>"`,
      ``,
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  loadDotenv(); // repo-root .env fills unset config; explicit env still wins
  const [cmd, ...rest] = args();
  // Intake is the default action: bare `weaver`, or a first word that is not a
  // subcommand, is a message to onboard (alias `w=weaver`). Every real
  // subcommand dispatches natively below.
  if (cmd === undefined || !KNOWN_COMMANDS.has(cmd)) {
    await runIntake(cmd === undefined ? '' : [cmd, ...rest].join(' '));
    return;
  }
  await runCommand(cmd, rest);
}

async function runCommand(cmd: string, rest: string[]): Promise<void> {
  switch (cmd) {
    case 'do': {
      // A management command mis-routed here by a `w='weaver do'` alias — e.g.
      // `w steer <slug> "<msg>"` — is dispatched to the real subcommand instead
      // of onboarding a duplicate workstream from its words.
      const routed = await misroutedSubcommand(rest, slugExists);
      if (routed) return runCommand(routed[0], routed[1]);
      // Exactly two args = message + explicit done-statement; anything else
      // joins into one message (so an unquoted sentence still just works).
      const message = rest.length === 2 ? rest[0]! : rest.join(' ');
      const done = rest.length === 2 ? rest[1]! : undefined;
      await runIntake(message, done);
      break;
    }

    case 'ask': {
      const question = rest.join(' ').trim();
      if (!question) fail('usage: weaver ask "<question about what happened / what was picked up / why>"');
      const { ask } = await import('./ask.js');
      const stopProgress = progress('searching the fleet’s recorded history');
      let answer;
      try {
        answer = await ask(question);
      } finally {
        stopProgress();
      }
      process.stdout.write(answer.trim() + '\n');
      break;
    }

    case 'create': {
      const slug = opt(rest, 'slug') ?? fail('--slug required');
      const title = opt(rest, 'title') ?? fail('--title required');
      const objective = opt(rest, 'objective') ?? fail('--objective required');
      // A stream created by hand for something that also exists in a tracker
      // carries the same key an intake stream would spawn it under, so the two
      // can never both create it. Uniqueness is enforced atomically at the
      // store write — no scan-then-create race — and surfaces as a
      // SourceKeyConflictError we render as a clean CLI failure.
      if (rest.includes('--max-passes') || rest.includes('--max-cost')) {
        fail('lifetime pass/dollar caps were removed; use --execution-window/--max-model-starts, and provider billing controls for API spend');
      }
      const executionWindow = opt(rest, 'execution-window');
      const maxModelStarts = opt(rest, 'max-model-starts');
      if (rest.includes('--execution-window') && !executionWindow) fail('--execution-window requires a duration');
      if (rest.includes('--max-model-starts') && !maxModelStarts) fail('--max-model-starts requires a positive integer');
      const sourceKey = opt(rest, 'source-key');
      const under = opt(rest, 'under');
      if (under === slug) fail(`--under cannot name the new workstream itself`);
      // Human composition path (#128 step 2): `--under` routes through the
      // SAME shared creation semantics the coordinator's create_workstream
      // tool uses (single managedBy pointer, no inheritance, source-key
      // idempotency), with parent-exists-and-active as a human precondition.
      if (under) {
        let child;
        try {
          child = await createWorkstreamUnderParent(under, {
            slug,
            title,
            objective,
            successCriteria: optAll(rest, 'success'),
            constraints: optAll(rest, 'constraint'),
            tags: optAll(rest, 'tag'),
            ...(sourceKey ? { sourceKey } : {}),
            executionWindowSeconds: executionWindow
              ? Math.ceil(parseDuration(executionWindow) / 1000)
              : undefined,
            maxModelStarts: maxModelStarts ? Number(maxModelStarts) : undefined,
          });
        } catch (e) {
          if (e instanceof SourceKeyConflictError || e instanceof ManagedWorkstreamError) fail(e.message);
          throw e;
        }
        process.stdout.write(`created workstream '${slug}' (${child.workstream.id}) under '${under}'\nits manager sees it via its own passes; run: weaver tick ${slug}\n`);
        break;
      }
      const doc = await createWorkstream({
        slug,
        title,
        objective,
        ...(sourceKey ? { sourceKey } : {}),
        tags: optAll(rest, 'tag'),
        successCriteria: optAll(rest, 'success'),
        constraints: optAll(rest, 'constraint'),
        autonomy: { sendsRequireApproval: true },
        executionSafety: newExecutionSafety({
          windowSeconds: executionWindow
            ? Math.ceil(parseDuration(executionWindow) / 1000)
            : undefined,
          maxModelStarts: maxModelStarts
            ? Number(maxModelStarts)
            : undefined,
        }),
      }).catch((e) => {
        // A collision on a hand-set source key is a clean user error, not a
        // stack trace: name the workstream that already holds it and exit.
        if (e instanceof SourceKeyConflictError) fail(e.message);
        throw e;
      });
      // The creation itself is the first wake: direction needs establishing.
      await arrive(slug, (d, event) => {
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
      for (const s of await listWorkstreams()) process.stdout.write(`${s}\n`);
      break;
    }

    case 'status': {
      const slug = rest[0] ?? fail('slug required');
      process.stdout.write(renderStatus(await load(slug), await listManagedBy(slug)) + '\n');
      break;
    }

    case 'capacity': {
      const subcommand = rest[0] ?? fail('capacity subcommand required (retry)');
      if (subcommand !== 'retry') fail(`unknown capacity subcommand '${subcommand}' (expected retry)`);
      const slug = rest[1] ?? fail('usage: weaver capacity retry <slug> [--model <model>]');
      const model = opt(rest, 'model');
      const current = await load(slug);
      const available = [...new Set(
        Object.values(current.capacity?.byModel ?? {}).map((entry) => entry.wait.model),
      )].sort();
      if (!available.length) fail(`${slug} has no provider capacity wait to retry`);
      if (model && !available.includes(model)) {
        fail(`${slug} has no provider capacity wait for '${model}' (waiting: ${available.join(', ')})`);
      }
      const { retryCapacityNow } = await import('./capacity.js');
      let retried: string[] = [];
      await arrive(slug, (d, event) => {
        retried = retryCapacityNow(d, virtualNow().toISOString(), model);
        event(
          'capacity.retry_requested',
          `operator made provider retry due for ${retried.join(', ')}; recovery remains unconfirmed until the next real run`,
        );
      });
      process.stdout.write(
        `provider retry due for ${retried.join(', ')} — Weaver changed no billing or identity; the next runner/tick will test recovery\n`,
      );
      break;
    }

    case 'log': {
      const slug = rest[0] ?? fail('slug required');
      for (const e of (await load(slug)).events) {
        process.stdout.write(`[${e.atVirtual}] ${e.type}: ${e.summary}\n`);
      }
      break;
    }

    case 'tail': {
      const slug = rest[0] ?? fail('slug required');
      await load(slug); // unknown slug fails loudly instead of waiting on a file forever
      const { runTail } = await import('./tail.js');
      await runTail(slug, { all: rest.includes('--all') });
      break;
    }

    case 'show': {
      const slug = rest[0] ?? fail('slug required');
      const delId = rest[1] ?? fail('deliverable id required');
      const doc = await load(slug);
      const del = doc.deliverables.find((d) => d.id === delId) ?? fail(`no deliverable ${delId}`);
      process.stdout.write((await readArtifact(slug, del.path)) + '\n');
      break;
    }

    case 'steer': {
      const slug = rest[0] ?? fail('slug required');
      // `weaver steer <slug> revoke [steerId]` withdraws instead of adding.
      // Same verb because it is the same conversation: taking back what you
      // just said belongs next to saying it, not in a separate command.
      if (rest[1] === 'revoke') {
        const { revokeSteering } = await import('./humanActs.js');
        const revoked = await revokeSteering(slug, rest[2]);
        process.stdout.write(`withdrew ${revoked.id} — the coordinator never read it: "${revoked.body.slice(0, 70)}${revoked.body.length > 70 ? '…' : ''}"\n`);
        break;
      }
      const body = rest.slice(1).join(' ') || fail('message required');
      const { addSteering } = await import('./humanActs.js');
      await addSteering(slug, body);
      process.stdout.write(`steering recorded — run: weaver tick ${slug}\n`);
      break;
    }

    case 'priority': {
      const slug = rest[0] ?? fail('slug required');
      const level = rest[1] ?? fail('usage: weaver priority <slug> <high|normal|low>');
      if (level !== 'high' && level !== 'normal' && level !== 'low') {
        fail(`unknown priority '${level}' (expected high, normal or low)`);
      }
      const { setPriority } = await import('./humanActs.js');
      const r = await setPriority(slug, level);
      process.stdout.write(
        r.changed
          ? `${slug}: priority ${r.previous} → ${r.priority} — a due high stream reserves most of the runner's slots; fairness decides the order within a band\n`
          : `${slug} is already ${r.priority}\n`,
      );
      break;
    }

    case 'placement': {
      const slug = rest[0] ?? fail('usage: weaver placement <slug> <runner-id|any>');
      const target = rest[1] ?? fail('usage: weaver placement <slug> <runner-id|any>');
      if (rest.length !== 2) fail('usage: weaver placement <slug> <runner-id|any>');
      const runnerId = target === 'any' ? undefined : assertRunnerId(target, 'runner id');
      const { setAssignmentPlacement } = await import('./humanActs.js');
      const result = await setAssignmentPlacement(slug, runnerId);
      if (!result.changed) {
        process.stdout.write(`${slug}: assignment placement is already ${runnerId ?? 'fleet-wide'}\n`);
        break;
      }
      process.stdout.write(
        `${slug}: assignments ${runnerId ? `bound to ${runnerId}` : 'restored to fleet-wide placement'}; ` +
          `${result.assignmentsUpdated.length} queued/gated assignment(s) updated\n`,
      );
      break;
    }

    case 'rename': {
      const oldSlug = rest[0] ?? fail('usage: weaver rename <slug> <new-slug>');
      const newSlug = rest[1] ?? fail('usage: weaver rename <slug> <new-slug>');
      const { renameWorkstream } = await import('./humanActs.js');
      const r = await renameWorkstream(oldSlug, newSlug);
      process.stdout.write(`${r.oldSlug} → ${r.newSlug} — ${r.title}\n`);
      if (r.pointersUpdated.length) {
        process.stdout.write(`  manager pointers followed on: ${r.pointersUpdated.join(', ')}\n`);
      }
      if (r.policiesUpdated) {
        process.stdout.write(`  policy attributions followed: ${r.policiesUpdated}\n`);
      }
      break;
    }

    case 'approve': {
      const slug = rest[0] ?? fail('slug required');
      const intId = rest[1] ?? fail('interaction id required');
      const { approveSend } = await import('./humanActs.js');
      await approveSend(slug, intId);
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
      const runnerId = opt(rest, 'runner-id');
      if (rest.includes('--runner-id') && runnerId === undefined) fail('--runner-id requires an id');
      if (runnerId !== undefined) assertRunnerId(runnerId, '--runner-id');
      const preflightMode = opt(rest, 'preflight-mode');
      if (rest.includes('--preflight-mode') && preflightMode === undefined) {
        fail('--preflight-mode requires postcondition or always-execute');
      }
      if (preflightMode !== undefined && preflightMode !== 'postcondition' && preflightMode !== 'always-execute') {
        fail(`--preflight-mode must be postcondition or always-execute, got '${preflightMode}'`);
      }
      if (preflightMode !== undefined && !run?.trim()) {
        fail('--preflight-mode requires --run');
      }
      const deps = optAll(rest, 'depends-on');
      {
        // Commands are stored in typed state forever — a pasted secret VALUE
        // would outlive every redaction layer. Reference secrets as $NAME.
        const { assertNoSecretValues, loadRedactionSecrets } = await import('./secrets.js');
        const secrets = loadRedactionSecrets(slug);
        for (const text of [verify, run ?? '', briefing, objective]) {
          assertNoSecretValues(text, secrets);
        }
      }
      const asgId = newId('asg');
      await arrive(slug, (d, event) => {
        const assignmentRunnerId = resolveAssignmentRunnerId(d.workstream.assignmentRunnerId, runnerId);
        d.assignments.push({
          id: asgId,
          objective,
          briefing,
          kind: 'action',
          ...(assignmentRunnerId ? { runnerId: assignmentRunnerId } : {}),
          exec: {
            cwd,
            verify,
            ...(run ? { run } : {}),
            ...(preflightMode ? { preflightMode } : {}),
            approval: { by: 'human', at: new Date().toISOString() },
          },
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
      await arrive(slug, (d, event) => {
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
        await approveAction(slug, asgId);
      }
      process.stdout.write(`approved — the action will run on the next tick and be confirmed by readback\n`);
      break;
    }

    case 'reject-action': {
      const slug = rest[0] ?? fail('slug required');
      const asgId = rest[1] ?? fail('assignment id required');
      const reason = rest.slice(2).join(' ') || 'rejected by human';
      const { rejectAction } = await import('./humanActs.js');
      await rejectAction(slug, asgId, reason);
      process.stdout.write(`rejected — the coordinator will reconcile on the next tick\n`);
      break;
    }

    case 'reject-send': {
      const slug = rest[0] ?? fail('slug required');
      const intId = rest[1] ?? fail('interaction id required');
      const { rejectSend } = await import('./humanActs.js');
      await rejectSend(slug, intId);
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
        const existing = (await load(slug)).interactions.flatMap((i) => i.replies).find((r) => r.ingressKey === ingressKey);
        if (existing) {
          process.stdout.write(`duplicate ingress key '${ingressKey}' — already recorded as ${existing.id}; no-op\n`);
          break;
        }
      }
      await arrive(slug, (d, event) => {
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
      const { recordObservation } = await import('./ingress.js');
      const result = await recordObservation(slug, { source, summary, ingressKey: obsKey });
      if (result.duplicate) {
        process.stdout.write(`duplicate ingress key '${obsKey}' — already recorded as ${result.id}; no-op\n`);
      } else {
        process.stdout.write(`observation recorded — run: weaver tick ${slug}\n`);
      }
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
      await adoptSubmission(slug, asgId, reason);
      process.stdout.write(`adopted ${asgId}\n`);
      break;
    }

    case 'budget': {
      fail('lifetime dollar/pass caps were removed; use `weaver execution-safety <slug> --window 1h --max-starts 30`, and provider billing controls for API spend');
      break;
    }

    case 'execution-safety': {
      const slug = rest[0] ?? fail('slug required');
      const window = opt(rest, 'window');
      const maxStarts = opt(rest, 'max-starts');
      if (rest.includes('--window') && !window) fail('--window requires a duration');
      if (rest.includes('--max-starts') && !maxStarts) fail('--max-starts requires a positive integer');
      if (!window && !maxStarts) fail('--window and/or --max-starts required');
      await arrive(slug, (d, event) => {
        const prior = executionSafetyConfig(d.workstream);
        d.workstream.executionSafety = newExecutionSafety({
          windowSeconds: window ? Math.ceil(parseDuration(window) / 1000) : prior.windowSeconds,
          maxModelStarts: maxStarts ? Number(maxStarts) : prior.maxModelStarts,
        });
        d.spend.humanInterventions = (d.spend.humanInterventions ?? 0) + 1;
        event('execution_safety.updated', `config: ${(process.env.WEAVER_ACTOR ?? 'operator')} set rolling guard to ${d.workstream.executionSafety.maxModelStarts} model starts / ${d.workstream.executionSafety.windowSeconds}s`);
      });
      process.stdout.write(`execution safety guard updated\n`);
      break;
    }

    case 'policies': {
      const { exportSeed, importSeed, loadPolicies, policyOrigin } = await import('./policies.js');
      if (rest[0] === 'export') {
        // Team seed: share your guardrails, never your trust or transcripts.
        const { userInfo } = await import('node:os');
        const author = opt(rest, 'author') ?? userInfo().username;
        const out = opt(rest, 'out') ?? `${process.cwd()}/state/seed-${author}.json`;
        const seed = await exportSeed(author);
        (await import('node:fs')).writeFileSync(out, JSON.stringify(seed, null, 2) + '\n');
        process.stdout.write(`exported ${seed.policies.length} shareable policies → ${out}\n(sanitized: statements + scope + effect only — no ids, evidence, or transcript quotes)\n`);
        break;
      }
      if (rest[0] === 'import') {
        const file = rest[1] ?? fail('seed file required');
        const { grantsAuthority } = await import('./backfill.js');
        const seed = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
        if (seed.weaverSeed !== 1) fail('not a weaver seed file');
        const res = await importSeed(seed, { refuseAuthority: grantsAuthority });
        process.stdout.write(
          `imported ${res.imported} policies from ${seed.author} — ALL land in shadow and earn active status through YOUR outcomes\n` +
          `${res.skippedDuplicate} duplicates skipped` +
          (res.refused.length ? `\n${res.refused.length} REFUSED (read like granting authority — authority is never imported):\n${res.refused.map((r) => `  - ${r}`).join('\n')}` : '') + '\n',
        );
        break;
      }
      if (rest[0] === 'supersede') {
        // weaver policies supersede <oldId> ( --with <existingId> | --statement <s> --tag <t>... --effect <kind> [--effect-desc <d>] ) [--reason <r>] [--ws <slug>]
        const oldId = rest[1] ?? fail('usage: weaver policies supersede <oldId> (--with <id> | --statement <s> --tag <t>... --effect <kind>)');
        const { supersedePolicy } = await import('./policies.js');
        const withExisting = opt(rest, 'with');
        let next;
        if (withExisting) {
          next = await supersedePolicy(oldId, { withExisting });
        } else {
          const statement = opt(rest, 'statement') ?? fail('--statement (or --with <existingId>) required');
          const tags = optAll(rest, 'tag');
          if (!tags.length) fail('--tag required (at least one) for a new replacement');
          const effectKind = opt(rest, 'effect') ?? 'advisory';
          if (!['add_verification', 'narrow_authority', 'advisory'].includes(effectKind)) {
            fail(`--effect must be add_verification|narrow_authority|advisory, got '${effectKind}'`);
          }
          next = await supersedePolicy(oldId, {
            statement,
            tags,
            effectKind: effectKind as 'add_verification' | 'narrow_authority' | 'advisory',
            effectDescription: opt(rest, 'effect-desc') ?? statement,
            workstreamSlug: opt(rest, 'ws') ?? 'cli',
            passId: newId('pass'),
            interventionSummary: opt(rest, 'reason') ?? 'superseded via CLI',
          });
        }
        process.stdout.write(`superseded ${oldId} → ${next.id} (shadow — earns active through the normal evidence loop)\n`);
        break;
      }
      if (rest[0] === 'mechanism') {
        // weaver policies mechanism <id> [text...] — revise the HOW. No
        // supersession, no approval: the rule is unchanged and evidence was
        // never about the command anyway. Omitting the text clears it.
        const id = rest[1] ?? fail('usage: weaver policies mechanism <policyId> [text] (omit text to clear)');
        const { revisePolicyMechanism } = await import('./policies.js');
        const updated = await revisePolicyMechanism(id, rest.slice(2).join(' '));
        process.stdout.write(
          updated.mechanism
            ? `${id} mechanism: ${updated.mechanism}\n(statement and evidence untouched — a mechanism is the how, not the rule)\n`
            : `${id} mechanism cleared\n`,
        );
        break;
      }
      if (rest[0] === 'review-clear') {
        // weaver policies review-clear <id> [note] — resolve a contest without superseding.
        const id = rest[1] ?? fail('usage: weaver policies review-clear <policyId> [note]');
        const { reviewClearPolicy } = await import('./policies.js');
        await reviewClearPolicy(id, rest.slice(2).join(' ') || 'cleared via CLI');
        process.stdout.write(`${id} contest cleared — it renders as ordinary guidance again\n`);
        break;
      }
      // Doctrine first, for the same reason the projection puts it first: it
      // is the operator's own rule and it outranks everything below it.
      const { isDoctrine } = await import('./policies.js');
      const all = (await loadPolicies()).policies;
      for (const p of [...all.filter(isDoctrine), ...all.filter((x) => !isDoctrine(x))]) {
        const contestSource = p.contested?.workstreamSlug
          ? `in ${p.contested.workstreamSlug}`
          : p.contested?.byPolicyId
            ? `by refreshed doctrine ${p.contested.byPolicyId}`
            : 'source not recorded';
        process.stdout.write(
          `${p.id} [${isDoctrine(p) ? 'DOCTRINE' : p.status}/${p.effect.kind}]${p.contested ? ' CONTESTED' : ''} tags=[${p.scope.tags.join(',')}] "${p.statement}"\n` +
          (p.mechanism ? `    mechanism (revisable, not the rule): ${p.mechanism}\n` : '') +
          `    from ${policyOrigin(p)} (${p.provenance.interventionSummary.slice(0, 100)})\n` +
          `    evidence: ${p.evidence.length} (${p.evidence.filter((e) => e.interventionFree).length} intervention-free)` +
          `${isDoctrine(p) ? ' — doctrine binds without evidence' : ''}` +
          `${p.supersedes ? ` supersedes ${p.supersedes}` : ''}${p.supersededBy ? ` superseded by ${p.supersededBy}` : ''}` +
          `${!p.supersededBy && p.supersededReason ? ` retired: ${p.supersededReason}` : ''}` +
          `${p.contested ? `\n    CONTESTED ${contestSource}: ${p.contested.note.slice(0, 100)}` : ''}\n`,
        );
      }
      break;
    }

    case 'backfill': {
      // Seed the policy store from pre-Weaver practice. Everything lands in
      // SHADOW — backfill imports candidates, never trust — and re-running
      // is a no-op (dedup on normalized statement).
      const tagsCsv = opt(rest, 'tags') ?? fail('--tags required — backfilled policies need an explicit scope (comma-separated)');
      const tags = tagsCsv.split(',').map((t) => t.trim()).filter(Boolean);
      if (!tags.length) fail('--tags must name at least one tag');
      const rulePaths = optAll(rest, 'rules');
      const projectsDir = opt(rest, 'claude-projects');
      if (!rulePaths.length && !projectsDir) {
        fail('nothing to backfill — pass --rules <path> and/or --claude-projects <dir>');
      }
      const dryRun = rest.includes('--dry-run');
      const limit = Number(opt(rest, 'limit') ?? 5);
      const { backfillRules, backfillSessions, renderBackfillReport } = await import('./backfill.js');
      if (rulePaths.length) {
        process.stdout.write(`## rules files (deterministic)\n${renderBackfillReport(await backfillRules(rulePaths, tags, dryRun), dryRun)}\n`);
      }
      if (projectsDir) {
        const report = await backfillSessions(projectsDir, tags, { dryRun, limit });
        process.stdout.write(`## Claude Code sessions (model-distilled, last ${limit})\n${renderBackfillReport(report, dryRun)}\n`);
      }
      break;
    }

    case 'secret': {
      const {
        executorSecretNames,
        removeExecutorSecret,
        removeSecret,
        renderSelectedGlobalSecretLines,
        secretNames,
        setExecutorSecret,
        setSecret,
      } = await import('./secrets.js');
      const [sub, ...f] = rest;
      const ws = opt(f, 'ws');
      const executor = f.includes('--executor');
      if (ws && executor) fail('--ws and --executor are mutually exclusive');
      switch (sub) {
        case 'set': {
          const name = f[0] && !f[0].startsWith('--') ? f[0] : fail('secret NAME required');
          const { readSecretInput } = await import('./secretInput.js');
          if (process.stdin.isTTY) {
            process.stderr.write(`paste the value for ${name} and press Enter (input hidden): `);
          }
          const value = await readSecretInput();
          if (process.stdin.isTTY) process.stderr.write('\n');
          if (executor) setExecutorSecret(name, value);
          else setSecret(name, value, ws);
          process.stdout.write(`secret ${name} stored (${executor ? 'executor-only' : ws ? `workstream ${ws}` : 'global'})\n`);
          break;
        }
        case 'list': {
          const names = executor ? executorSecretNames() : secretNames(ws);
          process.stdout.write(names.length ? names.map((n) => `${n}\n`).join('') : '(none)\n');
          break;
        }
        case 'rm': {
          const name = f[0] && !f[0].startsWith('--') ? f[0] : fail('secret NAME required');
          process.stdout.write(
            (executor ? removeExecutorSecret(name) : removeSecret(name, ws))
              ? `secret ${name} removed\n`
              : `no secret ${name}\n`,
          );
          break;
        }
        case 'render-selected': {
          if (ws || executor || f.some((value) => value.startsWith('--'))) {
            fail('render-selected accepts only global secret NAMES');
          }
          if (process.stdout.isTTY) {
            fail('render-selected emits secret VALUES — redirect it to a secure pipe, never a terminal');
          }
          try {
            const lines = renderSelectedGlobalSecretLines(f);
            process.stdout.write(lines.map((line) => `${line}\n`).join(''));
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
          }
          break;
        }
        default:
          fail('secret subcommand must be set|list|rm');
      }
      break;
    }

    case 'login': {
      const { runLogin } = await import('./login.js');
      await runLogin(rest);
      break;
    }

    case 'pilot-auth-check': {
      if (rest.length) fail('pilot-auth-check accepts no arguments');
      const { checkPilotAuthentication } = await import('./pilot.js');
      await checkPilotAuthentication();
      process.stdout.write('Pilot authentication verified\n');
      break;
    }

    case 'github-app-setup': {
      if (rest.length !== 1) fail('usage: weaver github-app-setup <organization>');
      const { startGitHubAppSetup } = await import('./githubAppSetup.js');
      const setup = await startGitHubAppSetup(rest[0]!, {
        onDiagnostic: (message) => process.stderr.write(`GitHub App setup: ${message}\n`),
      });
      process.stdout.write(
        `Open this local URL to confirm the organization App on GitHub:\n\n${setup.url}\n\n` +
        'Choose All repositories. IDs and the private key return directly to this process; do not copy them.\n' +
        'Waiting for GitHub installation confirmation…\n',
      );
      await setup.completion;
      process.stdout.write('GitHub App organization-wide installation verified and stored locally\n');
      break;
    }

    case 'github-auth-check': {
      if (rest.length) fail('github-auth-check accepts no arguments');
      const { checkGitHubAppAuthentication } = await import('./githubApp.js');
      await checkGitHubAppAuthentication();
      process.stdout.write('GitHub App authentication verified\n');
      break;
    }

    case 'github-clone': {
      if (rest.length !== 2) fail('usage: weaver github-clone <owner/repo> <absolute-path>');
      const { cloneGitHubRepository } = await import('./githubApp.js');
      await cloneGitHubRepository(rest[0]!, rest[1]!);
      process.stdout.write(`GitHub repository cloned to ${rest[1]}\n`);
      break;
    }

    case 'link': {
      const { runLink } = await import('./link.js');
      await runLink(rest);
      break;
    }

    case 'store': {
      const [subcommand, ...storeArgs] = rest;
      if (subcommand !== 'copy-to-postgres') {
        fail('usage: weaver store copy-to-postgres [<postgres-url>]');
      }
      if (storeArgs.length > 1) fail('copy-to-postgres accepts one destination URL');
      let destinationUrl = storeArgs[0]?.trim();
      if (!destinationUrl) {
        const { readSecretInput } = await import('./secretInput.js');
        if (process.stdin.isTTY) {
          process.stderr.write('paste the empty destination Postgres URL and press Enter (input hidden): ');
        }
        destinationUrl = (await readSecretInput()).trim();
        if (process.stdin.isTTY) process.stderr.write('\n');
      }
      if (!destinationUrl) fail('a destination Postgres URL is required');
      const { runFilesystemToPostgresCopy } = await import('./storeMigration.js');
      process.stderr.write('locking and validating the filesystem fleet before copy…\n');
      const copied = await runFilesystemToPostgresCopy(destinationUrl);
      process.stdout.write(
        `copied and verified ${copied.workstreams} workstreams, ${copied.artifacts} artifacts, ` +
        `policy revision ${copied.policyRevision}; source filesystem unchanged\n`,
      );
      break;
    }

    case 'run': {
      const { acquireRunnerLock, liveRunnerPid, runLoop } = await import('./runner.js');
      const { runnerExecutorCapabilities } = await import('./modelRouting.js');
      const interval = Number(opt(rest, 'interval') ?? '30') * 1000;
      const concurrency = Math.max(1, Number(opt(rest, 'concurrency') ?? '10'));
      const executorCapabilities = runnerExecutorCapabilities();
      const release = acquireRunnerLock();
      if (!release) fail(`a runner is already live (pid ${liveRunnerPid()}) — one runner per state dir`);
      process.stdout.write(
        `weaver run — ticking active workstreams every ${interval / 1000}s, ${concurrency} in parallel; ` +
        `executors=${[...executorCapabilities].join(',')} (Ctrl-C to stop)\n`,
      );
      // A bare kill used to take the process down mid-action — the orphaned
      // push then cost a human a manual provider reconciliation. First signal
      // drains in-flight ticks through runLoop's bounded window; a second
      // signal is the standard force-exit escape hatch.
      const stopper = new AbortController();
      let stopping = false;
      const requestStop = (sig: string) => {
        if (stopping) {
          process.stderr.write(`\n[run] second ${sig} — forcing exit\n`);
          process.exit(130);
        }
        stopping = true;
        process.stdout.write(`\n[run] ${sig} — draining in-flight ticks before exit (signal again to force)\n`);
        stopper.abort();
      };
      process.on('SIGINT', () => requestStop('SIGINT'));
      process.on('SIGTERM', () => requestStop('SIGTERM'));
      await runLoop({ intervalMs: interval, concurrency, executorCapabilities, signal: stopper.signal });
      // runLoop returning is the decision to stop, but it cannot END the
      // process: an in-flight worker's SDK child process is a live handle that
      // pins the event loop past any drain window, so a drained runner sat
      // stalled-with-heartbeat-frozen for 8+ minutes until a second signal.
      // Exit explicitly — the abandoned attempt is exactly what action/worker
      // crash recovery reconciles on the next runner's first tick.
      process.stdout.write('[run] loop stopped — exiting\n');
      process.exit(0);
    }
    case 'serve': {
      const token = process.env.WEAVER_SERVE_TOKEN;
      if (!token) fail('WEAVER_SERVE_TOKEN must be set — the ingress adapter refuses to serve the durable fleet unauthenticated');
      const host = opt(rest, 'host') ?? '127.0.0.1';
      const port = Number(opt(rest, 'port') ?? '9723');
      const { startServer } = await import('./serve.js');
      const running = await startServer({ token, host, port });
      process.stdout.write(
        `weaver serve — ingress for external bots on http://${host}:${running.port} (Ctrl-C to stop)\n` +
          `  POST /workstreams · GET /workstreams/:slug · POST /workstreams/:slug/observations\n`,
      );
      // The runner (weaver run) executes; this process only accepts ingress.
      await new Promise<never>(() => {});
      break;
    }

    case 'ui': {
      const host = opt(rest, 'host') ?? '127.0.0.1';
      const port = Number(opt(rest, 'port') ?? '9724');
      const token = process.env.WEAVER_UI_TOKEN;
      const {
        clerkOperatorAuthConfigFromEnv,
        createClerkOperatorAuthenticator,
      } = await import('./clerkOperatorAuth.js');
      const clerkConfig = clerkOperatorAuthConfigFromEnv();
      const clerk = clerkConfig ? createClerkOperatorAuthenticator(clerkConfig) : undefined;
      const { startOperatorUi } = await import('./operatorUi.js');
      const running = await startOperatorUi({ host, port, token, clerk });
      const access = clerk
        ? 'Clerk authentication with verified email-domain access'
        : token
        ? 'Basic auth (WEAVER_UI_TOKEN is the password; the username is recorded as the actor)'
        : 'loopback access';
      process.stdout.write(
        `weaver ui — operator workspace on http://${host}:${running.port} (Ctrl-C to stop)\n` +
          `  access: ${access}\n` +
          '  execution: start `weaver run` separately\n',
      );
      // This process serves the workspace; the separate runner executes work.
      // Hosted supervisors stop with SIGTERM. Close the listener before the
      // store pool so an accepted request is never cut off halfway through a
      // durable write; a second signal remains the force-exit escape hatch.
      let stopping = false;
      let finish!: () => void;
      let failClose!: (error: unknown) => void;
      const stopped = new Promise<void>((resolve, reject) => {
        finish = resolve;
        failClose = reject;
      });
      const requestStop = (sig: string) => {
        if (stopping) {
          process.stderr.write(`\n[ui] second ${sig} — forcing exit\n`);
          process.exit(130);
        }
        stopping = true;
        process.stdout.write(`\n[ui] ${sig} — closing the HTTP listener before exit\n`);
        void running.close().then(finish, failClose);
      };
      const onSigint = () => requestStop('SIGINT');
      const onSigterm = () => requestStop('SIGTERM');
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
      try {
        await stopped;
      } finally {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
      }
      break;
    }

    case 'resolve': {
      // Attention items are addressed TO the human; only the human closes
      // them. The note (if any) lands in the event tail for the next pass.
      const slug = rest[0] ?? fail('slug required');
      const attId = rest[1] ?? fail('attention id required');
      const note = rest.slice(2).join(' ');
      const { resolveAttention } = await import('./humanActs.js');
      await resolveAttention(slug, attId, note);
      process.stdout.write(`${attId} resolved\n`);
      break;
    }

    case 'tag': {
      const slug = rest[0] ?? fail('slug required');
      const verb = rest[1] ?? fail('add or remove required');
      const tag = rest[2] ?? fail('tag required');
      await arrive(slug, (d, event) => {
        if (verb === 'add' && !d.workstream.tags.includes(tag)) d.workstream.tags.push(tag);
        if (verb === 'remove') d.workstream.tags = d.workstream.tags.filter((t) => t !== tag);
        event('tags.changed', `config: ${(process.env.WEAVER_ACTOR ?? 'operator')} ${verb}ed tag '${tag}'`);
      });
      process.stdout.write(`tags now: ${(await load(slug)).workstream.tags.join(', ')}\n`);
      break;
    }

    case 'pause': {
      const { pauseAllWorkstreams, setPaused } = await import('./humanActs.js');
      const slug = rest[0];
      if (slug) {
        const result = await setPaused(slug, true);
        if (result.outcome === 'done') process.stdout.write(`${slug} is done; status unchanged\n`);
        else if (result.outcome === 'already-paused') process.stdout.write(`${slug} is already paused; status unchanged\n`);
        else process.stdout.write(`${slug} is now paused\n`);
        break;
      }

      const result = await pauseAllWorkstreams();
      process.stdout.write(
        `paused ${result.paused.length} active workstream(s)${result.paused.length ? `: ${result.paused.join(', ')}` : ''}\n` +
        `unchanged: ${result.alreadyPaused.length} already paused${result.alreadyPaused.length ? ` (${result.alreadyPaused.join(', ')})` : ''}; ` +
        `${result.done.length} done${result.done.length ? ` (${result.done.join(', ')})` : ''}\n`,
      );
      if (result.failures.length) {
        throw new Error(
          `failed to pause ${result.failures.length} workstream(s): ` +
          result.failures.map((failure) => `${failure.slug}: ${failure.error}`).join('; '),
        );
      }
      break;
    }

    case 'resume': {
      const slug = rest[0] ?? fail('slug required');
      const { setPaused } = await import('./humanActs.js');
      const result = await setPaused(slug, false);
      if (result.outcome === 'done') process.stdout.write(`${slug} is done; status unchanged\n`);
      else if (result.outcome === 'reopened') process.stdout.write(`${slug} is reopened and active\n`);
      else if (result.outcome === 'already-active') process.stdout.write(`${slug} is already active; status unchanged\n`);
      else process.stdout.write(`${slug} is now active\n`);
      break;
    }

    case 'watch': {
      if (rest.includes('--plain')) {
        const { runWatch } = await import('./watch.js');
        await runWatch();
      } else {
        const { runTui } = await import('./tui.js');
        await runTui();
        // A disposable SDK/command process may still be inside a non-abortable
        // call. The durable engine reconciles its typed state on the next run;
        // q must return terminal ownership immediately.
        process.exit(0);
      }
      break;
    }

    case 'inspect': {
      // Knowledge view, not ops (`watch` covers ops): decision lineage,
      // learned policies, intervention density, adoption state, action audit
      // — rendered from typed state into one self-contained HTML file.
      const { runInspect } = await import('./inspect.js');
      const out = await runInspect(rest[0]);
      process.stdout.write(`${out}\n`);
      if (process.platform === 'darwin') {
        const { spawn } = await import('node:child_process');
        spawn('open', [out], { detached: true, stdio: 'ignore' }).unref();
      }
      break;
    }

    case 'printout': {
      const { parsePrintoutArgs } = await import('./printoutControls.js');
      const parsed = parsePrintoutArgs(rest);
      if (parsed.text) {
        const { deliverPrintout, preparePrintout } = await import('./printout.js');
        await deliverPrintout(await preparePrintout(parsed.slug));
      } else {
        const { publishPrintoutHtml } = await import('./printoutHtml.js');
        const published = await publishPrintoutHtml(parsed.slug);
        process.stdout.write(`${published.path}\n`);
      }
      break;
    }

    case 'stats': {
      // Fleet outcome metrics from durable typed state (never the bounded
      // event tail): interventions per adopted work product, approvals, policies.
      const { runStats } = await import('./stats.js');
      const out = await runStats();
      process.stdout.write(`${out}\n`);
      if (process.platform === 'darwin') {
        const { spawn } = await import('node:child_process');
        spawn('open', [out], { detached: true, stdio: 'ignore' }).unref();
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
      const engineOnly = rest.includes('--engine-only');
      const executorCapabilities = engineOnly
        ? undefined
        : (await import('./modelRouting.js')).runnerExecutorCapabilities();
      const report = await tick(slug, {
        ...(maxPasses ? { maxPasses: Number(maxPasses) } : {}),
        ...(engineOnly ? { engineOnly: true } : {}),
        ...(executorCapabilities ? { executorCapabilities } : {}),
      });
      process.stdout.write(
        `tick done: ${report.cycles} cycle(s), ${report.sendsExecuted} send(s), ` +
          `${report.unknownsResolved} readback(s), workers=[${report.workersRun.join(', ')}], ` +
          `passes=${report.passes.length}\n`,
      );
      for (const p of report.passes) {
        process.stdout.write(`  pass ${p.passId} [${p.outcome}]${p.summary ? ` — ${p.summary}` : ''}\n`);
      }
      break;
    }

    default:
      process.stdout.write(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1);
  }
}

main()
  // A Postgres-backed store holds a connection pool; close it so a finished
  // command exits instead of hanging on open sockets. (Error paths exit(1)
  // below, which tears the pool down with the process.)
  .then(() => closeStore())
  .catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : e}\n`);
    process.exit(1);
  });
