import type { Runtime } from "./config.ts";

/**
 * Startup screens the user agreed to accept automatically. Matching is
 * best-effort text detection; anything unrecognized is reported to Main.
 */
interface Dialog {
  id: string;
  runtime: Runtime;
  detect: RegExp;
  /** The option to select. */
  accept?: RegExp;
  /** Keys to send when the selected option cannot be identified, if that is safe. */
  fallback?: string[];
  /** Keys that dismiss the screen directly. */
  keys?: string[];
}

const DIALOGS: Dialog[] = [
  { id: "claude-bypass-permissions", runtime: "claude", detect: /Bypass Permissions mode/i, accept: /Yes,?\s+I\s+accept/i },
  {
    id: "claude-trust-folder", runtime: "claude",
    detect: /trust\s+(the\s+files\s+in\s+)?this\s+folder|project\s+you\s+created\s+or\s+one\s+you\s+trust/i,
    accept: /Yes,?\s+(I\s+trust|proceed|continue)/i, fallback: ["enter"],
  },
  { id: "codex-update-picker", runtime: "codex", detect: /Update\s+available[\s\S]*esc\s+skip/i, keys: ["esc"] },
  { id: "codex-update", runtime: "codex", detect: /Update\s+available!/i, accept: /^Skip(?!\s+until)/i },
  {
    id: "codex-trust-directory", runtime: "codex",
    detect: /Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?|Trust\s+this\s+folder\?/i,
    accept: /Yes,?\s+continue|Trust\s+and\s+continue/i, fallback: ["enter"],
  },
  {
    id: "copilot-trust-folder", runtime: "copilot",
    detect: /trust\s+the\s+files\s+in\s+this\s+folder|folder\s+trust/i,
    accept: /Yes,?\s+and\s+remember/i, fallback: ["enter"],
  },
];

// `>` is left out: Codex starts its trust screen with "> You are in <dir>".
const SELECTED = /^\s*[❯›▶➤]\s*(?:\d+[.)]\s*)?(.*\S)/;
const OPTION = /^\s*(?:[❯›▶➤]\s*)?(?:\d+[.)]\s*)?(.*\S)/;

export type DialogStep = { id: string; keys: string[] };

/**
 * One key step toward accepting a recognized dialog, or undefined when the
 * screen is not a known startup dialog. Call again after each step.
 */
export function dialogStep(runtime: Runtime, screen: string): DialogStep | undefined {
  const dialog = DIALOGS.find((item) => item.runtime === runtime && item.detect.test(screen));
  if (!dialog) return undefined;
  if (dialog.keys) return { id: dialog.id, keys: dialog.keys };
  const lines = screen.split(/\r?\n/);
  const target = lines.findIndex((line) => dialog.accept!.test(OPTION.exec(line)?.[1] ?? ""));
  // A prompt marker elsewhere on screen is not the selection; take the one nearest the option.
  const selected = lines.map((line, index) => (SELECTED.test(line) ? index : -1)).filter((index) => index >= 0)
    .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] ?? -1;
  if (selected >= 0 && target >= 0) {
    if (selected === target) return { id: dialog.id, keys: ["enter"] };
    return { id: dialog.id, keys: [target > selected ? "down" : "up"] };
  }
  return dialog.fallback ? { id: dialog.id, keys: dialog.fallback } : undefined;
}
