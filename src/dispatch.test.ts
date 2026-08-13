/**
 * The mis-aliased-subcommand guard. The bug it fixes: `w` aliased to `weaver do`
 * turned `w steer <slug> "<msg>"` into the message "steer <slug> <msg>", which
 * onboarding silently minted as a brand-new duplicate workstream instead of
 * steering the existing one. These tests pin that a real management command is
 * redispatched, while an ordinary message that merely opens with a reserved verb
 * still onboards — no model call decides either way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeUnknownSubcommand, misroutedSubcommand } from './dispatch.js';

const EXISTING = new Set(['investigate-t-287-error', 'edp-sync-health']);
const slugExists = async (slug: string): Promise<boolean> => EXISTING.has(slug);

test('a slug-first command with a real slug is redispatched, not onboarded', async () => {
  // The exact footgun: `w steer investigate-t-287-error "don't reply"`.
  assert.deepEqual(
    await misroutedSubcommand(['steer', 'investigate-t-287-error', "don't", 'reply'], slugExists),
    ['steer', ['investigate-t-287-error', "don't", 'reply']],
  );
  assert.deepEqual(
    await misroutedSubcommand(['status', 'edp-sync-health'], slugExists),
    ['status', ['edp-sync-health']],
  );
});

test('a slug-first verb without a real slug is a message, so it onboards', async () => {
  // "steer the roadmap toward retention" is a real brief, not a steer command:
  // its second word is not a live workstream, so it must NOT be hijacked.
  assert.equal(await misroutedSubcommand(['steer', 'the', 'roadmap', 'toward', 'retention'], slugExists), null);
  assert.equal(await misroutedSubcommand(['status', 'of', 'the', 'launch'], slugExists), null);
  // A slug-first verb with nothing after it is also just a word.
  assert.equal(await misroutedSubcommand(['steer'], slugExists), null);
});

test('a no-arg dashboard command is redispatched only when it stands alone', async () => {
  assert.deepEqual(await misroutedSubcommand(['watch'], slugExists), ['watch', []]);
  assert.deepEqual(await misroutedSubcommand(['list'], slugExists), ['list', []]);
  // "list the competitors and draft outreach" is a message, not `weaver list`.
  assert.equal(await misroutedSubcommand(['list', 'the', 'competitors'], slugExists), null);
});

test('a first word that is not a subcommand always onboards', async () => {
  assert.equal(await misroutedSubcommand(['fix', 'the', 'upload', 'bug'], slugExists), null);
  assert.equal(await misroutedSubcommand([], slugExists), null);
});

test('a command-shaped word aimed at an existing slug is a typo, never a new workstream', async () => {
  const exists = async (s: string) => s === 'nobe-parc-feedback';
  // The shape of the real incident: `weaver priority <slug> high` onboarded
  // eleven workstreams named <slug>-2 because 'priority' was not a command yet.
  // 'priority' is one now, so the case is written with a verb that still isn't
  // — which is the point: the guard protects the NEXT unreleased verb too.
  assert.equal(await looksLikeUnknownSubcommand(['rank', 'nobe-parc-feedback', 'high'], exists), true);
  assert.equal(await looksLikeUnknownSubcommand(['deprioritise', 'nobe-parc-feedback'], exists), true);

  // A real command never reaches intake, so it is never the caller's problem.
  assert.equal(await looksLikeUnknownSubcommand(['steer', 'nobe-parc-feedback', 'go'], exists), false);
  // An unknown slug is genuinely a new thing to onboard.
  assert.equal(await looksLikeUnknownSubcommand(['rank', 'something-new', 'high'], exists), false);
  // Ordinary prose survives, including prose that opens with a real slug.
  assert.equal(await looksLikeUnknownSubcommand(['Fix', 'nobe-parc-feedback', 'copy'], exists), false);
  assert.equal(await looksLikeUnknownSubcommand(['investigate:', 'nobe-parc-feedback'], exists), false);
  assert.equal(await looksLikeUnknownSubcommand(['nobe-parc-feedback'], exists), false);
});
