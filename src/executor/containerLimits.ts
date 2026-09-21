/**
 * The memory ceiling every worker container runs under — the OpenHands agent
 * server and the containerized Claude worker alike — resolved in one place so
 * the two `docker run` sites cannot drift.
 *
 * Why this exists: on 2026-09-18 three unbounded worker containers started
 * within two minutes on the hosted runner (an 8 GB e2-standard-2 with no swap)
 * and took host RAM from 3.5 GB to full in about ten minutes. Nothing was
 * OOM-killed; the kernel thrashed the page cache instead (disk reads rose a
 * hundredfold), the frozen VM missed its DHCP renewal, systemd-networkd marked
 * the NIC failed, and the fleet was offline for 3.4 days. A ceiling per
 * container turns one runaway build into an OOM kill inside that container's
 * own cgroup — a failed attempt Weaver already knows how to record — instead
 * of a host that stops answering.
 *
 * `--memory-swap` is set to the same value as `--memory`, which Docker reads as
 * "no swap on top of the limit": a container allowed to spill into host swap
 * reproduces exactly the thrash the ceiling is there to prevent.
 */

export const WORKER_MEMORY_LIMIT_ENV = 'WEAVER_WORKER_MEMORY_LIMIT';

/** Half the default 8 GB hosted VM, so a single runaway leaves the host the
 * other half. It bounds one container, not their sum: how many run at once is
 * the runner's concurrency budget, not this ceiling's. */
export const DEFAULT_WORKER_MEMORY_LIMIT = '4g';

/** Values an operator writes to run worker containers without a ceiling. */
const OPT_OUT = new Set(['0', 'none', 'off']);

/** A whole number with an optional single binary unit — the subset of
 * Docker's size syntax that means one thing to every reader of the env file. */
const DOCKER_SIZE = /^(\d+)([bkmg]?)$/;

const UNIT_BYTES: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** Below this a worker container cannot run the agent server or a toolchain,
 * so a smaller value is a missing unit (`4096` read as bytes), not a choice. */
const MINIMUM_BYTES = 512 * 1024 ** 2;

/**
 * The `docker run` flags that cap one worker container's memory, from the
 * operator's `WEAVER_WORKER_MEMORY_LIMIT` value: unset or empty → the 4g
 * default; `0` / `none` / `off` → no flags (an explicit operator opt-out);
 * anything else must be a Docker size (`4g`, `3072m`) of at least 512m, or
 * this throws — a typo must fail the launch loudly, never reach `docker run`
 * as an argument it might read differently or silently drop the ceiling.
 */
export function workerMemoryLimitArgs(configured: string | undefined): string[] {
  const raw = configured?.trim().toLowerCase() ?? '';
  if (OPT_OUT.has(raw)) return [];
  const limit = raw === '' ? DEFAULT_WORKER_MEMORY_LIMIT : raw;
  const match = DOCKER_SIZE.exec(limit);
  if (!match) {
    throw new Error(
      `${WORKER_MEMORY_LIMIT_ENV}=${JSON.stringify(configured)} is not a Docker memory size: ` +
        'use a whole number with an optional b, k, m or g unit (e.g. 4g, 3072m), or 0/none/off for no limit',
    );
  }
  const bytes = Number(match[1]) * UNIT_BYTES[match[2]!]!;
  if (!Number.isSafeInteger(bytes) || bytes < MINIMUM_BYTES) {
    throw new Error(
      `${WORKER_MEMORY_LIMIT_ENV}=${JSON.stringify(configured)} is outside the usable range: ` +
        'a worker container needs at least 512m (a bare number is read as bytes — write the unit, e.g. 4g)',
    );
  }
  return ['--memory', limit, '--memory-swap', limit];
}
