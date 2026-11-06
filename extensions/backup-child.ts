import { getSupportedThinkingLevels, isContextOverflow } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeAgent, isRole, modelSpec } from "../src/models.ts";
import { configuredBackup } from "../src/native-settings.ts";

export default function backupChild(pi: ExtensionAPI): void {
  let switched = false;
  pi.on("session_start", (_event, ctx) => {
    switched = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "hyagents.backup");
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (switched) return;
    const name = activeAgent(ctx.getSystemPrompt());
    if (!name || !isRole(name)) return;
    const message = [...event.context.contextMessages].reverse().find((item) => item.role === "assistant");
    if (!message || message.role !== "assistant" || message.stopReason !== "error" || isContextOverflow(message, ctx.model?.contextWindow)) return;
    let backup;
    try { backup = await configuredBackup(ctx, name); } catch { return; }
    if (!backup || !ctx.model || (backup.provider === ctx.model.provider && backup.id === ctx.model.id)) return;
    const model = ctx.modelRegistry.find(backup.provider, backup.id);
    if (!model || !getSupportedThinkingLevels(model).includes(backup.thinking)) return;
    const previous = `${ctx.model.provider}/${ctx.model.id}`;
    try { if (!await pi.setModel(model)) return; } catch { return; }
    pi.setThinkingLevel(backup.thinking);
    switched = true;
    return { entries: [...event.entries, { type: "custom_message", customType: "hyagents.backup", content: `The previous model ${previous} failed: ${(message.errorMessage ?? "unknown error").slice(0, 300)}. You now run on backup ${modelSpec(backup)}. Continue the assigned task from where it stopped without repeating completed steps; mention the switch in the final report.`, display: false }], continue: true };
  });
  pi.on("before_provider_request", (event) => {
    if (!switched || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
    const payload = event.payload as Record<string, unknown>;
    if (payload.service_tier !== "priority") return;
    const { service_tier: _tier, ...rest } = payload;
    return rest;
  });
}
