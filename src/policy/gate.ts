/**
 * The single choke point.
 *
 * Every action dispatched by this system — discovery, replay, and the operator
 * desk — passes through PolicyGate.check. Discovery and replay are handed a
 * GuardedSurface, which cannot be constructed without a gate. The desk calls
 * check() itself before it touches the raw surface, with actor: "operator":
 * a human is not the automation, but they are still inside the allowlist.
 * A test asserts the gate was consulted exactly as many times as the surface
 * was driven.
 *
 * Gate and GuardedSurface live in one file on purpose: the security-relevant
 * question "can anything act without a check?" should be answerable by reading
 * a single file top to bottom.
 */

import type {
  ActionResult,
  Surface,
  SurfaceAction,
  SurfaceCapabilities,
  UIElement,
  UISnapshot,
  Bounds,
} from "../surface/types.js";
import { checkUrl, type Allowlist } from "./allowlist.js";
import { classifyAction, effectiveRisk, type RiskClass } from "./risk.js";
import type { LeaseOwner } from "../escalation/control.js";

export type DenyCode =
  | "lease_not_held"
  | "action_not_allowed"
  | "origin_not_allowed"
  | "route_not_allowed"
  | "role_not_allowed"
  | "forbidden_field"
  | "writes_not_enabled"
  | "artifact_not_approved"
  | "coordinate_fallback_disabled";

export type PolicyDecision =
  | { readonly verdict: "allow"; readonly risk: RiskClass }
  | {
      readonly verdict: "deny";
      readonly risk: RiskClass;
      readonly code: DenyCode;
      readonly reason: string;
    }
  | {
      /** Never auto-executed. Routed to a human, who decides. */
      readonly verdict: "escalate";
      readonly risk: "irreversible";
      readonly reason: string;
    };

export interface PolicyContext {
  readonly mode: "discovery" | "replay";
  readonly allowlist: Allowlist;
  readonly currentUrl: string;
  /** The resolved target, when the action has one. */
  readonly element?: UIElement;
  /** Caller explicitly opted into state-changing actions. */
  readonly allowWrites: boolean;
  /** Replay only: unattended writes require an approved artifact. */
  readonly artifactApproved?: boolean;
  /**
   * A human is supervising this run and can see what it does.
   *
   * This is what makes the approval gate a gate rather than a deadlock: a draft
   * cannot be approved until it has proven it replays, and it cannot prove that
   * without being allowed to run. A supervised shadow replay is how a recording
   * earns approval. An agent invoking through the catalog is never supervised,
   * so it never gets this.
   */
  readonly attended?: boolean;
  /**
   * Who is asking. Defaults to automation. An operator who has taken the
   * lease may act — including on irreversible controls, which is the whole
   * point of the handoff — but they still cannot leave the allowlist or type
   * into a forbidden field. The desk is an HTTP API on localhost; without
   * those checks it would be a second door around the gate.
   */
  readonly actor?: "automation" | "operator";
  readonly leaseOwner: LeaseOwner;
  /** Risk this step declares in a reviewed artifact, if any. Can raise the
   *  heuristic classification, never lower it. */
  readonly declaredRisk?: RiskClass;
}

export class PolicyGate {
  /** Instrumentation for the no-bypass test. Not load-bearing at runtime. */
  private checkCount = 0;

  get checks(): number {
    return this.checkCount;
  }

  check(action: SurfaceAction, ctx: PolicyContext): PolicyDecision {
    this.checkCount += 1;
    const { allowlist } = ctx;
    const risk = effectiveRisk(
      classifyAction(action, ctx.element, allowlist.risk),
      ctx.declaredRisk,
    );

    const deny = (code: DenyCode, reason: string): PolicyDecision => ({
      verdict: "deny",
      risk,
      code,
      reason,
    });

    // 1. Control. One owner, enforced here rather than by convention.
    const actor = ctx.actor ?? "automation";
    if (actor === "operator") {
      if (ctx.leaseOwner !== "operator") {
        return deny(
          "lease_not_held",
          "take control before acting on the session",
        );
      }
    } else if (ctx.leaseOwner !== "automation") {
      const held =
        ctx.leaseOwner === "operator"
          ? "an operator is driving this session"
          : "the session is released and waiting for an operator";
      return deny("lease_not_held", `${held}; automation must not act`);
    }

    // 2. Action type.
    if (!allowlist.actions.includes(action.kind)) {
      return deny("action_not_allowed", `action '${action.kind}' is not permitted for this app`);
    }

    // 3. Location. Navigation is checked against its destination; everything
    //    else against where we already are — acting on a page we should never
    //    have reached is still acting outside the allowlist.
    const urlUnderTest = action.kind === "navigate" ? action.url : ctx.currentUrl;
    const urlCheck = checkUrl(allowlist, urlUnderTest);
    if (!urlCheck.ok) {
      const code: DenyCode = /origin/.test(urlCheck.reason ?? "")
        ? "origin_not_allowed"
        : "route_not_allowed";
      return deny(code, urlCheck.reason ?? "url rejected");
    }

    // 4. Target role.
    if (ctx.element && !allowlist.targetRoles.includes(ctx.element.role)) {
      return deny("role_not_allowed", `target role '${ctx.element.role}' is not permitted`);
    }

    // 5. Forbidden fields. Matched on the control's accessible name, which on
    //    this surface is often the adjacent label cell — the same thing a human
    //    reads to know what a box is for.
    if ((action.kind === "type" || action.kind === "select") && ctx.element) {
      const name = ctx.element.name.toLowerCase();
      const hit = allowlist.forbiddenFieldPatterns.find((p) => name.includes(p.toLowerCase()));
      if (hit) {
        return deny(
          "forbidden_field",
          `field '${ctx.element.name}' matches forbidden pattern '${hit}'`,
        );
      }
    }

    // 6. Risk. An operator who holds the lease is the confirmation that
    //    irreversible actions exist to wait for. The allowlist still bound
    //    them in the checks above.
    if (actor === "operator") return { verdict: "allow", risk };

    if (risk === "read_only") return { verdict: "allow", risk };

    if (risk === "reversible_write") {
      if (!ctx.allowWrites) {
        return deny(
          "writes_not_enabled",
          `'${describeTarget(action, ctx.element)}' writes state; re-run with --allow-writes to permit it`,
        );
      }
      if (ctx.mode === "replay" && ctx.artifactApproved === false && ctx.attended !== true) {
        return deny(
          "artifact_not_approved",
          "unattended writes require an approved capability; this artifact is still draft. " +
            "Shadow-replay it with a human watching (--attended) to earn approval.",
        );
      }
      return { verdict: "allow", risk };
    }

    // 7. Irreversible actions are never executed automatically, with or without
    //    a flag. In a regulated back office the cost of one wrong irreversible
    //    action dominates the cost of any number of escalations.
    return {
      verdict: "escalate",
      risk: "irreversible",
      reason: `'${describeTarget(action, ctx.element)}' is irreversible and requires human confirmation`,
    };
  }
}

function describeTarget(action: SurfaceAction, element: UIElement | undefined): string {
  if (element?.name) return element.name;
  if (action.kind === "navigate") return action.url;
  return action.kind;
}

/* ------------------------------------------------------ guarded surface --- */

export class PolicyViolation extends Error {
  constructor(
    readonly decision: Extract<PolicyDecision, { verdict: "deny" }>,
    readonly action: SurfaceAction,
  ) {
    super(`policy denied ${action.kind}: ${decision.reason}`);
    this.name = "PolicyViolation";
  }
}

export class ApprovalRequired extends Error {
  constructor(
    readonly decision: Extract<PolicyDecision, { verdict: "escalate" }>,
    readonly action: SurfaceAction,
  ) {
    super(decision.reason);
    this.name = "ApprovalRequired";
  }
}

export interface GuardedSurfaceOptions {
  readonly gate: PolicyGate;
  /** Read at every action, so a lease handover mid-run takes effect at once. */
  readonly context: () => Omit<PolicyContext, "currentUrl" | "element">;
  /** Per-action risk declared by the artifact step currently executing. */
  readonly declaredRisk?: () => RiskClass | undefined;
  readonly onDecision?: (
    action: SurfaceAction,
    decision: PolicyDecision,
    element: UIElement | undefined,
  ) => void;
}

/**
 * The only surface the discovery loop and replay executor ever see.
 *
 * It resolves the action's target from the most recent snapshot so the gate can
 * reason about what is actually being touched, not just the action's shape.
 */
export class GuardedSurface implements Surface {
  private lastSnapshot: UISnapshot | undefined;

  constructor(
    private readonly inner: Surface,
    private readonly options: GuardedSurfaceOptions,
  ) {}

  capabilities(): SurfaceCapabilities {
    return this.inner.capabilities();
  }

  async observe(): Promise<UISnapshot> {
    const snap = await this.inner.observe();
    this.lastSnapshot = snap;
    return snap;
  }

  async screenshot(masks: readonly Bounds[] = []): Promise<Buffer> {
    if (!this.inner.screenshot) throw new Error("surface cannot screenshot");
    return this.inner.screenshot(masks);
  }

  /** The most recent observation, for callers that need to resolve a ref. */
  get snapshot(): UISnapshot | undefined {
    return this.lastSnapshot;
  }

  async act(action: SurfaceAction): Promise<ActionResult> {
    const element = this.targetOf(action);
    const base = this.options.context();
    const decision = this.options.gate.check(action, {
      ...base,
      currentUrl: this.currentUrl(),
      element,
      declaredRisk: this.options.declaredRisk?.(),
    });

    this.options.onDecision?.(action, decision, element);

    if (decision.verdict === "deny") throw new PolicyViolation(decision, action);
    if (decision.verdict === "escalate") throw new ApprovalRequired(decision, action);

    return this.inner.act(action);
  }

  private targetOf(action: SurfaceAction): UIElement | undefined {
    if (!("ref" in action) || action.ref === undefined) return undefined;
    return this.lastSnapshot?.elements.find((e) => e.ref === action.ref);
  }

  /**
   * The URL that matters for a policy check is the one the action will touch.
   * In a frameset app that is the deepest content frame, not the shell.
   */
  private currentUrl(): string {
    const snap = this.lastSnapshot;
    if (!snap) return "about:blank";
    const deepest = [...snap.page.frames].sort(
      (a, b) => b.framePath.length - a.framePath.length,
    )[0];
    return deepest?.url ?? snap.page.url;
  }
}
