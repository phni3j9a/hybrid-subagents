import { accessSync, chmodSync, constants, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { modelSpec, parseSelection, supportsFast, type ModelSelection, type RoleName } from "./models.ts";

export type SettingsScope = "user" | "project";

// Internal modules of the bundled pi-subagents (exact version, so the paths are fixed): the same code the loaded subagent tool runs.
const piSubagentsRoot = new URL("../", import.meta.resolve("pi-subagents/agents"));
function internal<T>(file: string): Promise<T> {
  return import(new URL(`src/${file}.js`, piSubagentsRoot).href);
}

// Use the bundled runtime's locked, atomic settings merge and project-root resolver.
type NativeSettings = Pick<typeof import("../node_modules/pi-subagents/src/agents/agents.js"), "mergeBuiltinAgentOverride" | "findConfiguredProjectRoot" | "discoverAgents">;
let nativeSettings: Promise<NativeSettings> | undefined;
function native(): Promise<NativeSettings> {
  return nativeSettings ??= internal("agents/agents");
}

async function prepareScope(cwd: string, scope: SettingsScope): Promise<NativeSettings> {
  const api = await native();
  if (scope === "project" && !api.findConfiguredProjectRoot(cwd)) mkdirSync(path.join(cwd, CONFIG_DIR_NAME), { recursive: true });
  if (scope === "project" && !api.findConfiguredProjectRoot(cwd)) throw new Error("Hybrid Subagents: project settings are not available here. No project config root was found.");
  return api;
}

// Backups live in our own hyagents.json: pi-subagents 0.85+ rejects unknown agentOverrides fields such as backupModel.
// Same lease and project-root resolution as pi-subagents.
function shared<T>(name: string): Promise<T> {
  return internal(`shared/${name}`);
}

async function backupFile(cwd: string, scope: SettingsScope): Promise<string | undefined> {
  const utils = await shared<typeof import("../node_modules/pi-subagents/src/shared/utils.js")>("utils");
  if (scope === "user") return path.join(utils.getAgentDir(), "hyagents.json");
  const root = (await native()).findConfiguredProjectRoot(cwd);
  return root ? path.join(utils.getProjectConfigDir(root), "hyagents.json") : undefined;
}

export async function saveBackup(cwd: string, name: RoleName, selection: ModelSelection | undefined, scope: SettingsScope): Promise<string> {
  await prepareScope(cwd, scope);
  const lease = await shared<typeof import("../node_modules/pi-subagents/src/shared/settings-file-lease.js")>("settings-file-lease");
  const file = (await backupFile(cwd, scope))!;
  return lease.withSettingsFileLease(file, () => {
    const target = lease.resolveSettingsWriteTarget(file);
    let settings: Record<string, unknown> = {};
    let mode: number | undefined;
    try {
      const raw = readFileSync(target, "utf8");
      try { settings = JSON.parse(raw); } catch (error) { throw new Error(`Failed to parse settings file '${file}': ${String(error)}`); }
      mode = statSync(target).mode & 0o7777;
      accessSync(target, constants.W_OK);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const object = (value: unknown, label: string): Record<string, unknown> => {
      if (value === undefined) return {};
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Settings ${label} must be an object.`);
      return value as Record<string, unknown>;
    };
    settings = object(settings, "root");
    const backups = { ...object(settings.backupModels, "backupModels") };
    if (!selection && !(name in backups)) return file;
    if (selection) backups[name] = modelSpec(selection); else delete backups[name];
    settings.backupModels = backups;
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", ...(mode === undefined ? {} : { mode: mode | 0o200 }) });
      if (mode !== undefined) chmodSync(temp, mode);
      renameSync(temp, target);
    } finally { rmSync(temp, { force: true }); }
    return file;
  });
}

/** Read from the files saveBackup writes, fresh each time; a trusted project entry wins over the user entry. */
export async function configuredBackup(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, name: RoleName): Promise<ModelSelection | undefined> {
  let value: unknown;
  for (const scope of ctx.isProjectTrusted() ? ["user", "project"] as const : ["user"] as const) {
    const file = await backupFile(ctx.cwd, scope);
    let raw: string;
    try { raw = file ? readFileSync(file, "utf8") : "{}"; } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const backups = (JSON.parse(raw) as { backupModels?: Record<string, unknown> })?.backupModels;
    if (backups && typeof backups === "object" && name in backups) value = backups[name];
  }
  if (value !== undefined && typeof value !== "string") throw new Error(`Hybrid Subagents: ${name} backupModel must be a string.`);
  return value ? parseSelection(value) : undefined;
}

export async function saveSelection(cwd: string, name: RoleName, selection: ModelSelection, scope: SettingsScope, fast = false): Promise<string> {
  const api = await prepareScope(cwd, scope);
  return api.mergeBuiltinAgentOverride(cwd, name, scope, {
    model: modelSpec(selection), thinking: selection.thinking,
    fast: fast && supportsFast(selection.provider),
  });
}

/** Effective Fast choice from native agent discovery, including scoped overrides. */
export async function configuredFast(name: RoleName, ctx: SelectionContext): Promise<boolean> {
  const { agents } = (await native()).discoverAgents(ctx.cwd, ctx.isProjectTrusted() ? "both" : "user", ctx.model?.provider);
  return agents.find((agent) => agent.name === name)?.fast === true;
}

type SelectionContext = Pick<ExtensionContext, "cwd" | "modelRegistry" | "isProjectTrusted" | "model">;

/** Resolve the native settings without a per-run override; Main's provider may affect precedence. */
export async function configuredSelection(name: RoleName, ctx: SelectionContext): Promise<ModelSelection> {
  const result = await resolveSubagentLaunchContract({
    agent: name, cwd: ctx.cwd, agentScope: ctx.isProjectTrusted() ? "both" : "user",
    availableModels: ctx.modelRegistry.getAll(), parentModel: ctx.model,
  });
  if (!result.ok) throw new Error(`Hybrid Subagents: ${name}: ${result.message}`);
  const contract = result.contract;
  if (!contract.model) throw new Error(`Hybrid Subagents: ${name} requires a local native Pi model.`);
  return parseSelection(contract.model, contract.thinking);
}
