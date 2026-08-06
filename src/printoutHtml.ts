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
  let sectionOpen = false;
  const closeSection = () => {
    listOpen = closeList(out, listOpen);
    if (sectionOpen) out.push('</section>');
    sectionOpen = false;
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
      out.push(`<section class="report-section${technical ? ' technical' : ''}">`);
      if (technical) out.push('<p class="eyebrow">Technical record</p>');
      out.push(`<h3>${esc(title)}</h3>`);
      sectionOpen = true;
      continue;
    }
    if (line.startsWith('# ')) {
      listOpen = closeList(out, listOpen);
      // The document wrapper owns the h1/h2 hierarchy. The plain report's
      // leading title is deliberately omitted here rather than duplicated.
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
      out.push(`<h4 class="${cls}">${esc(heading)}</h4>`);
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
      out.push(`<p class="fact"><strong>${esc(fact[1]!)}:</strong> ${esc(fact[2]!)}</p>`);
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
:root { --paper:#f7f9f8; --ink:#1c2126; --muted:#5a6672; --accent:#1f7a5c; --accent-soft:rgba(31,122,92,.09); --rust:#b4552d; --rule:#dce2df; --mono-bg:#eef2f0; }
@media (prefers-color-scheme:dark) { :root { --paper:#131917; --ink:#e6eae7; --muted:#93a09a; --accent:#4cb68c; --accent-soft:rgba(76,182,140,.12); --rust:#d0764f; --rule:#2a332f; --mono-bg:#202824; } }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; background:var(--paper); color:var(--ink); font-family:Charter,"Bitstream Charter","Iowan Old Style",Georgia,serif; font-size:1.02rem; line-height:1.62; }
.wrap { max-width:46rem; margin:0 auto; padding:2.5rem 1.25rem 5rem; }
a { color:var(--accent); }
a:focus-visible,button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.masthead { display:flex; justify-content:space-between; align-items:baseline; gap:.4rem 1rem; border-bottom:3px double var(--rule); padding-bottom:1.4rem; margin-bottom:2.2rem; font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; }
.masthead strong { font-size:1.7rem; font-weight:600; letter-spacing:-.01em; }
.stamp { color:var(--muted); font-size:.8rem; letter-spacing:.06em; text-transform:uppercase; }
.page-nav { display:flex; flex-wrap:wrap; gap:1rem; margin:0 0 2rem; font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:.82rem; }
.page-nav a { text-decoration:none; }
.edition-date,.eyebrow { font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-weight:600; text-transform:uppercase; }
.edition-date { color:var(--accent); font-size:.82rem; letter-spacing:.1em; margin:0 0 .5rem; }
.edition-title { font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:1.55rem; font-weight:600; letter-spacing:-.01em; line-height:1.3; margin:0 0 1rem; text-wrap:balance; }
.lede { color:var(--muted); max-width:60ch; margin:0 0 1.5rem; }
.actions { display:flex; align-items:center; flex-wrap:wrap; gap:.7rem; margin:0 0 2.2rem; }
button { appearance:none; border:1px solid var(--rule); background:transparent; color:var(--ink); border-radius:3px; padding:.42rem .72rem; cursor:pointer; font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:.78rem; }
button:hover { border-color:var(--accent); color:var(--accent); }
.copy-status { color:var(--muted); font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:.78rem; }
.contents { border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); padding:1rem 0; margin:0 0 3rem; }
.contents ol { margin:.45rem 0 0; padding-left:1.3rem; }
.contents li { margin:.25rem 0; }
.contents a { color:var(--ink); text-decoration-color:var(--rule); text-underline-offset:.15em; }
.eyebrow { color:var(--muted); font-size:.7rem; letter-spacing:.14em; margin:0 0 .35rem; }
.workstream,.policy-report { border-top:1px solid var(--rule); margin:0 0 4rem; padding-top:1.5rem; scroll-margin-top:1.5rem; }
.workstream > h2,.policy-report > h2,.archive-group > h2 { font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:1.28rem; font-weight:600; line-height:1.35; letter-spacing:-.005em; margin:0 0 1.5rem; text-wrap:balance; }
.report-section { margin:0 0 2.7rem; }
.report-section h3 { font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:1.12rem; font-weight:600; line-height:1.4; margin:0 0 1rem; text-wrap:balance; }
.report-section.technical { border-top:1px solid var(--rule); padding-top:1.2rem; }
h4 { font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:.93rem; margin:1.6rem 0 .45rem; }
h4.good,.good { color:var(--accent); } h4.bad,.bad { color:var(--rust); } h4.warn,.warn { color:#8a6a12; }
.meta { color:var(--muted); font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:.82rem; margin:.1rem 0; }
.fact { margin:.42rem 0; overflow-wrap:anywhere; }
.fact strong { font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif; font-size:.92rem; }
ul { margin:.65rem 0; padding-left:1.25rem; }
li { margin:.38rem 0; overflow-wrap:anywhere; }
.delta { border-left:2px solid var(--rule); color:var(--muted); margin:.38rem 0; padding-left:.8rem; font:12px/1.55 ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:.8rem 1rem; background:var(--mono-bg); color:var(--ink); font:12px/1.55 ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace; }
hr { border:0; border-top:1px solid var(--rule); margin:2.5rem 0; }
.archive-group { border-top:1px solid var(--rule); margin-top:2.5rem; padding-top:1.3rem; }
.archive-list { list-style:none; margin:0; padding:0; }
.archive-list li { border-bottom:1px solid var(--rule); padding:.55rem 0; }
.archive-row { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; color:var(--ink); text-decoration:none; }
.archive-row:hover strong { color:var(--accent); }
.archive-row span { color:var(--muted); font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace; font-size:.78rem; }
.empty,.hint { color:var(--muted); }
footer.site { border-top:1px solid var(--rule); color:var(--muted); font-size:.84rem; margin-top:3.5rem; padding-top:1.2rem; }
code { background:var(--mono-bg); border-radius:3px; padding:.08em .35em; font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace; font-size:.85em; }
@media (max-width:34rem) { .wrap{padding-top:1.6rem}.masthead{align-items:flex-start;flex-direction:column}.archive-row{align-items:flex-start;flex-direction:column;gap:.1rem} }
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
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main class="wrap"><header class="masthead"><strong>Weaver</strong><span class="stamp">Printout</span></header>${body}<footer class="site">Generated from typed state and immutable operator-history sidecars. Coordinator prose is informational; adoption pins and deterministic readbacks remain the authority.</footer></main>${copy}</body></html>\n`;
}

function workstreamAnchor(report: WorkstreamPrintout): string {
  return `workstream-${safeScope(report.slug)}`;
}

function workstreamSection(report: WorkstreamPrintout, standalone: boolean): string {
  return `<section class="workstream" id="${esc(workstreamAnchor(report))}"><p class="eyebrow">${esc(report.status)} · ${esc(report.slug)} · revision ${report.throughRevision} · ${report.eventCount} recorded event${report.eventCount === 1 ? '' : 's'}</p><h2>${esc(standalone ? 'What changed' : report.title)}</h2>${reportMarkup(report.text)}</section>`;
}

export function renderPrintoutHtml(report: PrintoutReport): string {
  const selected = report.scope !== 'fleet' ? report.workstreams[0] : undefined;
  const title = selected ? `${selected.title} — printout` : 'Weaver fleet printout';
  const knowledgeHref = selected ? `../../../${encodeURIComponent(selected.slug)}/inspect.html` : '../../../inspect.html';
  const body = `
<nav class="page-nav"><a href="../../index.html">← All printouts</a><a href="${esc(knowledgeHref)}">Knowledge inspector</a></nav>
<article class="edition"><p class="edition-date">${selected ? 'Workstream' : 'Fleet'} printout · through ${esc(formatWhen(report.through))}</p><h1 class="edition-title">${esc(selected?.title ?? 'What Weaver did since the last printout')}</h1><p class="lede">${selected ? `The complete record for ${esc(selected.slug)}` : `${report.workstreams.length} workstream${report.workstreams.length === 1 ? '' : 's'} plus global learning activity`}, frozen through ${esc(report.through)}. Everything follows in one continuous engineering document; no section is hidden.</p><div class="actions"><button id="copy-report" type="button">Copy plain-text report</button><span class="copy-status" id="copy-status" aria-live="polite"></span></div>
${report.workstreams.length > 1 ? `<nav class="contents" aria-label="Contents"><p class="eyebrow">In this printout</p><ol>${report.workstreams.map((workstream) => `<li><a href="#${esc(workstreamAnchor(workstream))}">${esc(workstream.title)}</a> — ${esc(workstream.status)}</li>`).join('')}${report.policies ? '<li><a href="#global-learning">Global learning activity</a></li>' : ''}</ol></nav>` : ''}
${report.workstreams.map((workstream) => workstreamSection(workstream, report.workstreams.length === 1)).join('\n')}
${report.policies ? `<section class="policy-report" id="global-learning"><p class="eyebrow">Fleet policy store</p><h2>Global learning activity</h2>${reportMarkup(report.policies.text)}</section>` : ''}
${report.errors.length ? `<section class="report-section"><h3 class="bad">Unreadable sources</h3><ul>${report.errors.map((error) => `<li><strong>${esc(error.slug)}</strong>: ${esc(error.message)}</li>`).join('')}</ul></section>` : ''}</article>`;
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

async function scopeTitle(scope: string): Promise<string> {
  if (scope === 'fleet') return 'Fleet';
  try { return (await load(scope)).workstream.title; }
  catch { return scope; }
}

export async function renderPrintoutIndexHtml(records: PrintoutArchiveRecord[], unreadable: string[] = []): Promise<string> {
  const groups = new Map<string, PrintoutArchiveRecord[]>();
  for (const record of records) groups.set(record.scope, [...(groups.get(record.scope) ?? []), record]);
  const titles = new Map<string, string>();
  for (const scope of groups.keys()) titles.set(scope, await scopeTitle(scope));
  const title = (scope: string) => titles.get(scope) ?? scope;
  const ordered = [...groups.entries()].sort(([a], [b]) => a === 'fleet' ? -1 : b === 'fleet' ? 1 : title(a).localeCompare(title(b)));
  const body = `
<nav class="page-nav"><a href="../inspect.html">← Knowledge inspector</a></nav>
<article class="edition"><p class="edition-date">Weaver history</p><h1 class="edition-title">Printouts</h1><p class="lede">Saved catch-up documents, newest first. They make Weaver's typed record readable without creating authority or changing workstream state.</p>
${ordered.length ? ordered.map(([scope, items]) => `<section class="archive-group" id="${esc(scope)}"><p class="eyebrow">${esc(scope)}</p><h2>${esc(title(scope))}</h2><ol class="archive-list">${items.map((item) => `<li><a class="archive-row" href="${esc(item.relativePath)}"><strong>${esc(formatWhen(item.through))}</strong><span>${item.workstreamCount} workstream${item.workstreamCount === 1 ? '' : 's'}</span></a></li>`).join('')}</ol></section>`).join('\n') : '<section class="archive-group"><h2>Printouts</h2><p class="empty">No printout has been opened yet. Press uppercase P in the dashboard or run weaver printout.</p></section>'}
${unreadable.length ? `<section class="archive-group"><h2 class="bad">Unreadable archives</h2><p class="hint">Skipped without hiding healthy printouts: ${unreadable.map((item) => `<code>${esc(item)}</code>`).join(' ')}</p></section>` : ''}</article>`;
  return page('Weaver — printouts', body);
}

/** Regenerate the browseable hub from published immutable archive metadata. */
export async function writePrintoutIndex(): Promise<string> {
  const { records, unreadable } = readArchiveRecords();
  const target = path.join(siteDir(), 'index.html');
  atomicWrite(target, redactSecrets(await renderPrintoutIndexHtml(records, unreadable), loadAllSecrets()));
  return target;
}

export const openLocalHtml: HtmlFileOpener = (filePath, signal) => new Promise<void>((resolve, reject) => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', filePath] : [filePath];
  execFile(command, args, { windowsHide: true, signal, timeout: 5_000 }, (error) => error ? reject(error) : resolve());
});

/** Freeze, publish archive+hub, open, then acknowledge — failure repeats, never loses. */
export async function publishPrintoutHtml(slug?: string, options: PublishPrintoutOptions = {}): Promise<PublishedPrintout> {
  const report = await preparePrintout(slug);
  const archive = writeArchive(report);
  const published = { ...archive.metadata, published: true };
  atomicWrite(archive.metadataPath, JSON.stringify(published, null, 2) + '\n');
  const hubPath = await writePrintoutIndex();
  try {
    await (options.openFile ?? openLocalHtml)(archive.htmlPath, options.signal);
  } catch (error) {
    throw new Error(`could not open browser; HTML is available at ${archive.htmlPath}; ${error instanceof Error ? error.message : error}`);
  }
  acknowledgePrintout(report);
  return { path: archive.htmlPath, hubPath, report };
}
