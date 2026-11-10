import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ROLES, modelSpec, type RoleName } from "../src/models.ts";
import { saveSelection } from "../src/native-settings.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), "hybrid-subagents-runtime-"));
const agentDir = path.join(fixture, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(fixture, "runs");
writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));

const { resolveSubagentLaunchContract } = await import("pi-subagents/preflight");
const { registerRequiredChildExtensions } = await import("pi-subagents/required-child-extensions");
// Exercise the pinned runtime offline, including its own Fast extension.
const { createDefaultChildSessionFactory } = await import("../node_modules/pi-subagents/src/runs/shared/child-session.js");
const { discoverAgents } = await import("../node_modules/pi-subagents/src/agents/agents.js");
const { getModels } = await import("@earendil-works/pi-ai/compat");
const { Compile } = await import("typebox/compile");
const { resolvePiLaunchToolPlan } = await import("../node_modules/pi-subagents/src/runs/shared/child-tool-plan.js");
const sessionManagers = new Map<string, SessionManager>();
const sessions = new Map<string, any>();
const factory = createDefaultChildSessionFactory({
  loadPiCodingAgent: async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    return { ...pi, createAgentSession: async (...args: Parameters<typeof pi.createAgentSession>) => {
      const created = await pi.createAgentSession(...args);
      sessionManagers.set(created.session.sessionId, created.session.sessionManager);
      sessions.set(created.session.sessionId, created.session);
      return created;
    } };
  },
});

function retainUserTurn(sessionId: string): void {
  // Pi buffers a never-used session. A user turn persists the actual entries,
  // including the startup selection, without making a provider request.
  sessionManagers.get(sessionId)!.appendMessage({ role: "user", content: "Complete the assigned task.", timestamp: Date.now() });
}

after(async () => {
  await factory.dispose();
  rmSync(fixture, { recursive: true, force: true });
});

test("installed package discovery preserves builtins and registers four namespaced agents", () => {
  const discovered = discoverAgents(fixture, "both");
  for (const name of Object.keys(ROLES)) {
    const agent = discovered.agents.find((item) => item.name === name);
    assert.ok(agent, name);
    assert.equal(agent.source, "package");
    assert.equal(agent.advertise, true);
    assert.equal(agent.tools, undefined, "no extra tool allowlist");
    assert.equal(agent.excludeTools, undefined);
    assert.equal(agent.defaultProgress, false, "no progress/checkpoint files");
  }
  assert.ok(discovered.agents.some((item) => item.name === "worker" && item.source === "builtin"));
});

for (const name of Object.keys(ROLES) as RoleName[]) {
  test(`${name}: real native discovery and preflight retain model, thinking and permissions without a guard`, async () => {
    const result = await resolveSubagentLaunchContract({
      agent: name, cwd: fixture, parentSessionId: "hybrid-subagents-test", task: "Inspect the assignment.",
      availableModels: Object.values(ROLES).map(({ provider, id }) => getModels(provider).find((model) => model.id === id)!),
    });
    assert.ok(result.ok, JSON.stringify(result));
    const contract = result.contract;
    assert.equal(contract.model?.replace(/:(max|xhigh|high)$/, ""), modelSpec(name).replace(/:(max|xhigh|high)$/, ""));
    assert.equal(contract.thinking, ROLES[name].thinking);
    assert.equal(contract.tools.explicitAllowlist, false);
    assert.ok(!contract.tools.requiredExtensionIds.includes("hybrid-subagents.models"));
    assert.equal(contract.context, "fresh");
    assert.equal(contract.inheritProjectContext, true);
  });

  test(`${name}: real child startup accepts the exact model/effort without calling a provider`, async () => {
    const child = await factory.create(launch(name, modelSpec(name)));
    assert.equal(child.modelId, `${ROLES[name].provider}/${ROLES[name].id}`);
    await child.dispose();
  });
}

function launch(name: string, model: string, fast = false) {
  const plan = resolvePiLaunchToolPlan({ cwd: fixture, agentName: name, model, fast });
  return {
    cwd: fixture,
    storage: { kind: "memory" as const },
    model,
    extensionPaths: plan.extensionArgs,
    ambientExtensions: false,
    hooks: [],
    noSkills: true,
    noContextFiles: true,
    appendSystemPrompt: `<active_agent name="${name}"/>\n\nComplete the assignment.`,
    runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false, defaultTimeoutMs: 1000 }, fast },
  };
}

test("per-run model and thinking overrides are left to the native runtime", async () => {
  const result = await resolveSubagentLaunchContract({ agent: "hybrid-subagents.worker", cwd: fixture, model: "openai-codex/gpt-6.1-sol:low" });
  assert.ok(result.ok);
  assert.equal(result.contract.thinking, "low");
  const child = await factory.create(launch("hybrid-subagents.worker", result.contract.model!));
  assert.equal(child.modelId, "openai-codex/gpt-6.1-sol");
  await child.dispose();
});

test("native reviewer schema accepts empty findings and rejects malformed priorities/ranges", () => {
  const agent = discoverAgents(fixture, "both").agents.find((item) => item.name === "hybrid-subagents.reviewer")!;
  assert.ok(agent.outputSchema);
  const validator = Compile(agent.outputSchema);
  const correct = { overall_correctness: "correct", explanation: "No actionable defects found.", confidence: 0.8, findings: [] };
  assert.ok(validator.Check(correct));
  const finding = { title: "Handle an empty token", body: "The new empty-token path throws before returning a response.", priority: 1, confidence: 0.95, file_path: "src/auth.ts", line_start: 5, line_end: 6 };
  const result = { ...correct, overall_correctness: "incorrect", findings: [finding] };
  assert.ok(validator.Check(result));
  assert.equal(validator.Check({ ...result, findings: [{ ...finding, priority: 4 }] }), false);
  assert.equal(validator.Check({ ...result, findings: [{ ...finding, line_start: 0 }] }), false);
  assert.equal(validator.Check({ ...correct, confidence: 2 }), false);
});

test("native thinking ceiling remains authoritative", async () => {
  const result = await resolveSubagentLaunchContract({ agent: "hybrid-subagents.worker", cwd: fixture, thinkingCeiling: "high" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "thinking_ceiling");
});

test("saved choices apply to new real children while retained children keep their initial selection", async () => {
  const originalSettings = JSON.stringify({ packages: [root] });
  const initial = { provider: "openai-codex", id: "gpt-6.1-sol", thinking: "low" as const };
  try {
    await saveSelection(fixture, "hybrid-subagents.worker", initial, "user");
    const preflight = await resolveSubagentLaunchContract({ agent: "hybrid-subagents.worker", cwd: fixture });
    assert.ok(preflight.ok);
    assert.equal(preflight.contract.model, modelSpec(initial));
    const first = await factory.create({ ...launch("hybrid-subagents.worker", modelSpec(initial)), storage: { kind: "dir", sessionDir: path.join(fixture, "configured-sessions") } });
    retainUserTurn(first.sessionId);
    const sessionFile = first.sessionFile!;
    await first.dispose();
    await saveSelection(fixture, "hybrid-subagents.worker", ROLES["hybrid-subagents.worker"], "user");
    const fresh = await factory.create(launch("hybrid-subagents.worker", modelSpec("hybrid-subagents.worker")));
    await fresh.dispose();
    const resumed = await factory.create({ ...launch("hybrid-subagents.worker", modelSpec(initial)), storage: { kind: "file", sessionFile } });
    await resumed.dispose();
  } finally {
    writeFileSync(path.join(agentDir, "settings.json"), originalSettings);
  }
});

async function providerPayload(sessionId: string): Promise<Record<string, unknown>> {
  return await sessions.get(sessionId)!.extensionRunner.emitBeforeProviderRequest({ model: "probe", input: [] }) as Record<string, unknown>;
}

test("native Fast coexists with another host required extension and applies priority only when enabled", async () => {
  const hostPath = path.join(fixture, "host.ts");
  writeFileSync(hostPath, 'export default function(pi) { pi.on("before_provider_request", (event) => ({ ...event.payload, host_probe: true })); }');
  const host = registerRequiredChildExtensions({ sessionId: "hybrid-subagents-fast-test", extensions: [{ id: "other.host", path: hostPath }] });
  try {
    for (const fast of [true, false]) {
      await saveSelection(fixture, "hybrid-subagents.worker", ROLES["hybrid-subagents.worker"], "user", fast);
      const result = await resolveSubagentLaunchContract({ agent: "hybrid-subagents.worker", cwd: fixture, parentSessionId: "hybrid-subagents-fast-test" });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.contract.tools.requiredExtensionIds, ["other.host"]);
      const child = await factory.create({
        ...launch("hybrid-subagents.worker", result.contract.model!, fast),
        extensionPaths: [...result.contract.tools.extensionArgs, hostPath],
        requiredExtensions: [{ id: "other.host", path: hostPath }],
      });
      const payload = await providerPayload(child.sessionId);
      assert.equal(payload.host_probe, true);
      assert.equal(payload.service_tier, fast ? "priority" : undefined);
      await child.dispose();
    }
  } finally {
    host.dispose();
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
  }
});

test("native Fast rejects openai and other unsupported providers", async () => {
  for (const model of ["openai/gpt-6.1-sol:high", modelSpec("hybrid-subagents.designer")]) {
    const result = await resolveSubagentLaunchContract({ agent: "hybrid-subagents.worker", cwd: fixture, model, fast: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /[Ff]ast/);
  }
});

test("backup relaunch: per-run backup model needs fast:false when the role uses Fast", async () => {
  try {
    await saveSelection(fixture, "hybrid-subagents.worker", ROLES["hybrid-subagents.worker"], "user", true);
    const backup = modelSpec("hybrid-subagents.designer");
    const rejected = await resolveSubagentLaunchContract({ agent: "hybrid-subagents.worker", cwd: fixture, model: backup });
    assert.equal(rejected.ok, false);
    const result = await resolveSubagentLaunchContract({ agent: "hybrid-subagents.worker", cwd: fixture, model: backup, fast: false });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.contract.model, backup);
  } finally {
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
  }
});
