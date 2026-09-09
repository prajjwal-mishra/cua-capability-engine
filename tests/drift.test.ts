/**
 * Drift watch against committed evidence, not fixtures we invent.
 *
 * evidence/10 is the un-overlaid variant: steps slide to ordinals and the
 * flags are in the JSONL. evidence/11 is the overlay: top rungs hold.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  exceedsDriftThreshold,
  findRunLogs,
  reportDrift,
  scanRunLog,
} from "../src/obs/drift.js";

const evidence = (...parts: string[]) => join(process.cwd(), "evidence", ...parts);

describe("drift watch", () => {
  it("finds run.jsonl under an evidence tree", () => {
    const logs = findRunLogs(evidence("10-cross-tenant-without-overlay"));
    expect(logs.some((p) => p.endsWith("run.jsonl"))).toBe(true);
  });

  it("flags rung drops in the un-overlaid cross-tenant run", () => {
    const log = findRunLogs(evidence("10-cross-tenant-without-overlay"))[0]!;
    const scanned = scanRunLog(log);
    expect(scanned.resolutions).toBeGreaterThanOrEqual(3);
    expect(scanned.events.length).toBeGreaterThanOrEqual(2);
    expect(scanned.events.every((e) => e.recordedTopRung)).toBe(true);
    expect(scanned.events.map((e) => e.resolvedBy)).toContain("frame_role_ordinal");
  });

  it("sees no drift when the overlay holds the top rungs", () => {
    const report = reportDrift([evidence("11-cross-tenant-with-overlay")]);
    expect(report.scannedLogs).toBe(1);
    expect(report.driftedSteps).toBe(0);
    expect(report.rate).toBe(0);
    expect(exceedsDriftThreshold(report, 0)).toBe(false);
  });

  it("aggregates and trips a zero threshold on evidence/10", () => {
    const report = reportDrift([evidence("10-cross-tenant-without-overlay")]);
    expect(report.driftedSteps).toBeGreaterThan(0);
    expect(report.byStep.some((s) => s.includes("frame_role_ordinal"))).toBe(true);
    expect(exceedsDriftThreshold(report, 0)).toBe(true);
    expect(exceedsDriftThreshold(report, 1)).toBe(false);
  });
});
