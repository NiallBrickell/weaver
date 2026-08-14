import type { PolicyRecord } from '../../policies.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/index.js';
import { learnedGroups } from './model.js';
import { Empty, PolicyRow, Shell } from './shared.js';

export function LearnedPage({ policies }: { policies: PolicyRecord[] }) {
  const groups = learnedGroups(policies);
  const sections: { title: string; items: PolicyRecord[]; folded?: boolean }[] = [
    { title: 'Doctrine', items: groups.doctrine },
    { title: 'Active', items: groups.active },
    { title: 'Contested', items: groups.contested },
    { title: 'Shadow with evidence', items: groups.shadowProven },
    { title: 'Shadow unproven', items: groups.shadowUnproven, folded: true },
    { title: 'Superseded', items: groups.superseded, folded: true },
  ];
  return (
    <Shell
      title="Learned"
      subtitle={`${policies.length} polic${policies.length === 1 ? 'y' : 'ies'} · scoped, attributable, and never authority`}
      nav={[
        { href: 'inspect.html', label: '← Work' },
        { href: 'learned.html', label: 'Learned', count: policies.length },
        { href: 'printouts/index.html', label: 'Catch up' },
      ]}
    >
      <div className="space-y-3">
        {sections.filter((section) => section.items.length).map((section) => {
          const content = <div className="divide-y divide-zinc-900 px-4">{section.items.map((policy) => <PolicyRow key={policy.id} policy={policy} />)}</div>;
          return section.folded ? (
            <details key={section.title} className="rounded-xl border border-zinc-900 bg-zinc-900/20">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-400">{section.title} <span className="ml-1 text-zinc-600">{section.items.length}</span></summary>
              {content}
            </details>
          ) : (
            <Card key={section.title} className="bg-zinc-900/20">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm">{section.title}</CardTitle>
                <span className="text-xs text-zinc-600">{section.items.length}</span>
              </CardHeader>
              <CardContent>{section.items.map((policy) => <PolicyRow key={policy.id} policy={policy} />)}</CardContent>
            </Card>
          );
        })}
        {!policies.length ? <Empty label="No policies learned yet." /> : null}
      </div>
    </Shell>
  );
}
