import { AssetdError, ExitCode } from "../core/errors.ts";
import { JSON_SCHEMA_VERSION, type ErrorOutput } from "../contracts/json.ts";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stderrIsTTY: boolean;
}

export function processIO(): CliIO {
  return {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    cwd: process.cwd(),
    env: process.env,
    stderrIsTTY: process.stderr.isTTY === true,
  };
}

export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  project: string | undefined;
}

/** Output helper: JSON documents to stdout; diagnostics to stderr, never colored. */
export class Output {
  readonly io: CliIO;
  readonly flags: GlobalFlags;

  constructor(io: CliIO, flags: GlobalFlags) {
    this.io = io;
    this.flags = flags;
  }

  get json(): boolean {
    return this.flags.json;
  }

  /** Writes the command result: JSON document or human text. */
  result(document: unknown, human: () => string): void {
    if (this.flags.json) this.io.stdout(JSON.stringify(document, null, 2) + "\n");
    else {
      const text = human();
      if (text) this.io.stdout(text.endsWith("\n") ? text : text + "\n");
    }
  }

  /** Diagnostics (stderr). Suppressed by --quiet. */
  info(message: string): void {
    if (!this.flags.quiet) this.io.stderr(message + "\n");
  }

  warn(message: string): void {
    this.io.stderr(`warning: ${message}\n`);
  }

  /** Transient progress line; only on an interactive stderr. */
  progress(message: string): void {
    if (this.flags.quiet || !this.io.stderrIsTTY) return;
    const width = 100;
    const line = message.length > width ? "…" + message.slice(message.length - width + 1) : message;
    this.io.stderr(`\r${line.padEnd(width)}\r`);
  }

  clearProgress(): void {
    if (this.flags.quiet || !this.io.stderrIsTTY) return;
    this.io.stderr(`\r${" ".repeat(100)}\r`);
  }

  /** Reports an error and returns the exit code. */
  error(command: string, err: unknown): number {
    const e =
      err instanceof AssetdError
        ? err
        : new AssetdError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err), undefined, { cause: err });
    this.clearProgress();
    this.io.stderr(`error: ${e.message}\n`);
    if (e.code === "INTERNAL_ERROR" && err instanceof Error && err.stack && this.io.env.ASSETD_DEBUG) this.io.stderr(err.stack + "\n");
    if (this.flags.json) {
      const doc: ErrorOutput = {
        schemaVersion: JSON_SCHEMA_VERSION,
        command,
        error: { code: e.code, exitCode: ExitCode[e.code], message: e.message, ...(e.details ? { details: e.details } : {}) },
      };
      this.io.stdout(JSON.stringify(doc, null, 2) + "\n");
    }
    return ExitCode[e.code];
  }
}
