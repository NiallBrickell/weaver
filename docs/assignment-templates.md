# Assignment templates — plan

*26 August 2026. The gap, from the cross-harness team review: a team can
express any org shape and any specialist as durable text (tags + doctrine,
steering, managed workstreams, eval-backed routes), but a **repeatable named
assignment shape** — "every security review runs this exact brief" — has no
durable home. It gets re-stated in steering, or stays tribal. This plan adds
the smallest object that fixes that, without personas, registries of agents,
or a new write path.*

## The problem

Weaver deliberately has no `Agent` record: a "security agent" is a
security-shaped assignment, and that shape lives in prose the coordinator
re-composes each time. That is right for identity (kernel rule 1 — capability
requirements survive worker replacement; a named persona would invite
identity where there should only be intended work), but it leaves the
operator's *standard briefs* with nowhere durable to live:

- Policies carry judgment ("prefer small fixes"), not boilerplate — and the
  authority screen would mangle normal brief imperatives ("the worker may…").
- Rules files feed the policy screen, same problem.
- Steering re-statement works but is not shared, not versioned, and not
  reusable across workstreams or teammates.

## What a template is

A **named, versioned, operator-owned brief skeleton for a `work` assignment**:

```ts
interface AssignmentTemplate {
  id: Id;
  name: string;            // stable, human-chosen: "security-review"
  version: number;         // bumped on edit
  objective: string;       // plain prose skeleton
  briefing: string;        // plain prose skeleton
  acceptanceCriteria: string[];
  tags: string[];          // suggested policy-scope tags for instantiated work
  executionRequirements?: AssignmentExecutionRequirements; // SUGGESTED profile/modalities/complexity
  provenance: { author: string; source: 'operator' | 'import'; at: Iso };
}
```

Plain prose only — no placeholder/templating language. A skeleton says what
the brief must establish, in the operator's words; the coordinator still
writes the instance around the current workstream's actual state.

## The design lines (each one is a kernel constraint)

1. **Work-shaped only.** A template carries only the fields of a `work`
   assignment. It cannot carry `exec_cwd`/`exec_verify`/`approval_ask`/
   `approval_mode`/`exec_run`, so no template can ever pre-compose an egress.
   Actions stay hand-composed per external effect, with their own gates —
   unchanged.
2. **Copy at instantiation, never reference.** Using a template copies its
   fields into the assignment and records `templateRef: { name, version }` as
   provenance. Nothing at runtime reads the template back: routing reads the
   copied `executionRequirements` (declared on the assignment as today),
   adoption, gates, and readback are untouched, and editing a template never
   rewrites history. Templates are not load-bearing — delete one and every
   past assignment stands.
3. **No new write path.** The coordinator composes through the existing
   `create_assignment` tool. No `use_template` tool: one mutation path for
   intended work stays one. The projection renders tag-matching templates
   (bounded, like policies) and the system prompt states the copy rule: when
   human direction names a template or the work matches one, copy its
   skeleton; declare requirements as usual; the template is briefing text,
   never authority.
4. **No authority screen — because none is needed.** Template text is
   briefing text, and the boundary for briefs is the lifecycle (kernel rule
   7): a work brief cannot egress, whatever it says. Templates never render
   on approval cards and never touch action gates, so there is no surface
   where template prose could masquerade as a grant.
5. **Fleet-level store, seed-symmetric sharing.** Templates live beside the
   policy store (same trust class: operator-authored durable text, shared
   across a Postgres fleet). `weaver templates export` / `import` mirror
   team seeds: plain JSON, idempotent on name, no provenance paths leaving
   the machine. Imported templates land as ordinary operator-owned text on
   the importing fleet.

## Non-goals

- **No dispatch triggers or scheduling.** A template never runs itself;
  recurring work is a routine workstream's job. Templates are shapes, not
  engines.
- **No personas.** A template names a kind of assignment, not an agent.
  Nothing gains an identity, memory, or a seat.
- **No model pinning.** The suggested `executionRequirements` enters routing
  exactly as a coordinator-declared requirement does (see
  [execution-profiles.md](./execution-profiles.md)); the operator's config
  and reviewed routes answer it.
- **No tenancy.** One fleet, one operator authority; sharing is files between
  humans, not accounts.

## Implementation slices

1. **Store + CLI**: `AssignmentTemplate` in a fleet-level store (policy-store
   pattern); `weaver template set <name>` (fields from stdin, version bumped
   on edit), `list`, `show`, `rm`. Tests: roundtrip, version bump, `rm`
   leaves past `templateRef` provenance resolvable-as-history (name+version
   rendered, never a dangling pointer that breaks rendering).
2. **Projection + coordinator**: bounded render of tag-matching templates in
   the projection; system-prompt copy rule; `create_assignment` unchanged.
   Test: projection bound, template render, and the copy-path produces an
   ordinary assignment with `templateRef` provenance.
3. **Export/import + docs**: `weaver templates export/import` idempotent on
   name; `docs-public/templates.md` (share your work shapes, never your
   authority); cross-links from team-seeds and the future team page.

## Acceptance scenarios

- An operator sets `security-review` once; steering says "every PR in this
  stream gets a security review"; the coordinator instantiates the template's
  skeleton per PR, adapting prose to the actual PR, declaring
  `bounded-code-repair`-class requirements as the template suggests.
- The operator tightens the template's acceptance criteria; assignments
  created before the edit still show the criteria they were created with.
- A teammate imports the template; it lands as ordinary text with
  `source: 'import'` provenance; nothing about it is active or trusted
  differently.
- Nobody can template an action: the store refuses action-shaped fields, and
  `create_assignment`'s action invariants are untouched.

## Relationship to the other team-organization work

- [execution-profiles.md](./execution-profiles.md) — the routing key a
  template may *suggest* (shipped as documentation in the profiles PR).
- Team recipes page (`docs-public`, planned) — "running Weaver as a team":
  org shapes, specialists via tags+doctrine, where templates and seeds fit,
  and where personas are allowed to live (inside workers, as today).
