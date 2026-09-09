/**
 * Capturing what the human did, in the automation's own vocabulary.
 *
 * This is the piece that makes a handoff more than a pause. When an operator
 * takes over, their clicks and keystrokes are recorded as normalized
 * SurfaceAction-shaped records - role, accessible name, frame path - not as CSS
 * selectors or screen coordinates. That matters for one specific reason: the
 * only way captured human work can later be PROMOTED into a proposed artifact
 * patch is if it is already expressed in the same terms the artifact uses.
 * Record a click as `div.x > button:nth-child(2)` and that path is closed
 * forever.
 *
 * Events are pushed OUT of the page the instant they happen, over a binding,
 * rather than buffered in a page-scoped array and collected later. The first
 * version did buffer, and it lost every action that mattered: in this app an
 * operator's click navigates the frame, and the navigation destroys the buffer
 * before anyone drains it. The interesting human action is almost always the
 * one that moves the flow forward, so a collector that only survives
 * inconsequential clicks records nothing worth having.
 *
 * Values are never captured verbatim. A field's content is recorded as a length
 * and a class, because an operator resolving a stuck run is, by definition,
 * typing into a live banking system.
 */

import type { Frame, Page } from "playwright";
import type { CapturedAction } from "./intervention.js";

/** Runs inside the page. Self-contained: no imports, no closure over module scope. */
function installCapture(): void {
  const w = window as unknown as {
    __cuaHumanInstalled?: boolean;
    __cuaHumanEvent?: (record: Record<string, unknown>) => void;
  };
  if (w.__cuaHumanInstalled) return;
  w.__cuaHumanInstalled = true;

  const clean = (s: string | null | undefined): string =>
    (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

  const roleOf = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    return tag;
  };

  /** Same fallback the perception layer uses: on this markup the label IS the
   *  adjacent table cell, so a captured action names the control the way an
   *  operator would describe it. */
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") {
        return clean((el as HTMLInputElement).value);
      }
    }
    if (tag === "button" || tag === "a") return clean(el.textContent);
    const cell = el.closest("td, th");
    const row = cell?.parentElement;
    if (cell && row) {
      const cells = Array.from(row.children).filter(
        (c) => c.tagName === "TD" || c.tagName === "TH",
      );
      const idx = cells.indexOf(cell);
      if (idx > 0) return clean(cells[idx - 1]?.textContent);
    }
    return clean(el.getAttribute("name") ?? el.getAttribute("id"));
  };

  const push = (record: Record<string, unknown>): void => {
    try {
      w.__cuaHumanEvent?.({ at: new Date().toISOString(), ...record });
    } catch {
      // The page is being torn down mid-navigation. Losing the report of a
      // click is bad; throwing inside the operator's page is worse.
    }
  };

  document.addEventListener(
    "click",
    (event) => {
      const el = (event.target as Element | null)?.closest?.(
        "a, button, input, select, textarea, [role]",
      );
      if (!el) return;
      push({ kind: "click", role: roleOf(el), name: nameOf(el) });
    },
    true,
  );

  document.addEventListener(
    "change",
    (event) => {
      const el = event.target as (HTMLInputElement & HTMLSelectElement) | null;
      if (!el || !el.tagName) return;
      const role = roleOf(el);
      if (role === "combobox") {
        // An option label is a choice, not a value: safe and useful to keep.
        const label = el.selectedOptions?.[0]?.textContent ?? el.value;
        push({ kind: "select", role, name: nameOf(el), option: clean(label) });
        return;
      }
      if (role === "checkbox" || role === "radio") {
        push({ kind: "click", role, name: nameOf(el), checked: el.checked });
        return;
      }
      // Never the value itself. This is a live banking screen.
      push({ kind: "type", role, name: nameOf(el), valueLength: (el.value ?? "").length });
    },
    true,
  );

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target as HTMLFormElement | null;
      push({ kind: "submit", role: "form", name: clean(form?.getAttribute("action")) });
    },
    true,
  );
}

const CAPTURE_SRC = installCapture.toString();
/** esbuild wraps named functions in a `__name` helper that does not exist in
 *  the page, so it is shimmed at the injection boundary. */
const BOOTSTRAP = `(() => { const __name = (f) => f; (${CAPTURE_SRC})(); })()`;

const BINDING = "__cuaHumanEvent";

/** Node-side buffer per page. Survives navigations, which is the entire point. */
const buffers = new WeakMap<Page, CapturedAction[]>();

/**
 * Install the recorder into every frame, now and after any navigation.
 *
 * `addInitScript` covers documents loaded from here on; the explicit per-frame
 * pass covers the ones already open - an operator takes over a session that is
 * already mid-flow, which is the whole situation.
 */
export async function installHumanRecorder(page: Page): Promise<void> {
  if (buffers.has(page)) return; // idempotent: taking control twice is allowed
  const captured: CapturedAction[] = [];
  buffers.set(page, captured);

  await page.exposeBinding(BINDING, (source, raw: Record<string, unknown>) => {
    captured.push(normalize(raw, source.frame));
  });

  await page.addInitScript(BOOTSTRAP);
  await Promise.all(
    page.frames().map((frame) => frame.evaluate(BOOTSTRAP).catch(() => undefined)),
  );
}

/**
 * Everything captured so far, newest last. Non-destructive: the console polls
 * this to show the operator their own action log, and a poll must not consume
 * the record that later becomes evidence.
 */
export function capturedActions(page: Page): CapturedAction[] {
  return [...(buffers.get(page) ?? [])];
}

/**
 * Frame paths are resolved lazily, at read time, because resolving them at
 * capture time means an `await` inside a synchronous binding callback - and the
 * frame is usually mid-navigation at exactly that moment.
 */
export async function resolveFramePaths(
  page: Page,
  framePathOf: (frame: Frame) => Promise<string[]>,
): Promise<CapturedAction[]> {
  const captured = buffers.get(page) ?? [];
  const resolved: CapturedAction[] = [];
  for (const action of captured) {
    const frame = frameRefs.get(action);
    const framePath = frame ? await framePathOf(frame).catch(() => action.framePath) : action.framePath;
    resolved.push({ ...action, framePath });
  }
  return resolved;
}

/** Which frame each captured action came from, kept out of the serialized shape. */
const frameRefs = new WeakMap<CapturedAction, Frame>();

function normalize(raw: Record<string, unknown>, frame: Frame): CapturedAction {
  const action: CapturedAction = {
    at: String(raw.at ?? new Date().toISOString()),
    kind: String(raw.kind ?? "unknown"),
    describe: describeCaptured(raw),
    role: raw.role === undefined ? undefined : String(raw.role),
    name: raw.name === undefined ? undefined : String(raw.name),
    framePath: [],
    url: frame.url(),
  };
  frameRefs.set(action, frame);
  return action;
}

function describeCaptured(r: Record<string, unknown>): string {
  const name = r.name ? `"${String(r.name)}"` : "an unnamed control";
  switch (r.kind) {
    case "click":
      return r.checked === undefined
        ? `clicked the ${String(r.role)} ${name}`
        : `set the ${String(r.role)} ${name} to ${r.checked ? "checked" : "unchecked"}`;
    case "type":
      return `typed ${String(r.valueLength ?? "?")} characters into ${name}`;
    case "select":
      return `chose "${String(r.option ?? "")}" in ${name}`;
    case "submit":
      return `submitted the form ${name}`;
    default:
      return `${String(r.kind)} on ${name}`;
  }
}
