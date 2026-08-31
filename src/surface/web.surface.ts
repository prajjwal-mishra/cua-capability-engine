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
          ordinal: 0, // both assigned below, once the whole page is known
          roleOrdinal: 0,
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
          await this.actAndSettle(() => this.page.keyboard.press(action.key));
          return done({ ok: true });
        }
        case "reload": {
          // Reload the named frame, or the deepest one — in a frameset app the
          // shell is not what failed, the content frame is.
          const target = action.framePath
            ? await this.frameByPath(action.framePath)
            : this.deepestFrame();
          if (!target) return done({ ok: false, error: "no frame to reload" });
          await target.goto(target.url(), { waitUntil: "domcontentloaded" });
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
          await this.actAndSettle(() => el.click({ timeout: 5_000 }));
          return done({ ok: true });
        }
        case "type": {
          const el = await this.requireRef(action.ref);
          await el.fill(action.text, { timeout: 5_000 });
          if (action.submit) {
            await this.actAndSettle(() => el.press("Enter"));
          }
          return done({ ok: true });
        }
        case "select": {
          const el = await this.requireRef(action.ref);
          await this.actAndSettle(async () => {
            await el.selectOption({ label: action.option }).catch(async () => {
              await el.selectOption(action.option);
            });
          });
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

  /**
   * Fallback for a reload with no frame named. Deliberately conservative: when
   * more than one frame shares the greatest depth there is no honest answer to
   * "the deepest frame", and guessing would reload someone else's navigation.
   * Recoveries should name their frame; the pack does.
   */
  private deepestFrame(): Frame | undefined {
    const frames = this.page.frames();
    const maxDepth = Math.max(...frames.map(depthOf));
    const deepest = frames.filter((f) => depthOf(f) === maxDepth);
    return deepest.length === 1 ? deepest[0] : undefined;
  }

  private async frameByPath(path: readonly string[]): Promise<Frame | undefined> {
    for (const frame of this.page.frames()) {
      const actual = await this.framePathOf(frame);
      if (actual.join(">") === path.join(">")) return frame;
    }
    return undefined;
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
   * Perform an action that may navigate a FRAME, and wait for the result.
   *
   * This is the subtle one. In a frameset app, clicking a submit button inside
   * the content frame navigates that frame and never touches the top-level
   * document — so waiting on the page's load state returns immediately and we
   * observe the pre-click DOM. That failure is intermittent by nature: it is a
   * race, and it wins often enough to look like flakiness in the artifact
   * rather than a bug in perception.
   *
   * So we arm a frame-navigation listener BEFORE dispatching, and the wait ends
   * the moment a frame actually navigates. The ceiling is only reached when
   * nothing navigated — a click that genuinely changed nothing — and it exists
   * to bound that case, not to pace the common one.
   */
  private async actAndSettle(dispatch: () => Promise<unknown>, ceilingMs = 1_500): Promise<void> {
    let onNavigated: ((frame: Frame) => void) | undefined;
    const navigated = new Promise<void>((resolve) => {
      onNavigated = () => resolve();
      this.page.once("framenavigated", onNavigated);
    });
    const ceiling = new Promise<void>((resolve) => setTimeout(resolve, ceilingMs));

    try {
      await dispatch();
      await Promise.race([navigated, ceiling]);
    } finally {
      if (onNavigated) this.page.off("framenavigated", onNavigated);
    }
    await this.settle();
  }

  /**
   * Condition-based settling, never a bare sleep. Every frame is waited on, not
   * just the top document, and each wait falls through on timeout rather than
   * throwing: a page holding a socket open forever is still a usable page.
   */
  private async settle(timeoutMs = 5_000): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    await Promise.all(
      this.page
        .frames()
        .map((f) => f.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {})),
    );
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

function depthOf(frame: Frame): number {
  let n = 0;
  let cur: Frame | null = frame;
  while (cur?.parentFrame()) {
    n++;
    cur = cur.parentFrame();
  }
  return n;
}

function normalizeRole(role: string): UIRole {
  return (KNOWN_ROLES.includes(role) ? role : "generic") as UIRole;
}

/**
 * Two ordinals, because they answer different questions.
 *
 * `ordinal` counts within role+name and expresses "the second 'Open' link".
 * `roleOrdinal` counts within role alone and expresses "the first textbox in
 * this frame" — the only one of the two that still means something after the
 * app is relabelled, which is precisely the cross-tenant case.
 */
function assignOrdinals(elements: readonly UIElement[]): UIElement[] {
  const byRoleAndName = new Map<string, number>();
  const byRole = new Map<string, number>();
  return elements.map((e) => {
    const frame = e.framePath.join(">");
    const nameKey = `${frame}|${e.role}|${e.name}`;
    const roleKey = `${frame}|${e.role}`;
    const ordinal = byRoleAndName.get(nameKey) ?? 0;
    const roleOrdinal = byRole.get(roleKey) ?? 0;
    byRoleAndName.set(nameKey, ordinal + 1);
    byRole.set(roleKey, roleOrdinal + 1);
    return { ...e, ordinal, roleOrdinal };
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
