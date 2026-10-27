import { execFile } from "node:child_process";
import net from "node:net";
import { HyError } from "./util.ts";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent_status: AgentStatus;
  name?: string;
  agent?: string;
  state_change_seq?: number;
  interactive_ready?: boolean;
  cwd?: string;
}

export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent_status: AgentStatus;
  agent?: string;
  cwd?: string;
}

export type LayoutNode =
  | { type: "pane"; pane_id?: string }
  | { type: "split"; direction: "right" | "down"; ratio: number; first: LayoutNode; second: LayoutNode };

export interface LayoutDescription { workspace_id: string; tab_id: string; root: LayoutNode }

export interface HerdrEvent { event: string; data: Record<string, unknown> }

export type Subscription =
  | { type: "pane.agent_status_changed"; pane_id: string }
  | { type: "pane.closed" }
  | { type: "pane.exited" };

export interface SplitOptions { direction: "right" | "down"; ratio?: number; cwd: string; env: Record<string, string> }

/** The herdr operations Hybrid Subagents uses. Tests substitute an in-memory fake. */
export interface Herdr {
  paneSplit(target: string, options: SplitOptions): Promise<PaneInfo>;
  paneGet(pane: string): Promise<PaneInfo | undefined>;
  paneClose(pane: string): Promise<void>;
  paneRead(pane: string, lines?: number): Promise<string>;
  paneSendKeys(pane: string, keys: string[]): Promise<void>;
  agentStart(name: string, kind: string, pane: string, args: string[], timeoutMs: number): Promise<AgentInfo>;
  agentGet(target: string): Promise<AgentInfo | undefined>;
  agentList(): Promise<AgentInfo[]>;
  agentPrompt(target: string, text: string): Promise<AgentInfo>;
  agentRename(target: string, name: string): Promise<void>;
  agentWait(target: string, until: AgentStatus[], timeoutMs: number): Promise<AgentInfo | undefined>;
  layoutExport(pane: string): Promise<LayoutDescription>;
  layoutSetSplitRatio(tab: string, path: boolean[], ratio: number): Promise<void>;
  subscribe(subscriptions: Subscription[], onEvent: (event: HerdrEvent) => void, onClose: (error?: Error) => void): Promise<{ close(): void }>;
  notify(title: string, body: string): Promise<void>;
  version(): Promise<string>;
}

export class HerdrError extends HyError {}

const NOT_FOUND = /not_found|no_such|unknown_(pane|agent|target)/;

export function isNotFound(error: unknown): boolean {
  return error instanceof HerdrError && NOT_FOUND.test(error.code);
}

function parseLine(text: string): Record<string, any> | undefined {
  const line = text.split("\n").find((entry) => entry.trim().startsWith("{"));
  if (!line) return undefined;
  try { return JSON.parse(line); } catch { return undefined; }
}

function errorFrom(response: Record<string, any> | undefined, fallback: string): HerdrError {
  const error = response?.error;
  return new HerdrError(typeof error?.code === "string" ? error.code : "herdr_failed",
    typeof error?.message === "string" ? error.message : fallback.trim() || "herdr command failed");
}

/** herdr through its CLI for control commands and its socket for layout and events. */
export class HerdrCli implements Herdr {
  bin: string;
  socketPath: string | undefined;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.bin = env.HYAGENTS_HERDR_BIN || "herdr";
    this.socketPath = env.HERDR_SOCKET_PATH;
  }

  run(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new HerdrError(error.code === "ENOENT" ? "herdr_missing" : "herdr_failed",
            error.code === "ENOENT" ? "herdr is not on PATH." : error.message));
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      });
    });
  }

  async json(args: string[], timeoutMs?: number): Promise<Record<string, any>> {
    const { code, stdout, stderr } = await this.run(args, timeoutMs);
    if (code !== 0) throw errorFrom(parseLine(stderr) ?? parseLine(stdout), stderr || stdout);
    const response = parseLine(stdout);
    if (!response || response.error) throw errorFrom(response, stdout);
    return response.result ?? {};
  }

  async text(args: string[]): Promise<string> {
    const { code, stdout, stderr } = await this.run(args);
    if (code !== 0) throw errorFrom(parseLine(stderr), stderr);
    return stdout;
  }

  async paneSplit(target: string, options: SplitOptions): Promise<PaneInfo> {
    const args = ["pane", "split", target, "--direction", options.direction, "--cwd", options.cwd, "--no-focus"];
    if (options.ratio !== undefined) args.push("--ratio", String(options.ratio));
    for (const [key, value] of Object.entries(options.env)) args.push("--env", `${key}=${value}`);
    return (await this.json(args)).pane;
  }

  async paneGet(pane: string): Promise<PaneInfo | undefined> {
    try { return (await this.json(["pane", "get", pane])).pane; }
    catch (error) { if (isNotFound(error)) return undefined; throw error; }
  }

  async paneClose(pane: string): Promise<void> {
    try { await this.json(["pane", "close", pane]); }
    catch (error) { if (!isNotFound(error)) throw error; }
  }

  paneRead(pane: string, lines = 60): Promise<string> {
    return this.text(["pane", "read", pane, "--source", "visible", "--lines", String(lines)]);
  }

  async paneSendKeys(pane: string, keys: string[]): Promise<void> {
    await this.json(["pane", "send-keys", pane, ...keys]);
  }

  async agentStart(name: string, kind: string, pane: string, args: string[], timeoutMs: number): Promise<AgentInfo> {
    const result = await this.json(["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", String(timeoutMs), "--", ...args], timeoutMs + 15_000);
    return result.agent;
  }

  async agentGet(target: string): Promise<AgentInfo | undefined> {
    try { return (await this.json(["agent", "get", target])).agent; }
    catch (error) { if (isNotFound(error)) return undefined; throw error; }
  }

  async agentList(): Promise<AgentInfo[]> {
    return (await this.json(["agent", "list"])).agents ?? [];
  }

  async agentPrompt(target: string, text: string): Promise<AgentInfo> {
    return (await this.json(["agent", "prompt", target, text])).agent;
  }

  async agentRename(target: string, name: string): Promise<void> {
    await this.json(["agent", "rename", target, name]);
  }

  async agentWait(target: string, until: AgentStatus[], timeoutMs: number): Promise<AgentInfo | undefined> {
    const result = await this.json(["agent", "wait", target, ...until.flatMap((state) => ["--until", state]), "--timeout", String(timeoutMs)], timeoutMs + 5_000);
    return result.agent;
  }

  async layoutExport(pane: string): Promise<LayoutDescription> {
    return (await this.request("layout.export", { pane_id: pane })).layout;
  }

  async layoutSetSplitRatio(tab: string, path: boolean[], ratio: number): Promise<void> {
    await this.request("layout.set_split_ratio", { tab_id: tab, path, ratio });
  }

  async notify(title: string, body: string): Promise<void> {
    await this.json(["notification", "show", title, "--body", body, "--sound", "request"]);
  }

  async version(): Promise<string> {
    return (await this.text(["--version"])).trim();
  }

  socket(): string {
    if (!this.socketPath) throw new HerdrError("herdr_socket_missing", "HERDR_SOCKET_PATH is not set; run inside a herdr pane.");
    return this.socketPath;
  }

  /** One newline-delimited JSON request per connection, as herdr's own client does. */
  request(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socket());
      let buffer = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new HerdrError("timeout", `${method} timed out`)); }, timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ id: `hyagents:${method}`, method, params })}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        clearTimeout(timer);
        socket.end();
        const response = (() => { try { return JSON.parse(buffer.slice(0, end)); } catch { return undefined; } })();
        if (!response || response.error) reject(errorFrom(response, `invalid ${method} response`));
        else resolve(response.result ?? {});
      });
      socket.on("error", (error) => { clearTimeout(timer); reject(new HerdrError("herdr_socket_failed", error.message)); });
    });
  }

  subscribe(subscriptions: Subscription[], onEvent: (event: HerdrEvent) => void, onClose: (error?: Error) => void): Promise<{ close(): void }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socket());
      let buffer = "";
      let started = false;
      let closed = false;
      const finish = (error?: Error) => {
        if (closed) return;
        closed = true;
        socket.destroy();
        if (started) onClose(error); else reject(error ?? new HerdrError("herdr_socket_closed", "subscription closed before it started"));
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ id: "hyagents:events", method: "events.subscribe", params: { subscriptions } })}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          let message: Record<string, any>;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.error) { finish(errorFrom(message, "subscription failed")); return; }
          if (!started) {
            started = true;
            resolve({ close: () => { closed = true; socket.destroy(); } });
            continue;
          }
          if (typeof message.event === "string") onEvent({ event: message.event, data: message.data ?? {} });
        }
      });
      socket.on("error", (error) => finish(new HerdrError("herdr_socket_failed", error.message)));
      socket.on("close", () => finish());
    });
  }
}
