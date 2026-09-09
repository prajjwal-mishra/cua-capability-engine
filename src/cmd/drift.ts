/**
 * `cua drift report` - turn per-step rung-drop flags into something you can
 * fail a check on.
 *
 * Replay already writes `extra.driftSignal` into run.jsonl when a step
 * resolves below its recorded top strategy. This command aggregates those
 * flags across one or more evidence/run trees and exits non-zero when the
 * rate crosses a threshold.
 */

import type { Args } from "../cli-args.js";
import { exceedsDriftThreshold, reportDrift } from "../obs/drift.js";

export async function driftCommand(args: Args): Promise<void> {
  const sub = args.positional[0] ?? "report";
  if (sub !== "report") {
    throw new Error(`unknown drift subcommand '${sub}' (try: cua drift report)`);
  }

  const fromFlag = args.flags.from;
  const roots =
    fromFlag === undefined
      ? ["runs", "evidence"]
      : String(fromFlag)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  const threshold = Number(args.flags.threshold ?? 0);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be a fraction between 0 and 1 (e.g. 0.05)");
  }

  const report = reportDrift(roots);
  const pct = (report.rate * 100).toFixed(1);

  console.log(`drift report`);
  console.log(`  scanned:    ${report.scannedLogs} run.jsonl file(s) under ${roots.join(", ")}`);
  console.log(`  resolved:   ${report.stepResolutions} step resolution(s)`);
  console.log(`  drifted:    ${report.driftedSteps} (${pct}%)`);
  if (report.byStep.length === 0) {
    console.log(`  detail:     none - every logged resolution used its recorded top strategy`);
  } else {
    console.log(`  detail:`);
    for (const line of report.byStep) console.log(`    ${line}`);
  }

  if (exceedsDriftThreshold(report, threshold)) {
    console.log(
      `\nthreshold ${threshold} exceeded (${pct}% of resolutions slid to a lower rung).`,
    );
    console.log(
      `That is the scheduled-outage signal: the flow still ran, but the locator` +
        ` that was supposed to hold did not.`,
    );
    process.exitCode = 2;
  }
}
