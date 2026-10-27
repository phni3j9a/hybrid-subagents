import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { followUpBrief, initialBrief, promptLine } from "./brief.ts";
import {
  DEFAULT_ROLES, ROLE_NAMES, isRole, loadConfig, resetRoles, roleErrors, saveRole,
  type RoleConfig, type RoleName, type Scope,
} from "./config.ts";
import { dialogStep } from "./dialogs.ts";
import type { AgentInfo, Herdr } from "./herdr.ts";
import { planSplit, rebalance } from "./layout.ts";
import { checkReport } from "./report.ts";
import { EFFORTS, FAST_SUPPORTED, isRuntime, runtimeArgs } from "./runtimes.ts";
import {
  listChildren, mainDir, readChild, readMain, removeChild, turnFiles, withLock, writeChild, writeMain,
  type ChildRecord,
} from "./state.ts";
import { HyError, oneLine, sleep, writeFileAtomic } from "./util.ts";

export const START_TIMEOUT_MS = 90_000;
const ENTRY = fileURLToPath(new URL("../hyagents.ts", import.meta.url));

export interface Deps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  herdr: Herdr;
  /** Starts the watcher, or tells a running one to reload. */
  wakeWatcher: (dir: string) => void;
}

export interface MainContext { mainPane: string; socketPath: string; dir: string }

export function mainContext(env: NodeJS.ProcessEnv): MainContext {
  if (env.HYAGENTS_ROLE) throw new HyError("specialist", `This agent is the Hybrid Subagents ${env.HYAGENTS_ROLE}; specialists do not delegate.`);
  if (env.HERDR_ENV !== "1") throw new HyError("not_in_herdr", "Hybrid Subagents runs only inside a herdr pane (HERDR_ENV=1). Do the work directly.");
  if (!env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) throw new HyError("not_in_herdr", "HERDR_PANE_ID or HERDR_SOCKET_PATH is missing; start this agent inside herdr.");
  return { mainPane: env.HERDR_PANE_ID, socketPath: env.HERDR_SOCKET_PATH, dir: mainDir(env.HERDR_SOCKET_PATH, env.HERDR_PANE_ID, env) };
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const settled = (status: string | undefined) => status === "idle" || status === "done";
const tail = (text: string, lines = 12) => text.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join("\n");

function allocateName(role: RoleName, taken: Set<string>): string {
  for (let n = 1; ; n++) if (!taken.has(`${role}-${n}`)) return `${role}-${n}`;
}

/**
 * Accepts recognized startup dialogs until the agent is ready, or returns the
 * unrecognized screen. Works by pane, because a startup timeout can release the name.
 */
async function passStartupDialogs(herdr: Herdr, pane: string, runtime: RoleConfig["runtime"]):
  Promise<{ ok: true; agent: AgentInfo } | { ok: false; screen: string }> {
  let screen = "";
  for (let step = 0; step < 12; step++) {
    screen = await herdr.paneRead(pane).catch(() => "");
    const plan = dialogStep(runtime, screen);
    if (!plan) {
      const info = await herdr.agentGet(pane);
      return info && settled(info.agent_status) ? { ok: true, agent: info } : { ok: false, screen };
    }
    await herdr.paneSendKeys(pane, plan.keys);
    await sleep(500);
    const info = await herdr.agentWait(pane, ["idle", "done", "blocked"], 30_000).catch(() => undefined);
    if (info && settled(info.agent_status)) return { ok: true, agent: info };
  }
  return { ok: false, screen };
}

export interface StartOptions { role: string; task: string; name?: string; cwd?: string }

export async function start(deps: Deps, options: StartOptions) {
  const { env, herdr } = deps;
  if (!isRole(options.role)) throw new HyError("usage", `Unknown role "${options.role}". Use ${ROLE_NAMES.join(", ")}.`);
  const role = options.role;
  if (!options.task.trim()) throw new HyError("task_missing", "Pass the task on standard input.");
  if (options.name !== undefined && !NAME.test(options.name)) throw new HyError("usage", "--name must match [a-z][a-z0-9_-]{0,31}.");
  const cwd = path.resolve(options.cwd ?? deps.cwd);
  const roleConfig = loadConfig(cwd, env).roles[role];
  const invalid = roleErrors(role, roleConfig);
  if (invalid.length) throw new HyError("config_invalid", `${invalid.join(" ")} Fix it with the hyagents-models skill.`);
  const ctx = mainContext(env);

  // Reserve the name and pane under the lock; the slow agent start runs outside it.
  const record = await withLock(ctx.dir, async () => {
    if (!readMain(ctx.dir)) writeMain(ctx.dir, { mainPane: ctx.mainPane, socketPath: ctx.socketPath, createdAt: new Date().toISOString() });
    const existing = listChildren(ctx.dir);
    const taken = new Set([...existing.map((child) => child.name), ...(await herdr.agentList()).flatMap((agent) => agent.name ? [agent.name] : [])]);
    if (options.name && taken.has(options.name)) throw new HyError("name_taken", `An agent named ${options.name} already exists.`);
    const name = options.name ?? allocateName(role, taken);
    const root = await herdr.layoutExport(ctx.mainPane).then((layout) => layout.root, () => undefined);
    const plan = planSplit(root, ctx.mainPane, existing.map((child) => child.paneId));
    const pane = await herdr.paneSplit(plan.target, {
      direction: plan.direction, ratio: plan.ratio, cwd, env: { HYAGENTS_ROLE: role, HYAGENTS_MAIN: ctx.mainPane },
    });
    const files = turnFiles(ctx.dir, name, role, 1);
    const child: ChildRecord = {
      name, role, config: roleConfig, paneId: pane.pane_id, tabId: pane.tab_id, cwd, createdAt: new Date().toISOString(),
      turn: 1, brief: files.brief, report: files.report, promptSeq: 0, blockedAtStart: true,
    };
    writeChild(ctx.dir, child);
    writeFileAtomic(files.brief, initialBrief(name, role, options.task, files.report));
    await rebalance(herdr, ctx.mainPane, [...existing.map((item) => item.paneId), pane.pane_id]).catch(() => undefined);
    return child;
  });

  const { args, warnings } = runtimeArgs(roleConfig);
  let agent: AgentInfo;
  try {
    agent = await herdr.agentStart(record.name, roleConfig.runtime, record.paneId, args, START_TIMEOUT_MS);
  } catch (error) {
    const code = error instanceof HyError ? error.code : "";
    if (code !== "agent_not_ready" && code !== "timeout") {
      const screen = await herdr.paneRead(record.paneId).catch(() => "");
      await withLock(ctx.dir, async () => {
        removeChild(ctx.dir, record.name);
        await herdr.paneClose(record.paneId);
        await rebalance(herdr, ctx.mainPane, listChildren(ctx.dir).map((child) => child.paneId)).catch(() => undefined);
      });
      throw new HyError("start_failed", `${roleConfig.runtime} did not start: ${error instanceof Error ? error.message : String(error)}`, { screen: tail(screen) });
    }
    const passed = await passStartupDialogs(herdr, record.paneId, roleConfig.runtime);
    if (!passed.ok) {
      deps.wakeWatcher(ctx.dir);
      throw new HyError("startup_blocked",
        `${record.name} (${roleConfig.runtime}) is waiting at a screen Hybrid Subagents does not recognize. Ask the user to handle it in that pane, then run "hyagents send ${record.name}" to deliver the task, or close it.`,
        { name: record.name, pane: record.paneId, screen: tail(passed.screen) });
    }
    agent = passed.agent;
    if (agent.name !== record.name) await herdr.agentRename(record.paneId, record.name).catch(() => undefined);
  }
  await prompt(deps, ctx, record, agent);
  return {
    name: record.name, role, runtime: roleConfig.runtime, model: roleConfig.model, effort: roleConfig.effort, fast: roleConfig.fast,
    pane: record.paneId, report: record.report, warnings,
  };
}

/** Records the turn being attempted, then submits its one-line prompt. */
async function prompt(deps: Deps, ctx: MainContext, record: ChildRecord, fallback: AgentInfo): Promise<void> {
  const current = await deps.herdr.agentGet(record.paneId) ?? fallback;
  record.promptSeq = current.state_change_seq ?? 0;
  record.blockedAtStart = false;
  writeChild(ctx.dir, record);
  await deps.herdr.agentPrompt(record.paneId, promptLine(record.brief, record.report));
  deps.wakeWatcher(ctx.dir);
}

export async function send(deps: Deps, name: string, message: string) {
  const ctx = mainContext(deps.env);
  // The name becomes a path; keep it inside this Main's state directory.
  if (!NAME.test(name) || !existsSync(ctx.dir)) throw new HyError("unknown_child", `No specialist named ${name} belongs to this Main pane.`);
  // Serialized, so concurrent follow-ups get separate turns instead of overwriting one brief.
  return withLock(ctx.dir, () => sendLocked(deps, ctx, name, message));
}

async function sendLocked(deps: Deps, ctx: MainContext, name: string, message: string) {
  const record = readChild(ctx.dir, name);
  if (!record) throw new HyError("unknown_child", `No specialist named ${name} belongs to this Main pane.`);
  const info = await deps.herdr.agentGet(record.paneId);
  if (!info) throw new HyError("child_gone", `${name} is no longer running. Close it and start a new specialist.`);
  if (!settled(info.agent_status)) throw new HyError("busy", `${name} is ${info.agent_status}. Wait for its notice before following up.`);
  if (record.blockedAtStart) {
    if (message.trim()) writeFileAtomic(record.brief, `${readFileSync(record.brief, "utf8")}\n## Additional note from Main\n\n${message.trim()}\n`);
  } else {
    if (!message.trim()) throw new HyError("task_missing", "Pass the follow-up message on standard input.");
    record.turn += 1;
    Object.assign(record, turnFiles(ctx.dir, name, record.role, record.turn));
    writeFileAtomic(record.brief, followUpBrief(name, record.role, record.turn, message, record.report));
  }
  await prompt(deps, ctx, record, info);
  return { name, turn: record.turn, report: record.report };
}

const pidFile = (dir: string) => path.join(dir, "watcher.pid");

export function readPid(dir: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile(dir), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch { return undefined; }
}

/** Claims the watcher slot for this process; false when another live watcher holds it. */
export function claimWatcher(dir: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(pidFile(dir), String(process.pid), { flag: "wx" }); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readPid(dir)) return false;
      rmSync(pidFile(dir), { force: true });
    }
  }
  return false;
}

export function releaseWatcher(dir: string): void {
  try { if (readFileSync(pidFile(dir), "utf8").trim() === String(process.pid)) rmSync(pidFile(dir), { force: true }); }
  catch { /* already removed */ }
}

/** Detached, so it outlives the shell call that started it. */
export function wakeWatcher(dir: string): void {
  if (!existsSync(dir)) return;
  const pid = readPid(dir);
  if (pid) { process.kill(pid, "SIGHUP"); return; }
  const log = openSync(path.join(dir, "watcher.log"), "a");
  spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY, "watch", "--dir", dir], {
    detached: true, stdio: ["ignore", log, log], env: process.env,
  }).unref();
  closeSync(log);
}

export async function close(deps: Deps, target: { name?: string; all?: boolean }) {
  const ctx = mainContext(deps.env);
  if (!existsSync(ctx.dir)) {
    if (target.all) return { closed: [] as string[] };
    throw new HyError("unknown_child", `No specialist named ${target.name} belongs to this Main pane.`);
  }
  return withLock(ctx.dir, async () => {
    const children = listChildren(ctx.dir);
    const chosen = target.all ? children : children.filter((child) => child.name === target.name);
    if (!target.all && !chosen.length) throw new HyError("unknown_child", `No specialist named ${target.name} belongs to this Main pane.`);
    if (target.all) {
      const pid = readPid(ctx.dir);
      if (pid) process.kill(pid, "SIGTERM");
    }
    // Remove the record before the pane, so the watcher does not report the closure as an exit.
    for (const child of chosen) { removeChild(ctx.dir, child.name); await deps.herdr.paneClose(child.paneId); }
    if (target.all) rmSync(ctx.dir, { recursive: true, force: true });
    else {
      await rebalance(deps.herdr, ctx.mainPane, listChildren(ctx.dir).map((child) => child.paneId)).catch(() => undefined);
      deps.wakeWatcher(ctx.dir);
    }
    return { closed: chosen.map((child) => child.name) };
  });
}

export async function list(deps: Deps) {
  const ctx = mainContext(deps.env);
  const children = await Promise.all(listChildren(ctx.dir).map(async (child) => {
    const info = await deps.herdr.agentGet(child.paneId).catch(() => undefined);
    return {
      name: child.name, role: child.role, runtime: child.config.runtime, model: child.config.model,
      pane: child.paneId, status: info?.agent_status ?? "gone", turn: child.turn,
      report: child.report, reportStatus: checkReport(child.role, child.report).status,
    };
  }));
  return { main: ctx.mainPane, children };
}

export function configShow(cwd: string, env: NodeJS.ProcessEnv) {
  const config = loadConfig(cwd, env);
  const roles = Object.fromEntries(ROLE_NAMES.map((name) => [name, { ...config.roles[name], sources: config.sources[name] }]));
  return { roles, files: config.files, efforts: EFFORTS, fastSupported: FAST_SUPPORTED, errors: config.errors, warnings: config.warnings };
}

export interface ConfigSetOptions { runtime?: string; model?: string; effort?: string; fast?: string; args?: string; scope?: string }

function parseScope(scope: string | undefined): Scope {
  if (scope !== "user" && scope !== "project") throw new HyError("usage", "--scope must be user or project.");
  return scope;
}

/** Starts from the effective role and saves it whole, like Pi's model picker. */
export function configSet(cwd: string, env: NodeJS.ProcessEnv, name: string, options: ConfigSetOptions) {
  if (!isRole(name)) throw new HyError("usage", `Unknown role "${name}". Use ${ROLE_NAMES.join(", ")}.`);
  const scope = parseScope(options.scope);
  const role: RoleConfig = { ...loadConfig(cwd, env).roles[name] };
  if (options.runtime !== undefined) {
    if (!isRuntime(options.runtime)) throw new HyError("usage", "--runtime must be claude, codex or copilot.");
    role.runtime = options.runtime;
  }
  if (options.model !== undefined) role.model = options.model;
  if (options.effort !== undefined) role.effort = options.effort === "default" ? null : options.effort;
  if (options.fast !== undefined) {
    if (options.fast !== "on" && options.fast !== "off") throw new HyError("usage", "--fast must be on or off.");
    role.fast = options.fast === "on";
  }
  if (options.args !== undefined) {
    try { role.args = JSON.parse(options.args); } catch { throw new HyError("usage", "--args must be a JSON array of strings."); }
  }
  if (!FAST_SUPPORTED[role.runtime]) role.fast = false;
  const file = saveRole(cwd, scope, name, role, env);
  const effective = loadConfig(cwd, env);
  const shadowedByProject = scope === "user" && Object.values(effective.sources[name]).includes("project");
  return { role: name, saved: role, file, effective: effective.roles[name], shadowedByProject };
}

export function configReset(cwd: string, env: NodeJS.ProcessEnv, options: { scope?: string; role?: string }) {
  const scope = parseScope(options.scope);
  if (options.role !== undefined && !isRole(options.role)) throw new HyError("usage", `Unknown role "${options.role}".`);
  const names = options.role ? [options.role as RoleName] : ROLE_NAMES;
  const file = resetRoles(cwd, scope, names, env);
  return { reset: names, file, defaults: Object.fromEntries(names.map((name) => [name, DEFAULT_ROLES[name]])) };
}

function commandVersion(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 15_000 }, (error, stdout) => resolve(error ? undefined : oneLine(stdout, 120) || undefined));
  });
}

export async function doctor(deps: Deps) {
  const { env, herdr } = deps;
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const [major, minor] = process.versions.node.split(".").map(Number);
  add("node", major > 22 || (major === 22 && minor >= 19), `Node.js ${process.versions.node} (22.19 or later required)`);
  add("herdr pane", env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH,
    env.HERDR_ENV === "1" ? `pane ${env.HERDR_PANE_ID ?? "?"}` : "not inside herdr (HERDR_ENV is not 1)");
  if (env.HYAGENTS_ROLE) add("role", false, `this agent is the ${env.HYAGENTS_ROLE} specialist; specialists do not delegate`);
  const version = await herdr.version().catch(() => undefined);
  add("herdr", !!version, version ?? "herdr is not on PATH");
  let config;
  try {
    config = loadConfig(deps.cwd, env);
    add("config", !config.errors.length, config.errors.join(" ") || `valid (${[config.files.user, config.files.project].filter(Boolean).join(", ")})`);
  } catch (error) { add("config", false, error instanceof Error ? error.message : String(error)); }
  if (config) {
    const roles = config.roles;
    for (const runtime of new Set(ROLE_NAMES.map((name) => roles[name].runtime))) {
      const users = ROLE_NAMES.filter((name) => roles[name].runtime === runtime).join(", ");
      const found = await commandVersion(runtime);
      add(runtime, !!found, found ? `${found} (${users})` : `${runtime} is not on PATH but is used by ${users}`);
    }
    for (const warning of config.warnings) add("config warning", true, warning);
    if (process.getuid?.() === 0 && ROLE_NAMES.some((name) => roles[name].runtime === "claude")) {
      add("claude as root", false, "Claude Code refuses --dangerously-skip-permissions as root; run herdr as a normal user.");
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}
