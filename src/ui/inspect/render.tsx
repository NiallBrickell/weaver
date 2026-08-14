import type { PolicyRecord } from '../../policies.js';
import type { WorkstreamDoc } from '../../types.js';
import { FleetPage } from './fleet-page.js';
import { LearnedPage } from './learned-page.js';
import {
  fleetBoard,
  workstreamPage,
  type ManagedWorkstreamLink,
} from './model.js';
import { documentHtml } from './shared.js';
import { WorkstreamPage } from './workstream-page.js';

export function renderOverviewHtml(
  docs: WorkstreamDoc[],
  policies: PolicyRecord[],
  managedBySlug = new Map<string, ManagedWorkstreamLink[]>(),
  unreadable: string[] = [],
): string {
  return documentHtml(<FleetPage view={fleetBoard(docs, policies, managedBySlug, unreadable)} />);
}

export function renderWorkstreamHtml(
  doc: WorkstreamDoc,
  policies: PolicyRecord[],
  managed: ManagedWorkstreamLink[] = [],
): string {
  return documentHtml(<WorkstreamPage view={workstreamPage(doc, policies, managed)} totalPolicyCount={policies.length} />);
}

export function renderLearnedHtml(policies: PolicyRecord[]): string {
  return documentHtml(<LearnedPage policies={policies} />);
}
