/**
 * The shadow coordinator seat: measurement, never authority.
 *
 * A sampled completed pass is replayed once, afterwards, by a cheaper seat
 * against the SAME system prompt, the SAME rendered projection text, and the
 * SAME tool schemas. Every tool handler is a capture handler built here: it
 * validates what can be validated purely against the pass's snapshot, records
 * `{tool, targets}`, and answers with a plausible success so the loop runs its
 * course. The real handlers are never referenced — a capture tool copies only
 * a definition's name, description, schema, and annotations.
 *
 * The no-write guarantee is structural. This module imports no store, engine,
 * coordinator, ingress, policy, or managed-workstream code (a test pins the
 * import list), so it holds no function that could reach `mutate()`,
 * `arrive()`, a wake, a dispatch, or an egress. Its only side-effect surfaces
 * are the injected executor (the coordinator's own isolated executor
 * construction, with the tool set swapped) and a `ShadowReadPort` of
 * read-only functions over the pass's snapshot. Recording the result on the
 * PassRecord is the caller's separate harness write.
 */

import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BridgeToolDefinition } from './executor/toolBridge.js';
import type { CoordinatorExecutor } from './executor/coordinator.js';
import type { CapacityTarget } from './modelConfig.js';
import { armWall } from './wall.js';
import type {
  ShadowAgreement,
  ShadowMove,
  ShadowPassClass,
  ShadowPassRecord,
  WorkstreamDoc,
} from './types.js';

/** Read-only views a shadow seat may use, served from the pass's snapshot.
 * Nothing here can write: the port is the whole of the shadow's reach. */
export interface ShadowReadPort {
  readDeliverable(deliverableId: string): Promise<CallToolResult>;
  readProbeArtifact(artifactPath: string): Promise<CallToolResult>;
  readPolicy(policyId: string): CallToolResult;
  listCancellableWakes(afterWakeId?: string): CallToolResult;
  inspectWorkstream(slug: string): Promise<CallToolResult>;
}

/** Tools that change nothing; both seats' calls to them are not moves. */
export const SHADOW_READ_TOOLS: ReadonlySet<string> = new Set([
  'read_artifact',
  'read_policy',
  'list_cancellable_wakes',
  'inspect_workstream',
]);

const MAX_MOVES = 80;
const MAX_TARGETS = 10;
const SHADOW_WALL_MS = 15 * 60_000;

/** Which argument keys name existing ids, per write tool. A tool missing here
 * (one added later) falls back to every `*_id`/`*_ids` argument. record_decision
 * names only what it supersedes, so supersession is readable from its targets. */
const TARGET_KEYS: Record<string, readonly string[]> = {
  record_decision: ['supersedes_decision_id'],
  close_decision: ['decision_id'],
  record_progress: ['course_id'],
  create_assignment: ['depends_on'],
  cancel_assignment: ['assignment_id'],
  adopt_submission: ['assignment_id'],
  reject_submission: ['assignment_id'],
  request_send: ['deliverable_id'],
  evaluate_reply: ['interaction_id', 'reply_id'],
  evaluate_observation: ['observation_id'],
  raise_attention: ['ref_id'],
  withdraw_attention: ['attention_id'],
  resolve_attention: ['attention_id'],
  conclude_workstream: ['evidence_ids'],
  propose_policy: ['steering_id'],
  record_policy_outcome: ['policy_id', 'applying_decision_id'],
  supersede_policy: ['old_policy_id'],
  revise_policy_mechanism: ['policy_id'],
  cancel_wake: ['wake_id'],
  schedule_wake: ['course_id'],
  schedule_probe: ['course_id'],
  create_workstream: ['slug'],
  direct_workstream: ['slug'],
  report_repair_evidence: ['target_slug', 'source_entity_id'],
};

/** The typed move a successful tool call represents, or null for reads and
 * finish_pass. Shared by the real pass's recorder and the capture handlers so
 * both seats are described in exactly the same terms. */
export function moveOf(tool: string, args: unknown): ShadowMove | null {
  if (tool === 'finish_pass' || SHADOW_READ_TOOLS.has(tool)) return null;
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const keys = TARGET_KEYS[tool] ?? Object.keys(record).filter((key) => /_ids?$/.test(key));
  const targets: string[] = [];
  for (const key of keys) {
    const value = record[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item && !targets.includes(item)) targets.push(item.slice(0, 120));
    }
  }
  return { tool, targets: targets.slice(0, MAX_TARGETS) };
}

export function pushMove(sink: ShadowMove[], move: ShadowMove | null): void {
  if (move && sink.length < MAX_MOVES) sink.push(move);
}

function count(moves: readonly ShadowMove[], tool: string): number {
  return moves.filter((move) => move.tool === tool).length;
}

/** The real pass's class, from its typed moves. */
export function passClassOf(real: readonly ShadowMove[]): ShadowPassClass {
  if (count(real, 'conclude_workstream') > 0) return 'conclude';
  const verified = count(real, 'adopt_submission') + count(real, 'reject_submission');
  const dispatched = count(real, 'create_assignment');
  if (verified > 0 && dispatched > 0) return 'verify-then-dispatch';
  if (dispatched > 0) return 'dispatch-only';
  const waiting = new Set(['schedule_wake', 'schedule_probe', 'record_progress']);
  if (real.every((move) => waiting.has(move.tool))) return 'wait-only';
  return 'other';
}

function verdicts(moves: readonly ShadowMove[]): { adopt: string[]; reject: string[] } {
  const pick = (tool: string) =>
    [...new Set(moves.filter((m) => m.tool === tool).flatMap((m) => m.targets.slice(0, 1)))].sort();
  return { adopt: pick('adopt_submission'), reject: pick('reject_submission') };
}

function superseded(moves: readonly ShadowMove[]): string[] {
  return [...new Set(moves
    .filter((m) => (m.tool === 'record_decision' || m.tool === 'supersede_policy') && m.targets.length)
    .map((m) => m.targets[0]!))].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Agreement of the shadow seat's moves with the real pass's, per move type.
 * Adopt/reject and conclude/raise_attention are the headline numbers. */
export function computeAgreement(real: readonly ShadowMove[], shadow: readonly ShadowMove[]): ShadowAgreement {
  const realVerdicts = verdicts(real);
  const shadowVerdicts = verdicts(shadow);
  const adoptReject = {
    agree: sameList(realVerdicts.adopt, shadowVerdicts.adopt) && sameList(realVerdicts.reject, shadowVerdicts.reject),
    real: realVerdicts,
    shadow: shadowVerdicts,
  };
  const dispatch = { real: count(real, 'create_assignment'), shadow: count(shadow, 'create_assignment') };
  const conclude = { real: count(real, 'conclude_workstream') > 0, shadow: count(shadow, 'conclude_workstream') > 0 };
  const raise = { real: count(real, 'raise_attention'), shadow: count(shadow, 'raise_attention') };
  const supersede = { real: superseded(real), shadow: superseded(shadow) };
  const tools = (moves: readonly ShadowMove[]) => moves.map((m) => m.tool).sort();
  const agreement: ShadowAgreement = {
    adoptReject,
    dispatch: { agree: dispatch.real === dispatch.shadow, ...dispatch },
    conclude: { agree: conclude.real === conclude.shadow, ...conclude },
    raiseAttention: { agree: (raise.real > 0) === (raise.shadow > 0), ...raise },
    supersede: { agree: sameList(supersede.real, supersede.shadow), ...supersede },
    toolMultiset: sameList(tools(real), tools(shadow)),
    headline: false,
  };
  agreement.headline = agreement.adoptReject.agree && agreement.conclude.agree && agreement.raiseAttention.agree;
  return agreement;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const refuse = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function fakeId(prefix: string): string {
  // Same shape as the store's ids, so a plausible result gives the seat no tell.
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Pure validation over the snapshot plus what this shadow run itself did, so
 * the loop sees the refusals the real tools would give and cannot, say,
 * conclude over an assignment it never settled. Never reaches any store. */
class ShadowLedger {
  private readonly settled = new Set<string>();
  private readonly created = new Set<string>();
  private readonly resolved = new Set<string>();
  private readonly raised = new Set<string>();
  private readonly retiredDecisions = new Set<string>();

  constructor(private readonly doc: WorkstreamDoc) {}

  private str(args: Record<string, unknown>, key: string): string {
    return typeof args[key] === 'string' ? (args[key] as string) : '';
  }

  private standingDecision(id: string): string | undefined {
    const decision = this.doc.decisions.find((d) => d.id === id);
    if (!decision) return `no decision ${id}`;
    if (decision.status !== 'standing' || this.retiredDecisions.has(id)) return `${id} is not standing`;
    return undefined;
  }

  /** The refusal the real tool would give, or a plausible success. */
  apply(tool: string, args: Record<string, unknown>): CallToolResult {
    const doc = this.doc;
    switch (tool) {
      case 'adopt_submission':
      case 'reject_submission': {
        const id = this.str(args, 'assignment_id');
        const asg = doc.assignments.find((a) => a.id === id);
        if (!asg) return refuse(`no assignment ${id}`);
        if (asg.state !== 'awaiting_review' || !asg.submission || this.settled.has(id)) {
          return refuse(`${id} has no submission awaiting review`);
        }
        if (tool === 'adopt_submission') {
          if (asg.submission.completeness === 'checkpoint') return refuse(`${id} is an incomplete hard-wall checkpoint — it cannot be adopted`);
          if (asg.kind === 'action' && !asg.exec?.verified?.ok) return refuse(`${id} is an action whose readback has not confirmed the effect — it cannot be adopted`);
        }
        this.settled.add(id);
        return ok(tool === 'adopt_submission' ? `adopted ${id}` : `rejected ${id}: ${this.str(args, 'reason')}`);
      }
      case 'cancel_assignment': {
        const id = this.str(args, 'assignment_id');
        const asg = doc.assignments.find((a) => a.id === id);
        if (!asg && !this.created.has(id)) return refuse(`no assignment ${id}`);
        if (asg?.state === 'completed' || this.settled.has(id)) return refuse('cannot cancel a completed assignment');
        this.settled.add(id);
        return ok(`cancelled ${id}`);
      }
      case 'create_assignment': {
        for (const dep of Array.isArray(args.depends_on) ? args.depends_on : []) {
          if (typeof dep !== 'string' || (!doc.assignments.some((a) => a.id === dep) && !this.created.has(dep))) {
            return refuse(`unknown dependency ${String(dep)}`);
          }
        }
        if (args.kind === 'action' && (!this.str(args, 'exec_cwd') || !this.str(args, 'exec_verify'))) {
          return refuse('kind "action" requires exec_cwd and exec_verify');
        }
        if (args.kind === 'action' && !this.str(args, 'approval_ask').trim()) {
          return refuse('kind "action" requires approval_ask — the plain-language card the human decides from');
        }
        const id = fakeId('asg');
        this.created.add(id);
        return ok(`created assignment ${id}`);
      }
      case 'record_decision': {
        const supersedes = this.str(args, 'supersedes_decision_id');
        if (supersedes) {
          const refusal = this.standingDecision(supersedes);
          if (refusal) return refuse(refusal);
          this.retiredDecisions.add(supersedes);
        }
        const id = fakeId('dec');
        return ok(`recorded decision ${id} "${this.str(args, 'title')}"`);
      }
      case 'close_decision': {
        const id = this.str(args, 'decision_id');
        const refusal = this.standingDecision(id);
        if (refusal) return refuse(refusal);
        this.retiredDecisions.add(id);
        return ok(`closed decision ${id}`);
      }
      case 'record_progress': {
        const id = this.str(args, 'course_id');
        const refusal = this.standingDecision(id);
        if (refusal) return refuse(refusal);
        return ok(`recorded progress on ${id}: cycle ${String(args.cycle)} · step ${String(args.step)} "${this.str(args, 'label')}" (no decision created)`);
      }
      case 'raise_attention': {
        const id = fakeId('att');
        this.raised.add(id);
        return ok(`raised ${id}`);
      }
      case 'withdraw_attention':
      case 'resolve_attention': {
        const id = this.str(args, 'attention_id');
        const att = doc.attention.find((a) => a.id === id);
        if (!att || att.status !== 'open' || this.resolved.has(id)) return refuse(`no open attention ${id}`);
        this.resolved.add(id);
        return ok(`${tool === 'withdraw_attention' ? 'withdrew' : 'resolved'} ${id}`);
      }
      case 'conclude_workstream': {
        const live = [
          ...doc.assignments.filter((a) => !TERMINAL.has(a.state) && !this.settled.has(a.id)).map((a) => a.id),
          ...[...this.created].filter((id) => !this.settled.has(id)),
        ];
        if (live.length) return refuse(`cannot conclude: ${live.join(', ')} still live — resolve them first`);
        const open = [
          ...doc.attention.filter((a) => a.status === 'open' && !this.resolved.has(a.id)).map((a) => a.id),
          ...this.raised,
        ];
        if (open.length) return refuse(`cannot conclude: open attention ${open.join(', ')}`);
        return ok('workstream concluded');
      }
      case 'evaluate_reply': {
        const interaction = doc.interactions.find((i) => i.id === this.str(args, 'interaction_id'));
        if (!interaction?.replies.some((r) => r.id === this.str(args, 'reply_id'))) {
          return refuse(`no reply ${this.str(args, 'reply_id')} on ${this.str(args, 'interaction_id')}`);
        }
        return ok(`evaluated ${this.str(args, 'reply_id')}`);
      }
      case 'evaluate_observation': {
        const id = this.str(args, 'observation_id');
        if (!doc.observations.some((o) => o.id === id)) return refuse(`no observation ${id}`);
        return ok(`evaluated ${id}`);
      }
      case 'request_send': {
        const id = this.str(args, 'deliverable_id');
        if (!doc.deliverables.some((d) => d.id === id)) return refuse(`no deliverable ${id}`);
        return ok(`send ${fakeId('int')} awaiting human approval`);
      }
      case 'cancel_wake': {
        const id = this.str(args, 'wake_id');
        if (!doc.wakes.some((w) => w.id === id && w.status === 'pending')) return refuse(`no pending wake ${id}`);
        return ok(`cancelled ${id}`);
      }
      case 'schedule_wake':
        return ok(`scheduled ${fakeId('wake')} in ${this.str(args, 'after')}`);
      case 'schedule_probe':
        return ok(`scheduled probe ${fakeId('wake')} every ${this.str(args, 'every')}; it stays INERT until Pilot or the human approves it`);
      case 'propose_policy':
        return ok(`proposed policy ${fakeId('pol')} (shadow)`);
      case 'create_workstream':
        return ok(`created managed workstream '${this.str(args, 'slug')}' — it will run independently`);
      case 'direct_workstream':
        return ok(`direction ${fakeId('dir')} delivered to '${this.str(args, 'slug')}'`);
      default:
        return ok(`${tool} recorded`);
    }
  }
}

/** A tool's schema without its handler: the only shape of a real coordinator
 * tool that ever crosses into this module, so no real handler is reachable
 * from shadow code at all — not merely never called. */
export type ToolSchema = Omit<BridgeToolDefinition, 'handler'>;

export interface CaptureContext {
  snapshot: WorkstreamDoc;
  reads: ShadowReadPort;
  moves: ShadowMove[];
}

/**
 * Capture-only twins of the coordinator's tools. Each twin copies the
 * definition's name, description, schema, and annotations — never its
 * handler — so a shadow call cannot run any real handler code. Reads go to the
 * read-only port; writes are validated, recorded, and answered plausibly.
 */
export function buildCaptureTools(
  definitions: readonly ToolSchema[],
  context: CaptureContext,
): BridgeToolDefinition[] {
  const ledger = new ShadowLedger(context.snapshot);
  const readString = (args: unknown, key: string): string | undefined => {
    const value = (args as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'string' ? value : undefined;
  };
  const capture = (name: string) => async (args: unknown): Promise<CallToolResult> => {
    try {
      switch (name) {
        case 'read_artifact': {
          const deliverableId = readString(args, 'deliverable_id');
          const artifactPath = readString(args, 'artifact_path');
          if ((deliverableId === undefined) === (artifactPath === undefined)) {
            return refuse('pass exactly one of deliverable_id or artifact_path');
          }
          return artifactPath !== undefined
            ? await context.reads.readProbeArtifact(artifactPath)
            : await context.reads.readDeliverable(deliverableId!);
        }
        case 'read_policy':
          return context.reads.readPolicy(readString(args, 'policy_id') ?? '');
        case 'list_cancellable_wakes':
          return context.reads.listCancellableWakes(readString(args, 'after_wake_id'));
        case 'inspect_workstream':
          return await context.reads.inspectWorkstream(readString(args, 'slug') ?? '');
        case 'finish_pass':
          return ok('pass finished');
      }
      const result = ledger.apply(name, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>);
      if (!result.isError) pushMove(context.moves, moveOf(name, args));
      return result;
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
  };
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    handler: capture(definition.name),
  }));
}

export interface ShadowRunInput {
  seat: CapacityTarget;
  /** The coordinator's own executor for the seat — isolation unchanged. */
  executor: CoordinatorExecutor;
  prompt: string;
  systemPrompt: string;
  /** Schema source only: the caller strips every handler before handing
   * these over. */
  tools: readonly ToolSchema[];
  snapshot: WorkstreamDoc;
  reads: ShadowReadPort;
  env: Record<string, string | undefined>;
  realMoves: readonly ShadowMove[];
  now?: () => Date;
  wallMs?: number;
}

export function seatLabel(seat: CapacityTarget): string {
  return `${seat.executor}:${seat.model}`;
}

/** Run the shadow seat once. Never throws and never retries: a failure is
 * returned as the record's error, for the caller to store and move on. */
export async function runShadowCoordinator(input: ShadowRunInput): Promise<ShadowPassRecord> {
  const moves: ShadowMove[] = [];
  const realMoves = input.realMoves.slice(0, MAX_MOVES);
  const base = {
    seat: seatLabel(input.seat),
    at: (input.now ?? (() => new Date()))().toISOString(),
    passClass: passClassOf(realMoves),
    realMoves,
  };
  let costUsd: number | undefined;
  let error: string | undefined;
  const abort = new AbortController();
  const wall = armWall(abort, input.wallMs ?? SHADOW_WALL_MS, 'shadow coordinator');
  try {
    if (input.executor.id !== input.seat.executor) {
      throw new Error(`shadow executor '${input.executor.id}' does not match seat '${input.seat.executor}'`);
    }
    const tools = buildCaptureTools(input.tools, { snapshot: input.snapshot, reads: input.reads, moves });
    const outcome = await input.executor.execute({
      prompt: input.prompt,
      model: input.seat.model,
      systemPrompt: input.systemPrompt,
      tools,
      env: input.env,
      abort,
    });
    costUsd = outcome.costUsd;
    if (outcome.error) error = outcome.error;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    wall.disarm();
  }
  if (wall.fired() && !error) error = 'shadow coordinator hit its wall';
  return {
    ...base,
    moves,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(error ? { error: error.slice(0, 500) } : { agreement: computeAgreement(realMoves, moves) }),
  };
}
