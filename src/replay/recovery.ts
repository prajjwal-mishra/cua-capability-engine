/**
 * Recovery execution.
 *
 * Recoveries are declared as data in the artifact; this file is the small
 * interpreter for that data. Keeping the vocabulary tiny is deliberate — every
 * action a recovery can take is one a reviewer must be able to reason about
 * from the JSON alone, without reading code.
 */

import type { GuardedSurface } from "../policy/gate.js";
import type { Recovery } from "../artifact/schema.js";
import type { UISnapshot } from "../surface/types.js";
import type { ElementDescriptor } from "../locator/descriptor.js";
import { resolveDescriptor } from "../locator/resolve.js";

export async function applyRecovery(
  recovery: Recovery,
  surface: GuardedSurface,
  snapshot: UISnapshot,
  bindings: Readonly<Record<string, string>> = {},
): Promise<UISnapshot> {
  let current = snapshot;

  for (const action of recovery.actions) {
    switch (action.kind) {
      case "wait":
        await new Promise((r) => setTimeout(r, action.ms));
        current = await surface.observe();
        break;

      case "reload":
        await surface.act({ kind: "reload", framePath: action.framePath });
        current = await surface.observe();
        break;

      case "navigate":
        await surface.act({ kind: "navigate", url: action.url });
        current = await surface.observe();
        break;

      case "click": {
        const descriptor = action.target as unknown as ElementDescriptor;
        const outcome = resolveDescriptor(descriptor, current, { bindings });
        if (outcome.status !== "resolved") {
          // A recovery that cannot find its own control has not recovered.
          // Returning the unchanged snapshot lets the caller exhaust the
          // recovery budget and report it, rather than looping silently.
          return current;
        }
        await surface.act({ kind: "click", ref: outcome.ref });
        current = await surface.observe();
        break;
      }

      case "retryStep":
        // Declarative marker: the executor re-runs the step that tripped this
        // recovery. Nothing to do here beyond re-observing.
        current = await surface.observe();
        break;
    }
  }

  return current;
}
