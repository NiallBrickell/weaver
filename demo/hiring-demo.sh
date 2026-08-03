#!/usr/bin/env bash
# The Weaver acceptance-proof walkthrough: hiring one role, longitudinally.
#
# Every step below is a separate process invocation. Nothing survives between
# steps except the typed state on disk — that is the point. Coordinator passes
# A, B, C are separate model runs (set WEAVER_COORDINATOR_MODEL between steps
# to prove model-swap continuity).
#
# Run from the repo root:   bash demo/hiring-demo.sh
# State lands in ./state/hire-founding-engineer; inspect with `yarn weaver status ...`.
set -euo pipefail
cd "$(dirname "$0")/.."

W="npx tsx src/cli.ts"
SLUG=hire-founding-engineer

step() { printf '\n\033[1m━━ %s\033[0m\n' "$*"; }
pause_if_interactive() { if [ -t 0 ] && [ "${DEMO_PAUSE:-0}" = "1" ]; then read -rp "  ↵ to continue…"; fi; }

step "0. Clean slate"
rm -rf "state/$SLUG"

step "1. Human creates the workstream (outcome, constraints, budget)"
$W create --slug $SLUG \
  --title "Hire a founding engineer" \
  --objective "Hire one founding engineer for an early-stage startup: define the profile, produce the job description, run candidate outreach, and progress replies toward screens." \
  --success "A job description is adopted and published-ready" \
  --success "At least one outreach email is sent to a real candidate channel (simulated provider)" \
  --success "At least one candidate reply is evaluated and progressed or closed with a reason" \
  --constraint "All outbound communications require human approval before sending" \
  --constraint "Be honest in outreach: no inflated claims about the company" \
  --max-passes 12 --max-cost 10
pause_if_interactive

step "2. Coordinator pass A: establishes direction, dispatches research + drafts, exits"
$W tick $SLUG --max-passes 2
$W status $SLUG
pause_if_interactive

step "3. Five days pass. Nothing is running. Then the harness reconciles."
$W advance 5d
$W tick $SLUG --max-passes 2
$W status $SLUG
pause_if_interactive

step "4. The human returns, reads needs-you, and answers it with durable steering"
$W steer $SLUG "Company facts pack, answering your open blockers. Company: Loomworks. Product: an API that turns messy operational spreadsheets into governed internal tools. Stage: pre-seed, \$1.2M raised from Basecamp Ventures, 14 months runway. Team: two founders — Priya (CEO, ex-Stripe product) and Marco (CTO, ex-Datadog infra; he is technical and currently writes all the code). Stack: TypeScript, Node, Postgres, React, deployed on Fly.io. Remote policy: remote-first in EU/UK timezones, quarterly onsites in Lisbon. Compensation: EUR 90-115k plus 1.0-2.0% equity, no bonus. Interview loop: intro call, 2h paid working session on real code, founder chat, offer within a week. On your six flagged role-shape claims: confirm all six as true of us as written. You may fill every placeholder from this message, treat the JD as publishable once filled, and proceed to outreach — my approval is still required before anything is sent."
$W tick $SLUG --max-passes 3
$W status $SLUG
pause_if_interactive

step "5. Human approves whatever send is waiting (the needs-you queue)"
INT=$(node -e "
const d=require('./state/$SLUG/workstream.json');
const i=d.interactions.find(i=>i.status==='awaiting_approval');
process.stdout.write(i?i.id:'');
")
if [ -n "$INT" ]; then
  echo "approving $INT"
  $W approve $SLUG "$INT"
  step "5b. The send executes with a crash-after-egress (result UNKNOWN) — readback must resolve it, never a re-send"
  WEAVER_SEND_UNKNOWN=1 $W tick $SLUG --max-passes 0 || true
  $W tick $SLUG --max-passes 1
else
  echo "no send awaiting approval — check status output above"
fi
pause_if_interactive

step "6. Three days later a candidate replies (untrusted input; wakes the workstream)"
$W advance 3d
if [ -n "$INT" ]; then
  $W reply $SLUG --interaction "$INT" --from "sam@example-candidate.dev" \
    --body "Hi — this sounds interesting. I'm currently a senior engineer at a fintech, mostly TypeScript and some Go. Could you share compensation range and whether the role is remote-friendly before we talk?"
fi

step "7. Coordinator pass C: evaluates the reply, continues or supersedes the course"
$W tick $SLUG --max-passes 2

step "8. The returning human: five questions, no transcripts"
$W status $SLUG

step "9. Provenance: every pass, decision, adoption and send is typed state"
$W log $SLUG | tail -25
echo
echo "Demo complete. Deep-dive: cat state/$SLUG/workstream.json"
