import { oneLine } from "./util.ts";

export type Notice =
  | { kind: "completed"; name: string; report: string }
  | { kind: "needs_input"; name: string; screen: string }
  | { kind: "no_report"; name: string; report: string }
  | { kind: "invalid_report"; name: string; report: string; errors: string[] }
  | { kind: "exited"; name: string };

function describe(notice: Notice): string {
  switch (notice.kind) {
    case "completed": return `${notice.name} completed; report: ${notice.report}.`;
    case "needs_input": return `${notice.name} needs input in its pane: "${oneLine(notice.screen, 160)}".`;
    case "no_report": return `${notice.name} stopped without a report (expected ${notice.report}).`;
    case "invalid_report": return `${notice.name} wrote an invalid report ${notice.report}: ${oneLine(notice.errors.slice(0, 3).join("; "), 200)}.`;
    case "exited": return `${notice.name} exited; its pane is gone.`;
  }
}

/** One line, because herdr submits the notice as a prompt to Main. */
export function formatNotices(notices: Notice[], running: string[]): string {
  const parts = ["[hybrid-subagents] Notice for Main, not from the user:", ...notices.map(describe)];
  if (running.length) parts.push(`Still running: ${running.join(", ")}.`);
  return oneLine(parts.join(" "), 1800);
}
