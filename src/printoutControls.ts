/** Pure key routing for the Ink printout view, kept deterministic and tested. */

export interface PrintoutKey {
  escape?: boolean;
  downArrow?: boolean;
  upArrow?: boolean;
  pageDown?: boolean;
  pageUp?: boolean;
}

export type PrintoutModalCommand =
  | { kind: 'close' }
  | { kind: 'copy' }
  | { kind: 'scroll'; to: number }
  | { kind: 'ignore' };

/** Uppercase P opens; lowercase p remains the dashboard pause command. */
export function requestedPrintoutScope(input: string, selectedSlug: string | undefined): { requested: boolean; slug?: string } {
  return input === 'P' ? { requested: true, ...(selectedSlug ? { slug: selectedSlug } : {}) } : { requested: false };
}

export function printoutModalCommand(
  input: string,
  key: PrintoutKey,
  scroll: number,
  max: number,
  page: number,
): PrintoutModalCommand {
  if (key.escape) return { kind: 'close' };
  if (input === 'C' || input === 'c') return { kind: 'copy' };
  const base = Math.min(max, Math.max(0, scroll));
  if (key.downArrow || input === 'j') return { kind: 'scroll', to: Math.min(max, base + 1) };
  if (key.upArrow || input === 'k') return { kind: 'scroll', to: Math.max(0, base - 1) };
  if (key.pageDown || input === ']') return { kind: 'scroll', to: Math.min(max, base + page) };
  if (key.pageUp || input === '[') return { kind: 'scroll', to: Math.max(0, base - page) };
  return { kind: 'ignore' };
}
