/**
 * The surface-agnostic vocabulary.
 *
 * Nothing in this file mentions the DOM, CSS, or Playwright. That is the point:
 * a recorded flow speaks in roles, names, and relationships, so a DesktopSurface
 * backed by UIA/AXAPI can implement the same port and replay the same artifact.
 */

/** Where an element's accessible name came from. Drives descriptor confidence. */
export type NameSource =
  | "aria-labelledby"
  | "aria-label"
  | "label-element"
  | "value"
  | "alt"
  | "title"
  | "placeholder"
  | "text-content"
  | "heuristic-table-cell"
  | "heuristic-preceding-text"
  | "none";

export type UIRole =
  | "textbox"
  | "button"
  | "link"
  | "combobox"
  | "checkbox"
  | "radio"
  | "heading"
  | "cell"
  | "columnheader"
  | "row"
  | "table"
  | "text"
  | "generic";

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Positional context a legacy table layout gives us instead of a real label. */
export interface NearbyText {
  /** Text of the table cell immediately to the left, in the same row. */
  readonly leftCell?: string;
  /** Text of the cell directly above, in the same column. */
  readonly aboveCell?: string;
  /** Text node immediately preceding the element within its parent. */
  readonly precedingText?: string;
  /** Column header governing this cell, if the element sits in a data table. */
  readonly columnHeader?: string;
  /** First cell of this element's row — the natural row key in a data grid. */
  readonly rowKey?: string;
}

export interface UIElement {
  /**
   * Ephemeral, snapshot-scoped handle. NOT a locator. The model reasons in refs;
   * the recorder converts the ref it acted on into a durable ElementDescriptor.
   * A ref from one snapshot is meaningless in the next.
   */
  readonly ref: string;
  readonly role: UIRole;
  readonly name: string;
  readonly nameSource: NameSource;
  readonly value?: string;
  readonly state: {
    readonly disabled?: boolean;
    readonly checked?: boolean;
    readonly readOnly?: boolean;
    readonly required?: boolean;
  };
  /** Frame names from the root document down to this element's frame. */
  readonly framePath: readonly string[];
  /** Diagnostics only. Never used to locate an element unless explicitly allowed. */
  readonly bounds?: Bounds;
  /** Index among same-role, same-NAME elements in this frame. Disambiguates
   *  genuine duplicates: "the second 'Open' link". */
  readonly ordinal: number;
  /** Index among same-role elements in this frame, ignoring name. This is the
   *  rung that survives a pure relabelling, where role+name cannot. */
  readonly roleOrdinal: number;
  readonly nearbyText: NearbyText;
  /** Scoped structural path. Last-resort strategy, recorded as low confidence. */
  readonly structuralPath: string;
  /** Tag/type detail, kept for diagnostics and for the heuristic passes. */
  readonly tag: string;
}

/** One frame's own location. In a frameset app the top-level URL never changes,
 *  so a checkpoint that asserts on it asserts on nothing. */
export interface FrameContext {
  readonly framePath: readonly string[];
  readonly url: string;
  readonly routePattern: string;
}

export interface PageContext {
  readonly url: string;
  /** Concrete route with parameterizable segments generalized: /member/:id */
  readonly routePattern: string;
  readonly title: string;
  /** Every frame's location, deepest content frame included. */
  readonly frames: readonly FrameContext[];
}

export interface UISnapshot {
  readonly capturedAt: string;
  readonly page: PageContext;
  readonly elements: readonly UIElement[];
  /** Path on disk, if a screenshot was taken (already redaction-masked). */
  readonly screenshotPath?: string;
}

/* ------------------------------------------------------------- actions --- */

export type SurfaceAction =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "click"; readonly ref: string }
  | {
      readonly kind: "type";
      readonly ref: string;
      readonly text: string;
      readonly submit?: boolean;
    }
  | { readonly kind: "select"; readonly ref: string; readonly option: string }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "read"; readonly ref: string }
  | {
      readonly kind: "waitFor";
      readonly condition: "settled" | "elementPresent";
      readonly ref?: string;
      readonly timeoutMs?: number;
    }
  | { readonly kind: "scroll"; readonly direction: "up" | "down"; readonly amount?: number }
  /** Re-request a frame's current URL. The honest recovery for a transient
   *  server failure: the step's target is gone from the error page, so
   *  re-clicking it is impossible — the request itself must be retried. */
  | { readonly kind: "reload"; readonly framePath?: readonly string[] };

export interface ActionResult {
  readonly ok: boolean;
  /** For `read`, the text pulled from the element. */
  readonly text?: string;
  readonly error?: string;
  readonly durationMs: number;
}

export interface SurfaceCapabilities {
  readonly surfaceType: "web" | "legacy-web" | "desktop";
  readonly canScreenshot: boolean;
  readonly supportsFrames: boolean;
  /** True when the platform computes accessible names for us (UIA/AX do). */
  readonly nativeAccessibilityNames: boolean;
}

/**
 * Perception and action against one application surface.
 *
 * Deliberately three methods. Everything else a caller might want — waiting,
 * retrying, checkpointing, recovery — is policy that belongs above this line,
 * because it must behave identically no matter which surface is underneath.
 */
export interface Surface {
  observe(): Promise<UISnapshot>;
  act(action: SurfaceAction): Promise<ActionResult>;
  capabilities(): SurfaceCapabilities;
  /**
   * Capture evidence, with the given regions painted out before the image is
   * ever encoded. Masking happens here, at the point of capture, rather than
   * after the fact — an unmasked PNG should never exist, not even in memory.
   * Present only when `capabilities().canScreenshot`.
   */
  screenshot?(masks: readonly Bounds[]): Promise<Buffer>;
}
