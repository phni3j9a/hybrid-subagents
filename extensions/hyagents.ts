import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerRequiredChildExtensions, type RequiredChildExtensionRegistration } from "pi-subagents/required-child-extensions";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { activeAgent, describeSelection, modelSpec, ROLE_NAMES } from "../src/models.ts";
import { configuredBackup, configuredFast, configuredSelection } from "../src/native-settings.ts";
import { backupCommand, modelCommand, modelCompletions } from "../src/model-command.ts";

const policy = readFileSync(new URL("../skills/hyagents/SKILL.md", import.meta.url), "utf8")
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

export default function hyagents(pi: ExtensionAPI): void {
  // Background children discover ambient extensions. They must not become another Main.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  let registration: RequiredChildExtensionRegistration | undefined;
  let registrationError: string | undefined;
  function dispose(): void { registration?.dispose(); registration = undefined; }

  async function diagnostics(ctx: ExtensionContext, includeRegistrationError = true): Promise<{ mapping: string[]; issues: string[] }> {
    const lines: string[] = [];
    const mapping: string[] = [];
    if (!pi.getAllTools().some((tool) => tool.name === "subagent")) {
      lines.push("pi-subagents is not loaded. Run: pi install npm:pi-subagents@0.76.1, then /reload.");
    }
    if (includeRegistrationError && registrationError) lines.push(registrationError);
    const available = ctx.modelRegistry.getAvailable();
    for (const name of ROLE_NAMES) {
      try {
        const role = await configuredSelection(name, ctx);
        const fast = await configuredFast(name, ctx);
        let backup;
        try { backup = await configuredBackup(ctx, name); }
        catch (error) { lines.push(`${name}: invalid backup: ${error instanceof Error ? error.message : String(error)}`); }
        mapping.push(`${name}: ${describeSelection(role, fast)}${backup ? ` (backup: ${modelSpec(backup)})` : ""}`);
        if (backup) {
          const candidate = ctx.modelRegistry.find(backup.provider, backup.id);
          if (!candidate) lines.push(`${name}: backup missing ${backup.provider}/${backup.id}; update Pi/provider model configuration.`);
          else if (!getSupportedThinkingLevels(candidate).includes(backup.thinking)) lines.push(`${name}: backup ${backup.thinking} is unsupported; choose a supported value with /hyagents backup.`);
          else if (!available.some((item) => item.provider === backup.provider && item.id === backup.id)) lines.push(`${name}: authenticate backup ${backup.provider} in Pi before use.`);
        }
        const model = ctx.modelRegistry.find(role.provider, role.id);
        if (!model) lines.push(`${name}: missing ${role.provider}/${role.id}; update Pi/provider model configuration.`);
        else if (!getSupportedThinkingLevels(model).includes(role.thinking)) lines.push(`${name}: ${role.thinking} is unsupported; choose a supported value with /hyagents models.`);
        else if (!available.some((item) => item.provider === role.provider && item.id === role.id)) lines.push(`${name}: authenticate ${role.provider} in Pi before use.`);
      } catch (error) { lines.push(error instanceof Error ? error.message : String(error)); }
    }
    return { mapping, issues: lines };
  }

  pi.on("session_start", async (_event, ctx) => {
    dispose();
    registrationError = undefined;
    if (activeAgent(ctx.getSystemPrompt())) return;
    try { registration = registerRequiredChildExtensions({ sessionId: ctx.sessionManager.getSessionId(), extensions: [{ id: "hyagents.backup", path: fileURLToPath(new URL("./backup-child.ts", import.meta.url)) }] }); }
    catch (error) { registrationError = `Automatic backup switching unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    const { issues } = await diagnostics(ctx, false);
    if (issues.length) ctx.ui.notify(issues.join("\n"), "warning");
  });

  pi.on("session_shutdown", dispose);

  pi.on("before_agent_start", (event) => {
    if (activeAgent(event.systemPrompt) || !event.systemPromptOptions.selectedTools.some((name) => name === "subagent" || name === "subagents_enable")) return;
    // Keep Pi's structured prompt and other extensions' sections (and prompt caching).
    event.systemPromptOptions.sections.hyagents = policy;
  });

  pi.registerCommand("hyagents", {
    description: "Show Hybrid Subagents readiness, or choose role models with /hyagents models",
    getArgumentCompletions: modelCompletions,
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        if (trimmed === "models" || trimmed.startsWith("models ")) {
          await modelCommand(trimmed.slice(6), ctx);
          return;
        }
        if (trimmed === "backup" || trimmed.startsWith("backup ")) {
          await backupCommand(trimmed.slice(6), ctx);
          return;
        }
        if (trimmed) { ctx.ui.notify("Usage: /hyagents [models [worker|scout|reviewer|designer|reset] | backup [worker|scout|reviewer|designer]]", "error"); return; }
        const { mapping, issues } = await diagnostics(ctx);
        ctx.ui.notify([...mapping, "", ...(issues.length ? issues : ["Model registry and authentication configuration ready. Live provider access is checked when each child runs."])].join("\n"), issues.length ? "warning" : "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
