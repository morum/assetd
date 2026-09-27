import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** SHA-256 of the file contents, streamed. */
export async function hashFile(nativePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(nativePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function hashBuffer(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

async function withRetries<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts - 1 || !code || !RETRYABLE.has(code)) throw err;
      // Windows: antivirus/indexers briefly lock freshly written files.
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
}

/**
 * Writes via a temp file in the same directory, then renames. Retries the
 * rename on transient Windows lock errors, falling back to a copy.
 */
export async function writeFileAtomic(target: string, data: Uint8Array | string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  try {
    await withRetries(() => fs.rename(tmp, target));
  } catch {
    await withRetries(() => fs.copyFile(tmp, target));
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
