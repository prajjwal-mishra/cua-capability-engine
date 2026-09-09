# Design report

## Architecture

I split discovery and replay into two programs. They share the artifact file
and nothing else.

Discovery can wander and it can fail. It has a model. Replay does not: same
artifact, same inputs, same screen, same actions. I enforced that with
`tests/no-llm-import.test.ts`, which walks the import graph from `src/replay/`
and fails the build if a model client is reachable. The obvious shortcut is to
ask the model when a locator goes ambiguous. I did not take it. A recording you
cannot replay without a model is not reviewable.

The target is a local hostile credit-union back office I built for this
(`apps/legacy-cu/`). The brief allows that. I wanted iframes, table layouts, no
test IDs, and faults I can inject on demand. A public cart demo would not give
me session timeouts, permission denials, or a second "tenant" with relabelled
fields. The cost is real: detectors match copy I also wrote. On a core I have
never seen, unclassified screens would escalate more often. That is the right
failure mode, and it is a cost curve, not something this take-home pretends to
close.

The engine talks to a `Surface`: roles, accessible names, frame paths.
Playwright is the current driver. Perception prefers the accessibility tree,
then a heuristic pass for markup with no semantics (most of this target). Each
`UIElement` records `nameSource` so an `aria-label` (0.95) is not scored like a
name scraped from a neighbouring `<td>` (0.65).

That is also the desktop story. UIA/AX already speak role and name; the frame
path becomes a window/pane path. The heuristic layer is DOM-shaped and would
stay in `WebSurface`. Selectors do not go in the artifact.

A step does not store `#ctl00_btnSearch`. It stores a ladder, filled in at
record time:

| rung | strategy | survives |
| --- | --- | --- |
| 1 | role + accessible name | a re-skin |
| 2 | label anchor (textbox in the row labelled *Member ID*) | markup churn |
| 3 | table cell (column header × row key) | row reordering |
| 4 | frame + role + ordinal | renames |
| 5 | structural path | almost nothing |
| 6 | recorded geometry | diagnostic only; off unless policy opts in |

Resolution needs a unique match. If a rung hits three elements, we do not pick
one. The log always records which rung won. Sliding from rung 1 to rung 4
without anyone noticing is how these systems die in production.

Outputs are addressed by relation, not by the value being read. Locating "the
cell named `$8,241.17`" only works for one member. In a data grid I also drop
rung 2: the neighbour is another value, not a label. The first compiled
artifact used `4417-99820-01` as an anchor. If a rung cannot be written without
someone's data in it, it is omitted. Redacting it would leave a locator that
never matches.

The catalog and the desk are HTTP faces on this engine. One is how an agent
calls a capability by name. The other is how a person takes the session when
the engine stops.

I considered CSS selectors as the recorded target, and a single process with a
mode flag. Both leak. Both went.

## Artifact schema

Zod is the schema: runtime checks, TypeScript types, and the JSON Schema the
catalog publishes. Facts in the artifact come from snapshots, not from whatever
the model said in the transcript. The transcript stays in `evidence/`.

A capability has:

- `inputs` / `outputs` as JSON Schema, each with a `sensitivity` tag
- `steps`: intent, action, `ElementDescriptor`, optional `$param`,
  precondition, checkpoint, wait/retry, `risk`
- `successCondition`
- `knownOutcomes` with detectors (`member_not_found`, `permission_denied`)
- `recoveries` (dismiss a banner, re-auth, retry a 503), with a budget
- `provenance`, `lifecycle` (`draft` | `approved` | `deprecated`), stability

The compiler rewrites recorded literals that match an input to
`{$param: "memberId"}`, and `/frame/member/10042` to `/frame/member/:memberId`.
Otherwise you have a tape of one member, not a capability.

The savings lookup is 542 lines. That is ugly. I kept it because the document
a person approves is the document that runs. A compiled IR in between means
the review is of something else.

Detectors and recoveries are JSON. You can read what an approved capability
will tolerate without opening `src/`.

Tenant patches are not inside the base file. A base that re-versions every
time one credit union relabels a button gets hundreds of editors. Overlays
are separate, keyed `(vendorProduct, tenant, capabilityId)`.

## Determinism & error handling

Replay never calls a model. Inputs are checked against the artifact schema
before a browser starts. Each step: resolve the ladder, policy check, act,
wait on a condition (not `sleep(n)` as the main wait), checkpoint, then run
detectors.

The result is a union, not a message to parse:

```
success            outputs, evidence
business_outcome   typed code (member_not_found, permission_denied, ...)
escalated          intervention id
failed             step, expected, observed, classification, screenshot
```

Unclassified screens are hard failures. Guessing and clicking is how you hit
the wrong member.

`failed` is split further (`descriptor_unresolvable`, `checkpoint_failed`,
`success_condition_failed`, `application_error`, `policy_denied`,
`recovery_exhausted`) because those pages go to different people. A 503 is
the host. A relabelled grid at a tenant with no overlay is the recording.

I got that wrong once. Detectors ran after each step but not when the run
decided its verdict. A 503 in the nested accounts iframe, after the last
outer checkpoint had already passed, came back as `success_condition_failed`.
They run at the verdict now (`tests/replay.test.ts`). `evidence/05` is a 503
cleared mid-step; `evidence/06` and `evidence/07` are the interstitial and
the session timeout.

`--stability N` writes a per-tenant flake rate. `business_outcome` counts as
the flow working. Injected faults and policy denials do not count; they are
not about the locators.

I did not add "ask the model for this one step," and I did not dump every
unhappy path into `failed`.

## Heterogeneity & multi-tenant

Built against one hostile web app. A second surface is a new `Surface`, not a
new artifact. `DesktopSurface` would map UIA/AX into the same `UISnapshot` and
the same `SurfaceAction` union. Replay, locators, policy, catalog stay put.

The scale problem is hundreds of institutions on ~20 apps, many of them the
same vendor product with different labels. Recording per (institution, flow)
does not review. Recording per (vendor product, flow) plus a small overlay
does.

Summit FCU's savings overlay patches four strings (two labels, a column
header, a row key). Their sub-account overlay inserts a step for the review
screen they interpose, marked `irreversible`, which is why it goes to a
human. `evidence/10` is variant-b with no overlay: ladder drops, drift is
flagged, run fails. `evidence/11` is the overlay.

Every resolved step logs the rung that won. `cua drift report` walks
`run.jsonl` trees, aggregates those flags, and exits non-zero when the rate
crosses a threshold (default: any drift fails). That is the watch: not a
pager, a check you can put on a schedule. A week of rung-4 hits is still an
outage that has not fired yet - now at least the check fails before the
click does. Stability stays per tenant so a probe at a new shop does not
trash the number where the recording already works.

## Escalation & handoff

Filing a ticket throws away a live, authenticated session. This is a handoff
of that session.

The lease is three states:

- `automation` - the engine may act
- `awaiting_operator` - it has stopped; nobody has taken it
- `operator` - a person has claimed it

With two states, "we stepped back" and "a human is driving" looked the same,
and a console could click into a live page with no recorder. I found that
with a 409 test.

Stuck means: locator miss, unclassified screen, policy block on a required
action, recovery exhausted, stall, or `request_human_help`. The intervention
has capability, goal, step, reason, redacted screen text, a screenshot, the
full flow (so the operator can pick a resume point), and a resume token.
Files under the run directory.

Takeover is the same Playwright page. Lease flips to operator, then the
recorder is installed. Events go to Node as they happen. Buffering in the
page lost every useful click: those clicks navigate the frame and kill the
buffer. Typed values are not stored raw. On handback we observe again and
check the nominated step's precondition. We do not assume the page is where
we left it, and we do not send the browser back to the entry URL (that
discards the human's work and can re-run a write).

Real: lease, same-session takeover, capture, resume. Mocked: no embedded
video stream. Headed, you drive the window. Headless, the desk posts clicks
through the same API. Production is CDP screencast or a remote browser.
Lease and recorder stay.

Captured actions are role + name + frame path. `cua overlay propose` turns
them into a draft overlay. It will not overwrite an existing overlay or
lower risk. Someone still has to apply it. Until then, the same stop costs a
person every time - that is intentional, not unfinished wiring.

## Safety

Every dispatched action goes through `PolicyGate.check`. Discovery and replay
only see a `GuardedSurface`. The desk holds the raw page because the operator
is not the bot, but `/api/live/act` still calls `check` with
`actor: "operator"`. Holding the lease lets you confirm irreversible. It does
not let you leave the allowlist or type into a forbidden field.

Allowlist is config, per app: origins, route patterns, action types, roles,
forbidden field names. Default deny.

`read_only` is allowed. `reversible_write` needs `--allow-writes`, and
unattended also needs an approved artifact. `irreversible` always escalates.
Review can raise a step's risk, not lower it. Typing is read-only; the submit
carries the write. If typing were a write, every lookup would need
`--allow-writes` and people would pass it by habit.

Writes and approval deadlocked (unattended writes need approval, approval
needs a proven replay, a draft could not replay). `--attended` is a
supervised shadow run. Catalog callers cannot set it.

Redaction sits in front of logs, artifacts, and screenshots: regexes (SSN,
Luhn PAN, account numbers, email, phone, DOB) plus tokens for `pii`/`secret`
inputs, on discovery and replay. Screenshots mask flagged boxes before
encode. Regexes miss names and balances. Masking is only as good as the
flags. An allowlist will not stop a permitted click on the wrong row. I
would add field types from the app's own schema, dual-control on
irreversible steps, and an audit log that leaves the box.

## Cuts

**LLM on replay failure.** The stretch I skipped on purpose. A bounded "just
this step" call is the hole the discovery/replay split exists to close.
Ambiguous screen goes to a human.

**Stretch picks.** The brief said at most one or two. I treated
cross-tenant overlays and draft→approved (with `--stability N`) as the ones
that load-bear the production story. The catalog is how an agent invokes a
capability by name - without it, "agent-invocable" is a claim. `cua emit` and
`cua overlay propose` fell out of the same role+name vocabulary; they are
projections, not a second engine. Replay still runs the JSON.

**Applying overlay proposals automatically.** A draft is the product. Auto-
apply would silently change risk and locators under an approved capability.

**Desktop driver.** The port is there. I have not run UIA/AX, so I am not
claiming it works.

**Auth on the catalog, locking a member record, a pager wired to drift,
a scheduler.** One browser per process. Two agents can both write the same
member. The lease is on a session. `cua drift report` fails a check; it does
not page Slack. The brief does not want that plumbing from a take-home.
