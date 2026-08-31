/**
 * Argument parsing, separate from the CLI entry point.
 *
 * Split out because the entry point dispatches to every command, so any module
 * importing a type from it pulls the whole command graph along — which put the
 * LLM back inside `cua replay`'s import graph purely for a type alias.
 * A shared type belongs in a leaf module, not in the thing that wires
 * everything together.
 */

export interface Args {
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** Repeated `--input k=v` pairs, collected. */
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
