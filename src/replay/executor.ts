/**
 * Deterministic replay — the path an AI agent actually triggers in production.
 *
 * THERE IS NO MODEL IN THIS FILE, AND THERE MUST NEVER BE. Not a fallback, not
 * a "just for ambiguous cases" escape hatch. The value of a recorded capability
 * is that its behaviour is a function of the artifact and the inputs; a single
 * conditional model call would destroy that property and make the whole thing
 * impossible to reason about. tests/no-llm-import.test.ts fails the build if an
 * import ever appears — in this file or anything it reaches.
 *
 * Per step: resolve → gate (inside GuardedSurface) → act → wait → checkpoint →
 * detect. Anything unclassified is a hard failure by default. We never guess
 * and proceed: on this surface, proceeding on a screen you do not understand is
 * how you act on the wrong member's account.
 */

import { join } from "node:path";
import type { GuardedSurface } from "../policy/gate.js";
import { ApprovalRequired, PolicyViolation } from "../policy/gate.js";
import type { CapabilityArtifact, Step, ValueBinding } from "../artifact/schema.js";
import type { SurfaceAction, UISnapshot } from "../surface/types.js";
import type { ElementDescriptor } from "../locator/descriptor.js";
import { isDriftSignal, resolveDescriptor } from "../locator/resolve.js";
import type { RunLog } from "../obs/log.js";
import type { EvidenceWriter } from "../obs/evidence.js";
import type { SessionControl } from "../escalation/control.js";
import { InterventionQueue } from "../escalation/intervention.js";
import { evaluateCondition, explain, observations } from "./checkpoint.js";
import { detectOutcome, recoveryFor } from "./detectors.js";
import { applyRecovery } from "./recovery.js";
import type {
  EvidenceRefs,
  FailureClassification,
  ReplayFailure,
  ReplayResult,
  StepTelemetry,
  Timing,
} from "./result.js";

export interface ReplayOptions {
  readonly inputs: Readonly<Record<string, string>>;
  readonly allowWrites: boolean;
  readonly tenant?: string;
  /**
   * Which instance of the app to enter. In production this comes from the
   * tenant record — "your CoreVantage install lives here" is deployment
   * configuration, not a property of the recording. `variant` is this project's
   * stand-in for that, and it is overridable so one capability can be aimed at
   * a second tenant's instance BEFORE an overlay exists for them, which is how
   * you find out what needs overlaying.
   */
  readonly variant?: string;
  /** Fail instead of escalating. Used by the stability runner, which must not
   *  leave a queue of interventions behind after twenty unattended runs. */
  readonly noEscalate?: boolean;
  /**
   * Resume an escalated run after a human handed control back. The step id to
   * continue from, or VERIFY_ONLY when the operator finished the flow by hand
   * and all that is left is to verify the success condition and extract.
   */
  readonly resumeAtStepId?: string;
}

/**
 * Resume sentinel: the operator says the flow is already at the end state.
 * We still verify it — an operator's word that they finished is a claim about
 * the screen, and the success condition is how we check the claim.
 */
export const VERIFY_ONLY = "$verify";

export class InputValidationError extends Error {}

/** Everything the step machinery needs, gathered once. */
interface RunContext {
  readonly artifact: CapabilityArtifact;
  readonly surface: GuardedSurface;
  readonly control: SessionControl;
  readonly log: RunLog;
  readonly evidence: EvidenceWriter;
  readonly capability: string;
  readonly options: ReplayOptions;
  readonly telemetry: StepTelemetry[];
  readonly screenshots: string[];
  readonly snapshots: string[];
  readonly startedAt: string;
  readonly started: number;
}

/** What the caller should do after a declared condition was detected. */
type Handled =
  | { readonly kind: "recovered"; readonly snapshot: UISnapshot }
  | { readonly kind: "result"; readonly result: ReplayResult };

export async function replayCapability(
  artifact: CapabilityArtifact,
  surface: GuardedSurface,
  control: SessionControl,
  log: RunLog,
  evidence: EvidenceWriter,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const ctx: RunContext = {
    artifact,
    surface,
    control,
    log,
    evidence,
    capability: `${artifact.capabilityId}@${artifact.version}`,
    options,
    telemetry: [],
    screenshots: [],
    snapshots: [],
    startedAt: new Date().toISOString(),
    started: Date.now(),
  };

  // Inputs are validated against the artifact's own schema BEFORE anything is
  // launched. A bad member id should cost nothing and should never be
  // distinguishable, to the caller, from any other invalid argument.
  const bound = validateInputs(artifact, options.inputs);

  // A resume picks up a session a human has been driving. Navigating to the
  // entry point would throw their work away and land us on a screen the
  // remaining steps do not expect, so resume re-OBSERVES instead of resetting,
  // and every step it then runs re-checks its own precondition.
  const resuming = options.resumeAtStepId !== undefined;
  if (!resuming) {
    await surface.act({ kind: "navigate", url: entryUrl(artifact, options.variant) });
  }
  let snapshot = await surface.observe();
  ctx.snapshots.push(saveSnapshot(ctx, resuming ? "000-resume" : "000-entry", snapshot));

  const startIndex = resumeIndex(artifact, options.resumeAtStepId);
  if (startIndex instanceof Error) {
    throw new InputValidationError(startIndex.message);
  }

  for (let i = startIndex; i < artifact.steps.length; i++) {
    const step = artifact.steps[i]!;
    const outcome = await runStep(ctx, step, snapshot, bound);
    if (outcome.kind === "result") return outcome.result;
    snapshot = outcome.snapshot;
  }

  return finish(ctx, snapshot, bound);
}

/**
 * Where a resume starts. An unknown step id is rejected rather than coerced to
 * step 0: silently restarting a flow a human has half-completed is how you
 * open two sub-accounts.
 */
function resumeIndex(artifact: CapabilityArtifact, stepId: string | undefined): number | Error {
  if (stepId === undefined) return 0;
  if (stepId === VERIFY_ONLY) return artifact.steps.length;
  const index = artifact.steps.findIndex((s) => s.id === stepId);
  if (index === -1) {
    return new Error(
      `cannot resume at '${stepId}': ${artifact.capabilityId}@${artifact.version} has no such step ` +
        `(steps: ${artifact.steps.map((s) => s.id).join(", ")}, or '${VERIFY_ONLY}' to verify only)`,
    );
  }
  return index;
}

/* ---------------------------------------------------------------- step --- */

type StepOutcome =
  { kind: "done"; snapshot: UISnapshot } | { kind: "result"; result: ReplayResult };

async function runStep(
  ctx: RunContext,
  step: Step,
  entrySnapshot: UISnapshot,
  bound: Readonly<Record<string, string>>,
): Promise<StepOutcome> {
  const stepStarted = Date.now();
  let snapshot = entrySnapshot;
  const recoveriesApplied: string[] = [];
  const recoveryBudget = new Map<string, number>();
  let attempts = 0;

  // The lease is re-read from disk every step: the operator console is a
  // separate process, and a handover mid-run must take effect immediately.
  if (ctx.control.owner !== "automation") {
    return {
      kind: "result",
      result: await escalate(ctx, step, "lease is held by an operator", "policy_denied", snapshot),
    };
  }

  // Preconditions run before acting, and matter most on resume: after a human
  // has driven the session we must never assume the page is where we left it.
  if (step.precondition) {
    const pre = evaluateCondition(step.precondition, snapshot);
    if (!pre.passed) {
      return {
        kind: "result",
        result: await fail(
          ctx,
          step,
          "precondition_failed",
          step.precondition.describe ?? "the step's precondition",
          observations(pre),
          snapshot,
        ),
      };
    }
  }

  let lastFailure:
    { classification: FailureClassification; expected: string; observed: string } | undefined;

  // Retries from the step's own policy, plus one extra pass per recovery we
  // applied — a recovery that clears an interstitial has not consumed the
  // step's budget for genuine flakiness.
  while (attempts < step.retryPolicy.maxAttempts + recoveriesApplied.length) {
    attempts += 1;

    /* ---- resolve ------------------------------------------------------- */

    let ref: string | undefined;
    let resolvedBy: StepTelemetry["resolvedBy"];
    let resolutionConfidence: number | undefined;
    let drift = false;

    if (step.target) {
      const descriptor = step.target as unknown as ElementDescriptor;
      const resolution = resolveDescriptor(descriptor, snapshot, {
        allowCoordinateFallback: false,
        bindings: bound,
      });

      if (resolution.status !== "resolved") {
        // Before calling it unresolvable, ask whether the app is showing us
        // something it declared. A timeout interstitial has no Search box, and
        // reporting "descriptor unresolvable" there would be true but useless.
        const handled = await handleDetected(
          ctx,
          step,
          snapshot,
          recoveryBudget,
          recoveriesApplied,
          bound,
        );
        if (handled) {
          if (handled.kind === "result") return { kind: "result", result: handled.result };
          snapshot = handled.snapshot;
          continue;
        }

        const classification: FailureClassification =
          resolution.status === "ambiguous" ? "descriptor_ambiguous" : "descriptor_unresolvable";
        const observed =
          resolution.status === "ambiguous"
            ? `${resolution.candidates} elements matched; refusing to choose between them`
            : `no element matched any of ${descriptor.strategies.length} recorded strategies`;

        ctx.log.write({
          phase: "replay",
          stepId: step.id,
          intent: step.intent,
          action: step.action,
          leaseOwner: ctx.control.owner,
          resolutionStatus: resolution.status,
          descriptorIntent: descriptor.intent,
          error: observed,
          extra: { attempts: resolution.attempts },
        });

        return {
          kind: "result",
          result: ctx.options.noEscalate
            ? await fail(ctx, step, classification, descriptor.intent, observed, snapshot)
            : await escalate(ctx, step, observed, classification, snapshot),
        };
      }

      ref = resolution.ref;
      resolvedBy = resolution.strategy;
      resolutionConfidence = resolution.confidence;
      drift = isDriftSignal(descriptor, resolution);
    }

    /* ---- act ----------------------------------------------------------- */

    try {
      const action = buildAction(step, ref, bound);
      if (action) {
        const result = await ctx.surface.act(action);
        if (!result.ok) {
          lastFailure = {
            classification: "surface_error",
            expected: step.intent,
            observed: result.error ?? "action reported failure",
          };
          if (attempts < step.retryPolicy.maxAttempts) {
            await sleep(step.retryPolicy.backoffMs);
            snapshot = await ctx.surface.observe();
            continue;
          }
        }
      }
    } catch (err) {
      if (err instanceof ApprovalRequired) {
        return {
          kind: "result",
          result: await escalate(ctx, step, err.message, "policy_denied", snapshot),
        };
      }
      if (err instanceof PolicyViolation) {
        return {
          kind: "result",
          result: await fail(
            ctx,
            step,
            "policy_denied",
            step.intent,
            err.decision.reason,
            snapshot,
            err.decision.code,
          ),
        };
      }
      throw err;
    }

    snapshot = await ctx.surface.observe();
    ctx.snapshots.push(saveSnapshot(ctx, `${step.id}-after`, snapshot));

    /* ---- detect declared conditions before trusting the checkpoint ------ */

    const handled = await handleDetected(
      ctx,
      step,
      snapshot,
      recoveryBudget,
      recoveriesApplied,
      bound,
    );
    if (handled) {
      if (handled.kind === "result") return { kind: "result", result: handled.result };
      snapshot = handled.snapshot;

      // A recovery frequently lands us exactly where the step was trying to
      // get to — acknowledging an interstitial continues to the page we asked
      // for, and re-authenticating returns to the interrupted request. Blindly
      // re-running the step would then repeat an action against a page that has
      // already moved on, and fail looking for a control that is no longer
      // there. So verify first, and only re-run if we genuinely have not
      // arrived.
      if (step.checkpoint && evaluateCondition(step.checkpoint, snapshot).passed) {
        ctx.log.write({
          phase: "recovery",
          stepId: step.id,
          intent: step.intent,
          action: step.action,
          leaseOwner: ctx.control.owner,
          checkpoint: { passed: true, describe: step.checkpoint.describe },
          outcome: `recovered:${recoveriesApplied.join(",")}`,
        });
        ctx.telemetry.push({
          stepId: step.id,
          intent: step.intent,
          resolvedBy,
          resolutionConfidence,
          driftSignal: drift,
          attempts,
          recoveriesApplied: [...recoveriesApplied],
          durationMs: Date.now() - stepStarted,
          risk: step.risk,
        });
        return { kind: "done", snapshot };
      }
      continue;
    }

    /* ---- checkpoint ---------------------------------------------------- */

    if (step.checkpoint) {
      const check = evaluateCondition(step.checkpoint, snapshot);
      if (!check.passed) {
        lastFailure = {
          classification: "checkpoint_failed",
          expected: step.checkpoint.describe ?? "the step's checkpoint",
          observed: observations(check),
        };
        if (attempts < step.retryPolicy.maxAttempts) {
          await sleep(step.retryPolicy.backoffMs);
          snapshot = await ctx.surface.observe();
          continue;
        }
        ctx.log.write({
          phase: "replay",
          stepId: step.id,
          intent: step.intent,
          action: step.action,
          leaseOwner: ctx.control.owner,
          resolvedBy,
          resolutionStatus: "resolved",
          checkpoint: {
            passed: false,
            describe: step.checkpoint.describe,
            observed: explain(check),
          },
        });
        return {
          kind: "result",
          result: await fail(
            ctx,
            step,
            "checkpoint_failed",
            lastFailure.expected,
            lastFailure.observed,
            snapshot,
          ),
        };
      }
    }

    /* ---- landed -------------------------------------------------------- */

    ctx.log.write({
      phase: "replay",
      stepId: step.id,
      intent: step.intent,
      action: step.action,
      leaseOwner: ctx.control.owner,
      resolvedBy,
      resolutionStatus: "resolved",
      descriptorIntent: step.target?.intent,
      checkpoint: step.checkpoint
        ? { passed: true, describe: step.checkpoint.describe }
        : undefined,
      outcome: recoveriesApplied.length > 0 ? `recovered:${recoveriesApplied.join(",")}` : "ok",
      extra: drift
        ? { driftSignal: true, recordedTopRung: step.target?.strategies[0]?.kind }
        : undefined,
    });

    ctx.telemetry.push({
      stepId: step.id,
      intent: step.intent,
      resolvedBy,
      resolutionConfidence,
      driftSignal: drift,
      attempts,
      recoveriesApplied: [...recoveriesApplied],
      durationMs: Date.now() - stepStarted,
      risk: step.risk,
    });

    return { kind: "done", snapshot };
  }

  const f = lastFailure ?? {
    classification: "recovery_exhausted" as const,
    expected: step.intent,
    observed: "step did not complete within its retry budget",
  };
  return {
    kind: "result",
    result: await fail(ctx, step, f.classification, f.expected, f.observed, snapshot),
  };
}

/* ----------------------------------------------------------- conditions --- */

/**
 * Evaluate every declared outcome against the current screen and act on the
 * first that matches. Returns undefined when nothing was detected, so the
 * caller proceeds normally.
 *
 * This runs after EVERY step, not only when something looks wrong. A session
 * timeout or a permission denial can land on a step whose checkpoint happens to
 * still pass, and detecting eagerly is what stops the run continuing on a
 * screen it does not understand.
 */
async function handleDetected(
  ctx: RunContext,
  step: Step,
  snapshot: UISnapshot,
  recoveryBudget: Map<string, number>,
  recoveriesApplied: string[],
  bound: Readonly<Record<string, string>>,
): Promise<Handled | undefined> {
  const detected = detectOutcome(ctx.artifact, snapshot);
  if (!detected) return undefined;
  const { outcome } = detected;

  /* --- a legitimate answer the caller needs, not a crash ----------------- */
  if (outcome.severity === "business") {
    const shot = await ctx.evidence.saveScreenshot(
      `business-${outcome.code}`,
      ctx.surface,
      snapshot,
    );
    if (shot) ctx.screenshots.push(shot);
    ctx.log.write({
      phase: "replay",
      stepId: step.id,
      intent: step.intent,
      action: step.action,
      leaseOwner: ctx.control.owner,
      outcome: `business:${outcome.code}`,
    });
    return {
      kind: "result",
      result: {
        status: "business_outcome",
        capability: ctx.capability,
        code: outcome.code,
        message: outcome.message,
        mapsTo: outcome.mapsTo,
        detail: describeScreen(snapshot),
        telemetry: ctx.telemetry,
        evidence: evidenceRefs(ctx),
        timing: timing(ctx),
      },
    };
  }

  /* --- something we declared we can clear, within a budget --------------- */
  if (outcome.severity === "recoverable") {
    const recovery = recoveryFor(ctx.artifact, outcome.code, snapshot);
    if (!recovery) {
      // Declared recoverable with nothing to recover with is an artifact bug,
      // and it is a hard failure rather than a shrug.
      return {
        kind: "result",
        result: await fail(
          ctx,
          step,
          "unclassified_condition",
          outcome.message,
          `'${outcome.code}' is declared recoverable but the artifact defines no recovery for it`,
          snapshot,
        ),
      };
    }
    const used = recoveryBudget.get(outcome.code) ?? 0;
    if (used >= recovery.maxAttempts) {
      return {
        kind: "result",
        result: await fail(
          ctx,
          step,
          "recovery_exhausted",
          `recovery '${outcome.code}' to clear the condition`,
          `applied ${used} time(s) without clearing it`,
          snapshot,
        ),
      };
    }
    recoveryBudget.set(outcome.code, used + 1);
    recoveriesApplied.push(outcome.code);
    ctx.log.write({
      phase: "recovery",
      stepId: step.id,
      intent: recovery.describe ?? `recover from ${outcome.code}`,
      action: "recovery",
      leaseOwner: ctx.control.owner,
      outcome: outcome.code,
    });
    const after = await applyRecovery(recovery, ctx.surface, snapshot, bound);
    return { kind: "recovered", snapshot: after };
  }

  /* --- declared hard, or anything we could not classify ------------------ */
  return {
    kind: "result",
    result: await fail(
      ctx,
      step,
      "unclassified_condition",
      step.intent,
      `${outcome.message} (${outcome.code})`,
      snapshot,
    ),
  };
}

/* ------------------------------------------------------------- finish ----- */

async function finish(
  ctx: RunContext,
  snapshot: UISnapshot,
  bound: Readonly<Record<string, string>>,
): Promise<ReplayResult> {
  const { artifact } = ctx;

  const success = evaluateCondition(artifact.successCondition, snapshot);
  if (!success.passed) {
    const last = artifact.steps[artifact.steps.length - 1]!;
    return fail(
      ctx,
      last,
      "success_condition_failed",
      artifact.successCondition.describe ?? "the capability's success condition",
      observations(success),
      snapshot,
      `every step completed, so the flow ran — but the end state the artifact expects is not what is on screen. ` +
        `If this is a tenant the capability was not recorded against, that is what an overlay is for.`,
    );
  }

  const outputs: Record<string, string> = {};
  for (const output of artifact.outputs) {
    const descriptor = output.extraction.descriptor as unknown as ElementDescriptor;
    const resolution = resolveDescriptor(descriptor, snapshot, { bindings: bound });
    if (resolution.status !== "resolved") {
      const last = artifact.steps[artifact.steps.length - 1]!;
      return fail(
        ctx,
        last,
        resolution.status === "ambiguous" ? "descriptor_ambiguous" : "descriptor_unresolvable",
        `output '${output.name}' from ${descriptor.intent}`,
        `the output descriptor was ${resolution.status}`,
        snapshot,
      );
    }
    const read = await ctx.surface.act({ kind: "read", ref: resolution.ref });
    outputs[output.name] = parseValue(read.text ?? "", output.extraction.parse);
    ctx.log.write({
      phase: "replay",
      stepId: `out:${output.name}`,
      intent: `extract ${output.name}`,
      action: "read",
      leaseOwner: ctx.control.owner,
      resolvedBy: resolution.strategy,
      resolutionStatus: "resolved",
      outcome: "extracted",
    });
  }

  const shot = await ctx.evidence.saveScreenshot("success", ctx.surface, snapshot);
  if (shot) ctx.screenshots.push(shot);

  return {
    status: "success",
    capability: ctx.capability,
    outputs,
    telemetry: ctx.telemetry,
    evidence: evidenceRefs(ctx),
    timing: timing(ctx),
  };
}

/* ------------------------------------------------------------- exits ----- */

async function fail(
  ctx: RunContext,
  step: Step,
  classification: FailureClassification,
  expected: string,
  observed: string,
  snapshot: UISnapshot,
  detail?: string,
): Promise<ReplayResult> {
  const shot = await ctx.evidence.saveScreenshot(`failure-${step.id}`, ctx.surface, snapshot);
  if (shot) ctx.screenshots.push(shot);

  const error: ReplayFailure = {
    stepId: step.id,
    stepIntent: step.intent,
    classification,
    expected,
    observed,
    detail,
  };

  ctx.log.write({
    phase: "replay",
    stepId: step.id,
    intent: step.intent,
    action: step.action,
    leaseOwner: ctx.control.owner,
    outcome: `failed:${classification}`,
    error: observed,
  });
  ctx.evidence.saveJson(`failure-${step.id}.json`, { error, screen: describeScreen(snapshot) });

  return {
    status: "failed",
    capability: ctx.capability,
    error,
    telemetry: ctx.telemetry,
    evidence: evidenceRefs(ctx),
    timing: timing(ctx),
  };
}

async function escalate(
  ctx: RunContext,
  step: Step,
  reason: string,
  classification: FailureClassification,
  snapshot: UISnapshot,
): Promise<ReplayResult> {
  const queue = new InterventionQueue(ctx.evidence.dir);
  const shot = await ctx.evidence.saveScreenshot(`intervention-${step.id}`, ctx.surface, snapshot);
  if (shot) ctx.screenshots.push(shot);
  const snapPath = saveSnapshot(ctx, `intervention-${step.id}`, snapshot);

  const intervention = queue.open({
    runId: ctx.evidence.runId,
    capability: ctx.capability,
    goal: ctx.artifact.description,
    stepId: step.id,
    stepIntent: step.intent,
    reason,
    classification,
    flow: ctx.artifact.steps.map((s) => ({ id: s.id, intent: s.intent, risk: s.risk })),
    snapshotPath: snapPath,
    screenshotPath: shot,
    visibleText: describeScreen(snapshot),
  });

  // Automation releases the lease as part of raising the request, so there is
  // never a window in which both sides believe they may act. It goes to
  // `awaiting_operator`, not `operator`: nobody has arrived yet, and saying
  // otherwise would authorise a console to start driving on the strength of
  // automation having stopped.
  ctx.control.transferTo(
    "awaiting_operator",
    `intervention ${intervention.interventionId}: ${reason}`,
    intervention.interventionId,
  );

  ctx.log.write({
    phase: "intervention",
    stepId: step.id,
    intent: step.intent,
    action: "escalate",
    leaseOwner: "awaiting_operator",
    outcome: `escalated:${classification}`,
    error: reason,
    extra: { interventionId: intervention.interventionId },
  });

  return {
    status: "escalated",
    capability: ctx.capability,
    interventionId: intervention.interventionId,
    resumeToken: intervention.resumeToken,
    reason,
    telemetry: ctx.telemetry,
    evidence: evidenceRefs(ctx),
    timing: timing(ctx),
  };
}

/* ------------------------------------------------------------- helpers --- */

const evidenceRefs = (ctx: RunContext): EvidenceRefs => ({
  runId: ctx.evidence.runId,
  dir: ctx.evidence.dir,
  logPath: ctx.evidence.logPath,
  screenshots: ctx.screenshots,
  snapshots: ctx.snapshots,
});

const timing = (ctx: RunContext): Timing => ({
  startedAt: ctx.startedAt,
  durationMs: Date.now() - ctx.started,
  stepsExecuted: ctx.telemetry.length,
});

function saveSnapshot(ctx: RunContext, label: string, snapshot: UISnapshot): string {
  ctx.evidence.saveSnapshot(label, snapshot);
  return join("snapshots", `${label}.json`);
}

export function validateInputs(
  artifact: CapabilityArtifact,
  provided: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const bound: Record<string, string> = {};
  for (const input of artifact.inputs) {
    const value = provided[input.name];
    if (value === undefined) {
      if (input.required) {
        throw new InputValidationError(
          `missing required input '${input.name}' for ${artifact.capabilityId}@${artifact.version}`,
        );
      }
      continue;
    }
    const schema = input.jsonSchema as {
      pattern?: string;
      enum?: string[];
      minLength?: number;
      maxLength?: number;
    };
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new InputValidationError(
        `input '${input.name}'='${value}' does not match ${schema.pattern} — rejected before a browser was launched`,
      );
    }
    if (schema.enum && !schema.enum.includes(value)) {
      throw new InputValidationError(
        `input '${input.name}' must be one of: ${schema.enum.join(", ")}`,
      );
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new InputValidationError(
        `input '${input.name}' must be at least ${schema.minLength} characters`,
      );
    }
    bound[input.name] = value;
  }
  return bound;
}

function entryUrl(artifact: CapabilityArtifact, override?: string): string {
  const origin = process.env.CUA_TARGET_ORIGIN ?? "http://localhost:4000";
  const variant = override ?? artifact.target.variant;
  return variant ? `${origin}/?variant=${variant}` : `${origin}/`;
}

function buildAction(
  step: Step,
  ref: string | undefined,
  bound: Readonly<Record<string, string>>,
): SurfaceAction | undefined {
  const value = resolveBinding(step.value, bound);
  switch (step.action) {
    case "click":
      return ref ? { kind: "click", ref } : undefined;
    case "type":
      return ref ? { kind: "type", ref, text: value ?? "" } : undefined;
    case "select":
      return ref ? { kind: "select", ref, option: value ?? "" } : undefined;
    case "read":
      return ref ? { kind: "read", ref } : undefined;
    case "navigate":
      return value ? { kind: "navigate", url: value } : undefined;
    case "key":
      return { kind: "key", key: value ?? "Enter" };
    case "waitFor":
      return { kind: "waitFor", condition: "settled", timeoutMs: step.waitPolicy.timeoutMs };
    case "scroll":
      return { kind: "scroll", direction: "down" };
  }
}

function resolveBinding(
  binding: ValueBinding | undefined,
  bound: Readonly<Record<string, string>>,
): string | undefined {
  if (!binding) return undefined;
  if ("literal" in binding) return binding.literal;
  if ("$param" in binding) return bound[binding.$param];
  return undefined;
}

export function parseValue(
  raw: string,
  rule: { kind: string; pattern?: string; group?: number },
): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (rule.kind === "currency") {
    const m = /-?[$£€]?\s?[\d,]+(?:\.\d{2})?/.exec(text);
    return m ? m[0].trim() : text;
  }
  if (rule.kind === "regex" && rule.pattern) {
    const m = new RegExp(rule.pattern).exec(text);
    return m?.[rule.group ?? 1] ?? text;
  }
  return text;
}

/** A compact description of what was on screen, for failure payloads. */
function describeScreen(snapshot: UISnapshot): string {
  const routes = snapshot.page.frames
    .filter((f) => f.framePath.length > 0)
    .map((f) => `${f.framePath.join(">")}=${f.routePattern}`)
    .join(" ");
  const text = snapshot.elements
    .filter((e) => e.name)
    .slice(0, 14)
    .map((e) => e.name)
    .join(" | ");
  return `[${routes}] ${text}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
