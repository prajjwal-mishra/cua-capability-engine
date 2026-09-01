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

import { parseArgs } from "./cli-args.js";

const [, , command, ...rest] = process.argv;

const USAGE = `cua — computer-use capability engine

  discover   --goal "<text>" --target <url> --tenant <id> [--input k=v ...]
             [--capability <id>] [--variant variant-a|variant-b] [--allow-writes]
             Run an LLM-driven exploration and compile the successful run into a capability.
             Requires CUA_LLM_* in .env. Everything below does not.

  replay     --capability <id>[@<version>] [--input k=v ...] [--tenant <id>]
             [--allow-writes] [--inject <mode>] [--inject-path <substr>] [--stability N]
             [--attended]
             Re-run a saved capability with no model in the decision loop.
             --attended hands the live session to an operator console if it escalates.

  catalog    list
             describe <id> [--tenant <id>] [--json]
             invoke <id> --args '<json>' [--allow-writes] [--allow-draft] [--tenant <id>]
             approve <id> | deprecate <id>
             serve [--port 4200]
             The agent-facing surface: typed capabilities, invoked by name.

  operator   [--port 4100]
             Operator console: triage queued interventions across all runs.
             Same-session takeover happens via 'replay --attended'.
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
