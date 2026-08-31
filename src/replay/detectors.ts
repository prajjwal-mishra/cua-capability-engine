/**
 * Outcome detection.
 *
 * Every declared outcome is evaluated against the snapshot after every step.
 * That is more work than checking only when something looks wrong, and it is
 * the point: a session timeout or a permission denial can appear on a step that
 * otherwise "succeeded", and a checkpoint that happens to still pass would hide
 * it. Detecting eagerly is what stops the run proceeding on a screen it does
 * not understand.
 */

import type { UISnapshot } from "../surface/types.js";
import type { CapabilityArtifact, KnownOutcome, Recovery } from "../artifact/schema.js";
import { evaluateCondition, explain, type ConditionResult } from "./checkpoint.js";

export interface DetectedOutcome {
  readonly outcome: KnownOutcome;
  readonly result: ConditionResult;
  readonly detail: string;
}

/**
 * First matching outcome, most severe first. Ordering matters: an application
 * error page and a validation message can co-occur, and reporting the benign
 * one would send a caller chasing the wrong thing.
 */
const SEVERITY_ORDER: Record<KnownOutcome["severity"], number> = {
  hard: 0,
  recoverable: 1,
  business: 2,
};

export function detectOutcome(
  artifact: CapabilityArtifact,
  snapshot: UISnapshot,
): DetectedOutcome | undefined {
  const ordered = [...artifact.knownOutcomes].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  for (const outcome of ordered) {
    const result = evaluateCondition(outcome.detector, snapshot);
    if (result.passed) return { outcome, result, detail: explain(result) };
  }
  return undefined;
}

export function recoveryFor(
  artifact: CapabilityArtifact,
  code: string,
  snapshot: UISnapshot,
): Recovery | undefined {
  return artifact.recoveries.find(
    (r) => r.code === code && evaluateCondition(r.detector, snapshot).passed,
  );
}
