import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describeSelection, isRole, modelSpec, ROLES, ROLE_NAMES, supportsFast, type ModelSelection, type RoleName } from "./models.ts";
import { configuredBackup, configuredFast, configuredSelection, saveBackup, saveSelection, type SettingsScope } from "./native-settings.ts";

const FAST_CHOICES = ["Off — standard service tier", "On — priority service tier (faster, higher usage/cost)"];

const USAGE = "/hyagents models [worker|scout|reviewer|designer|reset]";

async function chooseScope(ctx: ExtensionCommandContext): Promise<SettingsScope | undefined> {
  const choices = ["User — all projects", ...(ctx.isProjectTrusted() ? ["Project — this project only"] : [])];
  const choice = await ctx.ui.select("Save model settings", choices);
  return choice === choices[0] ? "user" : choice === choices[1] && choices.length > 1 ? "project" : undefined;
}

async function reportSaved(name: RoleName, wanted: ModelSelection, fast: boolean, file: string, ctx: ExtensionCommandContext): Promise<void> {
  // Display the effective selection as well as the saved one. A project override
  // can legitimately shadow a user setting; never claim that it took effect.
  const saved = describeSelection(wanted, fast);
  try {
    const actual = await configuredSelection(name, ctx);
    const effective = describeSelection(actual, await configuredFast(name, ctx));
    const shadowed = effective !== saved;
    ctx.ui.notify(`${name}: saved ${saved}\n${file}\n${shadowed
      ? `Current project uses ${effective}. Change the project setting to override it.`
      : "Applies to new children. Existing and retained children keep their original selection."}`, shadowed ? "warning" : "info");
  } catch (error) {
    ctx.ui.notify(`${name}: saved ${saved}\n${file}\nNot ready: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

export async function modelCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Model selection requires an interactive or dialog-capable RPC client. Configure subagents.agentOverrides in Pi settings for headless use.", "warning");
    return;
  }
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) { ctx.ui.notify(`Usage: ${USAGE}`, "error"); return; }
  const target = parts[0];
  if (target === "reset") {
    const scope = await chooseScope(ctx);
    if (!scope) return;
    if (!await ctx.ui.confirm("Restore Hybrid Subagents defaults?", `${ROLE_NAMES.map((name) => `${name}: ${modelSpec(name)}`).join("\n")}\nFast mode: off for all roles.\n\nSave to ${scope} settings. Other agent settings are preserved.`)) return;
    for (const name of ROLE_NAMES) {
      const file = await saveSelection(ctx.cwd, name, ROLES[name], scope, false);
      await reportSaved(name, ROLES[name], false, file, ctx);
    }
    return;
  }
  let name = target?.startsWith("hyagents.") ? target : target ? `hyagents.${target}` : undefined;
  if (name && !isRole(name)) { ctx.ui.notify(`Unknown role. Usage: ${USAGE}`, "error"); return; }
  if (!name) {
    const labels = await Promise.all(ROLE_NAMES.map(async (role) => {
      try { return `${role.slice(9)} — ${describeSelection(await configuredSelection(role, ctx), await configuredFast(role, ctx))}`; }
      catch { return `${role.slice(9)} — configuration needs attention`; }
    }));
    const chosen = await ctx.ui.select("Hybrid Subagents models", labels);
    if (!chosen) return;
    name = ROLE_NAMES[labels.indexOf(chosen)];
  }
  if (!name || !isRole(name)) return;
  const models = ctx.modelRegistry.getAvailable();
  if (models.length === 0) { ctx.ui.notify("No configured models. Authenticate a provider in Pi first, then reopen /hyagents models.", "warning"); return; }
  const provider = await ctx.ui.select(`${name} — provider`, [...new Set(models.map((model) => model.provider))].sort());
  if (!provider) return;
  const candidates = models.filter((model) => model.provider === provider).sort((a, b) => a.id.localeCompare(b.id));
  const id = await ctx.ui.select(`${name} — ${provider}`, candidates.map((model) => model.id));
  const model = candidates.find((item) => item.id === id);
  if (!model) return;
  const levels = getSupportedThinkingLevels(model);
  const thinking = await ctx.ui.select(`${name} — thinking`, levels);
  if (!thinking || !levels.includes(thinking as typeof levels[number])) return;
  const selection: ModelSelection = { provider: model.provider, id: model.id, thinking: thinking as typeof levels[number] };
  let fast = false;
  if (supportsFast(selection.provider)) {
    const choice = await ctx.ui.select(`${name} — fast mode`, FAST_CHOICES);
    if (!choice || !FAST_CHOICES.includes(choice)) return;
    fast = choice === FAST_CHOICES[1];
  } else {
    ctx.ui.notify("Fast mode is available only for the legacy openai-codex provider. This selection uses Fast off.", "info");
  }
  const scope = await chooseScope(ctx);
  if (!scope) return;
  const file = await saveSelection(ctx.cwd, name, selection, scope, fast);
  await reportSaved(name, selection, fast, file, ctx);
}

export async function backupCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify("Model selection requires an interactive or dialog-capable RPC client. Configure subagents.agentOverrides in Pi settings for headless use.", "warning"); return; }
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const usage = "/hyagents backup [worker|scout|reviewer|designer]";
  if (parts.length > 1) { ctx.ui.notify(`Usage: ${usage}`, "error"); return; }
  let name = parts[0]?.startsWith("hyagents.") ? parts[0] : parts[0] ? `hyagents.${parts[0]}` : undefined;
  if (name && !isRole(name)) { ctx.ui.notify(`Unknown role. Usage: ${usage}`, "error"); return; }
  if (!name) {
    const labels = await Promise.all(ROLE_NAMES.map(async (role) => {
      try { const backup = await configuredBackup(ctx, role); return `${role.slice(9)} — ${backup ? modelSpec(backup) : "none"}`; }
      catch { return `${role.slice(9)} — configuration needs attention`; }
    }));
    const chosen = await ctx.ui.select("Hybrid Subagents backups", labels);
    if (!chosen) return;
    name = ROLE_NAMES[labels.indexOf(chosen)];
  }
  if (!name || !isRole(name)) return;
  const models = ctx.modelRegistry.getAvailable();
  const none = "None — no backup";
  const provider = await ctx.ui.select(`${name} — backup provider`, [none, ...[...new Set(models.map((model) => model.provider))].sort()]);
  if (!provider) return;
  let selection: ModelSelection | undefined;
  if (provider !== none) {
    const candidates = models.filter((model) => model.provider === provider).sort((a, b) => a.id.localeCompare(b.id));
    const id = await ctx.ui.select(`${name} — ${provider}`, candidates.map((model) => model.id));
    const model = candidates.find((item) => item.id === id);
    if (!model) return;
    const levels = getSupportedThinkingLevels(model);
    const thinking = await ctx.ui.select(`${name} — thinking`, levels);
    if (!thinking || !levels.includes(thinking as typeof levels[number])) return;
    selection = { provider: model.provider, id: model.id, thinking: thinking as typeof levels[number] };
    const primary = await configuredSelection(name, ctx);
    if (primary.provider === selection.provider && primary.id === selection.id) { ctx.ui.notify(`${name}: backup must differ from the primary model.`, "warning"); return; }
  }
  const scope = await chooseScope(ctx);
  if (!scope) return;
  const file = await saveBackup(ctx.cwd, name, selection, scope);
  ctx.ui.notify(`${name}: backup ${selection ? `saved ${modelSpec(selection)}` : "cleared"}\n${file}\nApplies to new children.`, "info");
}

export function modelCompletions(prefix: string): { value: string; label: string }[] | null {
  const values = ["models", "backup", ...["worker", "scout", "reviewer", "designer", "reset"].map((name) => `models ${name}`), ...["worker", "scout", "reviewer", "designer"].map((name) => `backup ${name}`)]
    .filter((value) => value.startsWith(prefix));
  return values.length ? values.map((value) => ({ value, label: value })) : null;
}
