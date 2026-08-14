/**
 * `weaver inspect` site generation.
 *
 * The visual surface lives in `ui/inspect`: React components render a typed,
 * read-only projection to self-contained static HTML. This file owns only the
 * store boundary, secret redaction, and file publication.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadPolicies } from './policies.js';
import { writePrintoutIndex } from './printoutHtml.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import { listWorkstreams, load, weaverHome, workstreamDir } from './store.js';
import type { WorkstreamDoc } from './types.js';
import type { ManagedWorkstreamLink } from './ui/inspect/model.js';
import { renderLearnedHtml, renderOverviewHtml, renderWorkstreamHtml } from './ui/inspect/render.js';

export { renderLearnedHtml, renderOverviewHtml, renderWorkstreamHtml } from './ui/inspect/render.js';
export {
  fleetBoard,
  fleetNeeds,
  learnedGroups,
  passIntegrityWarnings,
  policiesForWorkstream,
  workstreamPage,
} from './ui/inspect/model.js';
export type {
  FleetBoardView,
  FleetNeed,
  FleetNeedKind,
  ManagedWorkstreamLink,
  WorkstreamCardView,
  WorkstreamLane,
  WorkstreamPageView,
} from './ui/inspect/model.js';

function writeRedacted(filePath: string, html: string, secrets: Record<string, string>): void {
  fs.writeFileSync(filePath, redactSecrets(html, secrets));
}

function managedIndex(docs: WorkstreamDoc[]): Map<string, ManagedWorkstreamLink[]> {
  const index = new Map<string, ManagedWorkstreamLink[]>();
  for (const doc of docs) {
    const manager = doc.workstream.managedBy?.slug;
    if (!manager) continue;
    const children = index.get(manager) ?? [];
    children.push({ slug: doc.workstream.slug, status: doc.workstream.status });
    index.set(manager, children);
  }
  for (const children of index.values()) children.sort((a, b) => a.slug.localeCompare(b.slug));
  return index;
}

/**
 * Regenerate the complete read-only site and return the requested entry point.
 * Generation is not treated as proof that a person read anything. Exact
 * catch-up remains the delivery-acknowledged printout checkpoint.
 */
export async function runInspect(slug?: string): Promise<string> {
  if (slug) await load(slug);

  const policies = (await loadPolicies()).policies;
  const secrets = loadAllSecrets();
  const docs: WorkstreamDoc[] = [];
  const unreadable: string[] = [];

  for (const candidate of await listWorkstreams()) {
    await new Promise((resolve) => setImmediate(resolve));
    try {
      docs.push(await load(candidate));
    } catch {
      unreadable.push(candidate);
    }
  }

  const managed = managedIndex(docs);
  for (const doc of docs) {
    const target = path.join(workstreamDir(doc.workstream.slug), 'inspect.html');
    writeRedacted(
      target,
      renderWorkstreamHtml(doc, policies, managed.get(doc.workstream.slug) ?? []),
      secrets,
    );
  }

  const overview = path.join(weaverHome(), 'inspect.html');
  writeRedacted(overview, renderOverviewHtml(docs, policies, managed, unreadable), secrets);
  writeRedacted(path.join(weaverHome(), 'learned.html'), renderLearnedHtml(policies), secrets);
  await writePrintoutIndex();
  return slug ? path.join(workstreamDir(slug), 'inspect.html') : overview;
}
