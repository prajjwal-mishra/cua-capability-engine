# Design report

What I built, why it is shaped this way, and what I chose not to build.

The brief's framing is that the hard part is not making a model click things.
It is that a successful click has to become an asset — something reviewable,
reusable, and safe to run unattended against a system of record. Almost every
decision below follows from taking that seriously.

---

## 1. The core split: exploration is not execution

Discovery and replay are two different programs with two different failure
modes, and they share nothing but the artifact.

Discovery has a model in the loop, is allowed to be slow, is allowed to wander,
and is expected to fail. Replay has no model, is fast, and must be a pure
function of `(artifact, inputs, screen)`. `tests/no-llm-import.test.ts` fails
the build if any import reachable from `src/replay/` touches the LLM client.

That test exists because the tempting failure is real: replay hits an ambiguous
screen, and there is a model right there that could probably sort it out. Taking
that shortcut once destroys the only property that makes a recorded capability
worth having. If behaviour depends on a model's mood, you cannot review a
capability, you cannot regression-test it, and you cannot explain to an auditor
why it did what it did on Tuesday. So the answer to an ambiguous screen is to
stop and ask a human, and the code is arranged so that "just ask the model" is
not available.

## 2. The Surface port: what the automation is allowed to know

Everything above the port speaks **roles, accessible names, and frame paths**.
Nothing above the port knows that Playwright, a DOM, or a browser exists.

```ts
observe(): Promise<UISnapshot>          // what is on screen
act(action: SurfaceAction): Promise<ActionResult>   // do one thing
```

Perception is accessibility-tree-first, with a heuristic fallback layer for
markup that has no accessibility semantics at all — which on this target is most
of it. A 2003 back office does not use `<label for>`; the label is the adjacent
`<td>`. So `UIElement` carries `nearbyText.leftCell`, `aboveCell`,
`columnHeader`, `rowKey`, and — crucially — a `nameSource` recording *where* the
name came from. A name the app declared via `aria-label` scores 0.95; a name I
inferred from a neighbouring table cell scores 0.65. The artifact says which it
is instead of pretending they are equally trustworthy.

**Why this matters beyond tidiness:** the brief asks what changes when the
surface is a desktop app instead of a web page. The answer is `WebSurface` is
replaced and nothing else moves, because role and name are exactly what
UIA/AX-Accessibility give you natively. The frame path becomes a window/pane
path. Every artifact, every descriptor, and the whole replay engine are already
written in the vocabulary a desktop accessibility API speaks. What would *not*
carry over is the heuristic fallback layer, which is DOM-shaped — and that is a
cost I would rather pay in one file than have leak into the artifact format.

## 3. ElementDescriptor: a ladder, not a selector

This is the load-bearing robustness decision. A step never records "click
`#ctl00_btnSearch`". It records an ordered ladder of ways to find the control,
each scored at record time:

| rung | strategy | confidence | survives |
| --- | --- | --- | --- |
| 1 | role + accessible name | 0.55–0.95 | a re-skin |
| 2 | label anchor ("the textbox in the row labelled *Member ID*") | 0.6–0.82 | markup churn |
| 3 | table cell (column header × row key) | 0.9 | row reordering, new columns |
| 4 | frame + role + ordinal | 0.4–0.55 | **renames** |
| 5 | structural path | 0.3 | almost nothing |
| 6 | recorded geometry | 0 | diagnostic only, never used unless policy opts in |

Every rung that can be populated is populated at record time, even when rung 1
looks solid. The cost is a few hundred bytes of JSON. The benefit is that when
rung 1 breaks at 2am, the capability degrades instead of dying.

Two details I would defend specifically:

**The rung that resolved is logged, every time.** A capability that silently
slid from rung 1 to rung 4 still works, but it is now one more change away from
failing. That shows up as `⚠ drift` in the run telemetry the first time it
happens, which is weeks before the failure. Silent success on a lower rung is
the single most dangerous state this system can be in, and it is the one thing
the log is designed to make impossible to miss.

**An output descriptor must never key on the element's own text.** Recording
"the cell named `$8,241.17`" does not locate the savings balance — it locates one
member's balance, and on the next invocation it either misses or, far worse,
matches a different row holding the same amount and resolves on the top rung
with high confidence. So extraction descriptors are built with
`forExtraction: true`, which suppresses the name-based rungs entirely and forces
addressing by relation: which column, which row. The value being read is the
one thing that cannot be part of how you find it.

## 4. The artifact: reviewable by a human, callable by a machine

Zod schema, so one definition produces the runtime validator, the TypeScript
type, and the JSON Schema the catalog publishes. A capability declares:

- **`inputs` / `outputs`** as JSON Schema with a `sensitivity` tag per field
- **`steps`**, each with an intent, a descriptor, a declared `risk`, an optional
  `precondition` and `checkpoint`, and its own retry and wait policy
- **`successCondition`** — how to know the whole thing worked
- **`knownOutcomes`** — the business answers a caller must be prepared for, each
  with a detector, so "member not found" is part of the contract rather than a
  surprise
- **`recoveries`** — declared, budgeted responses to conditions this flow expects
- **`provenance`** — which model, which run, when. Every committed artifact names
  a discovery run that is in `evidence/00-discovery`
- **`lifecycle`** — `draft` / `approved` / `deprecated`, with a stability record

The compiler generalizes as it writes: recorded literals that match an input
become `{$param: "memberId"}`, and concrete URLs become route patterns
(`/frame/member/:memberId`). A checkpoint that asserted `/frame/member/10042`
would be a capability that only works for one member, which is not a capability.

### What "reviewable" cost

Reviewability is not free and I want to be precise about the trade. The artifacts
are large — 542 lines for the three-step savings lookup, 828 for the eight-step
sub-account flow — because every rung of every ladder is spelled out, along with
the recovery pack and the outcome detectors. A compact format would be a
fraction of the size. I chose verbosity because the
document a human approves and the document the engine executes have to be the
same document. The moment there is a compilation step between them, the review
is of something other than what runs.

## 5. Policy: one gate, before every action

`GuardedSurface` wraps the raw surface, so there is no code path that acts on the
UI without passing the gate. The gate checks, in order: lease ownership, action
type, origin, route, element role, forbidden fields, risk class, write
authorization, and artifact approval.

Risk is classified heuristically from the action and the element (a button
reading "Commit" is not the same as a button reading "Search"), and a step's
declared risk in a reviewed artifact can **raise** that classification but never
lower it. An artifact cannot talk its way into being treated as safer than it
looks.

`irreversible` is never executed automatically. Not "usually not" — the gate
returns `escalate`, and the executor's only way forward is a human. That is what
produces the sub-account demo: the commit at Summit FCU is declared irreversible
in their overlay, so replay stops there every single time.

### The deadlock I had to fix

Unattended writes require an approved artifact. Approval requires proof the
capability replays. Proof requires running it. For a write capability, those
three rules form a cycle, and a draft that writes could never be promoted.

The resolution is a supervised shadow replay: `--attended` permits a draft to
execute writes *because a human is watching it and can stop it*, and those runs
accumulate the stability record approval needs. An agent invoking through the
catalog never gets this flag — supervision is something a human asserts by being
present, not something a caller can claim about itself.

I record this because it is the kind of thing that only surfaces when you
actually try to run the system end to end, and a design document written before
that would have quietly shipped the deadlock.

## 6. Errors: three tiers, and the distinction that matters most

```
business_outcome   the app gave a legitimate answer that is not the happy path
recoverable        a declared condition with a declared, budgeted response
hard               stop; either escalate or fail with enough context to debug
```

The `failed` arm is further classified — `descriptor_unresolvable`,
`checkpoint_failed`, `success_condition_failed`, `application_error`,
`policy_denied`, `recovery_exhausted`, `unclassified_condition` — because these
route to different people. `application_error` means the bank's software fell
over and no amount of re-recording fixes it. `success_condition_failed` means
every step did what it claimed but the end state is not the recorded one, which
is the signature of an un-overlaid tenant. Collapsing those into "failed" sends
the wrong person to investigate.

`unclassified_condition` is the default, and deliberately so. On this surface,
proceeding from a screen you cannot identify is how you act on the wrong
member's account.

**The bug this taxonomy caught.** Detectors ran after every step but not at the
point the run's overall verdict was reached. So a 503 inside the nested accounts
frame — arriving *after* the last step's checkpoint had already passed on the
outer route — was reported as `success_condition_failed`: "your recording is
wrong", for what was actually a transient server error. It is now
`evidence/05-replay-recovers-from-transient`, and it recovers.

## 7. Human-in-the-loop: control transfer, not a pause

An escalation that just stops and files a ticket throws away the expensive
thing: a live, authenticated session already deep inside a flow. So escalation
here is a transfer of control over that session.

A `SessionControl` lease has **three** states, and the third is the one that is
easy to omit:

- `automation` — the engine may act
- `awaiting_operator` — the engine has stopped and let go; **nobody has arrived**
- `operator` — a human has claimed the session and is driving it

I started with two and a test caught the consequence. With only
`automation | operator`, "the engine stepped back" and "a human is in control"
are the same value — so any console could dispatch clicks into a live banking
session on the strength of the automation merely having stopped, with no recorder
installed and nothing attributing the actions to a person. The brief asks for a
way to know who is, *or should be*, in control. That is two questions, so it
needs three states.

The lease is enforced inside the policy gate rather than by convention in the
executor, which means there is exactly one place that answers "may I act".

**What the human did is recorded, in the automation's own vocabulary.** Clicks
and keystrokes are captured as role + accessible name + frame path — not
selectors, not coordinates — because that is the only form from which captured
human work could later be promoted into a proposed artifact patch. Record a click
as `div.x > button:nth-child(2)` and that door is closed forever.

That capture was broken in a way worth mentioning: the first version buffered
events in a page-scoped array and drained them at handback. In this app an
operator's click *navigates the frame*, which destroys the buffer — so it lost
every action that mattered and kept only the inconsequential ones. Events are
now pushed out over a binding as they happen.

Values are never captured verbatim. A field's content is recorded as a length
and a class, because an operator resolving a stuck run is by definition typing
into a live banking system.

**Resume re-observes.** The executor re-enters at the step the operator
nominates, re-reads the screen, and re-checks that step's precondition before
touching anything. It does not navigate to the entry point, which would discard
the human's work and land on a screen the remaining steps do not expect. An
unknown resume step is rejected outright rather than silently restarting the
flow — the failure mode there is re-running a write.

## 8. Heterogeneity: overlays, not re-recording

Twenty apps, hundreds of institutions, each on a slightly different build. The
naive answer is one recording per (institution, flow), which is
hundreds-of-thousands of artifacts nobody can review.

Instead: one recording per (vendor product, flow), plus a small per-tenant
**overlay** that patches only what differs. Summit FCU's overlay for the savings
lookup patches four things — two field labels, a column header, a row key — and
does not restate the flow. Their sub-account overlay additionally *inserts* a
step, because their configuration interposes a review screen with an explicit
commit, and declares that step `irreversible`, which is what routes it to a
human.

Overlays are keyed by `(vendorProduct, tenant, capabilityId)`. I originally keyed
them by `(vendorProduct, tenant)` and the catalog tests exposed it immediately:
one institution runs many capabilities on one product, so that key collapses all
of their specializations into a single document — the exact unreviewable patch
swamp that separate overlay files exist to prevent.

### Stability is per tenant

A capability can be rock-solid where it was recorded and broken at a tenant whose
overlay is half-finished. One global success rate averages those together and
hides the only fact anyone wanted, and worse: it means *probing* a capability
against a new tenant — the only way to discover what an overlay needs to cover —
degrades its reputation everywhere it already works. So the artifact tracks the
headline figure and a per-tenant breakdown, and `catalog describe` shows both.

Stability also only counts what it should. A `business_outcome` is the flow
working correctly, so it counts as a success — otherwise probing for absent
members would look like a regression. An `application_error` and a
`policy_denied` are ignored entirely, because neither is evidence about the
recording. A run with a fault deliberately injected is not recorded at all.

## 9. The catalog: where an agent actually meets this

Three questions, because those are the three an agent has: what exists, what
does this one need, run it.

```bash
cua catalog list
cua catalog describe member.savings_balance --json    # JSON Schema, registrable as a tool
cua catalog invoke member.savings_balance --args '{"memberId":"10042"}'
```

Also over HTTP, with status codes that mean different things: `403` for a refusal
(retrying is pointless), `400` for a malformed call (correcting it is not), `200`
for every arm of the result union that reached the application — including
`business_outcome` and `escalated`, because both are legitimate answers and
neither is an HTTP-level failure.

Nothing in the published contract mentions frames, selectors, or browsers; a test
asserts that. The day a flow moves from a legacy web app to a desktop app, the
contract does not change.

`escalated` being returned to an agent is intentional. An agent that asks for
something requiring human judgement should be told that a human was asked, with
the intervention id — not left holding a timeout.

## 10. Evidence and observability

One JSONL record per step. Every record carries the resolved locator rung, the
lease owner, the gate's verdict and risk classification, timing, and the
checkpoint result. Redaction is structural: the logger cannot be handed an
unredacted value, because the `Redactor` sits between it and the raw world.
Screenshots are masked before they are encoded, not after.

`evidence/` holds 20 runs covering discovery, all four result classes, three
recoveries, a hard failure, a policy denial, cross-tenant before and after an
overlay, the human handoff, a stability sweep, promotion, and the catalog. It is
regenerated by `npm run evidence`, which normalizes lifecycle state first so the
output does not depend on how many times it has been run. The index is generated
from the transcripts rather than written by hand, because a hand-written index
that claims a run succeeded when the transcript disagrees is worse than none.

---

## Deliberate cuts

Things a production system needs that are not here, listed so it is clear they
were decisions rather than oversights.

**Auth and multi-tenancy on the catalog API.** No tokens, no tenant resolution
from a caller identity, no rate limiting. Real work, and orthogonal to what the
brief is assessing.

**Concurrency.** One session per process, no scheduler, no queue, no idempotency
keys. The interesting question — what happens when two agents invoke the same
write capability for the same member simultaneously — is real and unaddressed.
The pieces are in place to answer it (the lease is already a real lease) but the
scheduler is not.

**Promoting captured human actions into a patch.** The capture is in the right
vocabulary and the handback plumbing exists. Turning a handful of captured
actions into a proposed overlay diff, with a human approving it, is the obvious
next step and is not built. This is the gap I would close first.

**Artifact storage.** A directory of JSON files, committed to git. For a corpus
that is small, slow-changing and human-reviewed, git already has the workflow
you want — diff, approve, roll back. A database would be the wrong tool at this
size and the brief explicitly does not reward scaling infrastructure.

**A real desktop surface.** Argued for above, not implemented. The port makes it
a swap; claiming it is proven without having done it would be dishonest.

**Model-side robustness in discovery.** The loop has a stall detector, a step
budget, and a policy gate, but a genuinely adversarial or badly-behaved model
would find more edges. Discovery is the part that is *allowed* to fail, so it got
proportionally less hardening than replay.

---

## What I would look at first if this were mine to run

1. The promotion path above — captured human work → proposed overlay → review.
   Right now every escalation costs a human the same amount, forever.
2. Drift as a first-class alert rather than a log field. The data is already
   there; nothing watches it. A capability resolving on rung 4 for a week is a
   scheduled outage nobody has noticed yet.
3. A per-tenant conformance suite. Before pointing a capability at a new
   institution, run its read-only steps and diff the observed screens against
   the recording. Turns "find out by breaking" into "find out by asking".
