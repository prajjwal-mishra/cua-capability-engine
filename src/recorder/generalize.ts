/**
 * Turning one concrete run into something reusable.
 *
 * The rule throughout: generalize from PROVENANCE, never from string matching.
 * We know a value came from an input because the model bound it by name, not
 * because "10042" appears somewhere in the transcript. String matching would
 * happily rewrite a balance of $10,042.00, an account suffix, or a date that
 * coincided with the member id - and the resulting artifact would be subtly,
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

/**
 * Which frame is "the content frame".
 *
 * Naively this is the deepest one, and that is wrong here: a shell with a nav
 * frame and a content frame has two frames at the same depth, so "deepest"
 * silently picks whichever the browser happened to list first. That produced an
 * entryPoint of /frame/nav - a capability pointed at the menu.
 *
 * When a hint is available (the frame a step actually targets) it wins, because
 * the frame the flow interacts with is by definition the one that matters.
 * Otherwise we require the deepest frame to be unambiguous.
 */
export function contentRoute(
  snapshot: UISnapshot,
  preferFramePath?: readonly string[],
): { framePath: string[]; routePattern: string } {
  const frames = snapshot.page.frames;

  if (preferFramePath && preferFramePath.length > 0) {
    const want = preferFramePath.join(">");
    const hit = frames.find((f) => f.framePath.join(">") === want);
    if (hit) return { framePath: [...hit.framePath], routePattern: hit.routePattern };
  }

  const maxDepth = Math.max(0, ...frames.map((f) => f.framePath.length));
  const deepest = frames.filter((f) => f.framePath.length === maxDepth);
  const chosen = deepest.length === 1 ? deepest[0] : undefined;

  return {
    framePath: [...(chosen?.framePath ?? [])],
    routePattern: chosen?.routePattern ?? snapshot.page.routePattern,
  };
}

/**
 * The frame scope to WRITE INTO a compiled condition - and the reason it is a
 * separate function from `contentRoute`.
 *
 * `contentRoute` has to answer with something, because a route pattern needs a
 * frame. A condition does not: an omitted framePath means "any frame", which is
 * the correct reading of "we could not tell which frame owns this". Reusing
 * `contentRoute`'s `[]` fallback here silently compiled the opposite claim -
 * `[]` scopes a clause to the MAIN frame - so a success condition asserting
 * text that lives in the content frame could never pass. Same principle as the
 * locator ladder: when the answer is ambiguous, say so rather than guess.
 */
export function assertionFrame(
  snapshot: UISnapshot,
  preferFramePath?: readonly string[],
): string[] | undefined {
  const { framePath } = contentRoute(snapshot, preferFramePath);
  return framePath.length > 0 ? framePath : undefined;
}

/** The URL of the frame `contentRoute` would choose. */
export function contentUrl(snapshot: UISnapshot, preferFramePath?: readonly string[]): string {
  const { framePath } = contentRoute(snapshot, preferFramePath);
  const want = framePath.join(">");
  return snapshot.page.frames.find((f) => f.framePath.join(">") === want)?.url ?? snapshot.page.url;
}

/**
 * The frame whose route changed across a step. This is a far better signal for
 * a checkpoint than "the deepest frame's route", because it identifies the
 * thing the step actually moved - and if nothing moved, it says so instead of
 * inventing an assertion.
 */
export function changedFrame(
  pre: UISnapshot,
  post: UISnapshot,
): { framePath: string[]; routePattern: string } | undefined {
  const before = new Map(pre.page.frames.map((f) => [f.framePath.join(">"), f.routePattern]));
  const moved = post.page.frames.filter(
    (f) =>
      before.has(f.framePath.join(">")) && before.get(f.framePath.join(">")) !== f.routePattern,
  );
  // A frame that appeared entirely (a nested grid loading) also counts as motion.
  const appeared = post.page.frames.filter(
    (f) => f.framePath.length > 0 && !before.has(f.framePath.join(">")),
  );
  const candidates = [...moved, ...appeared];
  if (candidates.length !== 1) return undefined;
  const f = candidates[0]!;
  return { framePath: [...f.framePath], routePattern: f.routePattern };
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
