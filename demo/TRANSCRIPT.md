# What actually happened: the first full acceptance run

An honest account of the first end-to-end run of `hiring-demo.sh` (2026-08-03, real model passes), kept because the unplanned parts turned out to be stronger evidence than the script. Totals: **12 coordinator passes ($15.86), 8 worker runs, 16 virtual days, revision 138**, coordinators on **two different models** (opus for passes 1–5, sonnet for 6–12 after the environment started killing long processes — which turned the model-swap claim from a checkbox into a live necessity).

> Historical note (2026-08-13): the lifetime pass/dollar ceiling described below was later retired. Indefinite routines made any lifetime ceiling a scheduled failure, and the SDK estimate was not provider billing. Weaver now uses a rolling physical-time model-start guard that self-parks and resumes; the original run remains recorded here unchanged as acceptance history.

## The scripted spine worked

- **Pass A** (fresh workstream, empty state) recorded a sequencing decision — profile → JD → outreach, no invented company facts, every send human-approved — and dispatched three bounded assignments, then exited. No process stayed alive at any point in the run.
- Workers submitted; **fresh passes read each artifact in full against acceptance criteria before adopting** (`adopt_submission` pins the content hash) or rejecting — two JD revisions were rejected with recorded reasons, and both rejected candidates remain inspectable with their lineage (`del_70c0c819`, `del_149d2921`).
- The **virtual clock** advanced 5d/3d between phases; wakes fired as stored data; five coalesced wakes woke one pass, which noticed two were already satisfied and handled only the live ones.
- The **send** executed in the engine only after human approval, against a pinned hash. Under `WEAVER_SEND_UNKNOWN=1` it crashed after egress: the interaction went `unknown`, and the next tick **resolved it by provider readback — `confirmed`, exactly one provider record, no second send**.
- Three virtual days later the candidate replied; the final pass **evaluated the reply as untrusted input**, recorded a continuation decision on the lineage, and stopped at the budget ceiling (12/12 passes) with a needs-you item explaining exactly what the human should do next.

## The unscripted parts were the real proof

1. **The coordinator refused to outrun its human.** The script initially never answered the coordinator's "company facts" ask. Rather than inventing facts, it: kept the JD adopted-but-not-publishable with typed `[[NEEDS: …]]` placeholders; superseded its own honesty decision when it found a category the original didn't distinguish (fabricated facts vs. derived role-shape claims — `dec_dbe7fe59` → `dec_481f33b9`, lineage kept); and, five virtual days in, **narrowed a 17-fact ask to the 7 lines that make exactly one send possible**, on the reasoning that "omission is honest, approximation is not."
2. **The environment became a chaos monkey.** The session's task supervisor killed the demo process three separate times — twice mid-worker, once mid-tick. State survived every kill with zero corruption; the crash-recovery path (stale `running` attempts re-queued with `terminalReason: 'crashed'`) was built in response to the first kill and absorbed the rest. Every "resume" was a fresh process reading typed state.
3. **Model-side safety layers are a real actor in this architecture.** Three `create_assignment` attempts for candidate-personalized outreach were refused by the model's own content screening (named founder signature + named recipient → "impersonation risk"), with inconsistent reasons across retries. The coordinator's response was textbook: stop after three attempts, record the pattern, raise a needs-you item proposing two concrete unblocks. The unblock that worked — **the founder authors the text, a worker transcribes it verbatim, adoption requires a character-exact match** — was proposed by the coordinator itself and is arguably the *correct* general protocol for founder-voiced outreach, not a workaround. It also drove two real harness features: human adoption (`weaver adopt`) and operator-owned budget changes (`weaver budget`).
4. **Budget as a hard ceiling shaped behavior.** Near the ceiling, passes explicitly declined work they judged unaffordable ("not enough headroom given this workstream's own observed ~$2.94 per assignment-and-review cycle") and routed it to the human instead — which is the autonomy contract working, not a failure.

## Where the five questions landed

Final `weaver status`: **Now** idle, waiting on wakes. **Since you left** — send confirmed via readback, reply arrived and evaluated. **Needs you** — reply to Sam (author text for verbatim transcription, or top up budget for a worker draft). **Next** — a 3-day backstop wake. **Why** — 10 standing decisions, 2 superseded with lineage, 5 adopted deliverables with pinned hashes. No transcript was read to produce any of it.

## Failure modes the run surfaced (now fixed)

- A killed worker left its assignment stuck in `running` forever → crash recovery in `tick` (stale-attempt re-queue).
- No way for a human to adopt or fund: → `weaver adopt`, `weaver budget`.
- Coordinators write long handoff notes into wake reasons (good) which flooded the status view (bad) → full text kept in state, clipped at display.
