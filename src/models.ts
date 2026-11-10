import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export const ROLES = {
  "hybrid-subagents.worker": { provider: "openai-codex", id: "gpt-6-luna", thinking: "max" },
  "hybrid-subagents.scout": { provider: "openai-codex", id: "gpt-6-luna", thinking: "xhigh" },
  "hybrid-subagents.reviewer": { provider: "openai-codex", id: "gpt-6.1-sol", thinking: "high" },
  "hybrid-subagents.designer": { provider: "anthropic", id: "claude-opus-5-5", thinking: "high" },
} as const;

export type RoleName = keyof typeof ROLES;
export type Thinking = ReturnType<typeof getSupportedThinkingLevels>[number];
export interface ModelSelection { provider: string; id: string; thinking: Thinking }
export const ROLE_NAMES = Object.keys(ROLES) as RoleName[];

/** pi-subagents native Fast currently supports only the legacy Codex provider. */
export function supportsFast(provider: string): boolean {
  return provider === "openai-codex";
}

export function describeSelection(selection: ModelSelection, fast: boolean): string {
  return `${modelSpec(selection)}${fast ? " fast" : ""}`;
}

export function isRole(name: string): name is RoleName {
  return Object.hasOwn(ROLES, name);
}

export function modelSpec(name: RoleName | ModelSelection): string {
  const role = typeof name === "string" ? ROLES[name] : name;
  return `${role.provider}/${role.id}:${role.thinking}`;
}

/** pi-subagents adds this launch-owned tag to each native child's system prompt. */
export function activeAgent(prompt: string): string | undefined {
  return /(?:^|\n)<active_agent name="([^"]+)"\/>/.exec(prompt)?.[1];
}

export function parseSelection(spec: string, thinking?: string): ModelSelection {
  const match = /^(\S+?)\/(.+):(off|minimal|low|medium|high|xhigh|max)$/.exec(spec);
  const qualified = match ? `${match[1]}/${match[2]}` : spec;
  const separator = qualified.indexOf("/");
  const level = match?.[3] ?? thinking;
  if (separator < 1 || separator === qualified.length - 1 || !level || !/^(off|minimal|low|medium|high|xhigh|max)$/.test(level)) {
    throw new Error(`Hybrid Subagents requires an explicit provider/model and thinking level: ${spec}. Select them with /hybrid-subagents models.`);
  }
  return { provider: qualified.slice(0, separator), id: qualified.slice(separator + 1), thinking: level as Thinking };
}
