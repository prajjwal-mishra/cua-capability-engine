/**
 * Turning one concrete run into something reusable.
 *
 * The rule throughout: generalize from PROVENANCE, never from string matching.
 * We know a value came from an input because the model bound it by name, not
 * because "10042" appears somewhere in the transcript. String matching would
 * happily rewrite a balance of $10,042.00, an account suffix, or a date that
 * coincided with the member id — and the resulting artifact would be subtly,
 * silently wrong on the next invocation.
 */

import type { UISnapshot } from "../surface/types.js";

export interface ParamProvenance {
  /** param name → the concrete value used during this discovery run. */
  readonly values: Readonly<Record<string, string>>;
  /** param names actually bound to a step, i.e. proven to flow into the UI. */
  readonly bound: ReadonlySet<string>;
}

/**
 * Canonicalize a route into a pattern.
 *
 * A segment is replaced by `:paramName` only when it exactly equals the value
 * of a parameter we PROVED was typed into the app during this run. Everything
 * else keeps a conservative numeric collapse, which is a display nicety rather
 * than a binding.
 */
export function canonicalizeEntryPoint(rawUrl: string, provenance: ParamProvenance): string {
  let path: string;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    path = rawUrl;
  }

  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(provenance.values)) {
    if (provenance.bound.has(name) && value.length > 0) byValue.set(value, name);
  }

  return path
    .split("/")
    .map((seg) => {
      const param = byValue.get(seg);
      if (param) return `:${param}`;
      return /^\d{3,}$/.test(seg) ? ":id" : seg;
    })
    .join("/");
}

/**
 * Detector text must not embed a run-specific value, or the detector only ever
 * fires for the member we happened to record against. Returns the text with any
 * bound parameter value removed, and flags when that happened so the caller can
 * decide whether the detector is still meaningful.
 */
export function generalizeDetectorText(
  text: string,
  provenance: ParamProvenance,
): { text: string; containedParam?: string } {
  for (const [name, value] of Object.entries(provenance.values)) {
    if (!provenance.bound.has(name) || value.length < 2) continue;
    if (text.includes(value)) {
      return {
        text: text
          .split(value)
          .join("")
          .replace(/\s{2,}/g, " ")
          .trim(),
        containedParam: name,
      };
    }
  }
  return { text };
}

/** The deepest frame's route — in a frameset app that is the one that moves. */
export function contentRoute(snapshot: UISnapshot): { framePath: string[]; routePattern: string } {
  const deepest = [...snapshot.page.frames].sort(
    (a, b) => b.framePath.length - a.framePath.length,
  )[0];
  return {
    framePath: [...(deepest?.framePath ?? [])],
    routePattern: deepest?.routePattern ?? snapshot.page.routePattern,
  };
}

/**
 * Replace any strategy text that is EXACTLY a bound parameter's value with a
 * `{{param:name}}` token.
 *
 * Exact equality, not substring: "10042" as a whole accessible name is the
 * member id; "10042" appearing inside "$10,042.00" is a coincidence, and
 * rewriting the latter would produce a descriptor that matches nothing.
 */
export function parameterizeStrategyText(text: string, provenance: ParamProvenance): string {
  for (const name of provenance.bound) {
    const value = provenance.values[name];
    if (value !== undefined && value.length > 0 && text === value) return `{{param:${name}}}`;
  }
  return text;
}

/** Elements present after a step that were not present before it. */
export function newlyPresent(pre: UISnapshot, post: UISnapshot): UISnapshot["elements"] {
  const before = new Set(pre.elements.map((e) => `${e.framePath.join(">")}|${e.role}|${e.name}`));
  return post.elements.filter(
    (e) => e.name !== "" && !before.has(`${e.framePath.join(">")}|${e.role}|${e.name}`),
  );
}
