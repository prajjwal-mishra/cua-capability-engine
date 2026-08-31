/**
 * Playwright implementation of the Surface port.
 *
 * Playwright is the DRIVER, not the abstraction. It earns its place because it
 * gives us trusted input dispatch, actionability checks, frame handling, and
 * tracing — all things that are genuinely hard to get right. What it does NOT
 * get to do is leak upward: nothing above this file mentions a Locator, a CSS
 * selector, or a pixel. Swap this class for a DesktopSurface and the recorded
 * artifacts still replay.
 */

import type { Browser, BrowserContext, ElementHandle, Frame, Page } from "playwright";
import { collectElements, type RawElement } from "./perceive.js";
import type {
  ActionResult,
  Bounds,
  FrameContext,
  Surface,
  SurfaceAction,
  SurfaceCapabilities,
  UIElement,
  UIRole,
  UISnapshot,
} from "./types.js";

/** Where a global ref lives: which frame, and its index within that frame. */
interface RefLocation {
  readonly frameIndex: number;
  readonly localIndex: number;
}

const MAX_ELEMENTS_PER_FRAME = 250;

/** Serialized once: the perception pass, as source, ready to inject per frame. */
const COLLECTOR_SRC = collectElements.toString();

export interface WebSurfaceOptions {
  /** Called with a PNG buffer when a snapshot requests a screenshot. Returns
   *  the path it was written to. Redaction masking is applied by the caller —
   *  this class never writes evidence to disk itself. */
  readonly screenshotSink?: (
    png: Buffer,
    snapshotElements: readonly UIElement[],
  ) => Promise<string>;
}

export class WebSurface implements Surface {
  private refIndex = new Map<string, RefLocation>();
  private frames: Frame[] = [];

  constructor(private readonly page: Page) {}

  capabilities(): SurfaceCapabilities {
    return {
      surfaceType: "legacy-web",
      canScreenshot: true,
      supportsFrames: true,
      // We compute accessible names ourselves here; UIA/AX would give them to us.
      nativeAccessibilityNames: false,
    };
  }

  /* ------------------------------------------------------------ observe -- */

  async observe(): Promise<UISnapshot> {
    await this.settle();

    this.frames = this.page.frames();
    this.refIndex.clear();

    const elements: UIElement[] = [];
    const frameContexts: FrameContext[] = [];
    let counter = 0;

    for (let fi = 0; fi < this.frames.length; fi++) {
      const frame = this.frames[fi]!;
      const framePath = await this.framePathOf(frame);
      // Element bounds arrive frame-relative. Offset them into top-level page
      // coordinates so they are usable both as diagnostics and as screenshot
      // mask regions — a frame-relative box would mask the wrong pixels.
      const offset = await this.frameOffset(frame);
      frameContexts.push({
        framePath,
        url: frame.url(),
        routePattern: canonicalizeRoute(frame.url()),
      });

      let raw: RawElement[] = [];
      try {
        // The collector is serialized into the frame on every observe. It is
        // self-contained by construction (see perceive.ts), so this is the only
        // bridge between our code and the page.
        raw = await frame.evaluate(
          ({ src, max }: { src: string; max: number }) => {
            // esbuild/tsx wrap named functions in a __name() helper for stack
            // traces. That helper does not exist inside the page, so shim it
            // at the injection boundary rather than contorting perceive.ts.
            const collect = new Function(`const __name = (f) => f; return (${src})`)() as (
              prefix: string,
              max: number,
            ) => RawElement[];
            return collect("_", max);
          },
          { src: COLLECTOR_SRC, max: MAX_ELEMENTS_PER_FRAME },
        );
      } catch {
        continue; // detached or cross-origin frame: skip rather than crash
      }

      raw.forEach((r, localIndex) => {
        counter += 1;
        const ref = `e${counter}`;
        this.refIndex.set(ref, { frameIndex: fi, localIndex });
        elements.push({
          ref,
          role: normalizeRole(r.role),
          name: r.name,
          nameSource: r.nameSource as UIElement["nameSource"],
          value: r.value,
          state: r.state,
          framePath,
          bounds: r.bounds
            ? {
                x: r.bounds.x + offset.x,
                y: r.bounds.y + offset.y,
                width: r.bounds.width,
                height: r.bounds.height,
              }
            : undefined,
          ordinal: 0, // assigned below, once the whole page is known
          nearbyText: r.nearbyText,
          structuralPath: r.structuralPath,
          tag: r.tag,
        });
      });
    }

    const withOrdinals = assignOrdinals(elements);

    return {
      capturedAt: new Date().toISOString(),
      page: {
        url: this.page.url(),
        routePattern: canonicalizeRoute(this.page.url()),
        title: await this.page.title().catch(() => ""),
        frames: frameContexts,
      },
      elements: withOrdinals,
    };
  }

  /* --------------------------------------------------------------- act --- */

  async act(action: SurfaceAction): Promise<ActionResult> {
    const started = Date.now();
    const done = (r: Omit<ActionResult, "durationMs">): ActionResult => ({
      ...r,
      durationMs: Date.now() - started,
    });

    try {
      switch (action.kind) {
        case "navigate": {
          await this.page.goto(action.url, { waitUntil: "domcontentloaded" });
          return done({ ok: true });
        }
        case "key": {
          await this.page.keyboard.press(action.key);
          await this.settle();
          return done({ ok: true });
        }
        case "scroll": {
          const delta = (action.amount ?? 400) * (action.direction === "up" ? -1 : 1);
          await this.page.mouse.wheel(0, delta);
          return done({ ok: true });
        }
        case "waitFor": {
          if (action.condition === "settled") {
            await this.settle(action.timeoutMs);
            return done({ ok: true });
          }
          const el = await this.resolveRef(action.ref ?? "");
          return done({ ok: el !== null });
        }
        case "click": {
          const el = await this.requireRef(action.ref);
          await el.click({ timeout: 5_000 });
          await this.settle();
          return done({ ok: true });
        }
        case "type": {
          const el = await this.requireRef(action.ref);
          await el.fill(action.text, { timeout: 5_000 });
          if (action.submit) {
            await el.press("Enter");
            await this.settle();
          }
          return done({ ok: true });
        }
        case "select": {
          const el = await this.requireRef(action.ref);
          await el.selectOption({ label: action.option }).catch(async () => {
            await el.selectOption(action.option);
          });
          await this.settle();
          return done({ ok: true });
        }
        case "read": {
          const el = await this.requireRef(action.ref);
          const text = await el.evaluate((node) => {
            const input = node as HTMLInputElement;
            if (typeof input.value === "string" && input.value !== "") return input.value;
            return (node.textContent ?? "").replace(/\s+/g, " ").trim();
          });
          return done({ ok: true, text });
        }
      }
    } catch (err) {
      return done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /* ----------------------------------------------------------- internals -- */

  private async requireRef(ref: string): Promise<ElementHandle<Element>> {
    const el = await this.resolveRef(ref);
    if (!el) {
      throw new Error(
        `ref ${ref} does not resolve in the current page state — refs are snapshot-scoped, so observe() again before acting`,
      );
    }
    return el;
  }

  private async resolveRef(ref: string): Promise<ElementHandle<Element> | null> {
    const loc = this.refIndex.get(ref);
    if (!loc) return null;
    const frame = this.frames[loc.frameIndex];
    if (!frame) return null;
    try {
      const handle = await frame.evaluateHandle(
        (i) => (window as unknown as { __cuaRefs?: Element[] }).__cuaRefs?.[i] ?? null,
        loc.localIndex,
      );
      return handle.asElement() as ElementHandle<Element> | null;
    } catch {
      return null;
    }
  }

  /** A frame's position within the top-level page, accumulated up the chain. */
  private async frameOffset(frame: Frame): Promise<{ x: number; y: number }> {
    let x = 0;
    let y = 0;
    let cur: Frame | null = frame;
    while (cur && cur.parentFrame()) {
      const el = await cur.frameElement().catch(() => null);
      const box = el ? await el.boundingBox().catch(() => null) : null;
      if (box) {
        x += box.x;
        y += box.y;
      }
      cur = cur.parentFrame();
    }
    return { x, y };
  }

  /**
   * Screenshot with sensitive regions painted out BEFORE capture. The overlay
   * is injected, the image is taken, and the overlay is removed — so a PNG
   * containing the unmasked value is never produced in the first place.
   */
  async screenshot(masks: readonly Bounds[] = []): Promise<Buffer> {
    const MARKER = "__cua_mask__";
    if (masks.length > 0) {
      await this.page.evaluate(
        ({ boxes, marker }) => {
          for (const b of boxes) {
            const d = document.createElement("div");
            d.setAttribute("data-cua", marker);
            d.style.cssText = `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;background:#000;z-index:2147483647;pointer-events:none;`;
            document.body.appendChild(d);
          }
        },
        { boxes: masks as Bounds[], marker: MARKER },
      );
    }
    try {
      return await this.page.screenshot({ fullPage: false });
    } finally {
      if (masks.length > 0) {
        await this.page
          .evaluate((marker) => {
            document.querySelectorAll(`[data-cua="${marker}"]`).forEach((n) => n.remove());
          }, MARKER)
          .catch(() => {});
      }
    }
  }

  /** Frame names from the root document down. Empty array = main frame. */
  private async framePathOf(frame: Frame): Promise<string[]> {
    const path: string[] = [];
    let cur: Frame | null = frame;
    while (cur) {
      const parent: Frame | null = cur.parentFrame();
      if (!parent) break;
      let label = cur.name();
      if (!label) {
        const el = await cur.frameElement().catch(() => null);
        const id = el ? await el.getAttribute("id").catch(() => null) : null;
        label = id ?? `frame${path.length}`;
      }
      path.unshift(label);
      cur = parent;
    }
    return path;
  }

  /**
   * Condition-based settling, never a bare sleep. `networkidle` is bounded and
   * falls through on timeout rather than throwing: a page that keeps a socket
   * open forever is still a usable page.
   */
  private async settle(timeoutMs = 5_000): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
  }
}

/* ------------------------------------------------------------- helpers --- */

const KNOWN_ROLES: readonly string[] = [
  "textbox",
  "button",
  "link",
  "combobox",
  "checkbox",
  "radio",
  "heading",
  "cell",
  "columnheader",
  "row",
  "table",
  "text",
];

function normalizeRole(role: string): UIRole {
  return (KNOWN_ROLES.includes(role) ? role : "generic") as UIRole;
}

/**
 * Ordinal = index among elements sharing role + name within the same frame.
 * This is what makes "the second 'Open' link" expressible without a selector.
 */
function assignOrdinals(elements: readonly UIElement[]): UIElement[] {
  const seen = new Map<string, number>();
  return elements.map((e) => {
    const key = `${e.framePath.join(">")}|${e.role}|${e.name}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { ...e, ordinal: n };
  });
}

/**
 * Generalize a concrete URL into a route pattern: /frame/member/10042 becomes
 * /frame/member/:id. Used for checkpoints and for the artifact's entry point,
 * so a capability is not pinned to the record-time member.
 *
 * Note this is the *generic* pass. The recorder does a stronger, provenance-
 * driven parameterization where it knows which input param produced a segment.
 */
export function canonicalizeRoute(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const path = u.pathname
    .split("/")
    .map((seg) => (/^\d{3,}$/.test(seg) ? ":id" : seg))
    .join("/");
  return path === "" ? "/" : path;
}

/** Launch helper kept here so nothing above this file imports Playwright. */
export async function launchWebSurface(opts: {
  browser: Browser;
}): Promise<{ surface: WebSurface; context: BrowserContext; page: Page }> {
  const context = await opts.browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  return { surface: new WebSurface(page), context, page };
}
