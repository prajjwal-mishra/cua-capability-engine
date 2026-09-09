/**
 * The locator ladder, tested against snapshots the real app produced.
 *
 * These run with no browser: resolution is a pure function of descriptor and
 * snapshot. That property is worth more than the speed - it is the same
 * property that lets a DesktopSurface reuse this code unchanged.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UIElement, UISnapshot } from "../src/surface/types.js";
import {
  describeElement,
  descriptorConfidence,
  type ElementDescriptor,
} from "../src/locator/descriptor.js";
import { isDriftSignal, resolveDescriptor } from "../src/locator/resolve.js";

const fixture = (name: string): UISnapshot =>
  JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/snapshots", `${name}.json`), "utf8"));

const searchA = fixture("search-variant-a");
const searchB = fixture("search-variant-b");
const detailA = fixture("member-detail-variant-a");
const framed = fixture("member-detail-framed");

const find = (s: UISnapshot, role: string, name: string) => {
  const el = s.elements.find((e) => e.role === role && e.name === name);
  if (!el) throw new Error(`fixture missing ${role} "${name}"`);
  return el;
};

describe("describeElement builds a full ladder", () => {
  it("records every rung it can populate, not just the best one", () => {
    const d = describeElement(find(searchA, "textbox", "Member ID"), "enter the member id");
    const kinds = d.strategies.map((s) => s.kind);
    expect(kinds).toContain("role_name");
    expect(kinds).toContain("label_anchor");
    expect(kinds).toContain("frame_role_ordinal");
    expect(kinds).toContain("structural");
  });

  it("scores a heuristic name below a declared one", () => {
    // The textbox's name was inferred from the adjacent cell; the button's came
    // from its own value attribute. The artifact should not pretend those are
    // equally trustworthy.
    const heuristic = describeElement(find(searchA, "textbox", "Member ID"), "x");
    const declared = describeElement(find(searchA, "button", "Search"), "y");
    expect(descriptorConfidence(heuristic)).toBeLessThan(descriptorConfidence(declared));
  });

  it("omits coordinates unless explicitly asked for them", () => {
    const without = describeElement(find(searchA, "button", "Search"), "x");
    const with_ = describeElement(find(searchA, "button", "Search"), "x", { includeBounds: true });
    expect(without.strategies.some((s) => s.kind === "bounds")).toBe(false);
    expect(with_.strategies.some((s) => s.kind === "bounds")).toBe(true);
  });
});

/* ------------------------------------------- what extraction must not do --- */

describe("descriptors for reading a value out", () => {
  /** The savings balance cell in the accounts grid: what the read capability
   *  actually points at. */
  const balanceCell = (): UIElement => {
    const el = framed.elements.find(
      (e) => e.role === "cell" && e.nearbyText.columnHeader === "Current Balance",
    );
    if (!el) throw new Error("fixture has no balance cell");
    return el;
  };

  it("never keys on the value being read", () => {
    const d = describeElement(balanceCell(), "the savings balance", { forExtraction: true });
    // Recording "the cell named $8,241.17" does not locate the savings balance.
    // It locates one member's balance, and on the next invocation it either
    // misses or matches a different row holding the same amount - resolving on
    // the top rung, with high confidence, on the wrong data.
    expect(d.strategies.some((s) => s.kind === "role_name")).toBe(false);
    expect(d.strategies.some((s) => s.kind === "table_cell")).toBe(true);
  });

  it("does not anchor a grid cell to its neighbours' data", () => {
    const d = describeElement(balanceCell(), "the savings balance", { forExtraction: true });
    // In a grid the adjacent cell is a SIBLING VALUE, not a label. Anchoring to
    // it produces "the cell in the row labelled 4417-99820-01" - one member's
    // row wearing a relation's clothing. On a form, where leftCell really is a
    // label, the rung is still allowed.
    expect(d.strategies.some((s) => s.kind === "label_anchor")).toBe(false);

    const formField = framed.elements.find(
      (e) =>
        e.role === "textbox" &&
        e.nearbyText.leftCell !== undefined &&
        e.nearbyText.columnHeader === undefined,
    );
    if (formField) {
      const onForm = describeElement(formField, "a form field", { forExtraction: true });
      expect(onForm.strategies.some((s) => s.kind === "label_anchor")).toBe(true);
    }
  });

  it("drops any rung anchored on somebody's data rather than redacting it", () => {
    const el = balanceCell();
    const withAccountNumber: UIElement = {
      ...el,
      nearbyText: { ...el.nearbyText, rowKey: "4417-99820-01" },
    };
    const d = describeElement(withAccountNumber, "the savings balance", {
      forExtraction: true,
      isSensitive: (text) => /\b\d{4}-\d{4,6}-\d{2}\b/.test(text),
    });
    // Dropped, not masked: a redacted anchor is a locator that can never match,
    // which fails later and far less obviously than not being there at all.
    const asText = JSON.stringify(d);
    expect(asText).not.toContain("4417-99820-01");
    expect(asText).not.toContain("REDACTED");
    expect(d.strategies.some((s) => s.kind === "table_cell")).toBe(false);
    // And the ladder still has the rungs that do not depend on anyone's data.
    expect(d.strategies.some((s) => s.kind === "frame_role_ordinal")).toBe(true);
  });

  it("treats a Field/Value review table as a grid, not as labelled form fields", () => {
    // variant-b's review screen is <th>Field</th><th>Value</th>. Perception
    // fills both columnHeader and rowKey, so the grid heuristic fires. Rung 2
    // would duplicate rung 3 (leftCell === rowKey === "Product") at a lower
    // score - dropping it is the same relation, kept once, ranked higher.
    const cell: UIElement = {
      ...balanceCell(),
      nearbyText: {
        leftCell: "Product",
        columnHeader: "Value",
        rowKey: "Product",
      },
    };
    const d = describeElement(cell, "the product on the review screen", { forExtraction: true });
    expect(d.strategies.some((s) => s.kind === "label_anchor")).toBe(false);
    expect(d.strategies.some((s) => s.kind === "table_cell")).toBe(true);
    expect(d.strategies.some((s) => s.kind === "frame_role_ordinal")).toBe(true);
  });
});

describe("resolution", () => {
  it("resolves on rung 1 when the name is unchanged", () => {
    const d = describeElement(find(searchA, "button", "Search"), "submit the search");
    const out = resolveDescriptor(d, searchA);
    expect(out.status).toBe("resolved");
    if (out.status === "resolved") expect(out.strategy).toBe("role_name");
  });

  it("addresses a grid cell by column header and row key", () => {
    const balance = detailA.elements.find(
      (e) => e.nearbyText.columnHeader === "Current Balance" && e.nearbyText.rowKey === "Savings",
    );
    expect(balance?.name).toBe("$8,241.17");
    const d = describeElement(balance!, "read the savings balance");
    const out = resolveDescriptor(d, detailA);
    expect(out.status).toBe("resolved");
    if (out.status === "resolved") expect(out.ref).toBe(balance!.ref);
  });

  it("respects frame scoping - a descriptor never matches across frames", () => {
    // Two frames deep: the accounts grid lives inside the detail page, which
    // itself lives inside the shell's content frame.
    const cell = framed.elements.find(
      (e) => e.nearbyText.columnHeader === "Current Balance" && e.nearbyText.rowKey === "Savings",
    )!;
    const d = describeElement(cell, "read the savings balance");
    expect(d.framePath).toEqual(["contentFrame", "acctFrame"]);
    // Same ladder, but pointed at a frame path that does not exist here.
    const wrongFrame: ElementDescriptor = { ...d, framePath: ["nope"] };
    expect(resolveDescriptor(wrongFrame, framed).status).toBe("not_found");
  });

  it("reports ambiguity rather than picking one", () => {
    // Three accounts all sit under the 'Status' column reading 'Open'; a
    // descriptor that only knows the column matches all three.
    const ambiguous: ElementDescriptor = {
      intent: "a status cell",
      role: "cell",
      framePath: detailA.elements.find((e) => e.nearbyText.columnHeader === "Status")!.framePath,
      strategies: [
        { kind: "role_name", confidence: 0.9, role: "cell", name: "Open", match: "exact" },
      ],
    };
    const out = resolveDescriptor(ambiguous, detailA);
    expect(out.status).toBe("ambiguous");
    if (out.status === "ambiguous") expect(out.candidates).toBe(3);
  });

  it("falls through to a lower rung when the label was renamed", () => {
    // variant-b calls the same field 'Member Number'. Rung 1 (role+name) misses;
    // rung 4 (role + ordinal within frame) still finds it. That fall-through is
    // exactly the drift signal an operator should be told about.
    const recorded = describeElement(find(searchA, "textbox", "Member ID"), "enter the member id");
    const out = resolveDescriptor(recorded, searchB);
    expect(out.status).toBe("resolved");
    if (out.status === "resolved") {
      expect(out.strategy).not.toBe("role_name");
      expect(isDriftSignal(recorded, out)).toBe(true);
    }
  });

  it("does not use coordinates unless policy allows it", () => {
    const el = find(searchA, "button", "Search");
    const d: ElementDescriptor = {
      intent: "search button, geometry only",
      role: "button",
      framePath: el.framePath,
      strategies: [{ kind: "bounds", confidence: 0, bounds: el.bounds! }],
    };
    expect(resolveDescriptor(d, searchA).status).toBe("not_found");
    const allowed = resolveDescriptor(d, searchA, { allowCoordinateFallback: true });
    expect(allowed.status).toBe("resolved");
  });

  it("records every rung it tried, for drift telemetry", () => {
    const d = describeElement(find(searchA, "textbox", "Member ID"), "x");
    const out = resolveDescriptor(d, searchB);
    expect(out.attempts.length).toBeGreaterThan(1);
    // Every rung above the one that resolved missed, and they were tried in
    // descending confidence - the ladder's whole claim.
    const confidences = out.attempts.map((a) => a.confidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
    expect(out.attempts[0]!.matches).toBe(0); // the label was renamed in variant-b
  });

  it("tries the ladder strictly most-confident-first", () => {
    const d = describeElement(find(searchA, "textbox", "Member ID"), "x");
    const scores = d.strategies.map((s) => s.confidence);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
