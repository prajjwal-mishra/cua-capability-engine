/**
 * The locator ladder, tested against snapshots the real app produced.
 *
 * These run with no browser: resolution is a pure function of descriptor and
 * snapshot. That property is worth more than the speed — it is the same
 * property that lets a DesktopSurface reuse this code unchanged.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UISnapshot } from "../src/surface/types.js";
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

  it("respects frame scoping — a descriptor never matches across frames", () => {
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
    // descending confidence — the ladder's whole claim.
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
