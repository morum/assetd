/**
 * Stable, documented exit codes. Changing the meaning of an existing code is a
 * breaking change; new codes may be appended. See docs/cli-contract.md.
 */
export const ExitCode = {
  OK: 0,
  INTERNAL_ERROR: 1,
  USAGE_ERROR: 2,
  INDEX_NOT_FOUND: 3,
  PATH_NOT_FOUND: 4,
  NOT_INDEXED: 5,
  MODEL_UNAVAILABLE: 6,
  PARTIAL_FAILURE: 7,
  INDEX_BUSY: 8,
  INDEX_INCOMPATIBLE: 9,
  INTERRUPTED: 130,
} as const;

export type ExitCodeName = keyof typeof ExitCode;

export class AssetdError extends Error {
  readonly code: ExitCodeName;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ExitCodeName, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssetdError";
    this.code = code;
    this.details = details;
  }

  get exitCode(): number {
    return ExitCode[this.code];
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
