/**
 * Descriptor resolution.
 *
 * Note what this operates on: a UISnapshot, not a live DOM. Resolution is a
 * pure function from (descriptor, snapshot) to a ref. That is deliberate —
 * it means the locator ladder is unit-testable against saved fixtures with no
 * browser, and it means a DesktopSurface that produces the same snapshot shape
 * gets the same resolution behaviour for free.
 *
 * The rule that matters: A UNIQUE MATCH IS REQUIRED. If a rung matches three
 * elements we do not pick one — we record the ambiguity and try a more specific
 * rung. If no rung resolves uniquely, resolution fails. Guessing here is how
 * automation ends up clicking the wrong customer's account.
 */

import type { UIElement, UISnapshot } from "../surface/types.js";
import { elementsInFrame, type ElementDescriptor, type StrategyKind } from "./descriptor.js";

export interface StrategyAttempt {
  readonly kind: StrategyKind;
  readonly confidence: number;
  readonly matches: number;
  readonly skipped?: string;
}

export type ResolutionOutcome =
  | {
      readonly status: "resolved";
      readonly ref: string;
      readonly strategy: StrategyKind;
      readonly confidence: number;
      readonly attempts: readonly StrategyAttempt[];
    }
  | {
      readonly status: "ambiguous";
      /** How many elements the most specific attempted rung matched. */
      readonly candidates: number;
      readonly attempts: readonly StrategyAttempt[];
    }
  | { readonly status: "not_found"; readonly attempts: readonly StrategyAttempt[] };

export interface ResolveOptions {
  /** Coordinates are diagnostics by default. Turning this on is a policy act. */
  readonly allowCoordinateFallback?: boolean;
  /**
   * Input values for this invocation, substituted into parameterized strategy
   * text. Without this, any descriptor that identifies a row BY its key — "the
   * link named 10042" — is welded to the member it was recorded against, and
   * the capability is not a capability at all.
   */
  readonly bindings?: Readonly<Record<string, string>>;
}

/** Replace `{{param:name}}` tokens with this invocation's values. */
export function interpolate(text: string, bindings: Readonly<Record<string, string>> = {}): string {
  return text.replace(/\{\{param:([A-Za-z0-9_]+)\}\}/g, (whole, name: string) =>
    bindings[name] !== undefined ? bindings[name]! : whole,
  );
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export function resolveDescriptor(
  descriptor: ElementDescriptor,
  snapshot: UISnapshot,
  opts: ResolveOptions = {},
): ResolutionOutcome {
  const scoped = elementsInFrame(snapshot, descriptor.framePath);
  const attempts: StrategyAttempt[] = [];
  let sawAmbiguity = 0;

  for (const strategy of descriptor.strategies) {
    if (strategy.kind === "bounds" && !opts.allowCoordinateFallback) {
      attempts.push({
        kind: strategy.kind,
        confidence: strategy.confidence,
        matches: 0,
        skipped: "coordinate fallback disabled by policy",
      });
      continue;
    }

    const matches = matchStrategy(strategy, scoped, opts.bindings ?? {});
    attempts.push({
      kind: strategy.kind,
      confidence: strategy.confidence,
      matches: matches.length,
    });

    if (matches.length === 1) {
      return {
        status: "resolved",
        ref: matches[0]!.ref,
        strategy: strategy.kind,
        confidence: strategy.confidence,
        attempts,
      };
    }
    // More than one match is not a coin flip — escalate to a more specific rung.
    if (matches.length > 1) sawAmbiguity = matches.length;
  }

  if (sawAmbiguity > 0) return { status: "ambiguous", candidates: sawAmbiguity, attempts };
  return { status: "not_found", attempts };
}

/* ----------------------------------------------------------- strategies --- */

function matchStrategy(
  strategy: ElementDescriptor["strategies"][number],
  scoped: readonly UIElement[],
  bindings: Readonly<Record<string, string>>,
): readonly UIElement[] {
  switch (strategy.kind) {
    case "role_name": {
      const wanted = interpolate(strategy.name, bindings);
      const exact = scoped.filter((e) => e.role === strategy.role && e.name === wanted);
      if (exact.length === 1) return exact;
      // Case/whitespace drift is the most common benign change in these apps.
      const relaxed = scoped.filter(
        (e) => e.role === strategy.role && norm(e.name) === norm(wanted),
      );
      return relaxed.length > 0 ? relaxed : exact;
    }

    case "label_anchor": {
      const want = norm(interpolate(strategy.labelText, bindings));
      return scoped.filter((e) => {
        if (e.role !== strategy.role) return false;
        if (strategy.relation === "same-row") return norm(e.nearbyText.leftCell ?? "") === want;
        if (strategy.relation === "same-column") return norm(e.nearbyText.aboveCell ?? "") === want;
        return norm(e.nearbyText.precedingText ?? "") === want;
      });
    }

    case "table_cell": {
      const col = norm(interpolate(strategy.columnHeader, bindings));
      const row = norm(interpolate(strategy.rowKey, bindings));
      return scoped.filter(
        (e) =>
          norm(e.nearbyText.columnHeader ?? "") === col && norm(e.nearbyText.rowKey ?? "") === row,
      );
    }

    case "frame_role_ordinal": {
      // Two readings, and they resolve to different elements. Scoped to role
      // alone, the ordinal counts every control of that role in the frame — the
      // reading that still means something after a relabel. Scoped to role and
      // name, it disambiguates genuine duplicates of the same label.
      if (strategy.ordinalScope === "role") {
        return scoped.filter((e) => e.role === strategy.role && e.roleOrdinal === strategy.ordinal);
      }
      if (strategy.name === undefined) return [];
      const wanted = norm(interpolate(strategy.name, bindings));
      return scoped.filter(
        (e) =>
          e.role === strategy.role && norm(e.name) === wanted && e.ordinal === strategy.ordinal,
      );
    }

    case "structural":
      return scoped.filter((e) => e.structuralPath === strategy.path);

    case "bounds": {
      // Nearest element whose recorded box overlaps. Only ever reached when
      // policy explicitly allows it, and still required to be unambiguous.
      const b = strategy.bounds;
      return scoped.filter(
        (e) =>
          e.bounds !== undefined &&
          Math.abs(e.bounds.x - b.x) < 8 &&
          Math.abs(e.bounds.y - b.y) < 8,
      );
    }
  }
}

/**
 * Drift signal. The recorded top rung is what we expected to resolve; anything
 * lower means the app moved under us even though the step still worked.
 */
export function isDriftSignal(descriptor: ElementDescriptor, outcome: ResolutionOutcome): boolean {
  if (outcome.status !== "resolved") return false;
  const top = descriptor.strategies[0];
  return top !== undefined && top.kind !== outcome.strategy;
}
