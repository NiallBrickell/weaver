# Team seeds

*Share your guardrails with your team — never your trust, never your transcripts*

Once Weaver has learned how you work — backfilled from your rules files and session corrections, refined by live steering — that practice is exportable. A **seed** is the shareable form of your accumulated taste: a teammate imports it and their Weaver starts from your guardrails on day one, instead of learning the same lessons from zero.

## Export

```bash
weaver policies export --author niall        # → state/seed-niall.json
```

The seed is **sanitized by construction**. It carries each policy's statement, scope tags, effect kind, and a short origin label — and nothing else:

- No transcript quotes (session-derived provenance can contain private context; it never leaves your machine)
- No absolute paths, no policy ids, no evidence records
- No superseded policies — a rule you outgrew must not be seeded into a teammate

Send the file however you send files. Re-exporting after your store evolves produces an updated seed; sharing it again is safe.

## Import

```bash
weaver policies import seed-niall.json
```

Three properties make this *sharing guardrails* rather than *cloning a brain*:

1. **Everything lands in shadow.** The seed carries the author's practice, not their trust. Each rule earns *active* status through the **importer's** own intervention-free outcomes — run #1 on your machine starts the evidence loop fresh.
2. **Your corrections outrank the seed.** When you supersede a seeded policy, the lineage records the disagreement — over time the team gets a diffable record of where each person's engineering taste differs, with authorship on every rule.
3. **Authority is never imported.** The same firewall that guards backfill applies: a statement that reads like granting authority — merging, sending, spending, bypassing gates — is refused at import with a note. However trusted the author, authority on your machine comes only from you.

Imports are idempotent: policies dedup by normalized statement, so re-importing an updated seed adds only what's new.

## The team game

Every workstream tracks **interventions per successful outcome** — the number the learning loop drives down. With seeds in play this becomes a team property: corrections propagate with authorship, each person's dashboard shows how often work needed *them*, and a policy that spreads through the whole team's stores because it keeps earning promotion is, measurably, shared engineering judgment.
