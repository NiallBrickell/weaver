/**
 * CLI dispatch tables and the mis-aliased-subcommand guard.
 *
 * `w` has historically been aliased to `weaver do`, so `w steer <slug> "<msg>"`
 * reached the intake path as the message "steer <slug> <msg>" and silently
 * minted a NEW workstream instead of steering the existing one — a duplicate the
 * operator never asked for. These tables let the CLI recognize a management
 * command that arrived on the intake path and dispatch it to the real
 * subcommand, whatever `w` is aliased to. The guard is deliberately conservative
 * so an ordinary sentence that merely opens with a reserved verb still onboards.
 */

// Every real subcommand. A first word that is not one of these is a message to
// onboard, so bare `weaver` (alias `w`) stays a one-word capture while every
// subcommand dispatches natively. 'help'/'--help' are listed so they show usage
// instead of minting a workstream named "help".
export const KNOWN_COMMANDS = new Set([
  'do', 'ask', 'create', 'list', 'status', 'capacity', 'log', 'tail', 'show', 'steer', 'approve',
  'assign-action', 'constraint', 'approve-action', 'reject-action', 'reject-send', 'reply', 'observe',
  'adopt', 'budget', 'execution-safety', 'policies', 'backfill', 'secret', 'login', 'link', 'run', 'serve', 'resolve', 'tag', 'pause',
  'resume', 'watch', 'inspect', 'printout', 'stats', 'advance', 'tick', 'help', '--help', 'priority',
]);

// Subcommands whose first positional argument is a workstream slug. Used to tell
// a mis-aliased management command (`weaver do steer <slug> …`) apart from a real
// message that merely starts with the word "steer": only a REAL existing slug is
// a confident signal.
export const SLUG_FIRST_COMMANDS = new Set([
  'priority',
  'steer', 'status', 'tick', 'pause', 'resume', 'tail', 'log', 'show', 'approve', 'reply', 'observe',
  'adopt', 'budget', 'execution-safety', 'tag', 'resolve', 'reject-send', 'constraint', 'approve-action', 'reject-action',
]);

// Read-only, no-argument dashboards: `weaver do watch` almost certainly means
// `weaver watch`, never a workstream about the word "watch". Only redispatched
// when they stand alone, so "list the competitors and …" still onboards.
export const DASHBOARD_COMMANDS = new Set(['watch', 'list', 'stats', 'inspect', 'printout', 'link']);

/**
 * A management command that reached the intake path because `w` was (or still
 * is) aliased to `weaver do`. Returns [command, remainingArgs] to redispatch, or
 * null to let the tokens onboard as an ordinary message. `slugExists` is
 * injected so this stays a pure function over the dispatch tables — the caller
 * wires it to the store.
 */
/**
 * A mistyped or unreleased subcommand aimed at a workstream that EXISTS.
 *
 * Intake is deliberately the default — a first word that isn't a subcommand is
 * a message to onboard — but that default has a sharp edge: a management verb
 * the CLI doesn't know yet reads as a sentence, and `weaver priority <slug>
 * high` quietly became eleven new workstreams named `<slug>-2` instead of an
 * error. Nothing about that is recoverable by the person typing it; they think
 * they ranked a stream and instead they forked the fleet.
 *
 * The signal is narrow on purpose: one bare command-shaped word (no spaces, no
 * punctuation a sentence would carry) followed by the slug of a workstream that
 * already exists. A real message almost never opens that way, and when it does
 * the operator can say so — an error costs one retry, while a wrong workstream
 * costs a cleanup nobody notices they need.
 */
export async function looksLikeUnknownSubcommand(
  tokens: string[],
  slugExists: (slug: string) => Promise<boolean>,
): Promise<boolean> {
  const [first, second] = tokens;
  if (!first || !second) return false;
  if (KNOWN_COMMANDS.has(first)) return false; // a real command never reaches intake
  if (!/^[a-z][a-z0-9-]*$/.test(first)) return false; // command-shaped, not prose
  return slugExists(second);
}

export async function misroutedSubcommand(
  tokens: string[],
  slugExists: (slug: string) => Promise<boolean>,
): Promise<[string, string[]] | null> {
  const [c, ...rest] = tokens;
  if (!c || !KNOWN_COMMANDS.has(c)) return null;
  if (SLUG_FIRST_COMMANDS.has(c)) return rest[0] && (await slugExists(rest[0])) ? [c, rest] : null;
  if (DASHBOARD_COMMANDS.has(c) && rest.length === 0) return [c, rest];
  return null;
}
