import type { RoleConfig, Runtime } from "./config.ts";

export const RUNTIMES = ["claude", "codex", "copilot"] as const;

/**
 * Reasoning effort values each CLI accepts. Which of them a model supports is
 * up to the model and is checked by the CLI at launch.
 */
export const EFFORTS: Record<Runtime, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  copilot: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};

export const FAST_SUPPORTED: Record<Runtime, boolean> = { claude: true, codex: true, copilot: false };

export function isRuntime(value: unknown): value is Runtime {
  return typeof value === "string" && (RUNTIMES as readonly string[]).includes(value);
}

/**
 * CLI arguments for an interactive, full-access specialist. herdr quotes each
 * argument itself, so values are passed verbatim.
 */
export function runtimeArgs(role: RoleConfig): { args: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const fast = role.fast && FAST_SUPPORTED[role.runtime];
  if (role.fast && !fast) warnings.push(`${role.runtime} has no Fast mode; starting without it.`);
  const effort = role.effort ?? undefined;
  let args: string[];
  switch (role.runtime) {
    case "claude":
      args = ["--model", role.model, ...(effort ? ["--effort", effort] : []), "--dangerously-skip-permissions",
        ...(fast ? ["--settings", JSON.stringify({ fastMode: true })] : [])];
      break;
    case "codex":
      // Codex sends service_tier "fast" as the priority tier.
      args = ["-m", role.model, ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
        "--dangerously-bypass-approvals-and-sandbox", ...(fast ? ["-c", 'service_tier="fast"'] : [])];
      break;
    case "copilot":
      args = ["--model", role.model, ...(effort ? ["--reasoning-effort", effort] : []), "--yolo"];
      break;
  }
  return { args: [...args, ...role.args], warnings };
}
