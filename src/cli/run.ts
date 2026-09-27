import { createRequire } from "node:module";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { AssetdError, ExitCode } from "../core/errors.ts";
import { ASSET_KINDS, type AssetKind } from "../core/types.ts";
import { Output, type CliIO } from "./io.ts";

// Command modules are imported lazily: `--version`/`--help`/`status` never load sharp or the ML runtime.

type Options = NonNullable<ParseArgsConfig["options"]>;

const GLOBAL_OPTIONS: Options = {
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  project: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const SEARCH_OPTIONS: Options = {
  type: { type: "string", short: "t" },
  limit: { type: "string", short: "n" },
  in: { type: "string" },
};

const COMMANDS: Record<string, { options: Options; usage: string; summary: string }> = {
  index: {
    options: { "retry-failed": { type: "boolean" }, strict: { type: "boolean" } },
    usage: "assetd index [directory...] [--retry-failed] [--strict] [--json]",
    summary: "Index (or incrementally update) assets. Without arguments, re-scans the recorded roots.",
  },
  "ensure-index": {
    options: { "retry-failed": { type: "boolean" }, strict: { type: "boolean" } },
    usage: "assetd ensure-index [--json]",
    summary: "Do the minimal work needed to bring the existing index up to date (same as `assetd index`).",
  },
  search: {
    options: SEARCH_OPTIONS,
    usage: 'assetd search "<query>" [--type image] [--limit 10] [--in <dir>] [--json]',
    summary: "Semantic text search over indexed assets.",
  },
  similar: {
    options: SEARCH_OPTIONS,
    usage: "assetd similar <path> [--type image] [--limit 10] [--in <dir>] [--json]",
    summary: "Find assets visually similar to an image (indexed or not, inside the project or not).",
  },
  inspect: {
    options: {},
    usage: "assetd inspect <path> [--json]",
    summary: "Show metadata and index state of one asset.",
  },
  status: {
    options: { "no-stale-check": { type: "boolean" } },
    usage: "assetd status [--no-stale-check] [--json]",
    summary: "Show whether an index exists, what it covers, and whether it is stale.",
  },
  "contact-sheet": {
    options: {
      out: { type: "string", short: "o" },
      columns: { type: "string" },
      "thumb-size": { type: "string" },
      search: { type: "string" },
      limit: { type: "string", short: "n" },
    },
    usage: 'assetd contact-sheet <path...> | --search "<query>" [--limit 20] [--out sheet.png] [--columns N] [--thumb-size 192] [--json]',
    summary: "Render candidate images into one labeled grid image for visual comparison.",
  },
  models: {
    options: {},
    usage: "assetd models <status|pull> [--json]",
    summary: "Show the embedding model state, or download it ahead of time for offline use.",
  },
};

export function version(): string {
  try {
    return (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

function helpText(command?: string): string {
  if (command && COMMANDS[command]) {
    const c = COMMANDS[command];
    return `${c.summary}\n\nUsage:\n  ${c.usage}\n\nGlobal options:\n  --json            Machine-readable output on stdout (diagnostics on stderr)\n  --project <dir>   Project root (default: nearest directory with .asset-index/ or assetd.json)\n  -q, --quiet       Suppress informational stderr output\n`;
  }
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(15)}${c.summary}`);
  return [
    `assetd ${version()} - local semantic index and search for project assets`,
    "",
    "Usage: assetd <command> [options]",
    "",
    "Commands:",
    ...rows,
    "",
    "Global options: --json, --project <dir>, -q/--quiet, -h/--help, --version",
    "Run `assetd <command> --help` for details. Exit codes: docs/cli-contract.md",
    "",
  ].join("\n");
}

function intOption(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AssetdError("USAGE_ERROR", `--${name} must be an integer between ${min} and ${max}`);
  return n;
}

function kindOption(value: unknown): AssetKind {
  if (value === undefined) return "image";
  if (!(ASSET_KINDS as readonly string[]).includes(String(value))) {
    throw new AssetdError("USAGE_ERROR", `--type must be one of: ${ASSET_KINDS.join(", ")}`);
  }
  return value as AssetKind;
}

/** Runs one CLI invocation and returns its exit code. Never calls process.exit. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    io.stdout(version() + "\n");
    return ExitCode.OK;
  }
  let commandIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") i++; // skip its value
    else if (!argv[i]!.startsWith("-")) {
      commandIndex = i;
      break;
    }
  }
  const command = commandIndex >= 0 ? argv[commandIndex]! : undefined;
  const rest = commandIndex >= 0 ? [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)] : argv;
  const wantsJson = argv.includes("--json");
  const bootstrap = new Output(io, { json: wantsJson, quiet: false, project: undefined });

  if (!command) {
    if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
      io.stdout(helpText());
      return argv.length === 0 ? ExitCode.USAGE_ERROR : ExitCode.OK;
    }
    return bootstrap.error("assetd", new AssetdError("USAGE_ERROR", "Missing command. Run `assetd --help`."));
  }
  const spec = COMMANDS[command];
  if (!spec) {
    if (command === "help") {
      io.stdout(helpText(argv[commandIndex + 1]));
      return ExitCode.OK;
    }
    return bootstrap.error(command, new AssetdError("USAGE_ERROR", `Unknown command "${command}". Run \`assetd --help\`.`));
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTIONS, ...spec.options }, allowPositionals: true, strict: true });
  } catch (err) {
    return bootstrap.error(command, new AssetdError("USAGE_ERROR", `${(err as Error).message}\nUsage: ${spec.usage}`));
  }
  const v = parsed.values as Record<string, string | boolean | undefined>;
  const out = new Output(io, { json: v.json === true, quiet: v.quiet === true, project: v.project as string | undefined });
  if (v.help) {
    io.stdout(helpText(command));
    return ExitCode.OK;
  }
  const positionals = parsed.positionals;
  const requireOne = (what: string): string => {
    if (positionals.length !== 1) throw new AssetdError("USAGE_ERROR", `Expected exactly one ${what}.\nUsage: ${spec.usage}`);
    return positionals[0]!;
  };

  try {
    switch (command) {
      case "index":
      case "ensure-index":
        if (command === "ensure-index" && positionals.length > 0) throw new AssetdError("USAGE_ERROR", `ensure-index takes no directories.\nUsage: ${spec.usage}`);
        return await (await import("./commands/index-command.ts")).indexCommand(out, { targets: positionals, retryFailed: v["retry-failed"] === true, strict: v.strict === true });
      case "search":
        if (positionals.length === 0) throw new AssetdError("USAGE_ERROR", `Missing query.\nUsage: ${spec.usage}`);
        return await (await import("./commands/search-command.ts")).searchCommand(out, {
          query: positionals.join(" "),
          kind: kindOption(v.type),
          limit: intOption(v.limit, "limit", 10, 1, 1000),
          within: v.in as string | undefined,
        });
      case "similar":
        return await (await import("./commands/similar-command.ts")).similarCommand(out, {
          path: requireOne("path"),
          kind: kindOption(v.type),
          limit: intOption(v.limit, "limit", 10, 1, 1000),
          within: v.in as string | undefined,
        });
      case "inspect":
        return await (await import("./commands/inspect-command.ts")).inspectCommand(out, { path: requireOne("path") });
      case "status":
        if (positionals.length > 0) throw new AssetdError("USAGE_ERROR", `status takes no arguments.\nUsage: ${spec.usage}`);
        return await (await import("./commands/status-command.ts")).statusCommand(out, { checkStale: v["no-stale-check"] !== true });
      case "contact-sheet":
        return await (await import("./commands/contact-sheet-command.ts")).contactSheetCommand(out, {
          paths: positionals,
          search: v.search as string | undefined,
          limit: intOption(v.limit, "limit", 20, 1, 100),
          out: v.out as string | undefined,
          columns: v.columns === undefined ? undefined : intOption(v.columns, "columns", 4, 1, 20),
          thumbSize: intOption(v["thumb-size"], "thumb-size", 192, 48, 512),
        });
      case "models":
        return await (await import("./commands/models-command.ts")).modelsCommand(out, { action: requireOne("action (status or pull)") });
      default:
        throw new AssetdError("USAGE_ERROR", `Unknown command "${command}"`);
    }
  } catch (err) {
    return out.error(command, err);
  }
}
