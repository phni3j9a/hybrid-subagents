import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("real Pi loads the bundled pi-subagents from this package alone, without a child guard and saves models through its registered command", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "hybrid-subagents-parent-"));
  const agentDir = path.join(fixture, "agent");
  mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(fixture, "runs");
  const root = fileURLToPath(new URL("../", import.meta.url));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [root], compaction: { enabled: false } }));
  // Fail closed if a regression ever reaches network transport during this offline smoke.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Hybrid Subagents offline test forbids network requests"); };
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const settings = SettingsManager.create(fixture, agentDir);
  const loader = new DefaultResourceLoader({ cwd: fixture, agentDir, settingsManager: settings });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(loader.getSkills().skills.some((skill) => skill.name === "pi-subagents"), "bundled skills load");
    assert.ok(loader.getPrompts().prompts.some((prompt) => prompt.name === "parallel-review"), "bundled prompts load");
    ({ session } = await createAgentSession({ cwd: fixture, agentDir, modelRuntime: runtime, model: runtime.getModel("openai-codex", "gpt-6.1-sol"), thinkingLevel: "low", settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(fixture) }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
    assert.deepEqual(errors, []);
    assert.ok(session.getActiveToolNames().includes("subagents_enable"));
    const options = { cwd: fixture, selectedTools: session.getActiveToolNames() };
    const emit = session.extensionRunner.emitBeforeAgentStart;
    // Pi 1.2 replaced the 1.1 (prompt, images, options) test entry point with (trigger, options).
    const prompt = await Reflect.apply(emit, session.extensionRunner, emit.length === 3
      ? ["Investigate and implement the feature", undefined, options]
      : [{ messageType: "user", prompt: "Investigate and implement the feature", images: undefined }, options]);
    assert.match(prompt.systemPromptOptions.sections["hybrid-subagents"] ?? "", /subagents_enable/);
    assert.equal(session.model?.id, "gpt-6.1-sol");
    assert.equal(session.thinkingLevel, "low");
    const tool = session.getToolDefinition("subagent");
    assert.ok(tool);
    const { resolveSubagentLaunchContract } = await import("pi-subagents/preflight");
    const override = await resolveSubagentLaunchContract({ agent: "hybrid-subagents.worker", cwd: fixture, parentSessionId: session.sessionId, model: "openai-codex/gpt-6-luna:low" });
    assert.ok(override.ok);
    assert.equal(override.contract.thinking, "low");
    assert.ok(!override.contract.tools.requiredExtensionIds.includes("hybrid-subagents.models"));

    // Exercise the command loaded by Pi's real extension loader, including its
    // dynamic import of the native settings editor. Dialog answers replace user
    // interaction; only this offline fixture pretends models are authenticated.
    const command = session.extensionRunner.getCommand("hybrid-subagents");
    assert.ok(command);
    const commandCtx = { ...session.extensionRunner.createCommandContext(), hasUI: true };
    const answers = ["openai-codex", "gpt-6-luna", "high", "On — priority service tier (faster, higher usage/cost)", "User — all projects"];
    const notices: { text: string; type?: string }[] = [];
    commandCtx.modelRegistry.getAvailable = () => commandCtx.modelRegistry.getAll();
    commandCtx.ui = { ...commandCtx.ui,
      select: async (_title, options) => {
        const answer = answers.shift()!;
        assert.ok(options.includes(answer));
        return answer;
      },
      notify: (text, type) => notices.push({ text, type }),
    };
    await command.handler("models worker", commandCtx);
    assert.equal(answers.length, 0);
    assert.equal(notices.at(-1)?.type, "info", JSON.stringify(notices));
    const saved = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(saved.subagents.agentOverrides["hybrid-subagents.worker"].model, "openai-codex/gpt-6-luna:high");
    assert.equal(saved.subagents.agentOverrides["hybrid-subagents.worker"].fast, true);
    assert.equal(session.model?.id, "gpt-6.1-sol");
    assert.equal(session.thinkingLevel, "low");
    await command.handler("", commandCtx);
    assert.match(notices.at(-1)!.text, /hybrid-subagents.worker: openai-codex\/gpt-6-luna:high fast/);
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    globalThis.fetch = originalFetch;
    rmSync(fixture, { recursive: true, force: true });
  }
});
