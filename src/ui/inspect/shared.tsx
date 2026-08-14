import * as fs from 'node:fs';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PolicyRecord } from '../../policies.js';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '../components/index.js';
import { firstLine } from './model.js';

const CSS = fs.readFileSync(new URL('./tailwind.generated.css', import.meta.url), 'utf8');

interface NavItem {
  href: string;
  label: string;
  count?: number;
}

export function Shell({ title, subtitle, nav, children }: { title: string; subtitle: string; nav: NavItem[]; children: ReactNode }) {
  return (
    <html lang="en" className="bg-zinc-950 text-zinc-100">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-5 py-3 sm:px-8">
            <a href={nav[0]?.href ?? '#'} className="text-sm font-semibold tracking-tight text-white">
              Weaver
            </a>
            <nav aria-label="Page" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {nav.map((item) => (
                <a
                  key={`${item.href}-${item.label}`}
                  href={item.href}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-100"
                >
                  {item.label}
                  {item.count !== undefined ? <span className="text-xs text-zinc-600">{item.count}</span> : null}
                </a>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-5 py-7 sm:px-8 sm:py-10">
          <div className="mb-8 max-w-4xl">
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-400">{subtitle}</p>
          </div>
          {children}
          <footer className="mt-12 border-t border-zinc-900 py-6 text-xs text-zinc-600">
            Generated from typed Workstream state.
          </footer>
        </main>
      </body>
    </html>
  );
}

export function documentHtml(node: ReactNode): string {
  return `<!doctype html>${renderToStaticMarkup(node)}`;
}

export function RecordSection({ id, title, count, children }: { id?: string; title: string; count: number; children: ReactNode }) {
  return (
    <Card id={id} className="bg-zinc-900/20">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        <span className="text-xs text-zinc-600">{count}</span>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Empty({ label }: { label: string }) {
  return <p className="py-4 text-sm text-zinc-600">{label}</p>;
}

export function PolicyRow({ policy }: { policy: PolicyRecord }) {
  const clean = policy.evidence.filter((evidence) => evidence.interventionFree).length;
  return (
    <details className="border-t border-zinc-900 py-3 first:border-t-0 first:pt-0">
      <summary className="flex cursor-pointer items-start gap-2 text-sm">
        <Badge variant={policy.status === 'active' ? 'success' : policy.status === 'superseded' ? 'outline' : 'warning'}>{policy.status}</Badge>
        <span className="min-w-0 flex-1 text-zinc-300">{firstLine(policy.statement)}</span>
        <span className="shrink-0 text-xs text-zinc-600">{clean}/{policy.evidence.length} clean</span>
      </summary>
      <div className="mt-3 space-y-2 border-l border-zinc-800 pl-3 text-xs leading-5 text-zinc-500">
        <p className="text-zinc-300">{policy.statement}</p>
        <p>{policy.effect.kind}: {policy.effect.description}</p>
        <p className="font-mono">{policy.id}</p>
        {policy.contested ? <p className="text-rose-300">Contested: {policy.contested.note}</p> : null}
      </div>
    </details>
  );
}
