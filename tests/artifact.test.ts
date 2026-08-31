import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityArtifactSchema,
  SCHEMA_VERSION,
  toolContract,
  type CapabilityArtifact,
} from "../src/artifact/schema.js";
import { applyOverlay, describeOverlay, OverlayMismatch, OverlaySchema } from "../src/artifact/overlays.js";
import { ArtifactStore } from "../src/artifact/store.js";
import { latest, parseCapabilityRef, satisfies } from "../src/artifact/version.js";

const base: CapabilityArtifact = CapabilityArtifactSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  capabilityId: "member.savings_balance",
  version: "1.0.0",
  name: "Read member savings balance",
  description: "Look up a member and return their current savings balance.",
  provenance: {
    discoveredBy: "test",
    runId: "run-test",
    recordedAt: "2026-08-30T00:00:00.000Z",
    surfaceType: "legacy-web",
  },
  target: {
    surfaceType: "legacy-web",
    appId: "legacy-cu",
    vendorProduct: "corevantage-backoffice",
    variant: "variant-a",
    entryPoint: "/frame/search",
  },
  inputs: [
    {
      name: "memberId",
      jsonSchema: { type: "string", pattern: "^[0-9]{5}$" },
      required: true,
      sensitivity: "internal",
      example: "10042",
    },
  ],
  outputs: [
    {
      name: "savingsBalance",
      jsonSchema: { type: "string" },
      required: true,
      extraction: {
        descriptor: {
          intent: "the savings row's current balance cell",
          role: "cell",
          framePath: ["contentFrame", "acctFrame"],
          strategies: [
            { kind: "table_cell", confidence: 0.9, columnHeader: "Current Balance", rowKey: "Savings" },
          ],
        },
        parse: { kind: "currency" },
      },
    },
  ],
  steps: [
    {
      id: "s1",
      intent: "enter the member id",
      action: "type",
      value: { $param: "memberId" },
      target: {
        intent: "member id field",
        role: "textbox",
        framePath: ["contentFrame"],
        strategies: [{ kind: "role_name", confidence: 0.65, role: "textbox", name: "Member ID", match: "exact" }],
      },
      risk: "read_only",
    },
    {
      id: "s2",
      intent: "submit the search",
      action: "click",
      target: {
        intent: "search button",
        role: "button",
        framePath: ["contentFrame"],
        strategies: [{ kind: "role_name", confidence: 0.9, role: "button", name: "Search", match: "exact" }],
      },
      risk: "read_only",
    },
  ],
  successCondition: {
    all: [{ type: "elementPresent", role: "cell", name: "Savings", framePath: ["contentFrame", "acctFrame"] }],
    describe: "the accounts grid shows a savings row",
  },
  policy: { allowlistRef: "config/allowlist.demo-cu.json" },
  lifecycle: { state: "draft" },
});

describe("schema", () => {
  it("emits an agent-facing contract with no execution detail in it", () => {
    const c = toolContract(base);
    expect(c.name).toBe("member.savings_balance");
    expect(c.inputSchema).toMatchObject({ required: ["memberId"] });
    expect(JSON.stringify(c)).not.toContain("strategies");
    expect(JSON.stringify(c)).not.toContain("framePath");
  });

  it("rejects a descriptor with no strategies at all", () => {
    const bad = structuredClone(base) as CapabilityArtifact;
    (bad.steps[0]!.target as { strategies: unknown[] }).strategies = [];
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow();
  });
});

describe("versions", () => {
  it("handles the range forms an overlay may pin", () => {
    expect(satisfies("1.2.3", "*")).toBe(true);
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
  });

  it("picks the newest version numerically, not lexically", () => {
    expect(latest(["1.9.0", "1.10.0", "1.2.0"])).toBe("1.10.0");
  });

  it("parses a capability ref", () => {
    expect(parseCapabilityRef("member.savings_balance@1.0.0")).toEqual({
      capabilityId: "member.savings_balance",
      version: "1.0.0",
    });
    expect(parseCapabilityRef("member.savings_balance").version).toBeUndefined();
  });
});

describe("overlays are separate documents applied over a base", () => {
  const overlay = OverlaySchema.parse({
    overlayId: "summit-fcu.savings_balance",
    tenant: "summit-fcu",
    variant: "variant-b",
    basedOn: { capabilityId: "member.savings_balance", versionRange: "^1.0.0" },
    describe: "Summit calls the field 'Member Number' and the row 'Share Savings'.",
    patch: {
      steps: {
        s1: {
          target: {
            intent: "member number field",
            role: "textbox",
            framePath: ["contentFrame"],
            strategies: [
              { kind: "role_name", confidence: 0.65, role: "textbox", name: "Member Number", match: "exact" },
            ],
          },
        },
      },
      outputs: {
        savingsBalance: {
          extraction: {
            descriptor: {
              intent: "share savings balance cell",
              role: "cell",
              framePath: ["contentFrame", "acctFrame"],
              strategies: [
                { kind: "table_cell", confidence: 0.9, columnHeader: "Balance", rowKey: "Share Savings" },
              ],
            },
          },
        },
      },
    },
  });

  it("patches only what the tenant changed and leaves the rest inherited", () => {
    const resolved = applyOverlay(base, overlay);
    expect(resolved.steps[0]!.target!.strategies[0]).toMatchObject({ name: "Member Number" });
    expect(resolved.steps[1]).toEqual(base.steps[1]); // untouched
    expect(resolved.outputs[0]!.extraction.descriptor.strategies[0]).toMatchObject({
      columnHeader: "Balance",
    });
    expect(resolved.target.variant).toBe("variant-b");
  });

  it("summarizes itself for review", () => {
    expect(describeOverlay(overlay)).toEqual([
      "step s1: patched target",
      "output savingsBalance: re-targeted",
    ]);
  });

  it("refuses a base version it was never reviewed against", () => {
    const bumped = { ...base, version: "2.0.0" };
    expect(() => applyOverlay(bumped, overlay)).toThrow(OverlayMismatch);
  });

  it("refuses to silently ignore a patch for a step that no longer exists", () => {
    const stale = OverlaySchema.parse({
      ...overlay,
      patch: { ...overlay.patch, steps: { sX: { intent: "gone" } } },
    });
    expect(() => applyOverlay(base, stale)).toThrow(/no longer exist/);
  });

  it("inserts a tenant's extra confirmation step at an anchored position", () => {
    const withExtra = OverlaySchema.parse({
      ...overlay,
      patch: {
        ...overlay.patch,
        insertSteps: [
          {
            after: "s2",
            step: {
              id: "s2b",
              intent: "acknowledge the extra review screen Summit interposes",
              action: "click",
              risk: "reversible_write",
              target: {
                intent: "commit button",
                role: "button",
                framePath: ["contentFrame"],
                strategies: [
                  { kind: "role_name", confidence: 0.9, role: "button", name: "Commit Sub-Account", match: "exact" },
                ],
              },
            },
          },
        ],
      },
    });
    const resolved = applyOverlay(base, withExtra);
    expect(resolved.steps.map((s) => s.id)).toEqual(["s1", "s2", "s2b"]);
  });
});

describe("store", () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cua-store-"));
    store = new ArtifactStore({ capabilities: join(dir, "capabilities"), overlays: join(dir, "overlays") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips and resolves the latest version by default", () => {
    store.save(base);
    store.save({ ...base, version: "1.1.0" });
    expect(store.load("member.savings_balance").version).toBe("1.1.0");
    expect(store.load("member.savings_balance@1.0.0").version).toBe("1.0.0");
  });

  it("names what is available when a version is missing", () => {
    store.save(base);
    expect(() => store.load("member.savings_balance@9.9.9")).toThrow(/available: 1\.0\.0/);
  });

  it("applies a tenant overlay on resolve, and nothing when the tenant has none", () => {
    store.save(base);
    store.saveOverlay("corevantage-backoffice", {
      overlayId: "summit-fcu.savings_balance",
      tenant: "summit-fcu",
      variant: "variant-b",
      basedOn: { capabilityId: "member.savings_balance", versionRange: "^1.0.0" },
      patch: {
        steps: {
          s1: {
            target: {
              intent: "member number field",
              role: "textbox",
              framePath: ["contentFrame"],
              strategies: [
                { kind: "role_name", confidence: 0.65, role: "textbox", name: "Member Number", match: "exact" },
              ],
            },
          },
        },
        insertSteps: [],
        outputs: {},
        knownOutcomes: [],
        recoveries: [],
      },
    });

    const plain = store.resolve("member.savings_balance");
    expect(plain.overlay).toBeUndefined();
    expect(plain.artifact.steps[0]!.target!.strategies[0]).toMatchObject({ name: "Member ID" });

    const tenant = store.resolve("member.savings_balance", "summit-fcu");
    expect(tenant.overlay?.tenant).toBe("summit-fcu");
    expect(tenant.artifact.steps[0]!.target!.strategies[0]).toMatchObject({ name: "Member Number" });
  });

  it("accumulates a stability signal across runs", () => {
    store.save(base);
    store.recordRun("member.savings_balance@1.0.0", true);
    store.recordRun("member.savings_balance@1.0.0", false);
    const s = store.load("member.savings_balance@1.0.0").lifecycle.stability;
    expect(s).toMatchObject({ runs: 2, successes: 1 });
  });
});
