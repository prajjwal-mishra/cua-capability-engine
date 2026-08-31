/**
 * Structural proof that deterministic replay is deterministic.
 *
 * A comment saying "no LLM here" is worth nothing six months and four
 * contributors later. This walks the ENTIRE transitive import graph from the
 * replay entry points and fails the build if anything in it can reach a model —
 * so the guarantee survives someone adding a well-intentioned "just retry this
 * one step with the model" helper three layers down.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = process.cwd();

/** Modules that mean "a model is in the loop". */
const FORBIDDEN_MODULES = ["openai", "@anthropic-ai/sdk", "@google/generative-ai"];
const FORBIDDEN_LOCAL = [
  "src/discovery/llm.ts",
  "src/discovery/loop.ts",
  "src/discovery/tools.ts",
  "src/discovery/prompts.ts",
];

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  // `import type` is erased at build time and creates no runtime coupling, so
  // it is not traversed. Dynamic `import()` IS traversed: a lazily loaded model
  // is still a model in the loop, and that is exactly what this test guards.
  const patterns = [
    /(?<!import\s)(?<!export\s)import\s+(?!type\s)[\s\S]*?from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /export\s+(?!type\s)[\s\S]*?from\s+["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]!);
  }
  return specs;
}

function resolveLocal(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface GraphResult {
  readonly visited: Set<string>;
  readonly violations: string[];
}

function walk(entry: string): GraphResult {
  const visited = new Set<string>();
  const violations: string[] = [];
  const queue = [resolve(ROOT, entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const spec of importsOf(file)) {
      const bare = spec
        .split("/")
        .slice(0, spec.startsWith("@") ? 2 : 1)
        .join("/");
      if (FORBIDDEN_MODULES.includes(bare)) {
        violations.push(`${file.replace(ROOT + "/", "")} imports '${spec}'`);
        continue;
      }
      const local = resolveLocal(file, spec);
      if (!local) continue;
      const rel = local.replace(ROOT + "/", "");
      if (FORBIDDEN_LOCAL.includes(rel)) {
        violations.push(`${file.replace(ROOT + "/", "")} imports '${rel}'`);
        continue;
      }
      queue.push(local);
    }
  }

  return { visited, violations };
}

describe("replay cannot reach a model", () => {
  it("has no LLM anywhere in the executor's transitive import graph", () => {
    const { visited, violations } = walk("src/replay/executor.ts");
    // Sanity: the walk must actually be traversing something, or this test
    // would pass by doing nothing.
    expect(visited.size).toBeGreaterThan(8);
    expect(violations).toEqual([]);
  });

  it("has no LLM in the replay command's graph either", () => {
    const { violations } = walk("src/cmd/replay.ts");
    expect(violations).toEqual([]);
  });

  it("detects a violation when one is introduced", () => {
    // Guard against the walker silently breaking: discovery genuinely does
    // import a model, so walking it MUST produce violations.
    const { violations } = walk("src/cmd/discover.ts");
    expect(violations.length).toBeGreaterThan(0);
  });
});
