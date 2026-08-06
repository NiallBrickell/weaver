/**
 * Self-contained browser presentation and archive for operator printouts.
 *
 * HTML files are output artifacts over an already-frozen PrintoutReport. They
 * never become coordinator input or organizational truth. A report checkpoint
 * advances only after the host accepts the request to open the generated page.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acknowledgePrintout, preparePrintout, type PrintoutReport, type WorkstreamPrintout } from './printout.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import { load, weaverHome } from './store.js';

export interface PrintoutArchiveRecord {
  schemaVersion: 1;
  scope: string;
  through: string;
  workstreamCount: number;
  relativePath: string;
  published: boolean;
}

export type HtmlFileOpener = (filePath: string, signal?: AbortSignal) => Promise<void>;

export interface PublishPrintoutOptions {
  openFile?: HtmlFileOpener;
  signal?: AbortSignal;
}

export interface PublishedPrintout {
  path: string;
  hubPath: string;
  report: PrintoutReport;
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function safeScope(scope: string): string {
  if (scope === 'fleet') return scope;
  const normalized = scope.replace(/[^a-zA-Z0-9_-]/g, '_') || 'workstream';
  if (normalized === scope) return scope;
  const suffix = createHash('sha256').update(scope).digest('hex').slice(0, 8);
  return `${normalized}-${suffix}`;
}

function siteDir(): string {
  return path.join(weaverHome(), 'printouts');
}

function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function closeList(out: string[], listOpen: boolean): boolean {
  if (listOpen) out.push('</ul>');
  return false;
}

/** Render Weaver's deliberately small report format without trusting HTML in state. */
function reportMarkup(text: string): string {
  const out: string[] = [];
  let listOpen = false;
  let codeOpen = false;
  let section: 'section' | 'details' | null = null;
  const closeSection = () => {
    listOpen = closeList(out, listOpen);
    if (section === 'section') out.push('</section>');
    if (section === 'details') out.push('</div></details>');
    section = null;
  };

  for (const line of text.split('\n')) {
    if (line === '```text') {
      listOpen = closeList(out, listOpen);
      out.push('<pre>');
      codeOpen = true;
      continue;
    }
    if (line === '```' && codeOpen) {
      out.push('</pre>');
      codeOpen = false;
      continue;
    }
    if (codeOpen) {
      out.push(`${esc(line)}\n`);
      continue;
    }
    if (line.startsWith('## ')) {
      closeSection();
      const title = line.slice(3);
      const technical = /^(Exact |Current typed |Surviving pre-journal)/.test(title);
      if (technical) {
        out.push(`<details class="technical"><summary>${esc(title)}</summary><div class="technical-body">`);
        section = 'details';
      } else {
        out.push(`<section><h2>${esc(title)}</h2>`);
        section = 'section';
      }
      continue;
    }
    if (line.startsWith('# ')) {
      listOpen = closeList(out, listOpen);
      out.push(`<h1 class="report-title">${esc(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith('### ')) {
      listOpen = closeList(out, listOpen);
      const heading = line.slice(4);
      const cls = heading.startsWith('VERIFIED') || heading.startsWith('ACCEPTED')
        ? 'good'
        : heading.startsWith('READBACK FAILED') || heading.startsWith('REJECTED')
          ? 'bad'
          : heading.startsWith('PROPOSED') ? 'warn' : '';
      out.push(`<h3 class="${cls}">${esc(heading)}</h3>`);
      continue;
    }
    if (line === '---') {
      listOpen = closeList(out, listOpen);
      out.push('<hr>');
      continue;
    }
    if (!line.trim()) {
      listOpen = closeList(out, listOpen);
      continue;
    }
    const fact = /^- ([^:]{1,48}): (.*)$/.exec(line);
    if (fact) {
      listOpen = closeList(out, listOpen);
      out.push(`<div class="fact"><span>${esc(fact[1]!)}</span><p>${esc(fact[2]!)}</p></div>`);
      continue;
    }
    if (line.startsWith('- ')) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${esc(line.slice(2))}</li>`);
      continue;
    }
    listOpen = closeList(out, listOpen);
    if (/^\s{2}/.test(line)) out.push(`<p class="delta">${esc(line.trim())}</p>`);
    else if (line.startsWith('Period:') || line.startsWith('Boundary:')) out.push(`<p class="meta">${esc(line)}</p>`);
    else out.push(`<p>${esc(line)}</p>`);
  }
  closeSection();
  if (codeOpen) out.push('</pre>');
  return out.join('\n');
}

const STYLE = `
:root { color-scheme: dark; --bg:#0b0d12; --panel:#141821; --panel2:#1b202b; --line:#293141; --fg:#e6e9ef; --dim:#929cab; --blue:#7aa2f7; --green:#70d49b; --amber:#e7c568; --red:#ee7a7a; }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; background:linear-gradient(145deg,#0b0d12 0%,#111725 100%); color:var(--fg); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
main { max-width:1180px; margin:0 auto; padding:36px 26px 90px; }
a { color:var(--blue); }
.topbar { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:28px; }
.nav { display:flex; gap:14px; flex-wrap:wrap; }
.nav a { text-decoration:none; font-size:13px; }
.hero { padding:28px; border:1px solid var(--line); border-radius:18px; background:rgba(20,24,33,.94); box-shadow:0 20px 60px rgba(0,0,0,.25); }
.eyebrow { color:var(--blue); text-transform:uppercase; letter-spacing:.11em; font-size:12px; font-weight:700; }
.hero h1 { margin:5px 0 6px; font-size:30px; line-height:1.2; }
.hero p { margin:4px 0; color:var(--dim); }
.actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; }
button,.button { appearance:none; border:1px solid var(--line); background:var(--panel2); color:var(--fg); border-radius:9px; padding:8px 12px; cursor:pointer; text-decoration:none; font:inherit; font-size:13px; }
button:hover,.button:hover { border-color:var(--blue); }
.scope-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; margin:18px 0; }
.scope-card { display:block; padding:14px 16px; border:1px solid var(--line); border-radius:12px; background:var(--panel); text-decoration:none; }
.scope-card strong { display:block; color:var(--fg); }
.scope-card span { color:var(--dim); font-size:13px; }
.pill { display:inline-block; margin-left:7px; padding:1px 7px; border:1px solid var(--line); border-radius:999px; color:var(--dim); font-size:11px; text-transform:uppercase; }
.report { margin:20px 0; }
.report > summary { cursor:pointer; list-style:none; padding:17px 20px; border:1px solid var(--line); border-radius:13px; background:var(--panel); font-size:17px; font-weight:650; }
.report[open] > summary { border-radius:13px 13px 0 0; border-bottom-color:transparent; }
.report-body { padding:4px 20px 22px; border:1px solid var(--line); border-top:0; border-radius:0 0 13px 13px; background:var(--panel); }
.report-title { font-size:21px; margin:18px 0 4px; }
section,.technical { margin:16px 0; padding:17px 19px; border:1px solid var(--line); border-radius:12px; background:var(--panel2); }
section h2 { margin:0 0 12px; font-size:17px; }
h3 { margin:19px 0 7px; font-size:14px; }
h3.good,.good { color:var(--green); } h3.bad,.bad { color:var(--red); } h3.warn,.warn { color:var(--amber); }
.meta { color:var(--dim); margin:3px 0; font-size:13px; }
.fact { display:grid; grid-template-columns:minmax(140px,210px) 1fr; gap:15px; border-top:1px solid var(--line); padding:9px 0; }
.fact:first-of-type { border-top:0; }
.fact > span { color:var(--dim); font-weight:600; }
.fact p { margin:0; overflow-wrap:anywhere; }
ul { margin:8px 0; padding-left:22px; }
li { margin:5px 0; overflow-wrap:anywhere; }
.delta { margin:5px 0 5px 14px; color:#c5cbd5; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:13px; border:1px solid var(--line); border-radius:9px; background:#0d1017; color:#cbd3df; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
.technical { padding:0; }
.technical > summary { cursor:pointer; padding:14px 17px; color:var(--dim); font-weight:650; }
.technical-body { padding:0 17px 16px; }
hr { border:0; border-top:1px solid var(--line); margin:26px 0; }
.archive-list { display:grid; gap:10px; }
.archive-row { display:flex; justify-content:space-between; gap:12px; padding:13px 15px; border:1px solid var(--line); border-radius:10px; background:var(--panel2); text-decoration:none; }
.archive-row span { color:var(--dim); }
.empty { color:var(--dim); font-style:italic; }
.copy-status { color:var(--dim); align-self:center; font-size:13px; }
footer { color:var(--dim); font-size:12px; margin-top:30px; }
@media (max-width:680px) { main{padding:22px 14px 60px}.topbar{align-items:flex-start;flex-direction:column}.hero{padding:21px}.hero h1{font-size:24px}.fact{grid-template-columns:1fr;gap:2px}.report-body{padding-left:12px;padding-right:12px} }
`;

function page(title: string, body: string, reportText?: string): string {
  const copy = reportText === undefined ? '' : `
<script type="application/json" id="report-text">${JSON.stringify(reportText).replaceAll('<', '\\u003c')}</script>
<script>
(function () {
  var button = document.getElementById('copy-report');
  if (!button) return;
  var status = document.getElementById('copy-status');
  button.addEventListener('click', async function () {
    var text = JSON.parse(document.getElementById('report-text').textContent);
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard API unavailable');
      await navigator.clipboard.writeText(text);
    } catch (_) {
      var input = document.createElement('textarea');
      input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select();
      if (!document.execCommand('copy')) { input.remove(); status.textContent = 'Copy failed'; return; }
      input.remove();
    }
    status.textContent = 'Copied complete plain-text report';
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'C' && !event.metaKey && !event.ctrlKey && !event.altKey) button.click();
  });
})();
</script>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}<footer>Generated by Weaver from typed state and immutable operator-history sidecars. Coordinator prose is informational; adoption pins and deterministic readbacks remain the authority.</footer></main>${copy}</body></html>\n`;
}

function workstreamCard(report: WorkstreamPrintout): string {
  return `<a class="scope-card" href="#${esc(report.slug)}"><strong>${esc(report.title)} <span class="pill">${esc(report.status)}</span></strong><span>${esc(report.slug)} · revision ${report.throughRevision} · ${report.eventCount} recorded event${report.eventCount === 1 ? '' : 's'}</span></a>`;
}

export function renderPrintoutHtml(report: PrintoutReport): string {
  const selected = report.scope !== 'fleet' ? report.workstreams[0] : undefined;
  const title = selected ? `${selected.title} — printout` : 'Weaver fleet printout';
  const knowledgeHref = selected ? `../../../${encodeURIComponent(selected.slug)}/inspect.html` : '../../../inspect.html';
  const body = `
<div class="topbar"><nav class="nav"><a href="../../index.html">← All printouts</a><a href="${esc(knowledgeHref)}">Knowledge inspector</a></nav><span class="meta">through ${esc(formatWhen(report.through))}</span></div>
<header class="hero"><span class="eyebrow">Weaver printout</span><h1>${esc(selected?.title ?? 'Fleet catch-up')}</h1><p>${selected ? esc(selected.slug) : `${report.workstreams.length} workstream${report.workstreams.length === 1 ? '' : 's'} plus global learning activity`} · frozen through ${esc(report.through)}</p><p>Everything recorded since the previous delivered printout. Open a workstream below; detailed mutation history stays collapsed until needed.</p><div class="actions"><button id="copy-report" type="button">Copy plain-text report</button><span class="copy-status" id="copy-status" aria-live="polite"></span></div></header>
${report.workstreams.length > 1 ? `<nav class="scope-grid" aria-label="Workstreams in this printout">${report.workstreams.map(workstreamCard).join('')}</nav>` : ''}
${report.workstreams.map((workstream) => `<details class="report" id="${esc(workstream.slug)}"${report.workstreams.length === 1 ? ' open' : ''}><summary>${esc(workstream.title)} <span class="pill">${esc(workstream.status)}</span></summary><div class="report-body">${reportMarkup(workstream.text)}</div></details>`).join('\n')}
${report.policies ? `<details class="report"><summary>Global learning activity</summary><div class="report-body">${reportMarkup(report.policies.text)}</div></details>` : ''}
${report.errors.length ? `<section><h2 class="bad">Unreadable sources</h2><ul>${report.errors.map((error) => `<li><strong>${esc(error.slug)}</strong>: ${esc(error.message)}</li>`).join('')}</ul></section>` : ''}`;
  return page(title, body, report.text);
}

function archiveSecrets(_report: PrintoutReport): Record<string, string> {
  return loadAllSecrets();
}

function writeArchive(report: PrintoutReport): { htmlPath: string; metadataPath: string; metadata: PrintoutArchiveRecord } {
  const scope = safeScope(report.scope);
  const stamp = report.through.replace(/[^0-9TZ]/g, '');
  const base = `${stamp}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(siteDir(), 'archives', scope);
  const htmlPath = path.join(dir, `${base}.html`);
  const metadataPath = path.join(dir, `${base}.json`);
  const metadata: PrintoutArchiveRecord = {
    schemaVersion: 1,
    scope: report.scope,
    through: report.through,
    workstreamCount: report.workstreams.length,
    relativePath: path.relative(siteDir(), htmlPath).split(path.sep).join('/'),
    published: false,
  };
  atomicWrite(htmlPath, redactSecrets(renderPrintoutHtml(report), archiveSecrets(report)));
  atomicWrite(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  return { htmlPath, metadataPath, metadata };
}

function readArchiveRecords(): { records: PrintoutArchiveRecord[]; unreadable: string[] } {
  const archives = path.join(siteDir(), 'archives');
  const unreadable: string[] = [];
  try {
    const records = fs.readdirSync(archives, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((scope) => {
        const dir = path.join(archives, scope.name);
        try {
          return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
            try {
              const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as PrintoutArchiveRecord;
              const htmlPath = path.join(dir, name.replace(/\.json$/, '.html'));
              const relativePath = path.relative(siteDir(), htmlPath).split(path.sep).join('/');
              if (!value.published) return [];
              if (value.schemaVersion !== 1 || typeof value.scope !== 'string' || typeof value.through !== 'string' ||
                !Number.isInteger(value.workstreamCount) || !fs.existsSync(htmlPath)) {
                unreadable.push(`${scope.name}/${name}`);
                return [];
              }
              return [{ ...value, relativePath }];
            } catch { unreadable.push(`${scope.name}/${name}`); return []; }
          });
        } catch { unreadable.push(scope.name); return []; }
      })
      .sort((a, b) => b.through.localeCompare(a.through));
    return { records, unreadable };
  } catch { return { records: [], unreadable }; }
}

function scopeTitle(scope: string): string {
  if (scope === 'fleet') return 'Fleet';
  try { return load(scope).workstream.title; }
  catch { return scope; }
}

export function renderPrintoutIndexHtml(records: PrintoutArchiveRecord[], unreadable: string[] = []): string {
  const groups = new Map<string, PrintoutArchiveRecord[]>();
  for (const record of records) groups.set(record.scope, [...(groups.get(record.scope) ?? []), record]);
  const ordered = [...groups.entries()].sort(([a], [b]) => a === 'fleet' ? -1 : b === 'fleet' ? 1 : scopeTitle(a).localeCompare(scopeTitle(b)));
  const body = `
<div class="topbar"><nav class="nav"><a href="../inspect.html">← Knowledge inspector</a></nav></div>
<header class="hero"><span class="eyebrow">Weaver history</span><h1>Printouts</h1><p>Saved browser snapshots of generated catch-up windows. These pages make the record readable; they do not create authority or change workstream state.</p></header>
${ordered.length ? ordered.map(([scope, items]) => `<section id="${esc(scope)}"><h2>${esc(scopeTitle(scope))} <span class="pill">${esc(scope)}</span></h2><div class="archive-list">${items.map((item) => `<a class="archive-row" href="${esc(item.relativePath)}"><strong>${esc(formatWhen(item.through))}</strong><span>${item.workstreamCount} workstream${item.workstreamCount === 1 ? '' : 's'}</span></a>`).join('')}</div></section>`).join('\n') : '<section><h2>Printouts</h2><p class="empty">No printout has been opened yet. Press uppercase P in the dashboard or run weaver printout.</p></section>'}
${unreadable.length ? `<section><h2 class="bad">Unreadable archives</h2><p class="hint">Skipped without hiding healthy printouts: ${unreadable.map((item) => `<code>${esc(item)}</code>`).join(' ')}</p></section>` : ''}`;
  return page('Weaver — printouts', body);
}

/** Regenerate the browseable hub from published immutable archive metadata. */
export function writePrintoutIndex(): string {
  const { records, unreadable } = readArchiveRecords();
  const target = path.join(siteDir(), 'index.html');
  atomicWrite(target, redactSecrets(renderPrintoutIndexHtml(records, unreadable), loadAllSecrets()));
  return target;
}

export const openLocalHtml: HtmlFileOpener = (filePath, signal) => new Promise<void>((resolve, reject) => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', filePath] : [filePath];
  execFile(command, args, { windowsHide: true, signal, timeout: 5_000 }, (error) => error ? reject(error) : resolve());
});

/** Freeze, publish archive+hub, open, then acknowledge — failure repeats, never loses. */
export async function publishPrintoutHtml(slug?: string, options: PublishPrintoutOptions = {}): Promise<PublishedPrintout> {
  const report = preparePrintout(slug);
  const archive = writeArchive(report);
  const published = { ...archive.metadata, published: true };
  atomicWrite(archive.metadataPath, JSON.stringify(published, null, 2) + '\n');
  const hubPath = writePrintoutIndex();
  try {
    await (options.openFile ?? openLocalHtml)(archive.htmlPath, options.signal);
  } catch (error) {
    throw new Error(`could not open browser; HTML is available at ${archive.htmlPath}; ${error instanceof Error ? error.message : error}`);
  }
  acknowledgePrintout(report);
  return { path: archive.htmlPath, hubPath, report };
}
