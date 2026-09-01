# Evidence

Every directory here is the output of a real run against the real target app,
produced by `./scripts/make-evidence.sh`. Nothing is transcribed by hand.

Each case contains:

| file | what it is |
| --- | --- |
| `command.txt` | the exact command, so you can re-run it |
| `transcript.txt` | everything the command printed, plus its exit code |
| `run/` | the run's own evidence: `run.jsonl`, accessibility snapshots, screenshots |

Exit codes are meaningful and distinct — `0` success, `10` business outcome,
`20` escalated, `30` failed, `40` refused before running — so a caller can
branch on the outcome class without parsing text.

## Index

| # | demonstrates | result | exit |
| --- | --- | --- | --- |
| [`00-discovery`](./00-discovery) | The live model sessions that produced the committed capabilities. Each holds the run's full trace and the artifact it compiled to; `provenance.runId` in the artifact ties them together. | `2 capabilities compiled from live model runs` | — |
| [`01-replay-success`](./01-replay-success) | The happy path, with no model in the decision loop. | `success — savings_balance=$8,241.17` | `0` |
| [`02-replay-business-outcome`](./02-replay-business-outcome) | A member that does not exist. This is an ANSWER with a code, not an exception — the distinction the whole result contract exists to make. | `business outcome — member_not_found: No member matches the supplied identifier.` | `10` |
| [`03-replay-permission-denied`](./03-replay-permission-denied) | The same shape for an authorisation refusal: the application said no, and that is data. | `business outcome — permission_denied: The operator is not authorized to view this member record.` | `10` |
| [`04-replay-input-rejected`](./04-replay-input-rejected) | An input that fails the declared contract is refused before a browser is launched. | `input 'memberId'='abc' does not match ^[0-9]{5}$ — rejected before a browser was launched` | `1` |
| [`05-replay-recovers-from-transient`](./05-replay-recovers-from-transient) | Two 503s. The second lands inside the accounts frame after the last step's checkpoint has already passed, so nothing looks wrong until the run is verified — and it is still recognised as a server fault rather than blamed on the recording. | `success — savings_balance=$8,241.17` | `0` |
| [`06-replay-recovers-from-interstitial`](./06-replay-recovers-from-interstitial) | An unexpected maintenance dialog is acknowledged and the interrupted step retried. | `success — savings_balance=$8,241.17` | `0` |
| [`07-replay-recovers-from-session-timeout`](./07-replay-recovers-from-session-timeout) | Re-authentication mid-flow, then the interrupted step is retried rather than the flow restarted. | `success — savings_balance=$8,241.17` | `0` |
| [`08-replay-hard-failure`](./08-replay-hard-failure) | A server error that does not clear. Classified `application_error` — the bank's software broke, which is a different problem from a broken recording, and the payload says so. | `failed at s3 (application_error)` | `30` |
| [`09-policy-denies-unrequested-write`](./09-policy-denies-unrequested-write) | A write-bearing capability invoked without opting into writes. Denied at the gate, mid-flow, before the click. | `failed at s4 (policy_denied)` | `30` |
| [`10-cross-tenant-without-overlay`](./10-cross-tenant-without-overlay) | The same capability aimed at a second institution with no overlay. The locator ladder degrades to ordinals (flagged as drift), the flow completes, and it fails cleanly at verification. | `failed at s3 (success_condition_failed)` | `30` |
| [`11-cross-tenant-with-overlay`](./11-cross-tenant-with-overlay) | The same capability, same second institution, with a four-line overlay. Every step back on its top strategy. | `success — savings_balance=$8,241.17` | `0` |
| [`12-write-attended-shadow-replay`](./12-write-attended-shadow-replay) | A supervised replay of a draft that writes. This is how a recording earns approval without the gate deadlocking. | `success — no outputs` | `0` |
| [`13-write-validation-rejected`](./13-write-validation-rejected) | The write capability's own input contract, enforced before anything is touched. | `input 'nickname' must be at least 3 characters` | `1` |
| [`14-escalation-human-handoff`](./14-escalation-human-handoff) | The full control transfer: an irreversible step routes to a human, an operator takes the LIVE session, acts, hands back, and automation resumes and verifies. The operator here is a script speaking the console's own HTTP API so the run is reproducible; a person clicking the same buttons is the same path. | `success — no outputs` | `0` |
| [`15-stability-five-runs`](./15-stability-five-runs) | Five consecutive unattended replays. This is what approval is gated on. | `stability: 5/5 succeeded (100.0%)` | `0` |
| [`16-promotion`](./16-promotion) | The draft → approved transition, and the same request refused for a capability that has not earned it. | `draft → approved, and one refusal` | — |
| [`17-catalog`](./17-catalog) | What an agent sees: typed contracts, declared outcomes, per-tenant track record. | `2 capabilities, typed contracts` | — |
| [`18-catalog-invoke`](./18-catalog-invoke) | Invocation by name with typed arguments. No browser in the caller's vocabulary. | `success — savings_balance=$8,241.17` | `0` |
| [`19-catalog-refuses-unapproved-write`](./19-catalog-refuses-unapproved-write) | The catalog refusing an unapproved write to a system of record. | `rejected by the catalog` | `40` |

## Reading a run

`run/run.jsonl` is one JSON record per step. The fields worth knowing:

- `resolvedBy` — which rung of the locator ladder actually matched. A step
  resolving below its recorded rung is the earliest available signal that a
  screen has changed, and it is visible long before anything fails.
- `leaseOwner` — who was in control when this happened. `operator` records are
  a human's actions, captured in the same vocabulary as the automation's.
- `policy` — the gate's verdict, risk classification and reason, recorded for
  every action rather than only for the denied ones.

Values are redacted on the way in: the logger cannot be handed an unredacted
value, and screenshots are masked before they are encoded.
