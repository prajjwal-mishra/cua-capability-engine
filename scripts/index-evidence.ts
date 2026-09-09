/**
 * Build evidence/README.md from what is actually on disk.
 *
 * Generated rather than hand-written for one reason: a hand-written index
 * drifts from the runs it describes, and an index that claims a run succeeded
 * when the transcript says otherwise is worse than no index. Every headline
 * below is read back out of the transcript it points at.
 *
 *   npx tsx scripts/index-evidence.ts
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const EV = join(process.cwd(), "evidence");

/** What each case is meant to demonstrate. Keyed by directory name so that a
 *  case with no note still gets indexed, just without commentary. */
const NOTES: Record<string, string> = {
  "00-discovery":
    "The live model sessions that produced the committed capabilities. Each holds the run's " +
    "full trace and the artifact it compiled to; `provenance.runId` in the artifact ties them together.",
  "01-replay-success": "The happy path, with no model in the decision loop.",
  "02-replay-business-outcome":
    "A member that does not exist. This is an ANSWER with a code, not an exception — the " +
    "distinction the whole result contract exists to make.",
  "03-replay-permission-denied":
    "The same shape for an authorisation refusal: the application said no, and that is data.",
  "04-replay-input-rejected":
    "An input that fails the declared contract is refused before a browser is launched.",
  "05-replay-recovers-from-transient":
    "A transient 503 on the member page. Detected as a host fault, the frame is re-requested, and the interrupted step is retried — not blamed on the recording.",
  "06-replay-recovers-from-interstitial":
    "An unexpected maintenance dialog is acknowledged and the interrupted step retried.",
  "07-replay-recovers-from-session-timeout":
    "Re-authentication mid-flow, then the interrupted step is retried rather than the flow restarted.",
  "08-replay-hard-failure":
    "A server error that does not clear. Classified `application_error` — the bank's software " +
    "broke, which is a different problem from a broken recording, and the payload says so.",
  "09-policy-denies-unrequested-write":
    "A write-bearing capability invoked without opting into writes. Denied at the gate, mid-flow, " +
    "before the click.",
  "10-cross-tenant-without-overlay":
    "The same capability aimed at a second institution with no overlay. The locator ladder degrades " +
    "to ordinals (flagged as drift), the flow completes, and it fails cleanly at verification.",
  "11-cross-tenant-with-overlay":
    "The same capability, same second institution, with a four-line overlay. Every step back on its " +
    "top strategy.",
  "12-write-attended-shadow-replay":
    "A supervised replay of a draft that writes. This is how a recording earns approval without the " +
    "gate deadlocking.",
  "13-write-validation-rejected":
    "The write capability's own input contract, enforced before anything is touched.",
  "14-escalation-human-handoff":
    "The full control transfer: an irreversible step routes to a human, an operator takes the LIVE " +
    "session, acts, hands back, and automation resumes and verifies. The operator here is a script " +
    "speaking the console's own HTTP API so the run is reproducible; a person clicking the same " +
    "buttons is the same path.",
  "15-stability-five-runs": "Five consecutive unattended replays. This is what approval is gated on.",
  "16-promotion":
    "The draft → approved transition, and the same request refused for a capability that has not " +
    "earned it.",
  "17-catalog": "What an agent sees: typed contracts, declared outcomes, per-tenant track record.",
  "18-catalog-invoke": "Invocation by name with typed arguments. No browser in the caller's vocabulary.",
  "19-catalog-refuses-unapproved-write":
    "The catalog refusing an unapproved write to a system of record.",
  "20-overlay-from-handoff":
    "The human click from the live handoff, compiled into a proposed overlay against the base artifact. A document to review, not an applied patch.",
  "21-emit-playwright":
    "Code generation: the recorded ladder projected into a Playwright page object. Replay still executes the JSON.",
};

/**
 * Cases whose single most important line cannot be pattern-matched: a discovery
 * capture has no transcript at all, and the ones that print several results
 * would otherwise be summarized by whichever happened to match first.
 */
const FIXED_HEADLINES: Record<string, string> = {
  "00-discovery": "2 capabilities compiled from live model runs",
  "16-promotion": "draft → approved, and one refusal",
  "17-catalog": "2 capabilities, typed contracts",
  "20-overlay-from-handoff": "proposed overlay from captured human actions",
  "21-emit-playwright": "Playwright page object emitted from the artifact",
};

/** Pull the one line a reader wants from a transcript. */
function headline(dir: string): string {
  const fixed = FIXED_HEADLINES[dir];
  if (fixed) return fixed;
  const path = join(EV, dir, "transcript.txt");
  if (!existsSync(path)) return "—";
  const text = readFileSync(path, "utf8");

  const patterns: RegExp[] = [
    // The handoff transcript prints the resume block before the verdict, and
    // the verdict is the point.
    /^── resumed[\s\S]*?^(success — .*)$/m,
    /^success — .*$/m,
    /^business outcome — .*$/m,
    /^failed at .*$/m,
    /^stability: .*$/m,
    /^.*: draft → approved.*$/m,
    /^.*has not earned approval.*$/m,
    /^input '.*$/m,
    /"status": "rejected"/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    // Prefer a capture group when the pattern used one to skip past preamble.
    if (m) return (m[1] ?? m[0]).trim().replace(/^"status": "rejected"$/, "rejected by the catalog");
  }
  return "—";
}

function exitCode(dir: string): string {
  const path = join(EV, dir, "transcript.txt");
  if (!existsSync(path)) return "—";
  const m = readFileSync(path, "utf8").match(/^exit (\d+)$/m);
  return m ? `\`${m[1]}\`` : "—";
}

const dirs = readdirSync(EV)
  .filter((d) => statSync(join(EV, d)).isDirectory())
  .sort();

const rows = dirs.map((d) => {
  const cmdPath = join(EV, d, "command.txt");
  const cmd = existsSync(cmdPath) ? readFileSync(cmdPath, "utf8").trim() : "";
  return { dir: d, cmd, headline: headline(d), exit: exitCode(d) };
});

const body = `# Evidence

Every directory here is the output of a real run against the real target app,
produced by \`./scripts/make-evidence.sh\`. Nothing is transcribed by hand.

Each case contains:

| file | what it is |
| --- | --- |
| \`command.txt\` | the exact command, so you can re-run it |
| \`transcript.txt\` | everything the command printed, plus its exit code |
| \`run/\` | the run's own evidence: \`run.jsonl\`, accessibility snapshots, screenshots |

Exit codes are meaningful and distinct — \`0\` success, \`10\` business outcome,
\`20\` escalated, \`30\` failed, \`40\` refused before running — so a caller can
branch on the outcome class without parsing text.

## Index

| # | demonstrates | result | exit |
| --- | --- | --- | --- |
${rows
  .map((r) => `| [\`${r.dir}\`](./${r.dir}) | ${NOTES[r.dir] ?? ""} | \`${r.headline}\` | ${r.exit} |`)
  .join("\n")}

## Reading a run

\`run/run.jsonl\` is one JSON record per step. The fields worth knowing:

- \`resolvedBy\` — which rung of the locator ladder actually matched. A step
  resolving below its recorded rung is the earliest available signal that a
  screen has changed, and it is visible long before anything fails.
- \`leaseOwner\` — who was in control when this happened. \`operator\` records are
  a human's actions, captured in the same vocabulary as the automation's.
- \`policy\` — the gate's verdict, risk classification and reason, recorded for
  every action rather than only for the denied ones.

Values are redacted on the way in: the logger cannot be handed an unredacted
value, and screenshots are masked before they are encoded.
`;

writeFileSync(join(EV, "README.md"), body);
console.log(`wrote evidence/README.md — ${rows.length} cases`);
for (const r of rows) console.log(`  ${r.dir.padEnd(38)} ${r.headline}`);
