import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { configReset, configSet, configShow } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/commands.ts";
import { DEFAULT_ROLES, loadConfig, userConfigPath } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/config.ts";
import { runtimeArgs } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/runtimes.ts";
import { HyError } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/util.ts";

const fixture = mkdtempSync(path.join(tmpdir(), "hyagents-plugin-config-"));
const project = path.join(fixture, "repo");
const nested = path.join(project, "packages", "app");
const env = { XDG_CONFIG_HOME: path.join(fixture, "config") };
const userFile = userConfigPath(env);
const projectFile = path.join(project, ".agents", "hybrid-subagents.json");
after(() => rmSync(fixture, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(path.join(project, ".git"), { recursive: true });
  mkdirSync(nested, { recursive: true });
});

const write = (file: string, value: unknown) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };

test("defaults match the Pi package roles, models and effort levels", () => {
  const config = loadConfig(nested, env);
  assert.deepEqual(config.roles, DEFAULT_ROLES);
  assert.deepEqual(
    Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([name, role]) => [name, `${role.runtime}/${role.model}:${role.effort}`])),
    { worker: "codex/gpt-6-luna:max", scout: "codex/gpt-6-luna:xhigh", reviewer: "codex/gpt-6.1-sol:high", designer: "claude/claude-opus-5-5:high" },
  );
  assert.equal(config.sources.worker.model, "default");
  assert.deepEqual(config.errors, []);
});

test("project settings override user settings field by field, found from a nested directory", () => {
  write(userFile, { roles: { worker: { runtime: "copilot", model: "gpt-6-luna", effort: "high" } } });
  write(projectFile, { roles: { worker: { model: "claude-opus-5-5" } } });
  const config = loadConfig(nested, env);
  assert.deepEqual(config.roles.worker, { runtime: "copilot", model: "claude-opus-5-5", effort: "high", fast: false, args: [] });
  assert.deepEqual(config.sources.worker, { runtime: "user", model: "project", effort: "user", fast: "default", args: "default" });
  assert.equal(config.files.project, projectFile);
});

test("invalid files and runtime/effort combinations are reported precisely", () => {
  write(userFile, { roles: { planner: {} } });
  assert.throws(() => loadConfig(nested, env), (error: HyError) => error.code === "config_invalid" && /unknown role "planner"/.test(error.message));
  write(userFile, { roles: { worker: { fast: "yes" } } });
  assert.throws(() => loadConfig(nested, env), /roles\.worker\.fast must be true or false/);
  write(userFile, { roles: { worker: { args: ["ok", "bad\nline"] } } });
  assert.throws(() => loadConfig(nested, env), /control characters/);
  write(userFile, { roles: { designer: { runtime: "claude", effort: "ultra" } } });
  assert.match(loadConfig(nested, env).errors.join(" "), /claude does not accept effort "ultra"/);
});

test("config set saves a whole role, keeps unrelated content, and reports project shadowing", () => {
  write(userFile, { note: "keep", roles: { scout: { model: "gpt-6-sol" } } });
  write(projectFile, { roles: { designer: { model: "claude-sonnet-5" } } });
  const saved = configSet(nested, env, "designer", { runtime: "copilot", model: "claude-opus-5-5", effort: "max", fast: "on", scope: "user" });
  assert.equal(saved.file, userFile);
  // Copilot has no Fast mode, so it is saved off.
  assert.deepEqual(saved.saved, { runtime: "copilot", model: "claude-opus-5-5", effort: "max", fast: false, args: [] });
  assert.equal(saved.shadowedByProject, true);
  assert.equal(saved.effective.model, "claude-sonnet-5");
  const file = JSON.parse(readFileSync(userFile, "utf8"));
  assert.equal(file.note, "keep");
  assert.deepEqual(file.roles.scout, { model: "gpt-6-sol" });

  const projectSave = configSet(nested, env, "worker", { effort: "default", args: '["--search"]', scope: "project" });
  assert.equal(projectSave.file, projectFile);
  assert.equal(projectSave.effective.effort, null);
  assert.deepEqual(projectSave.effective.args, ["--search"]);
});

test("config set and reset validate their input and write defaults on reset", () => {
  assert.throws(() => configSet(nested, env, "worker", { runtime: "gemini", scope: "user" }), /--runtime must be claude, codex or copilot/);
  assert.throws(() => configSet(nested, env, "worker", { scope: "global" }), /--scope must be user or project/);
  assert.throws(() => configSet(nested, env, "worker", { effort: "ultracode", scope: "user" }), /codex does not accept effort "ultracode"/);
  // A new project file goes to the repository root, not the nested directory.
  configSet(nested, env, "reviewer", { model: "gpt-6-sol", scope: "project" });
  const reset = configReset(nested, env, { scope: "project", role: "reviewer" });
  assert.equal(reset.file, projectFile);
  assert.deepEqual(JSON.parse(readFileSync(projectFile, "utf8")).roles.reviewer, DEFAULT_ROLES.reviewer);
  const shown = configShow(nested, env);
  assert.deepEqual(shown.efforts.codex, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(shown.roles.reviewer.sources.model, "project");
});

test("runtime arguments start each CLI with its model, effort, full access and Fast flags", () => {
  assert.deepEqual(runtimeArgs({ runtime: "codex", model: "gpt-6-luna", effort: "max", fast: true, args: ["--search"] }).args,
    ["-m", "gpt-6-luna", "-c", 'model_reasoning_effort="max"', "--dangerously-bypass-approvals-and-sandbox", "-c", 'service_tier="fast"', "--search"]);
  assert.deepEqual(runtimeArgs({ runtime: "claude", model: "claude-opus-5-5", effort: "high", fast: true, args: [] }).args,
    ["--model", "claude-opus-5-5", "--effort", "high", "--dangerously-skip-permissions", "--settings", '{"fastMode":true}']);
  const copilot = runtimeArgs({ runtime: "copilot", model: "gpt-6.1-sol", effort: null, fast: true, args: [] });
  assert.deepEqual(copilot.args, ["--model", "gpt-6.1-sol", "--yolo"]);
  assert.match(copilot.warnings[0], /copilot has no Fast mode/);
});
