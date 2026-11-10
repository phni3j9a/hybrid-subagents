import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RoleConfig, RoleName } from "./config.ts";
import { HyError, readJson, sleep, writeJsonAtomic } from "./util.ts";

/** One specialist started by one Main pane. Written only by the helper commands. */
export interface ChildRecord {
  name: string;
  role: RoleName;
  config: RoleConfig;
  paneId: string;
  tabId: string;
  cwd: string;
  createdAt: string;
  turn: number;
  brief: string;
  report: string;
  /** herdr's state_change_seq just before the current turn's prompt; later changes mean it ran. */
  promptSeq: number;
  /** Set when start stopped at an unrecognized dialog, so no prompt was sent. */
  blockedAtStart?: boolean;
}

/** Watcher bookkeeping for the current turn. Written only by the watcher. */
export interface WatchRecord {
  turn: number;
  /** Activity counts only after this state sequence: the prompt, a nudge or a fix request. */
  afterSeq: number;
  active: boolean;
  nudged: boolean;
  fixRequested: boolean;
  notified: boolean;
  blockedNotified: boolean;
  gone: boolean;
}

export interface MainRecord { mainPane: string; socketPath: string; createdAt: string }

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "hybrid-subagents");
}

/** Pane IDs are scoped to one herdr server, so the socket path is part of the key. */
export function mainDir(socketPath: string, mainPane: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash("sha256").update(`${socketPath}\0${mainPane}`).digest("hex").slice(0, 16);
  return path.join(stateRoot(env), key);
}

export const childDir = (dir: string, name: string) => path.join(dir, "children", name);
const childFile = (dir: string, name: string) => path.join(childDir(dir, name), "child.json");
const watchFile = (dir: string, name: string) => path.join(childDir(dir, name), "watch.json");

export function readMain(dir: string): MainRecord | undefined { return readJson<MainRecord>(path.join(dir, "main.json")); }
export function writeMain(dir: string, record: MainRecord): void { writeJsonAtomic(path.join(dir, "main.json"), record); }

export function listChildren(dir: string): ChildRecord[] {
  const root = path.join(dir, "children");
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().flatMap((name) => {
    const record = readJson<ChildRecord>(childFile(dir, name));
    return record ? [record] : [];
  });
}

export function readChild(dir: string, name: string): ChildRecord | undefined { return readJson<ChildRecord>(childFile(dir, name)); }
export function writeChild(dir: string, record: ChildRecord): void { writeJsonAtomic(childFile(dir, record.name), record); }
export function removeChild(dir: string, name: string): void { rmSync(childDir(dir, name), { recursive: true, force: true }); }

export function readWatch(dir: string, name: string): WatchRecord | undefined { return readJson<WatchRecord>(watchFile(dir, name)); }
export function writeWatch(dir: string, name: string, record: WatchRecord): void {
  if (existsSync(childDir(dir, name))) writeJsonAtomic(watchFile(dir, name), record);
}

/** Brief and report paths for a turn: brief.md/report.md first, then brief-2.md/report-2.md, … */
export function turnFiles(dir: string, name: string, role: RoleName, turn: number): { brief: string; report: string } {
  const suffix = turn > 1 ? `-${turn}` : "";
  return {
    brief: path.join(childDir(dir, name), `brief${suffix}.md`),
    report: path.join(childDir(dir, name), `report${suffix}.${role === "reviewer" ? "json" : "md"}`),
  };
}

/** Serializes helper commands of one Main; a lock older than staleMs is from a dead command. */
export async function withLock<T>(dir: string, fn: () => Promise<T>, staleMs = 180_000, waitMs = 120_000): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new HyError("busy", "Another Hybrid Subagents command is still running for this Main pane.");
      await sleep(100);
    }
  }
  try { return await fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
