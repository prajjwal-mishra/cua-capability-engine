/**
 * Run identifiers.
 *
 * Trivial, and deliberately in its own module. It used to live in the recorder,
 * which meant `cua replay` imported the compiler, which imports the discovery
 * trace type, which reaches the LLM client - putting a model back inside
 * replay's import graph for the sake of one string function.
 * tests/no-llm-import.test.ts caught it. Keeping this here keeps that boundary
 * honest rather than merely documented.
 */

import { randomUUID } from "node:crypto";

export function newRunId(prefix = "run"): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
