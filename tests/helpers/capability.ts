/**
 * A hand-built capability used ONLY as test input.
 *
 * This is deliberately not the artifact in /evidence — that one must come from
 * a genuine discovery run. This exists so the replay executor can be tested
 * exhaustively (every branch of the result contract, every recovery) without
 * needing a model, and without twenty LLM runs to produce twenty fixtures.
 * It mirrors the shape the compiler emits.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CapabilityArtifactSchema,
  SCHEMA_VERSION,
  type CapabilityArtifact,
} from "../../src/artifact/schema.js";
import { RecoveryPackSchema } from "../../src/recorder/compile.js";
import { AllowlistSchema, type Allowlist } from "../../src/policy/allowlist.js";

export function testAllowlist(origin: string): Allowlist {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "config/allowlist.demo-cu.json"), "utf8"),
  );
  return AllowlistSchema.parse({ ...raw, origins: [origin] });
}

export function savingsBalanceCapability(variant = "variant-a"): CapabilityArtifact {
  const pack = RecoveryPackSchema.parse(
    JSON.parse(
      readFileSync(join(process.cwd(), "config/recovery-pack.corevantage-backoffice.json"), "utf8"),
    ),
  );

  return CapabilityArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    capabilityId: "test.member.savings_balance",
    version: "1.0.0",
    name: "Read member savings balance",
    description: "Look up a member and read their current savings balance.",
    provenance: {
      discoveredBy: "hand-built test fixture",
      runId: "fixture",
      recordedAt: "2026-08-30T00:00:00.000Z",
      surfaceType: "legacy-web",
    },
    target: {
      surfaceType: "legacy-web",
      appId: "legacy-cu",
      vendorProduct: "corevantage-backoffice",
      variant,
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
        sensitivity: "internal",
        extraction: {
          descriptor: {
            intent: "the savings row's current balance cell",
            role: "cell",
            framePath: ["contentFrame", "acctFrame"],
            strategies: [
              {
                kind: "table_cell",
                confidence: 0.9,
                columnHeader: "Current Balance",
                rowKey: "Savings",
              },
            ],
          },
          parse: { kind: "currency" },
        },
      },
    ],
    steps: [
      {
        id: "s1",
        intent: "enter the member id in the search field",
        action: "type",
        value: { $param: "memberId" },
        risk: "read_only",
        retryPolicy: { maxAttempts: 3, backoffMs: 400 },
        target: {
          intent: "member id field",
          role: "textbox",
          framePath: ["contentFrame"],
          strategies: [
            {
              kind: "role_name",
              confidence: 0.65,
              role: "textbox",
              name: "Member ID",
              match: "exact",
            },
            {
              kind: "label_anchor",
              confidence: 0.82,
              role: "textbox",
              labelText: "Member ID",
              relation: "same-row",
            },
            {
              kind: "frame_role_ordinal",
              confidence: 0.4,
              role: "textbox",
              ordinal: 0,
              ordinalScope: "role",
            },
          ],
        },
      },
      {
        id: "s2",
        intent: "submit the search",
        action: "click",
        risk: "read_only",
        retryPolicy: { maxAttempts: 3, backoffMs: 400 },
        target: {
          intent: "search button",
          role: "button",
          framePath: ["contentFrame"],
          strategies: [
            { kind: "role_name", confidence: 0.9, role: "button", name: "Search", match: "exact" },
          ],
        },
        checkpoint: {
          all: [{ type: "routeMatches", pattern: "/frame/results", framePath: ["contentFrame"] }],
          describe: "the content frame reached the results list",
        },
      },
      {
        id: "s3",
        intent: "open the matching member's record",
        action: "click",
        risk: "read_only",
        retryPolicy: { maxAttempts: 3, backoffMs: 400 },
        target: {
          intent: "the result row for the requested member",
          role: "link",
          framePath: ["contentFrame"],
          strategies: [
            // Parameterized: without the binding this descriptor would be
            // welded to whichever member the capability was recorded against.
            {
              kind: "role_name",
              confidence: 0.88,
              role: "link",
              name: "{{param:memberId}}",
              match: "exact",
            },
          ],
        },
        checkpoint: {
          all: [
            {
              type: "routeMatches",
              pattern: "/frame/member/:memberId",
              framePath: ["contentFrame"],
            },
          ],
          describe: "the content frame reached the member detail page",
        },
      },
    ],
    successCondition: {
      all: [
        {
          type: "elementPresent",
          role: "cell",
          name: "Savings",
          framePath: ["contentFrame", "acctFrame"],
        },
      ],
      describe: "the accounts grid shows a savings row",
    },
    knownOutcomes: pack.knownOutcomes,
    recoveries: pack.recoveries,
    policy: { allowlistRef: "config/allowlist.demo-cu.json" },
    lifecycle: { state: "approved", stability: { runs: 0, successes: 0 } },
  });
}
