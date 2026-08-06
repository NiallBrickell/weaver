/** Pure printout command routing, kept deterministic and terminal-free. */

/** Uppercase P opens; lowercase p remains the dashboard pause command. */
export function requestedPrintoutScope(input: string, selectedSlug: string | undefined): { requested: boolean; slug?: string } {
  return input === 'P' ? { requested: true, ...(selectedSlug ? { slug: selectedSlug } : {}) } : { requested: false };
}

export function parsePrintoutArgs(args: string[]): { slug?: string; text: boolean } {
  const flags = args.filter((arg) => arg.startsWith('--'));
  const unknown = flags.filter((flag) => flag !== '--text');
  if (unknown.length) throw new Error(`unknown printout option ${unknown.join(', ')}`);
  const slugs = args.filter((arg) => !arg.startsWith('--'));
  if (slugs.length > 1) throw new Error('weaver printout accepts at most one workstream slug');
  return { ...(slugs[0] ? { slug: slugs[0] } : {}), text: flags.includes('--text') };
}
