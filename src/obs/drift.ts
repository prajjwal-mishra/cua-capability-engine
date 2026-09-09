/**
 * Drift watch.
 *
 * Replay already logs which locator rung resolved. A run that slides from
 * role+name to frame_role_ordinal still "works" until the day the ordinal
 * moves - that is a scheduled outage, not a green checkmark.
 *
 * This module turns those per-step flags into a report you can fail a check
 * on. It does not page anyone. It does make "we measured it and ignored it"
 * false.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DriftEvent {
  readonly runId: string;
  readonly logPath: string;
  readonly stepId: string;
  readonly resolvedBy?: string;
  readonly recordedTopRung?: string;
  readonly ts?: string;
}

export interface DriftReport {
  readonly scannedLogs: number;
  readonly stepResolutions: number;
  readonly driftedSteps: number;
  /** driftedSteps / stepResolutions, or 0 when nothing resolved. */
  readonly rate: number;
  readonly events: readonly DriftEvent[];
  /** Unique "stepId:recorded→resolved" keys, sorted. */
  readonly byStep: readonly string[];
}

interface JsonlRecord {
  readonly ts?: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly resolvedBy?: string;
  readonly resolutionStatus?: string;
  readonly extra?: { driftSignal?: boolean; recordedTopRung?: string };
}

/** Walk a tree and collect every run.jsonl path. */
export function findRunLogs(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".git") continue;
        stack.push(path);
      } else if (name === "run.jsonl") {
        out.push(path);
      }
    }
  }
  return out.sort();
}

export function scanRunLog(logPath: string): {
  resolutions: number;
  events: DriftEvent[];
} {
  const text = readFileSync(logPath, "utf8");
  let resolutions = 0;
  const events: DriftEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: JsonlRecord;
    try {
      rec = JSON.parse(line) as JsonlRecord;
    } catch {
      continue;
    }
    if (rec.resolutionStatus !== "resolved") continue;
    resolutions += 1;
    if (!rec.extra?.driftSignal) continue;
    events.push({
      runId: rec.runId ?? "unknown",
      logPath,
      stepId: rec.stepId ?? "?",
      resolvedBy: rec.resolvedBy,
      recordedTopRung: rec.extra.recordedTopRung,
      ts: rec.ts,
    });
  }
  return { resolutions, events };
}

export function reportDrift(roots: readonly string[]): DriftReport {
  const logs = [...new Set(roots.flatMap((r) => findRunLogs(r)))];
  let stepResolutions = 0;
  const events: DriftEvent[] = [];
  for (const log of logs) {
    const scanned = scanRunLog(log);
    stepResolutions += scanned.resolutions;
    events.push(...scanned.events);
  }
  const driftedSteps = events.length;
  const rate = stepResolutions === 0 ? 0 : driftedSteps / stepResolutions;
  const byStep = [
    ...new Set(
      events.map((e) => {
        const from = e.recordedTopRung ?? "?";
        const to = e.resolvedBy ?? "?";
        return `${e.stepId}: ${from} → ${to}`;
      }),
    ),
  ].sort();
  return { scannedLogs: logs.length, stepResolutions, driftedSteps, rate, events, byStep };
}

/** True when the drifted fraction of resolved steps exceeds the threshold. */
export function exceedsDriftThreshold(report: DriftReport, threshold: number): boolean {
  if (report.stepResolutions === 0) return false;
  return report.rate > threshold;
}
