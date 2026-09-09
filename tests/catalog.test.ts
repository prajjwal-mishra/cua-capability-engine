/**
 * The agent-facing contract.
 *
 * These tests are about what a CALLER sees and is protected from, not about
 * browsers — the catalog's job is to make a UI flow indistinguishable from a
 * typed function, and to refuse the calls that should not happen before a
 * browser is ever launched. Each refusal below is a thing an autonomous agent
 * would otherwise be free to do to a system of record on a hunch.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifact/store.js";
import {
  CapabilityNotInvocable,
  entryFor,
  invokeCapability,
  listCatalog,
  maxRisk,
} from "../src/catalog/catalog.js";
import { startCatalogServer } from "../src/catalog/server.js";
import { InputValidationError } from "../src/replay/executor.js";
import type { CapabilityArtifact } from "../src/artifact/schema.js";
import { savingsBalanceCapability } from "./helpers/capability.js";

let root: string;
let store: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cua-catalog-"));
  store = new ArtifactStore({
    capabilities: join(root, "capabilities"),
    overlays: join(root, "overlays"),
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The fixture, adjusted to whatever the test is actually about. */
function put(patch: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  const artifact = { ...savingsBalanceCapability(), ...patch } as CapabilityArtifact;
  store.save(artifact);
  return artifact;
}

const ID = "test.member.savings_balance";

/* --------------------------------------------------------------- listing -- */

describe("what an agent can discover", () => {
  it("publishes a JSON Schema contract, not a description of a browser", () => {
    put();
    const entry = listCatalog(store)[0]!;

    expect(entry.tool.name).toBe(ID);
    expect(entry.tool.inputSchema).toMatchObject({
      type: "object",
      required: ["memberId"],
      // Unknown keys rejected at the schema level too, not only in our coercion.
      additionalProperties: false,
      properties: { memberId: { type: "string", pattern: "^[0-9]{5}$" } },
    });
    expect(entry.tool.outputSchema).toMatchObject({
      properties: { savingsBalance: { type: "string" } },
    });
    // Nothing in the contract leaks the mechanism.
    const asText = JSON.stringify(entry.tool);
    for (const leak of ["frame", "selector", "playwright", "descriptor", "xpath"]) {
      expect(asText.toLowerCase()).not.toContain(leak);
    }
  });

  it("tells the caller the worst thing the capability can do before they call it", () => {
    const readOnly = savingsBalanceCapability();
    expect(maxRisk(readOnly)).toBe("read_only");

    const writes: CapabilityArtifact = {
      ...readOnly,
      steps: readOnly.steps.map((s, i) => (i === 1 ? { ...s, risk: "irreversible" as const } : s)),
    };
    // The whole flow's risk, not the average and not the first step's — a
    // caller deciding whether to invoke needs the worst case.
    expect(maxRisk(writes)).toBe("irreversible");
  });

  it("surfaces business outcomes as part of the contract", () => {
    const entry = entryFor(put());
    // "This member does not exist" is a documented answer the caller must
    // handle, not an exception it discovers in production.
    expect(entry.outcomes.map((o) => o.code)).toContain("member_not_found");
    expect(entry.outcomes.every((o) => o.severity === "business")).toBe(true);
  });

  it("lists one row per capability, at its newest version", () => {
    put();
    put({ version: "1.2.0" } as Partial<CapabilityArtifact>);
    put({ version: "1.10.0" } as Partial<CapabilityArtifact>);

    const rows = listCatalog(store);
    expect(rows).toHaveLength(1);
    // Semver, not lexicographic: "1.10.0" > "1.2.0" is the case that catches it.
    expect(rows[0]!.version).toBe("1.10.0");
  });

  it("reports stability as a rate, and as unknown when nothing has run", () => {
    const entry = entryFor(put());
    expect(entry.stability).toEqual({ runs: 0, successes: 0, rate: null });

    store.recordRun(`${ID}@1.0.0`, true);
    store.recordRun(`${ID}@1.0.0`, false);
    expect(entryFor(store.load(ID)).stability).toEqual({ runs: 2, successes: 1, rate: 0.5 });
  });

  it("keeps each tenant's track record separate from the recording's own", () => {
    put();
    store.recordRun(`${ID}@1.0.0`, true);
    store.recordRun(`${ID}@1.0.0`, true);
    // Aiming the same capability at an institution whose overlay is unfinished.
    store.recordRun(`${ID}@1.0.0`, false, "summit-fcu");
    store.recordRun(`${ID}@1.0.0`, false, "summit-fcu");

    const entry = entryFor(store.load(ID));
    // The headline still reflects where it was recorded. Otherwise probing a
    // new tenant — the only way to find out what needs overlaying — would
    // damage the capability's standing everywhere it already works.
    expect(entry.stability).toMatchObject({ runs: 2, successes: 2, rate: 1 });
    expect(entry.stabilityByTenant["summit-fcu"]).toMatchObject({
      runs: 2,
      successes: 0,
      rate: 0,
    });
  });
});

/* ------------------------------------------------------------- refusals --- */

describe("what an agent is refused", () => {
  const draft = { lifecycle: { state: "draft", stability: { runs: 0, successes: 0 } } };

  it("will not invoke an unapproved capability by default", async () => {
    put(draft as Partial<CapabilityArtifact>);
    await expect(invokeCapability(ID, { memberId: "10042" }, { store })).rejects.toThrow(
      CapabilityNotInvocable,
    );
    // And says how to fix it, rather than just refusing.
    await expect(invokeCapability(ID, { memberId: "10042" }, { store })).rejects.toThrow(
      /catalog approve/,
    );
  });

  it("will not invoke a deprecated capability even with allowDraft", async () => {
    put({
      lifecycle: { state: "deprecated", stability: { runs: 9, successes: 9 } },
    } as Partial<CapabilityArtifact>);
    await expect(
      invokeCapability(ID, { memberId: "10042" }, { store, allowDraft: true }),
    ).rejects.toThrow(/deprecated/);
  });

  it("will not perform a write unless the caller opted in", async () => {
    const base = savingsBalanceCapability();
    store.save({
      ...base,
      steps: base.steps.map((s, i) =>
        i === 1 ? { ...s, risk: "reversible_write" as const } : s,
      ),
    });
    await expect(invokeCapability(ID, { memberId: "10042" }, { store })).rejects.toThrow(
      /explicitly opt into writes/,
    );
  });

  it("rejects an argument the contract does not declare instead of dropping it", async () => {
    put();
    // The failure mode this prevents: `member_id` silently ignored, the flow
    // runs with no member id, and something unrelated comes back.
    await expect(
      invokeCapability(ID, { member_id: "10042" }, { store }),
    ).rejects.toThrow(InputValidationError);
    await expect(invokeCapability(ID, { member_id: "10042" }, { store })).rejects.toThrow(
      /it accepts: memberId/,
    );
  });

  it("rejects a structured argument rather than stringifying it into a form field", async () => {
    put();
    await expect(
      invokeCapability(ID, { memberId: { value: "10042" } }, { store }),
    ).rejects.toThrow(/must be a scalar/);
  });
});

/* ----------------------------------------------------------------- http --- */

describe("over HTTP", () => {
  it("serves the contract and maps refusals onto honest status codes", async () => {
    put({
      lifecycle: { state: "draft", stability: { runs: 0, successes: 0 } },
    } as Partial<CapabilityArtifact>);
    const server = await startCatalogServer(0, store);
    try {
      const list = (await (await fetch(`${server.url}/capabilities`)).json()) as {
        tool: { inputSchema: { required: string[] } };
      }[];
      expect(list).toHaveLength(1);
      expect(list[0]!.tool.inputSchema.required).toContain("memberId");

      const desk = await fetch(`${server.url}/`);
      expect(desk.headers.get("content-type") ?? "").toMatch(/html/);
      expect(await desk.text()).toMatch(/Capabilities/);

      const missing = await fetch(`${server.url}/capabilities/nope.not_a_thing`);
      expect(missing.status).toBe(404);

      // A refusal is the caller's problem to fix: 403, with the reason.
      const refused = await fetch(`${server.url}/capabilities/${ID}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: { memberId: "10042" } }),
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { reason: string }).reason).toMatch(/not approved/);

      // A malformed call is 400, distinctly — an agent retrying a 403 is
      // pointless, an agent correcting a 400 is not.
      const malformed = await fetch(`${server.url}/capabilities/${ID}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: { nope: "x" }, allowDraft: true }),
      });
      expect(malformed.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

/* -------------------------------------------------------------- overlays -- */

describe("resolving a capability for a tenant", () => {
  it("keeps each tenant's specializations in their own reviewable file", () => {
    put();
    const overlay = {
      overlayId: "t1.savings",
      tenant: "summit-fcu",
      variant: "variant-b",
      basedOn: { capabilityId: ID, versionRange: "^1.0.0" },
      describe: "relabelled search screen",
      patch: {
        steps: {
          s2: {
            target: {
              intent: "search button",
              role: "button" as const,
              framePath: ["contentFrame"],
              strategies: [
                {
                  kind: "role_name" as const,
                  confidence: 0.9,
                  role: "button" as const,
                  name: "Find Member",
                  match: "exact" as const,
                },
              ],
            },
          },
        },
      },
    };
    const path = store.saveOverlay("corevantage-backoffice", overlay);
    // Keyed by capability as well as tenant: one institution runs many
    // capabilities on the same product, and lumping them into one document
    // would make the patches unreviewable.
    expect(path).toContain(join("corevantage-backoffice", "summit-fcu", `${ID}.json`));

    const { artifact, overlay: applied } = store.resolve(ID, "summit-fcu");
    expect(applied?.overlayId).toBe("t1.savings");
    expect(artifact.steps.find((s) => s.id === "s2")!.target!.strategies[0]).toMatchObject({
      name: "Find Member",
    });
    // The base recording is untouched — the overlay is a view, not an edit.
    expect(store.load(ID).steps.find((s) => s.id === "s2")!.target!.strategies[0]).toMatchObject({
      name: "Search",
    });
  });

  it("ignores a tenant with no overlay rather than failing", () => {
    put();
    const { artifact, overlay } = store.resolve(ID, "someone-else");
    expect(overlay).toBeUndefined();
    expect(artifact.capabilityId).toBe(ID);
  });
});
