import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { backupCommand, modelCommand, modelCompletions } from "../src/model-command.ts";
import { configuredBackup, configuredFast, configuredSelection, saveSelection } from "../src/native-settings.ts";
import { modelSpec, ROLES } from "../src/models.ts";

const fixture = mkdtempSync(path.join(tmpdir(), "hyagents-picker-"));
const agentDir = path.join(fixture, "agent");
const cwd = path.join(fixture, "project");
mkdirSync(agentDir); mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
const root = fileURLToPath(new URL("../", import.meta.url));
const settingsPath = path.join(agentDir, "settings.json");
const backupPath = path.join(agentDir, "hyagents.json");
const base = { packages: [root], theme: "dark", subagents: { agentOverrides: { "hyagents.worker": { tools: ["read", "edit"], fast: false }, unrelated: { model: "keep/me" } } } };
beforeEach(() => {
  writeFileSync(settingsPath, JSON.stringify(base));
  rmSync(path.join(cwd, ".pi"), { recursive: true, force: true });
  rmSync(backupPath, { force: true });
});
after(() => rmSync(fixture, { recursive: true, force: true }));

const OFF = "Off — standard service tier";
const ON = "On — priority service tier (faster, higher usage/cost)";

const models = [
  ...Object.values(ROLES).map(({ provider, id }) => getModels(provider).find((model) => model.id === id)!),
  getModels("openai").find((model) => !model.reasoning)!,
].filter((model, index, all) => all.findIndex((item) => item.provider === model.provider && item.id === model.id) === index);

function ui(answers: (string | undefined)[], confirm = true) {
  const notifications: { text: string; type?: string }[] = [];
  const dialogs: { title: string; options: string[] }[] = [];
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => true,
    modelRegistry: { getAll: () => models, getAvailable: () => models, find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) },
    ui: {
      select: async (title: string, options: string[]) => {
        dialogs.push({ title, options });
        const answer = answers.shift();
        if (answer !== undefined) assert.ok(options.includes(answer), `${answer} not in ${JSON.stringify(options)}`);
        return answer;
      },
      confirm: async () => confirm,
      notify: (text: string, type?: string) => notifications.push({ text, type }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, dialogs, notifications };
}

test("role picker saves a different model and lower thinking to native settings, preserving unrelated fields", async () => {
  const h = ui(["openai-codex", "gpt-6.1-sol", "low", OFF, "User — all projects"]);
  await modelCommand("worker", h.ctx);
  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(saved.theme, "dark");
  assert.deepEqual(saved.subagents.agentOverrides.unrelated, base.subagents.agentOverrides.unrelated);
  assert.deepEqual(saved.subagents.agentOverrides["hyagents.worker"], { tools: ["read", "edit"], fast: false, model: "openai-codex/gpt-6.1-sol:low", thinking: "low" });
  assert.equal(existsSync(backupPath), false);
  assert.equal(modelSpec(await configuredSelection("hyagents.worker", h.ctx)), "openai-codex/gpt-6.1-sol:low");
  assert.match(h.notifications.at(-1)!.text, /Applies to new children/);
  assert.equal(h.notifications.at(-1)!.type, "info");
});

test("top-level menu shows effective choices and edits the selected role", async () => {
  const h = ui(["scout — openai-codex/gpt-6-luna:xhigh", "anthropic", "claude-opus-5-5", "high", "User — all projects"]);
  await modelCommand("", h.ctx);
  assert.equal(h.dialogs[0].options.length, 4);
  assert.equal(modelSpec(await configuredSelection("hyagents.scout", h.ctx)), "anthropic/claude-opus-5-5:high");
});

test("non-reasoning models offer only off, and off is saved explicitly", async () => {
  const model = models.find((item) => !item.reasoning)!;
  const h = ui([model.provider, model.id, "off", "User — all projects"]);
  await modelCommand("hyagents.worker", h.ctx);
  assert.deepEqual(h.dialogs[2].options, getSupportedThinkingLevels(model));
  assert.equal((await configuredSelection("hyagents.worker", h.ctx)).thinking, "off");
});

test("cancelling any selection dialog writes nothing", async () => {
  const steps = ["openai-codex", "gpt-6.1-sol", "low", OFF, "User — all projects"];
  const original = readFileSync(settingsPath, "utf8");
  for (let index = 0; index < steps.length; index++) {
    await modelCommand("worker", ui([...steps.slice(0, index), undefined]).ctx);
    assert.equal(readFileSync(settingsPath, "utf8"), original);
  }
  await modelCommand("", ui([undefined]).ctx);
  assert.equal(readFileSync(settingsPath, "utf8"), original);
});

test("project setting wins, persists independently, and shadowed user saves are reported", async () => {
  const h = ui(["openai-codex", "gpt-6.1-sol", "high", OFF, "Project — this project only"]);
  await modelCommand("worker", h.ctx);
  assert.equal(modelSpec(await configuredSelection("hyagents.worker", h.ctx)), "openai-codex/gpt-6.1-sol:high");
  assert.equal(readFileSync(settingsPath, "utf8"), JSON.stringify(base));
  const another = ui(["openai-codex", "gpt-6-luna", "low", OFF, "User — all projects"]);
  await modelCommand("worker", another.ctx);
  assert.equal(modelSpec(await configuredSelection("hyagents.worker", another.ctx)), "openai-codex/gpt-6.1-sol:high");
  assert.match(another.notifications.at(-1)!.text, /Current project uses/);
  assert.equal(another.notifications.at(-1)!.type, "warning");
  const nested = path.join(cwd, "src"); mkdirSync(nested, { recursive: true });
  await saveSelection(nested, "hyagents.scout", { provider: "openai-codex", id: "gpt-6.1-sol", thinking: "medium" }, "project");
  assert.equal(existsSync(path.join(nested, ".pi")), false, "reuse the configured project root");
  assert.equal(modelSpec(await configuredSelection("hyagents.scout", h.ctx)), "openai-codex/gpt-6.1-sol:medium");
});

test("reset restores all initial values including Worker max without erasing other settings", async () => {
  await saveSelection(cwd, "hyagents.worker", { provider: "openai-codex", id: "gpt-6.1-sol", thinking: "low" }, "user");
  const h = ui(["User — all projects"]);
  await modelCommand("reset", h.ctx);
  for (const name of Object.keys(ROLES) as (keyof typeof ROLES)[]) assert.equal(modelSpec(await configuredSelection(name, h.ctx)), modelSpec(name));
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides["hyagents.worker"].tools, ["read", "edit"]);
});

test("cancelled reset, headless invocation, unknown roles and unavailable authentication never write", async () => {
  const original = readFileSync(settingsPath, "utf8");
  await modelCommand("reset", ui(["User — all projects"], false).ctx);
  const headless = ui([]); headless.ctx.hasUI = false;
  await modelCommand("worker", headless.ctx);
  assert.match(headless.notifications[0].text, /dialog-capable RPC/);
  await modelCommand("unknown", ui([]).ctx);
  const unauthenticated = ui([]); unauthenticated.ctx.modelRegistry.getAvailable = () => [];
  await modelCommand("worker", unauthenticated.ctx);
  assert.match(unauthenticated.notifications[0].text, /Authenticate/);
  assert.equal(readFileSync(settingsPath, "utf8"), original);
});

test("untrusted projects cannot be chosen as the save scope", async () => {
  const h = ui(["openai-codex", "gpt-6-luna", "low", OFF, undefined]);
  h.ctx.isProjectTrusted = () => false;
  await modelCommand("worker", h.ctx);
  assert.deepEqual(h.dialogs.at(-1)!.options, ["User — all projects"]);
});

test("malformed settings are not overwritten", async () => {
  writeFileSync(settingsPath, "{broken json");
  const h = ui(["openai-codex", "gpt-6.1-sol", "low", OFF, "User — all projects"]);
  await assert.rejects(modelCommand("worker", h.ctx), /parse settings/);
  assert.equal(readFileSync(settingsPath, "utf8"), "{broken json");
  assert.equal(existsSync(backupPath), false, "No legacy Fast file is created");
  writeFileSync(backupPath, JSON.stringify({ fast: { "hyagents.scout": true } }));
  await assert.rejects(modelCommand("worker", ui(["openai-codex", "gpt-6.1-sol", "low", ON, "User — all projects"]).ctx), /parse settings/);
  assert.deepEqual(JSON.parse(readFileSync(backupPath, "utf8")), { fast: { "hyagents.scout": true } }, "Legacy Fast file is untouched");
});

test("legacy Fast files are ignored and never modified, even when malformed", async () => {
  writeFileSync(backupPath, "{broken json");
  const h = ui(["openai-codex", "gpt-6.1-sol", "low", ON, "User — all projects"]);
  await modelCommand("worker", h.ctx);
  assert.equal(await configuredFast("hyagents.worker", h.ctx), true);
  assert.equal(readFileSync(backupPath, "utf8"), "{broken json");
});

test("Fast saves for different roles are merged, not replaced", async () => {
  const selection = { provider: "openai-codex", id: "gpt-6-luna", thinking: "high" as const };
  await saveSelection(cwd, "hyagents.worker", selection, "user", true);
  await saveSelection(cwd, "hyagents.scout", selection, "user", false);
  const overrides = JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides;
  assert.equal(overrides["hyagents.worker"].fast, true);
  assert.equal(overrides["hyagents.scout"].fast, false);
});

test("Fast mode is offered only for the legacy openai-codex provider, saved explicitly and shown in the role menu", async () => {
  const h = ui(["openai-codex", "gpt-6-luna", "high", ON, "User — all projects"]);
  await modelCommand("worker", h.ctx);
  assert.deepEqual(h.dialogs[3], { title: "hyagents.worker — fast mode", options: [OFF, ON] });
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides["hyagents.worker"].fast, true);
  assert.equal(await configuredFast("hyagents.worker", h.ctx), true);
  assert.match(h.notifications.at(-1)!.text, /saved openai-codex\/gpt-6-luna:high fast/);
  const menu = ui([undefined]);
  await modelCommand("", menu.ctx);
  assert.ok(menu.dialogs[0].options.includes("worker — openai-codex/gpt-6-luna:high fast"));
  const anthropic = ui(["anthropic", "claude-opus-5-5", "high", "User — all projects"]);
  await modelCommand("worker", anthropic.ctx);
  assert.ok(!anthropic.dialogs.some((dialog) => dialog.title.endsWith("fast mode")));
  assert.equal(await configuredFast("hyagents.worker", anthropic.ctx), false);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides["hyagents.worker"].fast, false);
});

test("openai skips Fast and clears a previous native Fast choice", async () => {
  await saveSelection(cwd, "hyagents.worker", ROLES["hyagents.worker"], "user", true);
  const model = models.find((item) => item.provider === "openai")!;
  const h = ui([model.provider, model.id, "off", "User — all projects"]);
  await modelCommand("worker", h.ctx);
  assert.ok(!h.dialogs.some((dialog) => dialog.title.endsWith("fast mode")));
  assert.equal(await configuredFast("hyagents.worker", h.ctx), false);
  assert.ok(h.notifications.some(({ text }) => text.includes("legacy openai-codex")));
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides["hyagents.worker"].fast, false);
});

test("project Fast choice overrides the user choice; reset turns Fast off", async () => {
  const selection = { provider: "openai-codex", id: "gpt-6-luna", thinking: "high" as const };
  await saveSelection(cwd, "hyagents.worker", selection, "user", true);
  const h = ui([]);
  assert.equal(await configuredFast("hyagents.worker", h.ctx), true);
  await saveSelection(cwd, "hyagents.worker", selection, "project", false);
  assert.equal(await configuredFast("hyagents.worker", h.ctx), false);
  h.ctx.isProjectTrusted = () => false;
  assert.equal(await configuredFast("hyagents.worker", h.ctx), true, "untrusted project settings are ignored");
  await saveSelection(cwd, "hyagents.worker", { provider: "anthropic", id: "claude-opus-5-5", thinking: "high" }, "user", true);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides["hyagents.worker"].fast, false, "unsupported providers never save Fast");
  rmSync(path.join(cwd, ".pi"), { recursive: true, force: true });
  await saveSelection(cwd, "hyagents.scout", selection, "user", true);
  await modelCommand("reset", ui(["User — all projects"]).ctx);
  assert.equal(await configuredFast("hyagents.scout", ui([]).ctx), false);
});

test("provider-scoped native choices are displayed instead of rejected by a custom guard", async () => {
  const h = ui([]);
  h.ctx.model = models.find((model) => model.provider === "anthropic")!;
  writeFileSync(settingsPath, JSON.stringify({ ...base, subagents: { ...base.subagents, agentOverridesByProvider: {
    anthropic: { "hyagents.worker": { model: "openai-codex/gpt-6.1-sol:low", thinking: "low", fast: true } },
  } } }));
  assert.equal(modelSpec(await configuredSelection("hyagents.worker", h.ctx)), "openai-codex/gpt-6.1-sol:low");
  assert.equal(await configuredFast("hyagents.worker", h.ctx), true);
});

test("slash completions expose model selection, roles and reset", () => {
  assert.ok(modelCompletions("models w")!.some((item) => item.value === "models worker"));
  assert.ok(modelCompletions("models ")!.some((item) => item.value === "models reset"));
  assert.equal(modelCompletions("unknown"), null);
});

test("backup saves to hyagents.json, never Pi settings, and clears preserving unrelated fields", async () => {
  const original = readFileSync(settingsPath, "utf8");
  writeFileSync(backupPath, JSON.stringify({ fast: { "hyagents.worker": true }, backupModels: { "hyagents.scout": "keep/me:high" } }));
  await backupCommand("worker", ui(["openai-codex", "gpt-6.1-sol", "low", "User — all projects"]).ctx);
  assert.equal(readFileSync(settingsPath, "utf8"), original, "pi-subagents 0.85+ rejects unknown agentOverrides fields");
  assert.deepEqual(JSON.parse(readFileSync(backupPath, "utf8")), { fast: { "hyagents.worker": true }, backupModels: { "hyagents.scout": "keep/me:high", "hyagents.worker": "openai-codex/gpt-6.1-sol:low" } });
  await modelCommand("reset", ui(["User — all projects"]).ctx);
  assert.equal(modelSpec((await configuredBackup(ui([]).ctx, "hyagents.worker"))!), "openai-codex/gpt-6.1-sol:low");
  const h = ui(["None — no backup", "User — all projects"]);
  await backupCommand("worker", h.ctx);
  assert.deepEqual(JSON.parse(readFileSync(backupPath, "utf8")).backupModels, { "hyagents.scout": "keep/me:high" });
  assert.match(h.notifications.at(-1)!.text, /Applies to new children/);
});

test("backup cancels without writing at each step, rejects primary and saves project scope", async () => {
  const original = readFileSync(settingsPath, "utf8");
  const steps = ["openai-codex", "gpt-6.1-sol", "low", "User — all projects"];
  for (let i = 0; i < steps.length; i++) {
    await backupCommand("worker", ui([...steps.slice(0, i), undefined]).ctx);
    assert.equal(existsSync(backupPath), false);
  }
  await backupCommand("", ui([undefined]).ctx);
  await backupCommand("worker", ui(["None — no backup", undefined]).ctx);
  const same = ui(["openai-codex", "gpt-6-luna", "low"]);
  await backupCommand("worker", same.ctx);
  assert.match(same.notifications[0].text, /must differ/);
  await backupCommand("worker", ui(["None — no backup", "User — all projects"]).ctx);
  assert.equal(existsSync(backupPath), false, "clearing a missing backup creates no file");
  await backupCommand("worker", ui(["openai-codex", "gpt-6.1-sol", "low", "Project — this project only"]).ctx);
  assert.equal(JSON.parse(readFileSync(path.join(cwd, ".pi/hyagents.json"), "utf8")).backupModels["hyagents.worker"], "openai-codex/gpt-6.1-sol:low");
  assert.equal(existsSync(path.join(cwd, ".pi/settings.json")), false);
  assert.equal(modelSpec((await configuredBackup(ui([]).ctx, "hyagents.worker"))!), "openai-codex/gpt-6.1-sol:low", "fresh read without /reload");
  const untrusted = ui([]); untrusted.ctx.isProjectTrusted = () => false;
  assert.equal(await configuredBackup(untrusted.ctx, "hyagents.worker"), undefined, "untrusted project backup is ignored");
  assert.equal(readFileSync(settingsPath, "utf8"), original);
  assert.ok(modelCompletions("backup w")!.some((item) => item.value === "backup worker"));
});

test("backup save refuses malformed hyagents.json without overwriting", async () => {
  writeFileSync(backupPath, "{broken");
  await assert.rejects(backupCommand("worker", ui(["openai-codex", "gpt-6.1-sol", "low", "User — all projects"]).ctx), /parse settings/);
  assert.equal(readFileSync(backupPath, "utf8"), "{broken");
});
