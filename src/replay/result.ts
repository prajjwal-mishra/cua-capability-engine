/**
 * The replay result contract.
 *
 * The single most important distinction in this system is the one the brief
 * calls out as the common design mistake: "no such member" is an ANSWER, not a
 * crash. A caller that has to parse an exception message to learn that a member
 * does not exist will eventually treat a genuine outage as a missing member, or
 * the reverse. So the contract separates them structurally, and the type system
 * makes a caller handle all four cases.
 *
 * Four arms, and no more:
 *   success          — we did the thing, here are the declared outputs
 *   business_outcome — the application gave a legitimate answer that isn't the
 *                      happy path; the caller needs it as data, with a code
 *   escalated        — we stopped safely and a human has been asked; here is
 *                      how to resume
 *   failed           — something is wrong with the automation or the app, and
 *                      here is enough context to debug it without a repro
 */

import type { RiskClass } from "../policy/risk.js";
import type { StrategyKind } from "../locator/descriptor.js";

export interface Timing {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stepsExecuted: number;
}

export interface EvidenceRefs {
  readonly runId: string;
  readonly dir: string;
  readonly logPath: string;
  readonly screenshots: readonly string[];
  readonly snapshots: readonly string[];
}

/** Per-step telemetry. The locator rung that resolved is the drift signal. */
export interface StepTelemetry {
  readonly stepId: string;
  readonly intent: string;
  readonly resolvedBy?: StrategyKind;
  readonly resolutionConfidence?: number;
  readonly driftSignal: boolean;
  readonly attempts: number;
  readonly recoveriesApplied: readonly string[];
  readonly durationMs: number;
  readonly risk: RiskClass;
}

export type FailureClassification =
  | "descriptor_unresolvable"
  | "descriptor_ambiguous"
  /** A step's own post-action assertion did not hold. */
  | "checkpoint_failed"
  /**
   * Every step landed, but the capability's overall success condition did not
   * hold. Distinct from `checkpoint_failed` because it points somewhere else:
   * the steps did what they claimed, so the artifact's model of "done" is what
   * is wrong — which is the signature of replaying against a variant nobody
   * has overlaid yet, not of a broken step.
   */
  | "success_condition_failed"
  | "precondition_failed"
  | "policy_denied"
  | "recovery_exhausted"
  | "unclassified_condition"
  | "surface_error"
  | "budget_exceeded"
  | "input_invalid";

export interface ReplayFailure {
  readonly stepId: string;
  readonly stepIntent: string;
  readonly classification: FailureClassification;
  /** What the artifact said should be true. */
  readonly expected: string;
  /** What was actually on screen. */
  readonly observed: string;
  readonly detail?: string;
}

export type ReplayResult =
  | {
      readonly status: "success";
      readonly capability: string;
      readonly outputs: Readonly<Record<string, string>>;
      readonly telemetry: readonly StepTelemetry[];
      readonly evidence: EvidenceRefs;
      readonly timing: Timing;
    }
  | {
      readonly status: "business_outcome";
      readonly capability: string;
      readonly code: string;
      readonly message: string;
      readonly mapsTo?: string;
      readonly detail: string;
      readonly telemetry: readonly StepTelemetry[];
      readonly evidence: EvidenceRefs;
      readonly timing: Timing;
    }
  | {
      readonly status: "escalated";
      readonly capability: string;
      readonly interventionId: string;
      /** Opaque token the operator console hands back to resume this run. */
      readonly resumeToken: string;
      readonly reason: string;
      readonly telemetry: readonly StepTelemetry[];
      readonly evidence: EvidenceRefs;
      readonly timing: Timing;
    }
  | {
      readonly status: "failed";
      readonly capability: string;
      readonly error: ReplayFailure;
      readonly telemetry: readonly StepTelemetry[];
      readonly evidence: EvidenceRefs;
      readonly timing: Timing;
    };

/** Process exit codes, so a calling agent can branch without parsing text. */
export function exitCodeFor(result: ReplayResult): number {
  switch (result.status) {
    case "success":
      return 0;
    // A business outcome is a successful invocation with a non-happy answer.
    // It is deliberately NOT 0: an unattended caller should notice.
    case "business_outcome":
      return 10;
    case "escalated":
      return 20;
    case "failed":
      return 30;
  }
}

export function summarize(result: ReplayResult): string {
  switch (result.status) {
    case "success":
      return `success — ${
        Object.entries(result.outputs)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "no outputs"
      }`;
    case "business_outcome":
      return `business outcome — ${result.code}: ${result.message}`;
    case "escalated":
      return `escalated — ${result.reason} (intervention ${result.interventionId})`;
    case "failed":
      return `failed at ${result.error.stepId} (${result.error.classification})\n  step:     ${result.error.stepIntent}\n  expected: ${result.error.expected}\n  observed: ${result.error.observed}`;
  }
}
