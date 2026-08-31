/**
 * Command line entry point.
 *
 * `discover` is the only command that needs a model. Everything else — replay,
 * catalog, the operator console — runs offline against saved artifacts, which
 * is deliberate: a reviewer with no API key should still be able to exercise
 * the production path.
 */

import { loadEnv } from "./config/env.js";
loadEnv();

const [, , command, ...rest] = process.argv;

export interface Args {
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly inputs: Readonly<Record<string, string>>;
  readonly positional: readonly string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const inputs: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith("--");

    if (key === "input" && takesValue) {
      const eq = next.indexOf("=");
      if (eq > 0) inputs[next.slice(0, eq)] = next.slice(eq + 1);
      i++;
      continue;
    }
    if (takesValue) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, inputs, positional };
}

const USAGE = `cua — computer-use capability engine

  discover   --goal "<text>" --target <url> --tenant <id> [--input k=v ...]
             [--capability <id>] [--variant variant-a|variant-b] [--allow-writes]
             Run an LLM-driven exploration and compile the successful run into a capability.
             Requires CUA_LLM_* in .env. Everything below does not.

  replay     --capability <id>[@<version>] [--input k=v ...] [--tenant <id>]
             [--allow-writes] [--inject <mode>] [--stability N]
             Re-run a saved capability with no model in the decision loop.

  catalog    list | describe <id> | invoke <id> --args '<json>'
             The agent-facing surface: typed capabilities, invoked by name.

  operator   [--port 4100]
             Operator console: open interventions, live session takeover, hand back.
`;

async function main(): Promise<void> {
  const args = parseArgs(rest);
  switch (command) {
    case "discover":
      await (await import("./cmd/discover.js")).discoverCommand(args);
      break;
    case "replay":
      await (await import("./cmd/replay.js")).replayCommand(args);
      break;
    case "catalog":
      await (await import("./cmd/catalog.js")).catalogCommand(args);
      break;
    case "operator":
      await (await import("./cmd/operator.js")).operatorCommand(args);
      break;
    default:
      console.log(USAGE);
      process.exit(command === undefined || command === "--help" ? 0 : 1);
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
