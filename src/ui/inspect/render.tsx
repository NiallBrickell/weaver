import type { PolicyRecord } from '../../policies.js';
import type { WorkstreamDoc } from '../../types.js';
import type { RunnerPresence } from '../../store/types.js';
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
  presences: readonly RunnerPresence[] = [],
): string {
  return documentHtml(<FleetPage view={fleetBoard(docs, policies, managedBySlug, unreadable, undefined, undefined, presences)} />);
}

export function renderWorkstreamHtml(
  doc: WorkstreamDoc,
  policies: PolicyRecord[],
  managed: ManagedWorkstreamLink[] = [],
  presences: readonly RunnerPresence[] = [],
): string {
  return documentHtml(<WorkstreamPage view={workstreamPage(doc, policies, managed, presences)} totalPolicyCount={policies.length} />);
}

export function renderLearnedHtml(policies: PolicyRecord[]): string {
  return documentHtml(<LearnedPage policies={policies} />);
}
