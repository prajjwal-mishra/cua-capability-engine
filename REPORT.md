# Design report

The brief is under-specified on purpose. These are the decisions that followed,
and the alternatives I rejected.

## Architecture

Discovery and replay are two programs. They share the artifact and nothing else.

Discovery has a model in the loop, is allowed to wander, and is expected to fail.
Replay has no model, is fast, and is a pure function of `(artifact, inputs, screen)`.
`tests/no-llm-import.test.ts` walks the import graph from `src/replay/` and fails
the build if anything in it can reach the LLM client. The tempting failure is real:
replay hits an ambiguous screen and a model is sitting right there. Taking that
shortcut once destroys the only property that makes a recording worth keeping —
you cannot review it, regression-test it, or explain it to an auditor.

Everything above a `Surface` port speaks roles, accessible names, and frame
paths. Playwright is a driver, not the abstraction. Perception is
accessibility-tree-first with a heuristic fallback for markup that has no
semantics at all — on this target, most of it. `UIElement` records `nameSource`
so a name the app declared via `aria-label` (0.95) is not scored like a name
inferred from a neighbouring `<td>` (0.65).

That seam is what a desktop app would actually reuse. UIA/AX speak role and name
natively; the frame path becomes a window/pane path. The heuristic fallback is
DOM-shaped and would stay in `WebSurface`. I would rather pay that cost in one
file than leak selectors into the artifact.

A step never records `#ctl00_btnSearch`. It records an ordered ladder, every
rung that can be populated, scored at record time:

| rung | strategy | survives |
| --- | --- | --- |
| 1 | role + accessible name | a re-skin |
| 2 | label anchor (textbox in the row labelled *Member ID*) | markup churn |
| 3 | table cell (column header × row key) | row reordering |
| 4 | frame + role + ordinal | **renames** |
| 5 | structural path | almost nothing |
| 6 | recorded geometry | diagnostic only; never used unless policy opts in |

Resolution requires a unique match. Ambiguity is a failure, not a coin flip. The
rung that resolved is logged every time: silent success on a lower rung is the
most dangerous state in the system, and it is the one thing the log is designed
to make impossible to miss.

An output descriptor never keys on the value being read. "The cell named
`$8,241.17`" locates one member's balance. Extraction is addressed by relation.
In a data grid, rung 2 is also dropped: the neighbour is a sibling value, not a
label, and the first generated artifact shipped `4417-99820-01` as a locator
anchor. A rung that cannot be expressed without someone's data in it is omitted,
not redacted — a redacted anchor is a locator that can never match.

The operator desk and the catalog are HTTP faces on the same engine, not a
second product. The catalog is how an agent invokes a capability by name. The
desk is how a human takes the live session when the engine stops.

**Rejected:** putting the model in replay as a fallback. **Rejected:** CSS
selectors as the recorded target. **Rejected:** one process that both explores
and executes, with a flag switching modes.

## Artifact schema

Zod is the single source of truth: runtime validation, TypeScript types, and the
JSON Schema the catalog publishes. Mechanical facts come from recorded snapshots,
not from the model's memory. The transcript is evidence; the artifact is the
capability.

A capability declares:

- `inputs` / `outputs` as JSON Schema, each with a `sensitivity` tag
- `steps`: intent, action, `ElementDescriptor`, optional `$param` binding,
  precondition, checkpoint, wait/retry policy, declared `risk`
- `successCondition` — how to know the whole flow worked
- `knownOutcomes` — business answers (`member_not_found`, `permission_denied`)
  with detectors, so they are part of the contract
- `recoveries` — declared, budgeted responses (dismiss interstitial, re-auth,
  retry a 503)
- `provenance`, `lifecycle` (`draft` | `approved` | `deprecated`), stability

The compiler generalizes as it writes: recorded literals that match an input
become `{$param: "memberId"}`, and `/frame/member/10042` becomes
`/frame/member/:memberId`. A checkpoint that asserted a concrete member URL
would be a recording, not a capability.

Reviewability cost verbosity: 542 lines for a three-step lookup. A compact
format would be smaller. I chose the document a human approves and the document
the engine executes to be the same document. A compilation step between them
means the review is of something other than what runs.

Detectors and recoveries are data, not code. Approving an artifact means you can
read what it will tolerate without reading our source.

**Rejected:** embedding tenant overrides inside the base artifact. A base file
that re-versions every time one institution drifts gives one document hundreds
of editors. Overlays are separate files keyed by
`(vendorProduct, tenant, capabilityId)`.

## Determinism & error handling

Replay never calls a model. Inputs are validated against the artifact's own
schema before a browser launches. Per step: resolve the descriptor ladder →
policy check → act → wait on a condition (never `sleep(n)` as the primary
mechanism) → verify the checkpoint → evaluate detectors.

The result is a discriminated union, because a string to parse is how "no such
member" becomes an exception six months later:

```
success            outputs, evidence
business_outcome   typed code (member_not_found, permission_denied, …)
escalated          intervention id; a human has been asked
failed             step, expected, observed, classification, screenshot
```

Three tiers, applied at every step. Anything unclassified is a hard failure.
Proceeding from a screen you cannot identify is how you act on the wrong
member's account.

`failed` is further classified (`descriptor_unresolvable`, `checkpoint_failed`,
`success_condition_failed`, `application_error`, `policy_denied`,
`recovery_exhausted`) because these route to different people. A 503 is not "your
recording is wrong." An un-overlaid tenant landing on a relabelled grid is.

That distinction was not free. Detectors originally ran after every step but not
at the run's verdict. A 503 inside a nested accounts frame, arriving after the
last checkpoint had already passed on the outer route, was reported as
`success_condition_failed`. Detectors now run when the verdict is decided;
`tests/replay.test.ts` pins it. `evidence/05` is a 503 recovered mid-step;
`evidence/06` and `evidence/07` are the interstitial and session-timeout
recoveries.

`--stability N` replays N times and writes a flake rate back onto the artifact,
per tenant. A `business_outcome` counts as success (the flow worked). Injected
faults and policy denials are not counted: they are not evidence about the
recording.

**Rejected:** "ask the model for this one step." **Rejected:** collapsing every
unhappy path into `failed`.

## Heterogeneity & multi-tenant

Implemented against one hostile web surface. Designed so a second surface is a
new `Surface` implementation, not a new artifact format. A `DesktopSurface`
would observe UIA/AX into the same `UISnapshot` and dispatch the same
`SurfaceAction` union. Replay, locators, policy, and the catalog would not move.

Hundreds of institutions run ~20 apps, many on the same vendor product,
relabelled. One recording per (institution, flow) is hundreds of thousands of
artifacts nobody can review. One recording per (vendor product, flow), plus a
sparse overlay, is the unit that can be reviewed.

Summit FCU's overlay for the savings lookup patches four strings — two field
labels, a column header, a row key — and does not restate the flow. Their
sub-account overlay *inserts* a step, because their build interposes a review
screen, and marks that step `irreversible`, which is what routes it to a human.
`evidence/10` is the same artifact on variant-b without an overlay: it degrades
to a lower rung, flags drift, and fails cleanly. `evidence/11` is the overlay.

Drift is measured as the rung that resolved. A capability that has been
resolving on rung 4 for a week is a scheduled outage. Nothing watches that
signal yet; the data is there. Stability is tracked per tenant so probing a new
institution does not damage the number where the recording already works.

**Rejected:** a global success rate. **Rejected:** forking the artifact per
tenant.

## Escalation & handoff

An escalation that files a ticket throws away a live, authenticated session
already deep in a flow. This is a transfer of control over that session.

The lease has three states, not two:

- `automation` — the engine may act
- `awaiting_operator` — the engine has stopped; **nobody has arrived**
- `operator` — a human has claimed the session

Two states made "the engine stepped back" indistinguishable from "a human is
driving," which let any console dispatch clicks into a live session with no
recorder installed. The brief asks who is, *or should be*, in control. That is
two questions.

Stuck is: unresolvable descriptor, unclassified screen, policy block on a
required action, recovery exhaustion, stall, or an explicit `request_human_help`.
The intervention carries capability, goal, step, reason, redacted screen text, a
screenshot, the whole flow (so the operator can name a resume point), and a
resume token. It is file-backed under the run.

Takeover is the same Playwright page. The lease moves to the operator first,
then a recorder is installed. Events are pushed to Node as they happen — an
in-page buffer was destroyed by the navigation that every useful click causes.
Values are not captured verbatim. Handback re-observes and re-checks the
nominated step's precondition; it never assumes the page is where it was left,
and it never navigates back to the entry point (that would discard the human's
work and re-run a write).

What is real: the lease, same-session takeover, human-action capture, resume.
What is mocked: no embedded co-browsing stream. Headed, the operator drives the
visible window; headless, the desk injects clicks through the same API. The
production version is CDP screencast plus input forwarding, or a WebRTC-backed
remote browser — same lease, same recorder.

Captured actions are in role + name + frame path, the vocabulary an overlay
patch would need. `cua overlay propose` turns them into a draft overlay.
Applying it is a review; the command will not overwrite an existing overlay or
lower risk on its own.

## Safety

One choke point. `PolicyGate.check` runs before every dispatched action.
Discovery and replay see only a `GuardedSurface`, which cannot be constructed
without a gate. The desk holds the raw surface because a human is not the
automation, but it still calls `check` with `actor: "operator"` before every
click. An operator who holds the lease may confirm an irreversible action —
that is the handoff — and still cannot leave the allowlist or type into a
forbidden field.

Allowlist (config, per app): origins, route patterns, action types, target
roles, forbidden field names. Deny by default.

Risk: `read_only` allowed; `reversible_write` requires `--allow-writes` and, for
unattended replay, an approved artifact; `irreversible` always escalates. A
reviewed artifact may raise a step's risk, never lower it. Typing is classified
read-only: the submit carries the risk, not the keystroke. Classifying typing as
a write would force `--allow-writes` onto every lookup and train people to pass
it always.

Approval deadlocked write capabilities (unattended writes need approval;
approval needs a proven replay; a draft could not replay). `--attended` is a
supervised shadow replay; a catalog caller cannot claim it.

Redaction sits between the raw world and every sink: pattern-based (SSN, Luhn
PAN, account numbers, email, phone, DOB) plus schema-driven tokens for
`pii`/`secret` inputs, on discovery *and* replay. Screenshots mask flagged
bounds before encode. Limits, plainly: regexes miss names and balances; masking
is only as good as the flagging; an allowlist cannot stop a semantically
wrong-but-permitted click. Next: field classification from the app's own schema,
dual-control for irreversible steps, an audit log shipped off-box.

## Cuts

**Assisted LLM fallback on replay failure.** The stretch goal I refused. A
bounded "just this step" model call is the shortcut the architecture exists to
make impossible. The answer to an ambiguous screen is a human, not a quieter
model. Recorded as a seam (escalation), not as a second decision loop.

**Auto-applying a proposed overlay.** `cua overlay propose` drafts the patch.
A reviewer still has to accept it, and risk is never lowered automatically.
Until that review happens, the same escalation costs a human the same amount.

**A real desktop surface.** The port makes it a swap. Claiming it is proven
without having done it would be dishonest.

**Catalog auth, concurrency, a scheduler.** One session per process. Two agents
invoking the same write for the same member would both proceed. The lease is
over a session, not a member record. The brief does not reward building that
infrastructure.

The brief said pick at most one or two stretch goals. Several sat on the
production path, so they shipped with the core: an agent-facing catalog,
draft→approved gating on stability, overlays as the cross-tenant demo, and
`--stability N`. `cua emit` projects an artifact into a Playwright snippet in
the same role+name vocabulary; it is a projection, not a second engine. Replay
still executes the JSON.
