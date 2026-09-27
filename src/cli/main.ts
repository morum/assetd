#!/usr/bin/env node
import { processIO } from "./io.ts";
import { run } from "./run.ts";

// stdout is reserved for command results: route any library console output to stderr.
for (const method of ["log", "info", "warn", "debug"] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

run(process.argv.slice(2), processIO()).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
