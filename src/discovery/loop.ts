/**
 * The discovery loop: observe → model decides → policy gate → act → record.
 *
 * This is the only place in the system that talks to an LLM. It produces a
 * TRACE, not an artifact — compilation is a separate, deterministic step, so
 * the model's transcript stays evidence rather than becoming the capability.
 */

import { randomUUID } from "node:crypto";
import type { GuardedSurface } from "../policy/gate.js";
import { ApprovalRequired, PolicyViolation } from "../policy/gate.js";
import type { UIElement, UISnapshot, SurfaceAction } from "../surface/types.js";
import type { RunLog } from "../obs/log.js";
import type { EvidenceWriter } from "../obs/evidence.js";
import type { Redactor } from "../policy/redact.js";
import { LlmClient, type ChatMessage, type LlmToolCall } from "./llm.js";
import { DISCOVERY_TOOLS } from "./tools.js";
import { goalMessage, renderSnapshot, SYSTEM_PROMPT, type GoalSpec } from "./prompts.js";
import { ProgressMonitor, type StallReason } from "./progress.js";

export interface RecordedStep {
  readonly index: number;
  readonly tool: string;
  readonly rationale: string;
  readonly action: SurfaceAction;
  /** The target as it appeared in the snapshot the model was looking at. */
  readonly element?: UIElement;
  /** Set when the value came from an input parameter — the provenance that
   *  makes generalization safe rather than a string search. */
  readonly paramBinding?: string;
  readonly literalValue?: string;
  readonly preSnapshot: UISnapshot;
  readonly postSnapshot: UISnapshot;
}

export interface DeclaredOutput {
  readonly name: string;
  readonly element: UIElement;
  readonly parse: "text" | "currency";
  readonly snapshot: UISnapshot;
}

export interface NotedOutcome {
  readonly code: string;
  readonly severity: "business" | "recoverable" | "hard";
  readonly evidenceText: string;
  readonly message: string;
  readonly snapshot: UISnapshot;
}

export type DiscoveryStatus =
  "success" | "stalled" | "human_requested" | "budget_exhausted" | "blocked";

export interface DiscoveryTrace {
  readonly runId: string;
  readonly status: DiscoveryStatus;
  readonly goal: GoalSpec;
  readonly model: string;
  readonly steps: readonly RecordedStep[];
  readonly outputs: readonly DeclaredOutput[];
  readonly outcomes: readonly NotedOutcome[];
  readonly successEvidence?: { text: string; snapshot: UISnapshot };
  readonly stopReason: string;
  readonly stall?: StallReason;
}

export interface DiscoveryOptions {
  readonly maxSteps?: number;
  readonly maxDurationMs?: number;
  /** Concrete parameter values. Never sent to the model. */
  readonly paramValues: Readonly<Record<string, string>>;
}

export async function runDiscovery(
  surface: GuardedSurface,
  llm: LlmClient,
  goal: GoalSpec,
  log: RunLog,
  evidence: EvidenceWriter,
  redactor: Redactor,
  options: DiscoveryOptions,
): Promise<DiscoveryTrace> {
  const runId = evidence.runId;
  const maxSteps = options.maxSteps ?? 24;
  const deadline = Date.now() + (options.maxDurationMs ?? 180_000);

  // Values for pii/secret params must never surface in a log or a prompt.
  for (const p of goal.params) {
    const value = options.paramValues[p.name];
    if (value && (p.sensitivity === "pii" || p.sensitivity === "secret")) {
      redactor.registerLiteral(value, `{{param:${p.name}}}`);
    }
  }

  const steps: RecordedStep[] = [];
  const outputs: DeclaredOutput[] = [];
  const outcomes: NotedOutcome[] = [];
  const progress = new ProgressMonitor();

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: goalMessage(goal) },
  ];

  const finish = (
    status: DiscoveryStatus,
    stopReason: string,
    extra: Partial<DiscoveryTrace> = {},
  ): DiscoveryTrace => ({
    runId,
    status,
    goal,
    model: llm.model,
    steps,
    outputs,
    outcomes,
    stopReason,
    ...extra,
  });

  // Enter the app. Recorded as a step so the artifact has an entry point.
  await surface.act({ kind: "navigate", url: goal.targetUrl });
  let snapshot = await surface.observe();
  evidence.saveSnapshot("000-entry", snapshot);

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() > deadline) {
      return finish("budget_exhausted", `wall clock budget exceeded after ${i} steps`);
    }

    progress.record(snapshot);
    const stall = progress.stalled();
    if (stall) {
      log.write({
        phase: "discovery",
        stepId: `d${i}`,
        intent: "stall detected",
        action: "none",
        leaseOwner: "automation",
        outcome: stall,
      });
      return finish("stalled", `loop is ${stall}; escalating rather than burning the budget`, {
        stall,
      });
    }

    const redacted = redactor.redactSnapshot(snapshot).snapshot;
    messages.push({ role: "user", content: renderSnapshot(redacted) });

    const turn = await llm.next(messages, DISCOVERY_TOOLS);
    const call = turn.toolCalls[0];

    if (!call) {
      messages.push({ role: "assistant", content: turn.text ?? "" });
      messages.push({
        role: "user",
        content: "You must respond with exactly one tool call. Choose an action from the snapshot.",
      });
      continue;
    }

    messages.push({
      role: "assistant",
      content: turn.text ?? null,
      tool_calls: [
        {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        },
      ],
    });

    const rationale = String(call.args.why ?? call.args.reason ?? "");
    const reply = (content: string) =>
      messages.push({ role: "tool", tool_call_id: call.id, content });

    /* --------------------------------------------------- terminal tools -- */

    if (call.name === "declare_success") {
      const text = String(call.args.evidence_text ?? "");
      log.write({
        phase: "discovery",
        stepId: `d${i}`,
        intent: "declare success",
        action: "declare_success",
        leaseOwner: "automation",
        rationale,
        outcome: "success",
      });
      await evidence.saveScreenshot("success", surface, snapshot);
      return finish("success", "model declared the goal reached", {
        successEvidence: { text, snapshot },
      });
    }

    if (call.name === "request_human_help") {
      const reason = String(call.args.reason ?? "unspecified");
      log.write({
        phase: "discovery",
        stepId: `d${i}`,
        intent: "request human help",
        action: "request_human_help",
        leaseOwner: "automation",
        rationale: reason,
        outcome: "human_requested",
      });
      return finish("human_requested", reason);
    }

    /* ------------------------------------------------- declarative tools -- */

    if (call.name === "extract_output") {
      const el = elementFor(snapshot, call.args.ref);
      if (!el) {
        reply(refError(call.args.ref));
        continue;
      }
      outputs.push({
        name: String(call.args.name ?? "output"),
        element: el,
        parse: call.args.parse === "currency" ? "currency" : "text",
        snapshot,
      });
      log.write({
        phase: "discovery",
        stepId: `d${i}`,
        intent: `declare output ${String(call.args.name)}`,
        action: "extract_output",
        leaseOwner: "automation",
        rationale,
        descriptorIntent: el.name,
      });
      reply(`recorded output '${String(call.args.name)}' = ${redactor.redactText(el.name)}`);
      continue;
    }

    if (call.name === "note_known_outcome") {
      const noted: NotedOutcome = {
        code: String(call.args.code ?? "unknown"),
        severity: (call.args.severity as NotedOutcome["severity"]) ?? "business",
        evidenceText: String(call.args.evidence_text ?? ""),
        message: String(call.args.message ?? ""),
        snapshot,
      };
      outcomes.push(noted);
      log.write({
        phase: "discovery",
        stepId: `d${i}`,
        intent: `note outcome ${noted.code}`,
        action: "note_known_outcome",
        leaseOwner: "automation",
        rationale,
        outcome: noted.code,
      });
      await evidence.saveScreenshot(`outcome-${noted.code}`, surface, snapshot);
      reply(
        `recorded known outcome '${noted.code}'. If this answers the goal, declare_success; otherwise continue.`,
      );
      continue;
    }

    /* ------------------------------------------------------- act tools --- */

    const built = buildAction(call, snapshot, options.paramValues);
    if ("error" in built) {
      reply(built.error);
      continue;
    }

    const preSnapshot = snapshot;
    try {
      const result = await surface.act(built.action);
      const postSnapshot = await surface.observe();

      steps.push({
        index: steps.length,
        tool: call.name,
        rationale,
        action: built.action,
        element: built.element,
        paramBinding: built.paramBinding,
        literalValue: built.literalValue,
        preSnapshot,
        postSnapshot,
      });

      log.write({
        phase: "discovery",
        stepId: `d${i}`,
        intent: rationale || call.name,
        action: call.name,
        leaseOwner: "automation",
        descriptorIntent: built.element?.name,
        rationale,
        error: result.ok ? undefined : result.error,
        extra: { paramBinding: built.paramBinding },
      });

      snapshot = postSnapshot;
      evidence.saveSnapshot(`${String(steps.length).padStart(3, "0")}-${call.name}`, snapshot);
      reply(result.ok ? "done" : `action failed: ${result.error ?? "unknown"}`);
    } catch (err) {
      if (err instanceof ApprovalRequired) {
        log.write({
          phase: "discovery",
          stepId: `d${i}`,
          intent: rationale,
          action: call.name,
          leaseOwner: "automation",
          policy: { verdict: "escalate", risk: "irreversible", reason: err.message },
          outcome: "escalated",
        });
        await evidence.saveScreenshot(`escalation-${i}`, surface, snapshot);
        return finish("blocked", `irreversible action requires human confirmation: ${err.message}`);
      }
      if (err instanceof PolicyViolation) {
        log.write({
          phase: "discovery",
          stepId: `d${i}`,
          intent: rationale,
          action: call.name,
          leaseOwner: "automation",
          policy: {
            verdict: "deny",
            risk: err.decision.risk,
            code: err.decision.code,
            reason: err.decision.reason,
          },
        });
        // A policy denial is information the model can act on, not a crash.
        reply(`refused by policy: ${err.decision.reason}. Choose a different approach.`);
        continue;
      }
      throw err;
    }
  }

  return finish(
    "budget_exhausted",
    `reached the ${maxSteps}-step budget without declaring success`,
  );
}

/* ------------------------------------------------------------ helpers ---- */

function elementFor(snapshot: UISnapshot, ref: unknown): UIElement | undefined {
  return snapshot.elements.find((e) => e.ref === String(ref));
}

const refError = (ref: unknown) =>
  `no element ${String(ref)} in the current snapshot — refs are only valid for the snapshot you were just shown`;

type BuiltAction =
  | { action: SurfaceAction; element?: UIElement; paramBinding?: string; literalValue?: string }
  | { error: string };

function buildAction(
  call: LlmToolCall,
  snapshot: UISnapshot,
  paramValues: Readonly<Record<string, string>>,
): BuiltAction {
  const ref = call.args.ref === undefined ? undefined : String(call.args.ref);
  const element = ref ? elementFor(snapshot, ref) : undefined;

  switch (call.name) {
    case "navigate":
      return { action: { kind: "navigate", url: String(call.args.url ?? "") } };

    case "click":
      if (!element) return { error: refError(ref) };
      return { action: { kind: "click", ref: element.ref }, element };

    case "read":
      if (!element) return { error: refError(ref) };
      return { action: { kind: "read", ref: element.ref }, element };

    case "select":
      if (!element) return { error: refError(ref) };
      return {
        action: { kind: "select", ref: element.ref, option: String(call.args.option ?? "") },
        element,
        literalValue: String(call.args.option ?? ""),
      };

    case "type": {
      if (!element) return { error: refError(ref) };
      const param = call.args.param === undefined ? undefined : String(call.args.param);
      if (param !== undefined) {
        const value = paramValues[param];
        if (value === undefined) {
          return {
            error: `no input parameter named '${param}'. Available: ${Object.keys(paramValues).join(", ")}`,
          };
        }
        return {
          action: {
            kind: "type",
            ref: element.ref,
            text: value,
            submit: call.args.submit === true,
          },
          element,
          paramBinding: param,
        };
      }
      const text = call.args.text === undefined ? undefined : String(call.args.text);
      if (text === undefined) return { error: "type requires either 'text' or 'param'" };
      return {
        action: { kind: "type", ref: element.ref, text, submit: call.args.submit === true },
        element,
        literalValue: text,
      };
    }

    default:
      return { error: `unknown tool '${call.name}'` };
  }
}
