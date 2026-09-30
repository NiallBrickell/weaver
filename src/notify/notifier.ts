/**
 * Push one notification per registered device when a new open need appears.
 *
 * Runs inside `weaver ui` (always on). It reads open needs from the SAME
 * `WorkstreamIndex` the REST API serves `/api/v1/needs` from, so it costs one
 * narrow head read per refresh and a body load only for a workstream whose
 * revision changed — never a `load()` per workstream per tick (a hosted
 * store bills every body; see AGENTS.md, "Never loop load() over the fleet").
 *
 * Exactly-once per need version is carried by the store, not this process:
 * a `need_notifications` row is claimed with an atomic insert-if-absent
 * BEFORE anything is sent, so two UI processes racing one need send it once,
 * and a restart never sends it again. Delivery is therefore at-most-once: a
 * crash between the claim and the push loses that push rather than risking a
 * second one, and the card itself stays open in the app and the browser.
 *
 * The first time the feature ever runs against a store it records every
 * already-open need as seen-but-not-sent, so enabling it does not push the
 * backlog. A marker row records that seeding completed.
 */

import type { IndexedWorkstream } from '../restApi.js';
import {
  claimNeedNotification,
  completeNeedNotification,
  deleteDevice,
  findNeedNotifications,
  listDevices,
  type Device,
  type NeedNotification,
  type NeedNotificationOutcome,
} from '../store.js';
import { ApnsSender, apnsConfigFromEnv, collapseId, redactApns, type ApnsResult, type ApnsTransport } from './apns.js';
import { needKey, needPayload, type NeedPushPayload } from './payload.js';

export const NOTIFY_INTERVAL_MS = 30_000;
/** The claim key that records "open needs at first start were seeded". */
export const SEEDED_MARKER_KEY = 'weaver|notifier|seeded|v1';
export const PREEXISTING_REASON = 'preexisting at notifier start';
const MAX_ERROR = 300;

export interface PushSender {
  send(device: Pick<Device, 'token' | 'environment'>, payload: NeedPushPayload, collapse: string): Promise<ApnsResult>;
  close?(): void;
}

export interface NotifierStore {
  listDevices(): Promise<Device[]>;
  deleteDevice(id: string): Promise<boolean>;
  findNeedNotifications(keys: readonly string[]): Promise<NeedNotification[]>;
  claimNeedNotification(claim: NeedNotification): Promise<boolean>;
  completeNeedNotification(key: string, outcome: NeedNotificationOutcome): Promise<void>;
}

const defaultStore: NotifierStore = {
  listDevices,
  deleteDevice,
  findNeedNotifications,
  claimNeedNotification,
  completeNeedNotification,
};

export interface NeedNotifierOptions {
  index: { rows(): Promise<IndexedWorkstream[]> };
  sender: PushSender;
  store?: NotifierStore;
  intervalMs?: number;
  now?: () => Date;
  /** One redacted line per call. */
  log?: (line: string) => void;
  /** Applied to every log line before it is written. */
  redact?: (line: string) => string;
}

export interface NotifierTickResult {
  seeded: number;
  claimed: number;
  sent: number;
  failed: number;
  removedDevices: number;
}

function emptyResult(): NotifierTickResult {
  return { seeded: 0, claimed: 0, sent: 0, failed: 0, removedDevices: 0 };
}

export class NeedNotifier {
  private readonly index: NeedNotifierOptions['index'];
  private readonly sender: PushSender;
  private readonly store: NotifierStore;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly writeLog: (line: string) => void;
  private readonly redact: (line: string) => string;
  /** Keys known to have a row, bounded to the needs currently open. */
  private known = new Set<string>();
  private seeded = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<NotifierTickResult> | undefined;
  private again = false;
  private stopped = true;

  constructor(opts: NeedNotifierOptions) {
    this.index = opts.index;
    this.sender = opts.sender;
    this.store = opts.store ?? defaultStore;
    this.intervalMs = opts.intervalMs ?? NOTIFY_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    this.writeLog = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.redact = opts.redact ?? ((line) => line);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.sender.close?.();
  }

  /** Run a tick now (the fleet revision changed). Never overlaps a running
   * tick: a kick during one runs exactly one more right after it. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.tick().finally(() => this.schedule());
  }

  /** One pass. Resolves with what happened; never rejects. */
  tick(): Promise<NotifierTickResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass()
      .catch((error: unknown) => {
        this.log(`[notify] tick failed: ${error instanceof Error ? error.message : String(error)}`);
        return emptyResult();
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      this.kick();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, this.intervalMs);
    this.timer.unref();
  }

  private log(line: string): void {
    try {
      this.writeLog(this.redact(line));
    } catch {
      // Logging must never take the UI process down.
    }
  }

  private async pass(): Promise<NotifierTickResult> {
    const result = emptyResult();
    const rows = await this.index.rows();
    const open = rows.flatMap((row) => row.needs.map((need) => ({ key: needKey(need), need, title: row.summary.title })));
    const openKeys = new Set(open.map((entry) => entry.key));
    this.known = new Set([...this.known].filter((key) => openKeys.has(key)));

    if (!this.seeded) {
      const marker = await this.store.findNeedNotifications([SEEDED_MARKER_KEY]);
      if (!marker.length) {
        // First run against this store: everything already open was open
        // before notifications existed. Record it unsent, then the marker —
        // a crash in between just seeds again (claims are idempotent), and
        // nothing is ever sent from this branch.
        for (const entry of open) {
          if (await this.store.claimNeedNotification(this.claimRow(entry.key, PREEXISTING_REASON))) result.seeded += 1;
          this.known.add(entry.key);
        }
        await this.store.claimNeedNotification(this.claimRow(SEEDED_MARKER_KEY, 'seeding complete'));
        this.seeded = true;
        if (result.seeded) this.log(`[notify] recorded ${result.seeded} already-open need(s) without sending`);
        return result;
      }
      this.seeded = true;
    }

    const unknown = open.filter((entry) => !this.known.has(entry.key));
    if (!unknown.length) return result;
    const existing = new Set((await this.store.findNeedNotifications(unknown.map((entry) => entry.key))).map((row) => row.key));
    let devices: Device[] | undefined;
    for (const entry of unknown) {
      if (existing.has(entry.key)) {
        this.known.add(entry.key);
        continue;
      }
      if (!(await this.store.claimNeedNotification(this.claimRow(entry.key)))) {
        // Another UI process claimed it first; it sends.
        this.known.add(entry.key);
        continue;
      }
      this.known.add(entry.key);
      result.claimed += 1;
      devices ??= await this.store.listDevices();
      const outcome = await this.deliver(entry.key, needPayload(entry.title, entry.need), devices, result);
      await this.store.completeNeedNotification(entry.key, outcome);
    }
    return result;
  }

  private claimRow(key: string, lastError?: string): NeedNotification {
    return {
      key,
      createdAt: this.now().toISOString(),
      sentCount: 0,
      failedCount: 0,
      ...(lastError ? { lastError } : {}),
    };
  }

  /** Send to every device; returns the outcome to record on the claim row.
   * Removes (from `devices` too) every device Apple says is gone. */
  private async deliver(key: string, payload: NeedPushPayload, devices: Device[], result: NotifierTickResult): Promise<NeedNotificationOutcome> {
    let sentCount = 0;
    let failedCount = 0;
    let lastError: string | undefined;
    const collapse = collapseId(key);
    for (const device of [...devices]) {
      let outcome: ApnsResult;
      try {
        outcome = await this.sender.send(device, payload, collapse);
      } catch (error) {
        outcome = { ok: false, status: 0, reason: error instanceof Error ? error.message : String(error), unregistered: false };
      }
      if (outcome.ok) {
        sentCount += 1;
        continue;
      }
      if (outcome.unregistered) {
        try {
          await this.store.deleteDevice(device.id);
          const at = devices.indexOf(device);
          if (at >= 0) devices.splice(at, 1);
          result.removedDevices += 1;
          this.log(`[notify] removed device ${device.id}: APNs ${outcome.status} ${outcome.reason}`);
        } catch (error) {
          this.log(`[notify] could not remove device ${device.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      failedCount += 1;
      lastError = this.redact(`device ${device.id}: APNs ${outcome.status || 'transport'} ${outcome.reason}`).slice(0, MAX_ERROR);
      this.log(`[notify] push failed for ${key}: ${lastError}`);
    }
    result.sent += sentCount;
    result.failed += failedCount;
    return { sentCount, failedCount, ...(lastError ? { lastError } : {}) };
  }
}

/**
 * The notifier `weaver ui` runs, or null when APNs is not configured — in
 * which case the one line saying why is logged here, once, at startup.
 */
export function needNotifierFromEnv(
  index: NeedNotifierOptions['index'],
  opts: { env?: NodeJS.ProcessEnv; log?: (line: string) => void; transport?: ApnsTransport; store?: NotifierStore } = {},
): NeedNotifier | null {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const settings = apnsConfigFromEnv(opts.env);
  if (!settings.enabled) {
    log(`[notify] push notifications disabled: ${settings.reason}`);
    return null;
  }
  const { config } = settings;
  log(`[notify] push notifications enabled for ${config.topic} (key ${config.keyId})`);
  return new NeedNotifier({
    index,
    sender: new ApnsSender({ config, ...(opts.transport ? { transport: opts.transport } : {}) }),
    ...(opts.store ? { store: opts.store } : {}),
    log,
    redact: (line) => redactApns(line, config),
  });
}
