/**
 * Stopping conditions that are not "max steps".
 *
 * A goal-driven loop fails in two characteristic ways long before it exhausts
 * its budget: it stops moving, or it oscillates between two screens. Both are
 * detectable from the snapshot alone, and detecting them early is the
 * difference between an escalation with useful context and twenty wasted turns
 * followed by a timeout nobody can debug.
 */

import { createHash } from "node:crypto";
import type { UISnapshot } from "../surface/types.js";

/**
 * A stable identity for "what screen is this". Deliberately excludes refs,
 * ordinals and geometry, which change for reasons that are not progress, and
 * includes the frame routes plus the multiset of role+name pairs.
 */
export function snapshotFingerprint(snapshot: UISnapshot): string {
  const routes = snapshot.page.frames
    .map((f) => `${f.framePath.join(">")}=${f.routePattern}`)
    .sort();
  const elements = snapshot.elements
    .map((e) => `${e.framePath.join(">")}|${e.role}|${e.name}`)
    .sort();
  return createHash("sha1")
    .update([...routes, ...elements].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export type StallReason = "no_progress" | "oscillating";

export class ProgressMonitor {
  private readonly history: string[] = [];

  constructor(
    private readonly repeatLimit = 3,
    private readonly oscillationLimit = 3,
  ) {}

  record(snapshot: UISnapshot): void {
    this.history.push(snapshotFingerprint(snapshot));
  }

  /** Non-null when the loop should stop and escalate rather than press on. */
  stalled(): StallReason | undefined {
    const n = this.history.length;

    // The same screen, repeatLimit times running: the actions are not landing.
    if (n >= this.repeatLimit) {
      const tail = this.history.slice(-this.repeatLimit);
      if (tail.every((f) => f === tail[0])) return "no_progress";
    }

    // A,B,A,B…: each action works, but the pair makes no forward progress.
    const needed = this.oscillationLimit * 2;
    if (n >= needed) {
      const tail = this.history.slice(-needed);
      const even = tail.filter((_, i) => i % 2 === 0);
      const odd = tail.filter((_, i) => i % 2 === 1);
      const uniform = (xs: string[]) => xs.every((x) => x === xs[0]);
      if (uniform(even) && uniform(odd) && even[0] !== odd[0]) return "oscillating";
    }

    return undefined;
  }

  get fingerprints(): readonly string[] {
    return this.history;
  }
}
