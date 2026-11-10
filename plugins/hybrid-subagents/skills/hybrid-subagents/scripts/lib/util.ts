import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export class HyError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function readJson<T = unknown>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  try { return JSON.parse(text) as T; }
  catch (error) { throw new HyError("invalid_json", `${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Replace the file in one rename so readers never see a partial write. */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

// herdr rejects control characters in arguments and prompts.
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function hasControlChars(text: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(text);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
