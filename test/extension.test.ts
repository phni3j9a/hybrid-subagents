import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import hyagents from "../extensions/hyagents.ts";
import { ROLES } from "../src/models.ts";

const fixture = mkdtempSync(path.join(tmpdir(), "hyagents-extension-"));
const agentDir = path.join(fixture, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [fileURLToPath(new URL("../", import.meta.url))] }));
after(() => rmSync(fixture, { recursive: true, force: true }));

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const models = Object.values(ROLES).map(({ provider, id }) => getModels(provider).find((model) => model.id === id)!);
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => { handlers.set(event, handler); return () => handlers.delete(event); },
    registerCommand: (name: string, config: unknown) => commands.set(name, config),
    getAllTools: () => [{ name: "subagent" }],
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: fixture,
    isProjectTrusted: () => true,
    getSystemPrompt: () => "You are Pi Main.",
    sessionManager: { getSessionId: () => crypto.randomUUID() },
    ui: { notify: (text: string) => notifications.push(text) },
    modelRegistry: {
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
      getAll: () => models,
    },
  } as unknown as ExtensionContext;
  hyagents(pi);
  return { pi, ctx, handlers, commands, notifications };
}

test("automatically applies policy on every Main turn without replacing other prompt sections", async () => {
  const h = harness();
  try {
    await h.handlers.get("session_start")!({}, h.ctx);
    for (const tool of ["subagents_enable", "subagent", "subagent"]) {
      const event = { systemPrompt: "Pi Main", systemPromptOptions: { selectedTools: [tool], sections: { existing: "preserve" } as Record<string, string> } };
      assert.equal(await h.handlers.get("before_agent_start")!(event, h.ctx), undefined);
      assert.equal(event.systemPromptOptions.sections.existing, "preserve");
      assert.match(event.systemPromptOptions.sections.hyagents, /hyagents.worker/);
      assert.match(event.systemPromptOptions.sections.hyagents, /entirely Main's decision/);
    }
    assert.equal(h.notifications.length, 0);
  } finally { h.handlers.get("session_shutdown")?.(); }
});

test("no Main policy when the subagent tool is disabled or in a child prompt", async () => {
  const h = harness();
  for (const [prompt, tools] of [["Pi Main", []], ['<active_agent name="hyagents.worker"/>\nchild', ["subagent"]]] as const) {
    const event = { systemPrompt: prompt, systemPromptOptions: { selectedTools: tools, sections: {} } };
    await h.handlers.get("before_agent_start")!(event, h.ctx);
    assert.deepEqual(event.systemPromptOptions.sections, {});
  }
});

test("another host owns required child extensions without blocking policy or startup", async () => {
  const h = harness();
  (h.ctx.sessionManager as any).getSessionId = () => "reload-test";
  const { registerRequiredChildExtensions } = await import("pi-subagents/required-child-extensions");
  writeFileSync(path.join(fixture, "other.ts"), "export default function() {};");
  const owner = registerRequiredChildExtensions({ sessionId: "reload-test", extensions: [{ id: "other.host", path: path.join(fixture, "other.ts") }] });
  try {
    await h.handlers.get("session_start")!({}, h.ctx);
    await h.handlers.get("session_start")!({}, h.ctx);
    assert.equal(h.handlers.has("tool_call"), false);
    const event = { systemPrompt: "Pi Main", systemPromptOptions: { selectedTools: ["subagent"], sections: {} as Record<string, string> } };
    await h.handlers.get("before_agent_start")!(event, h.ctx);
    assert.match(event.systemPromptOptions.sections.hyagents, /hyagents.worker/);
    assert.equal(h.notifications.length, 0);
  } finally { owner.dispose(); }
});

test("background children do not register Main hooks or commands", () => {
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const h = harness();
    assert.equal(h.handlers.size, 0);
    assert.equal(h.commands.size, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  }
});

test("missing runtime and authentication produce actionable diagnostics without changing Main", async () => {
  const h = harness();
  h.pi.getAllTools = () => [];
  h.ctx.modelRegistry.getAvailable = () => [];
  try {
    await h.handlers.get("session_start")!({}, h.ctx);
    assert.match(h.notifications.join("\n"), /pi install npm:pi-subagents@0.76.1/);
    assert.match(h.notifications.join("\n"), /authenticate anthropic/);
    await h.commands.get("hyagents").handler("", h.ctx);
    assert.match(h.notifications.at(-1)!, /hyagents.worker: openai-codex\/gpt-6-luna:max/);
  } finally { h.handlers.get("session_shutdown")?.(); }
});

test("diagnostics read the saved backup fresh and report registry and authentication problems", async () => {
  const h = harness();
  const file = path.join(agentDir, "settings.json");
  const original = readFileSync(file, "utf8");
  const save = (backupModel: string) => writeFileSync(file, JSON.stringify({ ...JSON.parse(original), subagents: { agentOverrides: { "hyagents.worker": { backupModel } } } }));
  try {
    save("unknown/missing:high");
    await h.commands.get("hyagents").handler("", h.ctx);
    assert.match(h.notifications.at(-1)!, /backup: unknown\/missing:high/);
    assert.match(h.notifications.at(-1)!, /backup missing unknown\/missing/);
    save("openai-codex/gpt-6.1-sol:high");
    h.ctx.modelRegistry.getAvailable = () => [];
    await h.commands.get("hyagents").handler("", h.ctx);
    assert.match(h.notifications.at(-1)!, /backup: openai-codex\/gpt-6.1-sol:high/);
    assert.match(h.notifications.at(-1)!, /authenticate backup openai-codex/);
    const event = { systemPrompt: "Pi Main", systemPromptOptions: { selectedTools: ["subagent"], sections: {} as Record<string, string> } };
    await h.handlers.get("before_agent_start")!(event, h.ctx);
    assert.match(event.systemPromptOptions.sections.hyagents, /Configured backups:\n- hyagents\.worker: openai-codex\/gpt-6\.1-sol:high$/, "Main sees the saved backup without /reload");
    writeFileSync(file, original);
    await h.handlers.get("before_agent_start")!(event, h.ctx);
    assert.doesNotMatch(event.systemPromptOptions.sections.hyagents, /Configured backups:\n/);
  } finally { writeFileSync(file, original); }
});
