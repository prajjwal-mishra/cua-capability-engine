# Defence notes

The adversarial read of my own work. If I were reviewing this submission, these
are the things I would push on, in roughly the order I would push on them.

`README.md` says what it does. `REPORT.md` says why. This file says where it is
weak.

---

## The three questions I would ask first

### "Show me that the model really is out of the replay loop."

`tests/no-llm-import.test.ts` walks the import graph reachable from
`src/replay/executor.ts` and fails if it reaches the LLM client. That is a
structural guarantee, not a convention.

But be precise about what it does *not* prove: the model shaped every descriptor,
every checkpoint and every recovery in the artifact. Replay is deterministic
given the artifact; the artifact is a model's output that a human is expected to
review. The honesty of the whole system rests on that review actually happening,
and this repo cannot make it happen. What it can do — and does — is make the
artifact small enough and plain enough to review, and refuse to run an unreviewed
one unattended.

### "What happens when you are wrong about what is on screen?"

It stops. `unclassified_condition` is the default for any screen no detector
recognises, and there is no code path that guesses and continues.

The uncomfortable follow-up: my detectors were written against the app I also
wrote. On a real system of record I would be discovering outcome classes for
months, and every one I had not yet declared would arrive as
`unclassified_condition` — safe, but an escalation, which costs a human. The
system degrades toward "ask a human about everything" as the app gets stranger.
That is the correct direction to fail in, but it is a cost curve, not a solved
problem.

### "Is the human-in-the-loop real, or a queue?"

Real, and this is the part I would most want examined. Run `npm run demo:handoff`
and read `evidence/14-escalation-human-handoff`.

The lease is three-state and enforced inside the policy gate, so exactly one
party may act at any instant. The operator drives the *same* browser session the
automation was driving. Their actions are recorded as role + accessible name +
frame path, in the same vocabulary the artifact uses. The resume re-observes the
screen and re-checks the resumed step's precondition rather than assuming
anything.

What is missing is the payoff: captured human actions are recorded in a form that
*could* become a proposed artifact patch, and nothing turns them into one. So
every escalation of the same cause costs a human the same amount, forever. That
is the single biggest gap in the submission and I would rather say so than let it
be found.

---

## Where it would break first

**Drift is measured and nothing watches it.** The run log records which locator
rung resolved, and a capability resolving on rung 4 instead of rung 1 is a
scheduled outage that has not happened yet. There is no alert, no threshold, no
dashboard. The signal is the hard part and it exists; the plumbing is the easy
part and it does not. At any real scale this is what I would build next after the
promotion path.

**Concurrency is unaddressed.** One session per process. Two agents invoking the
same write capability for the same member at the same time would both proceed.
The lease is a real lease over a *session*, not over a *member record*, and the
second is what you would actually need. I know where it goes; it is not there.

**The recovery pack is shared, and that is load-bearing.**
`config/recovery-pack.corevantage-backoffice.json` is per vendor product, which
is right — session timeouts and maintenance banners are properties of the
product, not of one flow. But it means a bad edit to that file degrades every
capability on that product simultaneously, and nothing versions or gates changes
to it the way the artifact lifecycle gates capabilities. It should have its own
approval state. It does not.

**Overlays can drift from their base.** An overlay declares
`basedOn.versionRange` and `applyOverlay` rejects a mismatch, so a stale overlay
fails loudly rather than silently mis-patching. But there is no tooling that
tells a tenant's overlay it is *about* to go stale when a new capability version
is published. At hundreds of institutions that becomes an operational problem
long before it becomes a technical one.

**Perception cost.** `observe()` walks the accessibility tree of every frame on
every step. On this app that is milliseconds. On a real back office with deep
framesets and thousands of grid rows it would not be, and there is no incremental
observation, no caching, no scoping of the snapshot to the frame a step cares
about. The `Surface` port is the right place to fix it and it is not fixed.

---

## Choices I would defend, not apologise for

**Artifacts are verbose.** 542 lines for a three-step flow. Every rung of every
ladder, every detector, every recovery, spelled out. A reviewer approves exactly
the document the engine executes; the moment there is a compilation step between
them, the review is of something else. I would make the same call again.

**The target app is deliberately hostile.** Framesets, nested tables, `<font>`
tags, non-semantic markup, control ids like `ctl00_txt7`, and seven injectable
failure modes. Building a pleasant app to automate would have been faster and
would have proven nothing. The heuristic name-resolution layer only exists
because the app forces the question that every real back office forces.

**Injections are armed out of band.** `POST /__control/inject`, not a query
parameter. If the fault hook lived in the URL, a replay demonstrating "session
timeout" would be navigating to a *different route* than the one the capability
recorded, and the demonstration would be worthless. The automation drives
byte-identical URLs whether or not a fault is pending, and the allowlist denies
it `/__control/**` so it cannot reach the hook itself.

**Tests drive a real browser against the real app.** Slower, and it is the point.
The interesting defects in this system are things like "an operator's click
navigated the frame and destroyed the buffer holding their recorded actions" —
which is exactly the class of bug a mocked surface cannot produce, and which a
mocked surface would have let me ship.

**Stability ignores most failures.** Business outcomes count as successes;
application errors, policy denials and injected faults are not counted at all.
This looks like grade inflation until you see the alternative: with naive
counting, demonstrating error handling degraded the capability being
demonstrated, and probing for a non-existent member looked like a regression. The
number has to measure one thing — do the locators resolve and the flow execute —
or it measures nothing.

---

## Bugs my own tests and evidence runs found

Listed because how a system was debugged says more than how it was designed, and
because every one of these was a wrong belief I held until something disagreed.

1. **Human actions were lost exactly when they mattered.** The recorder buffered
   events in a page-scoped array. An operator's click navigates the frame, which
   destroys the buffer — so it captured inconsequential clicks and dropped every
   action that moved the flow forward. Now pushed out over a binding as they
   happen.

2. **Two lease states were one too few.** `automation | operator` made "the
   engine stepped back" indistinguishable from "a human is in control", which let
   a console dispatch clicks into a live session with no recorder installed and
   nothing attributing them to a person. A test asserting a 409 caught it. Now
   three states.

3. **The stall detector could not see a form being filled.** It fingerprinted
   screens by role and name and ignored control *values*, so typing into three
   fields looked like three identical screens and it declared the run stuck. This
   is why the sub-account discovery run stalled — and a multi-field form is the
   commonest back-office flow there is.

4. **A 503 in a nested frame was blamed on the recording.** Detectors ran after
   every step but not at the point the run's verdict was decided. A transient
   error inside the accounts iframe, arriving after the last checkpoint had
   already passed, was reported as `success_condition_failed` — "your artifact is
   wrong" — for a server error. Now `evidence/05`, and it recovers.

5. **`contentRoute`'s "I cannot tell" fallback was `[]`.** Downstream, `[]` means
   "the main frame only" and `undefined` means "any frame". So an ambiguous frame
   compiled into a success condition that could never pass. Two different
   concepts sharing a representation.

6. **Overlays were keyed on (product, tenant).** One institution runs many
   capabilities on one product, so that key collapsed all of their
   specializations into one file — the unreviewable patch swamp separate overlay
   files exist to prevent.

7. **The approval gate deadlocked promotion.** Unattended writes need approval;
   approval needs a proven replay; a write capability could not replay without
   approval. Resolved by supervised shadow replay, which a catalog caller cannot
   claim for itself.

8. **The catalog server reported the port it was asked for, not the one it
   bound.** Harmless until you pass `0` to mean "any free port", at which point
   the URL it hands back is unusable.

9. **The operator console died on `EADDRINUSE` via an unhandled `error` event.**
   A console left over from an abandoned run holds the default port; the crash
   stranded a live browser with the lease released and nobody able to claim it.

10. **An attended run waited forever.** Now bounded, and the intervention stays
    queued for the standalone console to pick up.

11. **Failure payloads restated the expectation inside the observation** —
    `expected: X / observed: X — no cell "Savings"` — and carried less context
    than an escalation did. A failure is not a lesser event than an escalation;
    it is the one nobody is coming to look at live. Both now carry the screen
    text, a screenshot, and a remediation line where the classification implies
    one.

12. **Human actions were logged twice** once the console took over that
    responsibility from the CLI — doubling every entry in the audit trail for the
    actions most worth auditing.

13. **A committed artifact contained a member's account number.** The read
    capability's extraction descriptor anchored the balance cell on its
    neighbours, and rung 2 assumes the neighbour is a label. In a grid it is a
    sibling value, so the artifact shipped `rowKey: "4417-99820-01"` — a locator
    that only ever matches member 10042, carrying their account number into a
    file that gets committed and code-reviewed. I found this reading the
    generated artifact rather than the code, which is the argument for artifacts
    being human-readable in the first place. Two fixes: rung 2 is suppressed for
    extraction inside a grid, and the compiler drops any rung whose anchor text
    trips the redactor. Worth noting what this was *not*: the redaction stage was
    working correctly on every path it covered — logs, prompts, snapshots. The
    leak was a path nobody had thought to route through it.

---

## If you have ten minutes

```bash
npm install && npx playwright install chromium
npm run app                      # terminal 1

npm run cua -- replay --capability member.savings_balance --input memberId=10042
npm run demo:handoff             # the control transfer
npm run cua -- catalog describe member.savings_balance
```

Then read `evidence/README.md`, and
`capabilities/member.savings_balance@1.0.0.json` — specifically one step's
`strategies` array and the `knownOutcomes` block. Those two are where the design
either convinces you or does not.
