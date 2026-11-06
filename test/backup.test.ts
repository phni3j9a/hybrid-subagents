import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

for (const hasBackup of [true, false]) test(`real Pi child ${hasBackup ? "continues on backup once" : "keeps error without backup"}`, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "hyagents-backup-"));
  const agentDir = path.join(cwd, "agent"); mkdirSync(agentDir);
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const backup = hasBackup ? { backupModel: "faux/backup:off" } : {};
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, subagents: { agentOverrides: { "hyagents.worker": backup } } }));
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline test forbids network"); };
  const faux = fauxProvider({ provider: "faux", models: [{ id: "primary" }, { id: "backup" }] });
  faux.provider.auth.apiKey!.check = async () => ({ source: "test", type: "api_key" });
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }), fauxAssistantMessage("backup completed")]);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const settings = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noSkills: true, noContextFiles: true, systemPrompt: '<active_agent name="hyagents.worker"/>', additionalExtensionPaths: [fileURLToPath(new URL("../extensions/backup-child.ts", import.meta.url))] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel("primary"), settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
    await session.prompt("Do the task");
    assert.deepEqual(errors, []);
    const messages = session.messages.filter((m) => m.role === "assistant");
    assert.equal(messages.at(-1)?.stopReason, hasBackup ? "stop" : "error");
    assert.equal(session.model?.id, hasBackup ? "backup" : "primary");
    assert.equal(faux.state.callCount, hasBackup ? 2 : 1);
    if (hasBackup) {
      assert.equal(messages.at(-1)?.model, "backup");
      const payload = await session.extensionRunner.emitBeforeProviderRequest({ service_tier: "priority", other: true });
      assert.deepEqual(payload, { other: true });
      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "another failure" })]);
      await session.prompt("Next task");
      assert.equal(faux.state.callCount, 3);
      assert.equal(session.messages.filter((m) => m.role === "assistant").at(-1)?.stopReason, "error");
    }
  } finally {
    session?.dispose();
    globalThis.fetch = fetch;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("child does not switch for aborts, context overflow, or missing backup authentication", async () => {
  const { default: backupChild } = await import("../extensions/backup-child.ts");
  const handlers = new Map<string, (...args: any[]) => any>();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "primary" }, { id: "backup" }] });
  let calls = 0;
  const agentDir = mkdtempSync(path.join(tmpdir(), "hyagents-backup-unit-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { agentOverrides: { "hyagents.worker": { backupModel: "faux/backup:off" } } } }));
  backupChild({
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    setModel: async () => { calls++; return false; }, setThinkingLevel: () => {},
  } as any);
  const ctx = { cwd: agentDir, isProjectTrusted: () => false, getSystemPrompt: () => '<active_agent name="hyagents.worker"/>', model: faux.getModel("primary"), modelRegistry: { find: () => faux.getModel("backup") } };
  const settle = handlers.get("agent_before_settle")!;
  const event = (stopReason: "error" | "aborted", errorMessage: string) => ({ entries: [], context: { contextMessages: [fauxAssistantMessage("", { stopReason, errorMessage })] } });
  try {
    assert.equal(await settle(event("aborted", "cancelled"), ctx), undefined);
    assert.equal(await settle(event("error", "maximum context length exceeded"), ctx), undefined);
    assert.equal(calls, 0);
    assert.equal(await settle(event("error", "insufficient_quota"), ctx), undefined);
    assert.equal(calls, 1);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
