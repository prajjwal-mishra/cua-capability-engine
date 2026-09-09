/**
 * Project a capability artifact into a Playwright snippet.
 *
 * This is a stretch the brief offered: a page object / test generated from the
 * recorded ladder. It is a projection of the artifact, not a second source of
 * truth — the engine still replays the JSON. Generated locators prefer the
 * same vocabulary replay uses (role + name + frame path) and never invent CSS
 * selectors from structural rungs.
 */

import type {
  CapabilityArtifact,
  Condition,
  ElementDescriptor,
  Step,
  ValueBinding,
} from "../artifact/schema.js";

export type EmitFormat = "test" | "page-object";

export function emitPlaywright(
  artifact: CapabilityArtifact,
  format: EmitFormat = "test",
): string {
  const className = `${pascal(artifact.capabilityId)}Page`;
  const argsType = `${pascal(artifact.capabilityId)}Args`;
  const methods = artifact.steps.map((step) => emitStepMethod(step, argsType)).join("\n\n");
  const extracts = artifact.outputs
    .map((o) => emitExtractMethod(o.name, o.extraction.descriptor))
    .join("\n\n");

  const header = `/**
 * Generated from ${artifact.capabilityId}@${artifact.version}.
 *
 * A projection of the capability artifact — not a second source of truth.
 * Replay still executes the JSON; this file exists so a reviewer can see the
 * recorded ladder as ordinary Playwright, or drop a snippet into an existing
 * suite. Do not edit this and the artifact independently.
 *
 * Target: ${artifact.target.appId} (${artifact.target.vendorProduct})
 * Entry:  ${artifact.target.entryPoint}
 */`;

  const pageObject = `export type ${argsType} = {
${artifact.inputs.map((i) => `  ${i.name}: string;`).join("\n") || "  // no inputs"}
};

export class ${className} {
  constructor(private readonly page: Page) {}

${methods}${extracts ? `\n\n${extracts}` : ""}
}
`;

  if (format === "page-object") {
    return `${header}
import { type Page } from "@playwright/test";

${pageObject}`;
  }

  const examples = artifact.inputs
    .map((i) => `    ${i.name}: ${JSON.stringify(i.example ?? "REPLACE_ME")},`)
    .join("\n");

  const calls = artifact.steps.map((step) => emitStepCall(step)).join("\n");
  const outputReads = artifact.outputs
    .map((o) => {
      const n = ident(o.name);
      return `  const ${n} = await flow.read_${n}();\n  expect(${n}.length).toBeGreaterThan(0);`;
    })
    .join("\n");
  const successAsserts = emitConditionAsserts(artifact.successCondition, "  ");

  return `${header}
import { test, expect, type Page } from "@playwright/test";

${pageObject}
test(${JSON.stringify(artifact.capabilityId)}, async ({ page }) => {
  const args: ${argsType} = {
${examples}
  };
  const flow = new ${className}(page);
  await page.goto(process.env.CUA_TARGET ?? "http://localhost:4000");
${calls}
${outputReads}
${successAsserts}
});
`;
}

/* ----------------------------------------------------------------- steps -- */

function emitStepMethod(step: Step, argsType: string): string {
  const params = needsArgs(step) ? `args: ${argsType}` : "";
  const body = emitStepBody(step, "    ");
  return `  /** ${step.id}: ${step.intent} (${step.action}, risk=${step.risk}) */\n  async ${ident(step.id)}(${params}): Promise<void> {\n${body}\n  }`;
}

function emitStepCall(step: Step): string {
  const args = needsArgs(step) ? "args" : "";
  return `  await flow.${ident(step.id)}(${args});`;
}

function needsArgs(step: Step): boolean {
  if (step.value && "$param" in step.value) return true;
  return Boolean(
    step.target?.strategies.some(
      (s) => "name" in s && typeof s.name === "string" && s.name.includes("{{param:"),
    ),
  );
}

function emitStepBody(step: Step, pad: string): string {
  const lines: string[] = [];

  if (step.action === "navigate") {
    const url = step.value ? valueExpr(step.value) : JSON.stringify("http://localhost:4000");
    lines.push(`${pad}await this.page.goto(${url});`);
  } else if (step.action === "waitFor") {
    if (step.checkpoint) lines.push(...emitConditionWaits(step.checkpoint, pad));
    else lines.push(`${pad}await this.page.waitForLoadState("domcontentloaded");`);
  } else if (!step.target) {
    lines.push(`${pad}// no target recorded for ${step.action}`);
  } else {
    const loc = locatorFor(step.target);
    lines.push(`${pad}// ${loc.comment}`);
    switch (step.action) {
      case "click":
        lines.push(`${pad}await ${loc.expr}.click();`);
        break;
      case "type":
        lines.push(`${pad}await ${loc.expr}.fill(${step.value ? valueExpr(step.value) : '""'});`);
        break;
      case "select":
        lines.push(`${pad}await ${loc.expr}.selectOption(${step.value ? valueExpr(step.value) : '""'});`);
        break;
      case "key":
        lines.push(`${pad}await ${loc.expr}.press(${step.value ? valueExpr(step.value) : JSON.stringify("Enter")});`);
        break;
      case "read":
        lines.push(`${pad}await ${loc.expr}.textContent();`);
        break;
      case "scroll":
        lines.push(`${pad}await ${loc.expr}.scrollIntoViewIfNeeded();`);
        break;
      default:
        lines.push(`${pad}await ${loc.expr}.click();`);
    }
  }

  if (step.checkpoint && step.action !== "waitFor") {
    lines.push(...emitConditionWaits(step.checkpoint, pad));
  }
  return lines.join("\n");
}

function emitExtractMethod(name: string, descriptor: ElementDescriptor): string {
  const loc = locatorFor(descriptor);
  return `  /** Extract output ${name}. */\n  async read_${ident(name)}(): Promise<string> {\n    // ${loc.comment}\n    return (await ${loc.expr}.textContent())?.trim() ?? "";\n  }`;
}

/* ------------------------------------------------------------- locators -- */

export function locatorFor(descriptor: ElementDescriptor): { expr: string; comment: string } {
  const scope = scopeExpr(descriptor.framePath);
  const ladder = descriptor.strategies.map((s) => s.kind).join(" → ");

  for (const s of descriptor.strategies) {
    if (s.kind === "role_name") {
      return {
        expr: `${scope}.getByRole(${JSON.stringify(ariaRole(s.role))}, { name: ${nameExpr(s.name)} })`,
        comment: `${descriptor.intent}; ladder ${ladder}; using role_name`,
      };
    }
    if (s.kind === "label_anchor") {
      return {
        expr: `${scope}.getByRole(${JSON.stringify(ariaRole(s.role))}, { name: ${JSON.stringify(s.labelText)} })`,
        comment: `${descriptor.intent}; ladder ${ladder}; using label_anchor (${s.relation})`,
      };
    }
    if (s.kind === "table_cell") {
      return {
        expr: `${scope}.getByRole("row", { name: ${JSON.stringify(s.rowKey)} }).getByRole("cell").last()`,
        comment: `${descriptor.intent}; ladder ${ladder}; table_cell column ${JSON.stringify(s.columnHeader)} × row ${JSON.stringify(s.rowKey)}`,
      };
    }
    if (s.kind === "frame_role_ordinal") {
      const role = JSON.stringify(ariaRole(s.role));
      const expr =
        s.ordinalScope === "role_and_name" && s.name
          ? `${scope}.getByRole(${role}, { name: ${nameExpr(s.name)} }).nth(${s.ordinal})`
          : `${scope}.getByRole(${role}).nth(${s.ordinal})`;
      return {
        expr,
        comment: `${descriptor.intent}; ladder ${ladder}; using frame_role_ordinal`,
      };
    }
  }

  return {
    expr: `${scope}.getByRole(${JSON.stringify(ariaRole(descriptor.role))})`,
    comment: `${descriptor.intent}; ladder ${ladder}; no Playwright-expressible rung, falling back to role`,
  };
}

function scopeExpr(framePath: readonly string[]): string {
  if (framePath.length === 0) return "this.page";
  let expr = "this.page";
  for (const name of framePath) {
    expr += `.frameLocator(${JSON.stringify(`iframe[name="${name}"]`)})`;
  }
  return expr;
}

/* ----------------------------------------------------------- conditions -- */

function emitConditionWaits(condition: Condition, pad: string): string[] {
  return condition.all.map((clause) => {
    const scope = scopeExpr(clause.framePath ?? []);
    switch (clause.type) {
      case "textPresent":
        return `${pad}await ${scope}.getByText(${JSON.stringify(clause.text)}).first().waitFor();`;
      case "textAbsent":
        return `${pad}await ${scope}.getByText(${JSON.stringify(clause.text)}).first().waitFor({ state: "hidden" }).catch(() => undefined);`;
      case "elementPresent": {
        const name = clause.name ? `, { name: ${nameExpr(clause.name)} }` : "";
        return `${pad}await ${scope}.getByRole(${JSON.stringify(ariaRole(clause.role))}${name}).first().waitFor();`;
      }
      case "elementAbsent": {
        const name = clause.name ? `, { name: ${nameExpr(clause.name)} }` : "";
        return `${pad}await ${scope}.getByRole(${JSON.stringify(ariaRole(clause.role))}${name}).first().waitFor({ state: "hidden" }).catch(() => undefined);`;
      }
      case "routeMatches":
        return `${pad}// checkpoint: frame route matches ${JSON.stringify(clause.pattern)}`;
    }
  });
}

function emitConditionAsserts(condition: Condition, pad: string): string {
  return condition.all
    .map((clause) => {
      const scope = scopeExpr(clause.framePath ?? []).replace(/^this\.page/, "page");
      switch (clause.type) {
        case "textPresent":
          return `${pad}await expect(${scope}.getByText(${JSON.stringify(clause.text)}).first()).toBeVisible();`;
        case "elementPresent": {
          const name = clause.name ? `, { name: ${nameExpr(clause.name)} }` : "";
          return `${pad}await expect(${scope}.getByRole(${JSON.stringify(ariaRole(clause.role))}${name}).first()).toBeVisible();`;
        }
        case "routeMatches":
          return `${pad}// success: frame route matches ${JSON.stringify(clause.pattern)}`;
        default:
          return `${pad}// ${clause.type}`;
      }
    })
    .join("\n");
}

/* ---------------------------------------------------------------- values -- */

function valueExpr(value: ValueBinding): string {
  if ("literal" in value) return JSON.stringify(value.literal);
  if ("$param" in value) return `args.${value.$param}`;
  return `/* $output ${value.$output} */ ""`;
}

function nameExpr(name: string): string {
  if (/^\{\{param:([^}]+)\}\}$/.test(name)) {
    return `args.${name.slice("{{param:".length, -2)}`;
  }
  if (name.includes("{{param:")) {
    const interpolated = name.replace(/\{\{param:([^}]+)\}\}/g, "${args.$1}");
    return `\`${interpolated}\``;
  }
  return JSON.stringify(name);
}

function ariaRole(role: string): string {
  if (role === "text") return "generic";
  return role;
}

function pascal(id: string): string {
  return id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function ident(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]+/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}
