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
  /**
   * The application itself broke, and the artifact says so.
   *
   * Kept apart from `unclassified_condition` because the two route to different
   * people: this one is the bank's software failing, which no amount of
   * re-recording fixes and which a caller may sensibly retry later.
   */
  | "application_error"
  /**
   * The screen is one nothing in the artifact describes.
   *
   * The honest and least dangerous answer, and deliberately the default. On
   * this surface, continuing from a screen you cannot identify is how you act
   * on the wrong member's account.
   */
  | "unclassified_condition"
  | "surface_error"
  | "budget_exceeded"
  | "input_invalid";

/**
 * Enough to debug the failure without reproducing it.
 *
 * That constraint is the whole design of this payload. These runs happen
 * unattended against a system nobody can safely re-drive on demand, so "run it
 * again with the browser open" is not available. Whatever a person needs in
 * order to understand what happened has to be captured at the moment it
 * happened — which is also why an escalation and a failure carry the same
 * context. Which of the two you got is a routing decision, not a reason to know
 * less.
 */
export interface ReplayFailure {
  readonly stepId: string;
  readonly stepIntent: string;
  readonly classification: FailureClassification;
  /** What the artifact said should be true. */
  readonly expected: string;
  /** What was actually on screen. */
  readonly observed: string;
  readonly detail?: string;
  /**
   * What a person should do about it, when the classification implies something
   * specific. Absent when it does not — a guess here is worse than a silence,
   * because it sends someone down the wrong path with apparent authority.
   */
  readonly remediation?: string;
  /** The screen, in text, redacted. */
  readonly visibleText?: string;
  readonly screenshotPath?: string;
  readonly url?: string;
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

/**
 * Whether a run says anything about whether this CAPABILITY works.
 *
 * The stability record gates approval, so what it counts decides what approval
 * means. It has to measure one thing: do this artifact's locators still resolve
 * and does its flow still execute. Several outcomes look like failures and are
 * not evidence about that at all —
 *
 *   business_outcome  the flow worked perfectly and the bank said no. Counting
 *                     "member not found" against a capability would mean
 *                     probing for absent members degrades it.
 *   application_error the bank's software fell over. Nothing about the
 *                     recording caused it and no re-recording fixes it.
 *   policy_denied     the caller did not ask for writes. That is a statement
 *                     about the invocation, not the artifact.
 *   escalated         we stopped early on purpose. Indeterminate, so silent.
 *
 * — and folding them in would produce a number that drifts downward with
 * ordinary use, which is worse than having no number, because it looks like
 * one.
 */
export function stabilitySignal(result: ReplayResult): "success" | "failure" | "ignore" {
  switch (result.status) {
    case "success":
      return "success";
    case "business_outcome":
      return "success";
    case "escalated":
      return "ignore";
    case "failed":
      switch (result.error.classification) {
        case "application_error":
        case "policy_denied":
        case "input_invalid":
        case "surface_error":
          return "ignore";
        default:
          return "failure";
      }
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
    case "failed": {
      const e = result.error;
      const lines = [
        `failed at ${e.stepId} (${e.classification})`,
        `  step:     ${e.stepIntent}`,
        `  expected: ${e.expected}`,
        `  observed: ${e.observed}`,
      ];
      if (e.remediation) lines.push(`  what now: ${wrap(e.remediation, 68, 12)}`);
      if (e.screenshotPath) lines.push(`  screen:   ${e.screenshotPath}`);
      return lines.join("\n");
    }
  }
}

/** Wrap to `width`, indenting continuation lines, so a remediation sentence
 *  stays readable in a terminal instead of becoming one long line. */
function wrap(text: string, width: number, indent: number): string {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.join(`\n${pad}`);
}
