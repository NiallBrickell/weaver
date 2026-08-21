#!/usr/bin/env python3
"""Fleet-wide "Needs You" dashboard — one glanceable page of every open
attention card across the whole Weaver fleet that needs the human, so nothing
gets lost across many sessions. Reads weaver state (the same attention queue the
coordinator writes), renders a self-refreshing HTML page. Regenerated on a
launchd cadence; open the output file in a browser and it refreshes itself.

Deliberately read-only and dependency-free (stdlib only): a dashboard that
could mutate state, or that broke when a dep drifted, would be worse than none.
"""
import json, glob, os, html, datetime

WEAVER = os.path.expanduser("~/work/weaver")
OUT = os.path.expanduser("~/.weaver/needs-you.html")

# kind -> (label, rank) — blockers first, then approvals, then decisions.
KIND_META = {
    "blocker": ("Blocking — can't proceed without you", 0),
    "approval": ("Awaiting your approval", 1),
    "review": ("Your decision (a safe default holds meanwhile)", 2),
}

def collect():
    cards = []
    for f in glob.glob(os.path.join(WEAVER, "state", "*", "workstream.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        ws = d.get("workstream", {}) or {}
        slug = ws.get("slug") or d.get("slug") or os.path.basename(os.path.dirname(f))
        for a in d.get("attention", []):
            if a.get("status") != "open":
                continue
            kind = a.get("kind", "review")
            cards.append({
                "slug": slug,
                "id": a.get("id", ""),
                "kind": kind,
                "summary": (a.get("summary") or "").strip(),
                "created": a.get("createdAt") or a.get("created") or "",
            })
    cards.sort(key=lambda c: (KIND_META.get(c["kind"], ("", 9))[1], c["slug"]))
    return cards

def render(cards):
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    by_kind = {}
    for c in cards:
        by_kind.setdefault(c["kind"], []).append(c)
    parts = []
    for kind in ("blocker", "approval", "review"):
        items = by_kind.get(kind, [])
        if not items:
            continue
        label = KIND_META.get(kind, (kind, 9))[0]
        parts.append(f'<section><h2 class="{kind}">{html.escape(label)} '
                     f'<span class="count">{len(items)}</span></h2>')
        for c in items:
            summ = html.escape(c["summary"])
            parts.append(
                f'<article class="{kind}">'
                f'<div class="slug">{html.escape(c["slug"])}</div>'
                f'<div class="summary">{summ}</div>'
                f'<div class="id">{html.escape(c["id"])}</div>'
                f'</article>')
        parts.append("</section>")
    body = "\n".join(parts) if parts else '<p class="empty">Nothing needs you right now. ✓</p>'
    total = len(cards)
    return f"""<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="45">
<title>Needs You ({total})</title>
<style>
:root {{ color-scheme: dark; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; background:#0b1017; color:#e6edf3; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
header {{ position:sticky; top:0; background:#0b1017ee; backdrop-filter:blur(6px); border-bottom:1px solid #21262d; padding:16px 24px; display:flex; align-items:baseline; gap:12px; }}
header h1 {{ margin:0; font-size:20px; }}
header .n {{ font-size:28px; font-weight:700; color:#f78166; }}
header .ts {{ margin-left:auto; color:#7d8590; font-size:12px; }}
main {{ max-width:900px; margin:0 auto; padding:24px; }}
section {{ margin-bottom:32px; }}
h2 {{ font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#7d8590; border-bottom:1px solid #21262d; padding-bottom:8px; }}
h2.blocker {{ color:#f78166; }}
h2 .count {{ float:right; color:#7d8590; }}
article {{ border:1px solid #21262d; border-left:3px solid #30363d; border-radius:6px; padding:14px 16px; margin:10px 0; background:#0d1420; }}
article.blocker {{ border-left-color:#f78166; }}
article.approval {{ border-left-color:#d29922; }}
article.review {{ border-left-color:#388bfd; }}
.slug {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:#58a6ff; margin-bottom:6px; }}
.summary {{ white-space:pre-wrap; }}
.id {{ font-family:ui-monospace,monospace; font-size:11px; color:#484f58; margin-top:8px; }}
.empty {{ text-align:center; color:#3fb950; font-size:18px; padding:60px; }}
</style></head>
<body>
<header><h1>Needs You</h1><span class="n">{total}</span><span class="ts">updated {now} · auto-refreshes</span></header>
<main>{body}</main>
</body></html>"""

def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    html_out = render(collect())
    tmp = OUT + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(html_out)
    os.replace(tmp, OUT)  # atomic — a browser mid-read never sees a half-written file

if __name__ == "__main__":
    main()
