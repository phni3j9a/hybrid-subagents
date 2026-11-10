import { readFileSync } from "node:fs";
import type { RoleName } from "./config.ts";
import { REVIEW_SCHEMA_URL } from "./report.ts";

export function roleText(role: RoleName): string {
  return readFileSync(new URL(`../../roles/${role}.md`, import.meta.url), "utf8").trim();
}

function finishing(role: RoleName, report: string): string {
  const format = role === "reviewer"
    ? `Write exactly one JSON object, with no Markdown fence, that matches this JSON Schema:\n\n\`\`\`json\n${readFileSync(REVIEW_SCHEMA_URL, "utf8").trim()}\n\`\`\``
    : "Write Markdown. Start with the outcome, then the details your role asks for.";
  return [
    "## How to finish",
    "",
    "- Work without asking interactive questions. Make routine decisions yourself. If a decision is consequential or you are blocked, stop and explain it in the report instead.",
    "- Do not delegate to other agents and do not start Hybrid Subagents yourself.",
    `- As your last step, write the final report to \`${report}\` (overwrite it if it exists), then end your turn.`,
    "- Main reads only that file, never your screen, so the report must stand on its own.",
    "",
    format,
  ].join("\n");
}

export function initialBrief(name: string, role: RoleName, task: string, report: string): string {
  return [
    `# Hybrid Subagents task for ${name} (${role})`,
    "",
    "Main, another coding agent, started you through Hybrid Subagents in herdr. Main is not watching your screen.",
    "",
    "## Your role",
    "",
    roleText(role),
    "",
    "## Task",
    "",
    task.trim(),
    "",
    finishing(role, report),
    "",
  ].join("\n");
}

export function followUpBrief(name: string, role: RoleName, turn: number, message: string, report: string): string {
  return [
    `# Follow-up ${turn} for ${name} (${role})`,
    "",
    "Main sent this follow-up. Keep your role and earlier context.",
    "",
    "## Message",
    "",
    message.trim(),
    "",
    finishing(role, report),
    "",
  ].join("\n");
}

export const promptLine = (brief: string, report: string) =>
  `Read and follow ${brief}. When finished, write your final report to ${report} and end your turn.`;

export const nudgeLine = (report: string) =>
  `Your turn ended without a report. Write your final report to ${report} as described in your brief, then end your turn.`;

export const fixLine = (report: string, errors: string[]) =>
  `The report at ${report} is invalid: ${errors.slice(0, 5).join("; ")}. Rewrite it to match the schema in your brief, then end your turn.`;
