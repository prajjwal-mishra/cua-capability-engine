/**
 * Condition evaluation.
 *
 * Checkpoints, preconditions, outcome detectors and recovery triggers are all
 * the same shape, so this is the only evaluator in the system. It is a pure
 * function of (condition, snapshot) — no browser, no I/O — which makes every
 * detector in every artifact testable without launching anything.
 *
 * A clause with no framePath matches in ANY frame. That is the right default
 * for this surface: a session interstitial or a 503 can replace the content of
 * whichever frame happened to be loading, and a detector that only looks in the
 * frame we expected would miss exactly the case it exists for.
 */

import type { UISnapshot } from "../surface/types.js";
import type { Condition, ConditionClause } from "../artifact/schema.js";

export interface ClauseResult {
  readonly clause: ConditionClause;
  readonly passed: boolean;
  readonly observed: string;
}

export interface ConditionResult {
  readonly passed: boolean;
  readonly describe?: string;
  readonly clauses: readonly ClauseResult[];
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

const inFrame = (elFramePath: readonly string[], want: readonly string[] | undefined): boolean =>
  want === undefined || elFramePath.join(">") === want.join(">");

/** All visible text of a snapshot, optionally confined to one frame. */
function textOf(snapshot: UISnapshot, framePath: readonly string[] | undefined): string {
  return snapshot.elements
    .filter((e) => inFrame(e.framePath, framePath))
    .map((e) => `${e.name} ${e.value ?? ""}`)
    .join(" ");
}

export function evaluateClause(clause: ConditionClause, snapshot: UISnapshot): ClauseResult {
  switch (clause.type) {
    case "textPresent": {
      const hay = norm(textOf(snapshot, clause.framePath));
      const passed = hay.includes(norm(clause.text));
      return {
        clause,
        passed,
        observed: passed ? `found "${clause.text}"` : `"${clause.text}" not on screen`,
      };
    }
    case "textAbsent": {
      const hay = norm(textOf(snapshot, clause.framePath));
      const passed = !hay.includes(norm(clause.text));
      return {
        clause,
        passed,
        observed: passed ? `"${clause.text}" absent` : `unexpectedly found "${clause.text}"`,
      };
    }
    case "elementPresent":
    case "elementAbsent": {
      const matches = snapshot.elements.filter(
        (e) =>
          e.role === clause.role &&
          inFrame(e.framePath, clause.framePath) &&
          (clause.name === undefined || norm(e.name) === norm(clause.name)),
      );
      const present = matches.length > 0;
      const passed = clause.type === "elementPresent" ? present : !present;
      const label = `${clause.role}${clause.name ? ` "${clause.name}"` : ""}`;
      return {
        clause,
        passed,
        observed: present ? `${matches.length} × ${label}` : `no ${label}`,
      };
    }
    case "routeMatches": {
      const frames = snapshot.page.frames.filter((f) => inFrame(f.framePath, clause.framePath));
      const passed = frames.some((f) => routePatternMatches(clause.pattern, f.routePattern));
      return {
        clause,
        passed,
        observed: `frame routes: ${frames.map((f) => f.routePattern).join(", ") || "none"}`,
      };
    }
  }
}

export function evaluateCondition(condition: Condition, snapshot: UISnapshot): ConditionResult {
  const clauses = condition.all.map((c) => evaluateClause(c, snapshot));
  return { passed: clauses.every((c) => c.passed), describe: condition.describe, clauses };
}

/**
 * A recorded pattern like /frame/member/:memberId must match an observed
 * /frame/member/:id — both sides are already canonicalized, and the parameter
 * NAME is ours, not the app's, so any `:token` segment matches any other.
 */
export function routePatternMatches(pattern: string, observed: string): boolean {
  const a = pattern.split("/");
  const b = observed.split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, i) => {
    const other = b[i]!;
    if (seg.startsWith(":") || other.startsWith(":")) return true;
    return seg === other;
  });
}

/** One-line summary for the run log and for a failure payload. */
export function explain(result: ConditionResult): string {
  if (result.passed) return result.describe ?? "condition met";
  const failed = result.clauses.filter((c) => !c.passed);
  return `${result.describe ?? "condition"} — ${failed.map((c) => c.observed).join("; ")}`;
}
