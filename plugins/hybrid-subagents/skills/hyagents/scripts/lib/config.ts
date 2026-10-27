import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EFFORTS, FAST_SUPPORTED, isRuntime } from "./runtimes.ts";
import { HyError, hasControlChars, readJson, writeJsonAtomic } from "./util.ts";

export const ROLE_NAMES = ["worker", "scout", "reviewer", "designer"] as const;
export type RoleName = typeof ROLE_NAMES[number];
export type Runtime = "claude" | "codex" | "copilot";
/** `effort: null` keeps the CLI's own default. */
export interface RoleConfig { runtime: Runtime; model: string; effort: string | null; fast: boolean; args: string[] }
export type Scope = "user" | "project";
export type Source = "default" | Scope;
const FIELDS = ["runtime", "model", "effort", "fast", "args"] as const;
type Field = typeof FIELDS[number];

// The same roles, models and effort levels as the Pi package defaults.
export const DEFAULT_ROLES: Record<RoleName, RoleConfig> = {
  worker: { runtime: "codex", model: "gpt-6-luna", effort: "max", fast: false, args: [] },
  scout: { runtime: "codex", model: "gpt-6-luna", effort: "xhigh", fast: false, args: [] },
  reviewer: { runtime: "codex", model: "gpt-6.1-sol", effort: "high", fast: false, args: [] },
  designer: { runtime: "claude", model: "claude-opus-5-5", effort: "high", fast: false, args: [] },
};

export const PROJECT_CONFIG = path.join(".agents", "hybrid-subagents.json");

export function isRole(name: unknown): name is RoleName {
  return typeof name === "string" && (ROLE_NAMES as readonly string[]).includes(name);
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hybrid-subagents", "config.json");
}

export function findProjectConfig(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, PROJECT_CONFIG);
    if (existsSync(file)) return file;
    if (path.dirname(dir) === dir) return undefined;
  }
}

function projectRoot(cwd: string): string {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(cwd);
  }
}

export function configPath(scope: Scope, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return scope === "user" ? userConfigPath(env) : findProjectConfig(cwd) ?? path.join(projectRoot(cwd), PROJECT_CONFIG);
}

type RoleOverride = Partial<RoleConfig>;
interface ConfigFile { roles?: Partial<Record<RoleName, RoleOverride>>; [key: string]: unknown }

function fieldErrors(field: Field, value: unknown): string | undefined {
  switch (field) {
    case "runtime": return isRuntime(value) ? undefined : "must be claude, codex or copilot";
    case "model":
      return typeof value === "string" && value.length > 0 && value.length <= 200 && !/\s/.test(value) && !hasControlChars(value)
        ? undefined : "must be a non-empty model ID without spaces";
    case "effort": return value === null || (typeof value === "string" && /^[a-z]+$/.test(value)) ? undefined : "must be a level name or null";
    case "fast": return typeof value === "boolean" ? undefined : "must be true or false";
    case "args":
      return Array.isArray(value) && value.every((arg) => typeof arg === "string" && !hasControlChars(arg))
        ? undefined : "must be an array of strings without control characters";
  }
}

function readConfigFile(file: string): ConfigFile {
  const data = readJson<ConfigFile>(file);
  if (data === undefined) return {};
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HyError("config_invalid", `${file}: expected a JSON object.`);
  if (data.roles === undefined) return data;
  if (!data.roles || typeof data.roles !== "object" || Array.isArray(data.roles)) throw new HyError("config_invalid", `${file}: "roles" must be an object.`);
  for (const [name, role] of Object.entries(data.roles)) {
    if (!isRole(name)) throw new HyError("config_invalid", `${file}: unknown role "${name}". Roles: ${ROLE_NAMES.join(", ")}.`);
    if (!role || typeof role !== "object" || Array.isArray(role)) throw new HyError("config_invalid", `${file}: roles.${name} must be an object.`);
    for (const [field, value] of Object.entries(role)) {
      if (!(FIELDS as readonly string[]).includes(field)) throw new HyError("config_invalid", `${file}: roles.${name}.${field} is not a setting. Use ${FIELDS.join(", ")}.`);
      const error = fieldErrors(field as Field, value);
      if (error) throw new HyError("config_invalid", `${file}: roles.${name}.${field} ${error}.`);
    }
  }
  return data;
}

/** Errors that make a role unusable as a whole, such as an effort the runtime does not accept. */
export function roleErrors(name: RoleName, role: RoleConfig): string[] {
  const errors = FIELDS.flatMap((field) => {
    const error = fieldErrors(field, role[field]);
    return error ? [`${name}.${field} ${error}`] : [];
  });
  if (!errors.length && role.effort !== null && !EFFORTS[role.runtime].includes(role.effort)) {
    errors.push(`${name}: ${role.runtime} does not accept effort "${role.effort}". Use one of ${EFFORTS[role.runtime].join(", ")} or default.`);
  }
  return errors;
}

export interface EffectiveConfig {
  roles: Record<RoleName, RoleConfig>;
  sources: Record<RoleName, Record<Field, Source>>;
  files: { user: string; project?: string };
  errors: string[];
  warnings: string[];
}

/** Project settings override user settings, field by field, over the bundled defaults. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): EffectiveConfig {
  const files = { user: userConfigPath(env), project: findProjectConfig(cwd) };
  const layers: [Scope, ConfigFile][] = [["user", readConfigFile(files.user)]];
  if (files.project) layers.push(["project", readConfigFile(files.project)]);
  const roles = {} as Record<RoleName, RoleConfig>;
  const sources = {} as Record<RoleName, Record<Field, Source>>;
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const name of ROLE_NAMES) {
    const role = { ...DEFAULT_ROLES[name], args: [...DEFAULT_ROLES[name].args] };
    const from = Object.fromEntries(FIELDS.map((field) => [field, "default"])) as Record<Field, Source>;
    for (const [scope, file] of layers) {
      const override = file.roles?.[name] ?? {};
      for (const field of FIELDS) {
        if (Object.hasOwn(override, field)) { (role as Record<Field, unknown>)[field] = override[field]; from[field] = scope; }
      }
    }
    roles[name] = role;
    sources[name] = from;
    errors.push(...roleErrors(name, role));
    if (role.fast && !FAST_SUPPORTED[role.runtime]) warnings.push(`${name}: ${role.runtime} has no Fast mode; it starts without it.`);
  }
  return { roles, sources, files, errors, warnings };
}

export function saveRole(cwd: string, scope: Scope, name: RoleName, role: RoleConfig, env: NodeJS.ProcessEnv = process.env): string {
  const errors = roleErrors(name, role);
  if (errors.length) throw new HyError("config_invalid", errors.join(" "));
  const file = configPath(scope, cwd, env);
  const data = readConfigFile(file);
  data.roles = { ...data.roles, [name]: { runtime: role.runtime, model: role.model, effort: role.effort, fast: role.fast, args: role.args } };
  writeJsonAtomic(file, data);
  return file;
}

export function resetRoles(cwd: string, scope: Scope, names: readonly RoleName[], env: NodeJS.ProcessEnv = process.env): string {
  let file = "";
  for (const name of names) file = saveRole(cwd, scope, name, DEFAULT_ROLES[name], env);
  return file;
}
