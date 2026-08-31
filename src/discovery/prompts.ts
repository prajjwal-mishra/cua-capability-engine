/**
 * Prompting. The model is handed a normalized, redacted snapshot — never HTML.
 *
 * Parameter VALUES are not in the prompt. The model is told a parameter exists
 * and what it means; when it wants that value typed it binds by name, and the
 * loop substitutes at dispatch. So a credential or a member's PII reaches the
 * browser without ever reaching the provider.
 */

import type { UISnapshot } from "../surface/types.js";

export interface GoalSpec {
  readonly goal: string;
  readonly targetUrl: string;
  readonly tenant: string;
  readonly variant?: string;
  /** Names and descriptions only. Values are held by the loop. */
  readonly params: readonly { name: string; description: string; sensitivity: string }[];
}

export const SYSTEM_PROMPT = `You are operating a legacy bank back-office application through a normalized accessibility view. You cannot see the screen and you cannot write selectors. Each turn you receive a snapshot: a list of elements with a ref, a role, an accessible name, and positional context.

Rules:
- Act by calling exactly one tool per turn, choosing elements by their ref.
- Refs are valid only for the snapshot you were just given. Never reuse an old ref.
- Element names may have been inferred from the surrounding table layout, because this application has no labels. Trust the name, but prefer elements whose role matches what you intend.
- When a value comes from a task input parameter, use the "param" field rather than typing the literal. You are not given parameter values, and you do not need them.
- If the application shows a legitimate business outcome (no such member, permission denied, a validation error), call note_known_outcome. That is a real answer, not a failure — do not try to work around it.
- Call extract_output for every value the goal asks you to return, then call declare_success.
- If you are stuck, looping, or an action looks unsafe or irreversible, call request_human_help instead of guessing.

Be economical. This run is recorded and replayed deterministically afterwards, so every step you take becomes a step someone else has to maintain.`;

export function goalMessage(spec: GoalSpec): string {
  const params =
    spec.params.length === 0
      ? "  (none)"
      : spec.params.map((p) => `  - ${p.name} (${p.sensitivity}): ${p.description}`).join("\n");
  return `GOAL: ${spec.goal}

TARGET: ${spec.targetUrl}
TENANT: ${spec.tenant}${spec.variant ? `  VARIANT: ${spec.variant}` : ""}

INPUT PARAMETERS available to bind by name (values are withheld from you):
${params}`;
}

/**
 * Serialize a snapshot for the model. Compact on purpose: these pages produce
 * dozens of table cells, and a verbose format buys nothing but tokens.
 */
export function renderSnapshot(snapshot: UISnapshot, note?: string): string {
  const lines: string[] = [];
  const frames = snapshot.page.frames.filter((f) => f.framePath.length > 0);
  lines.push(`PAGE: ${snapshot.page.title}`);
  for (const f of frames) {
    lines.push(`FRAME ${f.framePath.join(">")}: ${f.routePattern}`);
  }
  lines.push("ELEMENTS:");

  for (const el of snapshot.elements) {
    const frame = el.framePath.join(">") || "main";
    const bits: string[] = [`[${el.ref}]`, frame, el.role];
    if (el.name) bits.push(`"${el.name}"`);
    if (el.value) bits.push(`value="${el.value}"`);
    if (el.state.disabled) bits.push("disabled");
    const ctx: string[] = [];
    if (el.nearbyText.columnHeader) ctx.push(`col=${el.nearbyText.columnHeader}`);
    if (el.nearbyText.rowKey) ctx.push(`row=${el.nearbyText.rowKey}`);
    if (ctx.length > 0) bits.push(`(${ctx.join(" ")})`);
    lines.push("  " + bits.join(" "));
  }

  if (note) lines.push(`\nNOTE: ${note}`);
  return lines.join("\n");
}
