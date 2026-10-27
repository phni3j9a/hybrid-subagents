import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { readPid, wakeWatcher } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/commands.ts";
import { DEFAULT_ROLES, ROLE_NAMES } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/config.ts";
import { writeChild, writeMain } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/state.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const plugin = path.join(root, "plugins", "hybrid-subagents");
const entry = path.join(plugin, "skills", "hyagents", "scripts", "hyagents.ts");
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const fixture = mkdtempSync(path.join(tmpdir(), "hyagents-plugin-package-"));
after(() => rmSync(fixture, { recursive: true, force: true }));

test("Claude Code, Codex and Copilot manifests and marketplaces describe the same plugin", () => {
  const portable = json("plugins/hybrid-subagents/plugin.json");
  const claude = json("plugins/hybrid-subagents/.claude-plugin/plugin.json");
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(portable.name, /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/);
  for (const key of ["name", "version", "description", "license", "repository"]) assert.equal(claude[key], portable[key], key);
  const marketplaces = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", ".github/plugin/marketplace.json"].map(json);
  for (const marketplace of marketplaces) {
    assert.equal(marketplace.name, "hybrid-subagents");
    const [entry] = marketplace.plugins;
    assert.equal(entry.name, portable.name);
    const source = typeof entry.source === "string" ? entry.source : entry.source.path;
    assert.equal(path.resolve(root, source), plugin);
    if (entry.version) assert.equal(entry.version, portable.version);
  }
  const codex = marketplaces[1].plugins[0];
  assert.deepEqual([codex.policy.installation, codex.category], ["AVAILABLE", "Productivity"]);
});

test("skills, roles and the review schema ship inside the plugin; the Pi npm package excludes them", () => {
  for (const name of readdirSync(path.join(plugin, "skills"))) {
    const text = readFileSync(path.join(plugin, "skills", name, "SKILL.md"), "utf8");
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: [^\\n"]+\\n`), `${name} frontmatter`);
  }
  for (const role of ROLE_NAMES) assert.ok(existsSync(path.join(plugin, "skills", "hyagents", "roles", `${role}.md`)), role);
  assert.ok(existsSync(path.join(plugin, "skills", "hyagents", "schemas", "review.schema.json")));
  assert.equal(json("package.json").files.includes("plugins"), false);
});

function run(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ code: number; result: Record<string, any> }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [entry, ...args], { env: { PATH: process.env.PATH, HOME: fixture, ...options.env } }, (error, stdout) => {
      resolve({ code: error ? Number(error.code) : 0, result: JSON.parse(stdout) });
    });
    child.stdin!.end(options.input ?? "");
  });
}

test("the helper prints JSON results and errors with matching exit codes", async () => {
  const config = { XDG_CONFIG_HOME: path.join(fixture, "config") };
  const shown = await run(["config", "show"], { env: config });
  assert.equal(shown.code, 0);
  assert.equal(shown.result.ok, true);
  assert.equal(shown.result.roles.worker.model, "gpt-6-luna");
  const saved = await run(["config", "set", "scout", "--runtime=claude", "--model", "claude-sonnet-5", "--effort", "medium", "--scope", "user"], { env: config });
  assert.equal(saved.result.effective.runtime, "claude");
  const outside = await run(["start", "--role", "worker"], { input: "Fix it." });
  assert.deepEqual([outside.code, outside.result.ok, outside.result.error], [1, false, "not_in_herdr"]);
  const unknown = await run(["frobnicate"]);
  assert.deepEqual([unknown.code, unknown.result.error], [1, "usage"]);
  const help = await run([]);
  assert.match(help.result.usage, /start --role <worker\|scout\|reviewer\|designer>/);
});

test("a second watcher hands over to the live one instead of running twice", async () => {
  const dir = path.join(fixture, "main");
  mkdirSync(dir, { recursive: true });
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  writeFileSync(path.join(dir, "watcher.pid"), String(live.pid));
  const exited = new Promise<NodeJS.Signals | null>((resolve) => live.on("exit", (_code, signal) => resolve(signal)));
  const second = await new Promise<number>((resolve) => {
    execFile(process.execPath, [entry, "watch", "--dir", dir], { env: { PATH: process.env.PATH, HOME: fixture } }, (error) => resolve(error ? Number(error.code) : 0));
  });
  assert.equal(second, 0);
  assert.equal(await exited, "SIGHUP", "the live watcher is asked to reload");
  assert.equal(readFileSync(path.join(dir, "watcher.pid"), "utf8"), String(live.pid));
});

test("wakeWatcher starts a detached watcher that subscribes through herdr's socket", async () => {
  const dir = path.join(fixture, "detached");
  const socketPath = path.join(fixture, "detached.sock");
  const bin = path.join(fixture, "herdr-detached");
  writeFileSync(bin, `#!/usr/bin/env node
const [group, verb, target] = process.argv.slice(2);
const info = { pane_id: target, tab_id: "w1:t1", workspace_id: "w1", agent_status: "working", agent: "codex", state_change_seq: 1 };
console.log(JSON.stringify({ id: "cli", result: group === "pane" ? { pane: info } : { agent: info } }));
`);
  chmodSync(bin, 0o755);
  writeMain(dir, { mainPane: "w1:p1", socketPath, createdAt: new Date().toISOString() });
  writeChild(dir, {
    name: "worker-1", role: "worker", config: DEFAULT_ROLES.worker, paneId: "w1:p2", tabId: "w1:t1", cwd: "/repo",
    createdAt: new Date().toISOString(), turn: 1, brief: path.join(dir, "brief.md"), report: path.join(dir, "report.md"), promptSeq: 1,
  });
  const subscribed = new Promise<Record<string, any>>((resolve) => {
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString().split("\n")[0]);
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        server.close();
        resolve(request);
      });
    });
    server.listen(socketPath);
  });
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_SOCKET_PATH: socketPath, HYAGENTS_HERDR_BIN: bin });
  try { wakeWatcher(dir); } finally { process.env = saved; }
  const request = await subscribed;
  assert.equal(request.method, "events.subscribe");
  assert.deepEqual(request.params.subscriptions, [
    { type: "pane.agent_status_changed", pane_id: "w1:p1" },
    { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    { type: "pane.closed" },
    { type: "pane.exited" },
  ]);
  let pid: number | undefined;
  for (let i = 0; i < 50 && !pid; i++) { pid = readPid(dir); await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.ok(pid, "the watcher records its pid");
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && readPid(dir); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(readPid(dir), undefined, "the watcher releases its slot when stopped");
  assert.match(readFileSync(path.join(dir, "watcher.log"), "utf8"), /stop: terminated/);
});
