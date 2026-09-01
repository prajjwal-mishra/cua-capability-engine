/**
 * How a recorded step says which control it means.
 *
 * This is the load-bearing robustness decision in the system. A descriptor is
 * never a CSS selector and never a pixel: it is an ORDERED LADDER of resolution
 * strategies, each scored at record time, tried in order at replay. The ladder
 * degrades from "semantically meaningful and stable" down to "structural and
 * brittle", and the replay log records WHICH RUNG RESOLVED — so a capability
 * that silently slid from rung 1 to rung 5 is visible as drift telemetry rather
 * than as a mystery failure three weeks later.
 */

import type { Bounds, UIElement, UIRole, UISnapshot } from "../surface/types.js";

export type StrategyKind =
  "role_name" | "label_anchor" | "table_cell" | "frame_role_ordinal" | "structural" | "bounds";

/** Rung 1: computed role + accessible name. The only strategy that survives a
 *  re-skin, and the only one a desktop surface gets for free from UIA/AX. */
export interface RoleNameStrategy {
  readonly kind: "role_name";
  readonly confidence: number;
  readonly role: UIRole;
  readonly name: string;
  readonly match: "exact" | "normalized";
}

/** Rung 2: "the textbox in the same table row as the cell reading 'Member ID'".
 *  This is what legacy form layouts give you instead of a <label for>. */
export interface LabelAnchorStrategy {
  readonly kind: "label_anchor";
  readonly confidence: number;
  readonly role: UIRole;
  readonly labelText: string;
  readonly relation: "same-row" | "same-column" | "preceding-text";
}

/** Rung 3: a data-grid cell, addressed the way a human reads a table —
 *  by column header and row key. */
export interface TableCellStrategy {
  readonly kind: "table_cell";
  readonly confidence: number;
  readonly columnHeader: string;
  readonly rowKey: string;
}

/**
 * Rung 4: position within a frame. Survives text changes, not reorders.
 *
 * The scope is explicit rather than implied by whether `name` is set, because
 * the two readings resolve to different elements and a reviewer should not have
 * to infer which one an artifact meant:
 *   role_and_name — "the 2nd link named 'Open'"
 *   role          — "the 1st textbox in this frame", regardless of its label
 */
export interface FrameRoleOrdinalStrategy {
  readonly kind: "frame_role_ordinal";
  readonly confidence: number;
  readonly role: UIRole;
  readonly name?: string;
  readonly ordinal: number;
  readonly ordinalScope: "role_and_name" | "role";
}

/** Rung 5: scoped structural path. Explicitly low confidence; recorded so a
 *  reviewer can see the capability is leaning on markup shape. */
export interface StructuralStrategy {
  readonly kind: "structural";
  readonly confidence: number;
  readonly path: string;
}

/** Rung 6: recorded geometry. DIAGNOSTIC ONLY — never used to locate anything
 *  unless the policy explicitly enables coordinate fallback. */
export interface BoundsStrategy {
  readonly kind: "bounds";
  readonly confidence: 0;
  readonly bounds: Bounds;
}

export type ResolutionStrategy =
  | RoleNameStrategy
  | LabelAnchorStrategy
  | TableCellStrategy
  | FrameRoleOrdinalStrategy
  | StructuralStrategy
  | BoundsStrategy;

export interface ElementDescriptor {
  /** Human-readable, for the run log and for a reviewer reading the artifact. */
  readonly intent: string;
  readonly role: UIRole;
  readonly framePath: readonly string[];
  /** Ordered most-stable-first. Resolution walks this list. */
  readonly strategies: readonly ResolutionStrategy[];
}

/* --------------------------------------------------------------- record --- */

const NAME_SOURCE_CONFIDENCE: Record<string, number> = {
  "aria-labelledby": 0.95,
  "aria-label": 0.95,
  "label-element": 0.95,
  value: 0.9,
  "text-content": 0.88,
  alt: 0.85,
  title: 0.8,
  placeholder: 0.7,
  // A name we inferred from layout is weaker than one the app declared, and the
  // artifact should say so rather than pretend they are equivalent.
  "heuristic-table-cell": 0.65,
  "heuristic-preceding-text": 0.55,
  none: 0,
};

/**
 * Build the full ladder for an element we just acted on.
 *
 * Every rung that can be populated is populated, even when rung 1 looks solid.
 * The cost is a few hundred bytes of JSON; the benefit is that when rung 1
 * breaks at 2am the capability degrades instead of dying.
 */
export function describeElement(
  el: UIElement,
  intent: string,
  opts: {
    readonly includeBounds?: boolean;
    readonly forExtraction?: boolean;
    /**
     * Reject an anchor whose text carries something sensitive.
     *
     * A locator anchored on a member's account number is broken twice over: it
     * only ever matches that one member, and it writes their data into a
     * document that gets committed, reviewed and shipped. Dropping the rung is
     * the right response rather than redacting it — a redacted anchor is a
     * locator that can never match, which fails later and less obviously.
     */
    readonly isSensitive?: (text: string) => boolean;
  } = {},
): ElementDescriptor {
  const strategies: ResolutionStrategy[] = [];
  const usable = (text: string | undefined): text is string =>
    text !== undefined && text !== "" && !(opts.isSensitive?.(text) ?? false);

  // In a data grid the neighbouring cell holds a SIBLING VALUE, not a label —
  // "the cell in the row labelled 4417-99820-01" is one member's row, dressed
  // up as a relation. `columnHeader` and `rowKey` are only both set for grid
  // cells, which is how a grid is told apart from a form here. On a form,
  // `leftCell` really is the label, so the rung stays.
  const inDataGrid = el.nearbyText.columnHeader !== undefined && el.nearbyText.rowKey !== undefined;
  const anchorIsData = opts.forExtraction === true && inDataGrid;

  // An OUTPUT descriptor must never key on the element's own text, because
  // that text is the payload. Recording "the cell named $8,241.17" does not
  // locate the savings balance — it locates one particular member's balance,
  // and on the next invocation it either misses entirely or, worse, matches
  // some other row that happens to hold the same amount, resolving on the top
  // rung with high confidence. Extraction is addressed by RELATION: which
  // column, which row.
  if (usable(el.name) && !opts.forExtraction) {
    strategies.push({
      kind: "role_name",
      confidence: NAME_SOURCE_CONFIDENCE[el.nameSource] ?? 0.5,
      role: el.role,
      name: el.name,
      match: "exact",
    });
  }

  // Only meaningful when the name came from somewhere OTHER than the anchor
  // itself — otherwise this rung is rung 1 wearing a different hat.
  if (!anchorIsData) {
    if (usable(el.nearbyText.leftCell)) {
      strategies.push({
        kind: "label_anchor",
        confidence: 0.82,
        role: el.role,
        labelText: el.nearbyText.leftCell,
        relation: "same-row",
      });
    } else if (usable(el.nearbyText.aboveCell)) {
      strategies.push({
        kind: "label_anchor",
        confidence: 0.72,
        role: el.role,
        labelText: el.nearbyText.aboveCell,
        relation: "same-column",
      });
    } else if (usable(el.nearbyText.precedingText)) {
      strategies.push({
        kind: "label_anchor",
        confidence: 0.6,
        role: el.role,
        labelText: el.nearbyText.precedingText,
        relation: "preceding-text",
      });
    }
  }

  if (usable(el.nearbyText.columnHeader) && usable(el.nearbyText.rowKey)) {
    strategies.push({
      kind: "table_cell",
      confidence: 0.9,
      columnHeader: el.nearbyText.columnHeader,
      rowKey: el.nearbyText.rowKey,
    });
  }

  // Disambiguates duplicates while the label still matches.
  if (usable(el.name) && !opts.forExtraction) {
    strategies.push({
      kind: "frame_role_ordinal",
      confidence: 0.55,
      role: el.role,
      name: el.name,
      ordinal: el.ordinal,
      ordinalScope: "role_and_name",
    });
  }

  // The rename-tolerant rung: position alone. This is what carries a capability
  // across a tenant that calls the same field something else — and when it is
  // the rung that resolves, the run log says so, which is the drift signal.
  strategies.push({
    kind: "frame_role_ordinal",
    confidence: 0.4,
    role: el.role,
    ordinal: el.roleOrdinal,
    ordinalScope: "role",
  });

  strategies.push({ kind: "structural", confidence: 0.3, path: el.structuralPath });

  if (opts.includeBounds && el.bounds) {
    strategies.push({ kind: "bounds", confidence: 0, bounds: el.bounds });
  }

  // The ladder is documented as most-stable-first, so order it by the stability
  // score we already record rather than by the order the rungs were appended.
  // This makes `confidence` the single knob governing resolution order, and it
  // matters in practice: for a grid cell, addressing by column header and row
  // key (0.9) is strictly better than anchoring to the neighbouring cell's
  // value (0.82), which is itself data that changes per invocation.
  const ordered = [...strategies].sort((a, b) => b.confidence - a.confidence);

  return { intent, role: el.role, framePath: el.framePath, strategies: ordered };
}

/** Highest confidence on the ladder — a quick health signal for reviewers. */
export function descriptorConfidence(d: ElementDescriptor): number {
  return d.strategies.reduce((max, s) => Math.max(max, s.confidence), 0);
}

/** Snapshot elements confined to the descriptor's frame. */
export function elementsInFrame(
  snapshot: UISnapshot,
  framePath: readonly string[],
): readonly UIElement[] {
  const want = framePath.join(">");
  return snapshot.elements.filter((e) => e.framePath.join(">") === want);
}
