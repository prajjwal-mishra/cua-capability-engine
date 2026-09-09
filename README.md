# cua-capability-engine

Gives an AI agent hands on a UI that has no API — then takes the model out of
the loop.

A model explores a hostile legacy web app to work out how to complete a task.
The successful run is compiled into a **capability artifact**: a typed, versioned,
reviewable document describing what to do and how to know it worked. From then
on the flow replays deterministically, with no model in the decision loop, and
is callable by name with typed arguments.

The interesting parts are not the happy path. They are what happens when the app
misbehaves, when the screen has quietly changed, when the next click is
irreversible, and when the same flow has to run at a second institution whose
build of the same software is labelled differently.

---

## Try it in five minutes

Requires Node 20+. No API key needed for anything except `discover`.

```bash
npm install
npx playwright install chromium
npm run app            # the target app on http://localhost:4000
```

In a second terminal:

```bash
# 1. Replay a recorded capability. No model involved.
npm run cua -- replay --capability member.savings_balance --input memberId=10042

# 2. A member who does not exist. Note this is an ANSWER, not a crash.
npm run cua -- replay --capability member.savings_balance --input memberId=99999

# 3. Break the app underneath it, on purpose, and watch it recover.
npm run cua -- replay --capability member.savings_balance --input memberId=10042 \
  --inject transient_503 --inject-path /frame/member

# 4. What an agent sees.
npm run cua -- catalog list
npm run cua -- catalog describe member.savings_balance

# 5. Invoke it like a function.
npm run cua -- catalog invoke member.savings_balance --args '{"memberId":"10042"}'

# 6. Project the artifact into a Playwright snippet (stretch).
npm run cua -- emit --capability member.savings_balance --format page-object
```

Add `HEADLESS=1` to any command to skip the browser window.

Every one of these is captured in [`evidence/`](./evidence) with its full
transcript, so you can compare against a run we did.

### Demo path (discover, then replay)

The committed artifacts already came from a live model run
([`evidence/00-discovery`](./evidence/00-discovery)). To run that thread yourself:
copy `.env.example` to `.env` and set `CUA_LLM_API_KEY` (any OpenAI-compatible
endpoint). The rest of the system does not need a key.

```bash
npm run cua -- discover \
  --goal "look up member 10042 and read their current savings balance" \
  --target http://localhost:4000 --tenant riverbend-cu --input memberId=10042

npm run cua -- replay --capability member.savings_balance --input memberId=10042
```

What is real versus stubbed: discovery, replay, the policy gate, same-session
handoff, and the catalog are live against `apps/legacy-cu/`. The operator desk
is a real control-transfer surface, not an embedded co-browsing stream (headed,
you drive the visible window; headless, the desk injects clicks through the same
API). There is no desktop driver — that is a documented cut. Replay has no
model in the loop, by design.

### The two demos worth your time

**A human takes over a live session and hands it back.** The sub-account flow at
Summit FCU ends in an irreversible commit, which policy refuses to click. The run
stops, releases the browser session, and waits. An operator takes control, reviews
the request, commits it by hand, and hands back — and the automation resumes *on
the same session* and verifies.

```bash
npm run demo:handoff
```

The "operator" there is a script driving the console's own HTTP API, so the demo
is reproducible. It prints a console URL; open it and do it by hand instead if you
prefer. ([evidence](./evidence/14-escalation-human-handoff))

**The same capability at a second institution.** Summit FCU runs the same vendor
product as the tenant this was recorded against, relabelled. First without an
overlay, then with one:

```bash
npm run cua -- replay --capability member.savings_balance --input memberId=10042 \
  --variant variant-b --no-escalate      # fails cleanly, and says why
npm run cua -- replay --capability member.savings_balance --input memberId=10042 \
  --tenant summit-fcu                    # succeeds, via a small overlay
```

The overlay is [one file](./overlays/corevantage-backoffice/summit-fcu/member.savings_balance.json)
patching four things — two field labels, a column header and a row key. The flow
itself is not duplicated, which is the whole argument for overlays over
re-recording per tenant.

([evidence](./evidence/10-cross-tenant-without-overlay), [evidence](./evidence/11-cross-tenant-with-overlay))

### Open the desk

Two pages. Same visual language, no build step.

```bash
npm run desk             # http://localhost:4100  — intervention queue and live takeover
npm run catalog:serve    # http://localhost:4200  — typed contracts, invocable from the page
```

The desk is what an operator sees when a run escalates. The catalog is what an
agent sees, rendered so a human can read the contract without curling it. Invoke
from the catalog page hits the same `POST /capabilities/:id/invoke` an agent
would — drafts and writes still refused unless you opt in.

---

## How it works

```
                     ┌──────────────┐
   goal + inputs ───▶│  discovery   │  model in the loop, once
                     │     loop     │
                     └──────┬───────┘
                            │ successful trace
                     ┌──────▼───────┐
                     │   compiler    │  generalize: values → params,
                     └──────┬───────┘  URLs → route patterns
                            │
                     ┌──────▼───────────────┐
                     │ capability artifact  │  typed, versioned, reviewable
                     └──────┬───────────────┘
                            │            ┌──────────────┐
                     ┌──────▼───────┐    │ tenant       │
   typed args ──────▶│    replay    │◀───│ overlay      │
                     │   executor   │    └──────────────┘
                     └──┬────────┬──┘
                        │        │
          ┌─────────────▼─┐   ┌──▼──────────────┐
          │ policy gate   │   │ escalation      │
          │ every action  │   │ human takes the │
          └─────┬─────────┘   │ live session    │
                │             └─────────────────┘
          ┌─────▼─────────┐
          │ Surface port  │  observe() / act()
          └─────┬─────────┘
                │
          ┌─────▼─────────┐
          │ the actual UI │
          └───────────────┘
```

Everything above the Surface port is expressed in roles, accessible names and
frame paths — never CSS selectors or coordinates. That is what lets the same
artifact shape describe a desktop app later.

### Layout

| path | what lives there |
| --- | --- |
| `apps/legacy-cu/` | the target: a deliberately hostile 2003-era back office, framesets and all, with seven injectable failure modes |
| `src/surface/` | the Surface port and its Playwright implementation; accessibility-tree-first perception |
| `src/locator/` | `ElementDescriptor` and the resolution ladder |
| `src/artifact/` | the capability schema, versioning, storage, tenant overlays |
| `src/discovery/` | the model-driven loop, its tools, and the stall detector |
| `src/recorder/` | compiling a successful trace into an artifact |
| `src/replay/` | the deterministic executor. No model reaches this directory, and a test enforces it |
| `src/policy/` | allowlist, risk classification, the gate, redaction |
| `src/escalation/` | the session lease, intervention queue, and operator desk |
| `src/catalog/` | the agent-facing surface: list, describe, invoke — JSON and a page |
| `src/emit/` | project an artifact into a Playwright page object / test |
| `src/desk/` | shared chrome for the two human-facing surfaces |
| `evidence/` | 20 real runs, regenerable with `npm run evidence` |
| `docs/` | design defence and the questions this system does not answer yet |

### The result contract

Every replay returns exactly one of four things, and the difference is
structural rather than a string to parse:

| status | means | exit |
| --- | --- | --- |
| `success` | the flow completed; here are the declared outputs | `0` |
| `business_outcome` | the application gave a legitimate answer that is not the happy path, with a code | `10` |
| `escalated` | we stopped safely, a human has been asked, and here is how to resume | `20` |
| `failed` | something is wrong with the automation or the app, with enough context to debug it without a repro | `30` |

The separation of the second from the fourth is the point. "No such member" is an
answer. A caller that has to read an exception message to learn that will
eventually confuse a genuine outage for a missing member, or the reverse.

---

## What to read to judge this

- **[REPORT.md](./REPORT.md)** — the design write-up, under the seven headings
  the brief asked for.
- **[docs/defense-notes.md](./docs/defense-notes.md)** — the honest version: what
  is weak, what would break first at scale, and what I would do next.
- **[capabilities/member.savings_balance@1.0.0.json](./capabilities/member.savings_balance@1.0.0.json)**
  — a real artifact, produced by a real model run. The locator ladders and the
  declared outcomes are the parts worth looking at.
- **[evidence/README.md](./evidence/README.md)** — 20 runs, indexed, with what
  each one is meant to prove.

## Development

```bash
npm run typecheck
npm test               # launches real browsers against the real app
npm run check          # both
npm run evidence       # regenerate evidence/ from scratch (needs the app running)
```

The test suite runs the real Playwright browser against the real target app
rather than mocking the surface. Mocking it would test the mock: the interesting
failures in this system are things like "an operator's click navigated the frame
and destroyed the buffer holding their recorded actions", which no fake surface
would ever produce.
