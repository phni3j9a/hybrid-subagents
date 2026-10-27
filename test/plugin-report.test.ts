import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fixLine, initialBrief, promptLine } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/brief.ts";
import { dialogStep } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/dialogs.ts";
import { formatNotices } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/notify.ts";
import { checkReport, loadReviewSchema, reviewErrors } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/report.ts";
import { hasControlChars } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/util.ts";

const fixture = mkdtempSync(path.join(tmpdir(), "hyagents-plugin-report-"));
after(() => rmSync(fixture, { recursive: true, force: true }));

const finding = { title: "Guard the empty list", body: "Empty input crashes the parser and stops the import.", priority: 1, confidence: 0.8, file_path: "src/a.ts", line_start: 4, line_end: 6 };
const review = { overall_correctness: "incorrect", explanation: "One crash.", confidence: 0.9, findings: [finding] };

test("the bundled review schema is the Pi reviewer's outputSchema", () => {
  const pi = readFileSync(new URL("../agents/reviewer.md", import.meta.url), "utf8").split("\n").find((line) => line.startsWith("outputSchema: "))!;
  const { $schema: _, title: __, ...schema } = loadReviewSchema() as Record<string, unknown>;
  assert.deepEqual(schema, JSON.parse(pi.slice("outputSchema: ".length)));
});

test("review reports are validated against the schema and line ranges", () => {
  assert.deepEqual(reviewErrors(review), []);
  assert.deepEqual(reviewErrors({ ...review, findings: [] }), []);
  assert.match(reviewErrors({ ...review, overall_correctness: "maybe" }).join(), /overall_correctness must be one of correct, incorrect/);
  assert.match(reviewErrors({ ...review, extra: 1 }).join(), /\$\.extra is not allowed/);
  assert.match(reviewErrors({ ...review, findings: [{ ...finding, priority: 4 }] }).join(), /priority must be <= 3/);
  assert.match(reviewErrors({ ...review, findings: [{ ...finding, priority: 1.5 }] }).join(), /priority must be integer/);
  assert.match(reviewErrors({ ...review, findings: [{ ...finding, title: "x".repeat(81) }] }).join(), /title must not be longer than 80/);
  assert.match(reviewErrors({ ...review, findings: [{ ...finding, line_end: 3 }] }).join(), /line_end must be >= line_start/);
  assert.match(reviewErrors({ explanation: "x" }).join(), /overall_correctness is required/);
});

test("checkReport distinguishes missing, valid and invalid reports", () => {
  const md = path.join(fixture, "report.md");
  const json = path.join(fixture, "report.json");
  assert.equal(checkReport("worker", md).status, "missing");
  writeFileSync(md, "");
  assert.equal(checkReport("worker", md).status, "missing");
  writeFileSync(md, "# Done\n");
  assert.equal(checkReport("worker", md).status, "ok");
  writeFileSync(json, "```json\n{}\n```");
  assert.match(JSON.stringify(checkReport("reviewer", json)), /not valid JSON/);
  writeFileSync(json, JSON.stringify(review));
  assert.equal(checkReport("reviewer", json).status, "ok");
});

test("briefs carry the role, task and report contract; prompts stay on one line", () => {
  const brief = initialBrief("reviewer-1", "reviewer", "Review HEAD~1..HEAD.", "/state/reviewer-1/report.json");
  assert.match(brief, /You are the Hybrid Subagents Reviewer/);
  assert.match(brief, /Review HEAD~1\.\.HEAD\./);
  assert.match(brief, /`\/state\/reviewer-1\/report\.json`/);
  assert.match(brief, /"overall_correctness"/);
  assert.match(brief, /Work without asking interactive questions/);
  assert.ok(!hasControlChars(promptLine("/s/brief.md", "/s/report.md")));
  assert.match(fixLine("/s/report.json", ["$.a is required"]), /\$\.a is required/);
});

const CLAUDE_TRUST = `Do you trust the files in this folder?\n\n/repo\n\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel`;
const CLAUDE_BYPASS = `WARNING: Claude Code running in Bypass Permissions mode\n\n❯ 1. No, exit\n  2. Yes, I accept\n\nEnter to confirm · Esc to cancel`;
const CODEX_TRUST = `> You are in /repo\n\n  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk.\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue`;
const CODEX_UPDATE = `  Update available · 0.164.0 -> 0.165.0\n\n  enter continue · esc skip`;
const COPILOT_TRUST = `Confirm folder trust\n\n❯ 1. Yes\n  2. Yes, and remember this folder for future sessions\n  3. No (Esc)`;

test("recognized startup dialogs are accepted one key at a time; unknown screens are not", () => {
  assert.deepEqual(dialogStep("claude", CLAUDE_TRUST), { id: "claude-trust-folder", keys: ["enter"] });
  assert.deepEqual(dialogStep("claude", CLAUDE_BYPASS), { id: "claude-bypass-permissions", keys: ["down"] });
  assert.deepEqual(dialogStep("claude", CLAUDE_BYPASS.replace("❯ 1. No", "  1. No").replace("  2. Yes", "❯ 2. Yes")), { id: "claude-bypass-permissions", keys: ["enter"] });
  // "> You are in" is a heading, not the selection.
  assert.deepEqual(dialogStep("codex", CODEX_TRUST), { id: "codex-trust-directory", keys: ["enter"] });
  assert.deepEqual(dialogStep("codex", CODEX_UPDATE), { id: "codex-update-picker", keys: ["esc"] });
  assert.deepEqual(dialogStep("copilot", COPILOT_TRUST), { id: "copilot-trust-folder", keys: ["down"] });
  assert.equal(dialogStep("claude", "Which database should I use?\n❯ 1. Postgres\n  2. SQLite"), undefined);
  assert.equal(dialogStep("codex", CLAUDE_TRUST), undefined, "dialogs are matched per runtime");
});

test("notices are one line, list running specialists and are marked as not from the user", () => {
  const text = formatNotices([
    { kind: "completed", name: "worker-1", report: "/s/worker-1/report.md" },
    { kind: "needs_input", name: "designer-1", screen: "Pick a color\n❯ 1. Blue" },
    { kind: "invalid_report", name: "reviewer-1", report: "/s/r.json", errors: ["$.findings is required"] },
  ], ["scout-1"]);
  assert.ok(!hasControlChars(text));
  assert.match(text, /^\[hybrid-subagents\] Notice for Main, not from the user:/);
  assert.match(text, /worker-1 completed; report: \/s\/worker-1\/report\.md\./);
  assert.match(text, /designer-1 needs input in its pane: "Pick a color ❯ 1\. Blue"\./);
  assert.match(text, /reviewer-1 wrote an invalid report/);
  assert.match(text, /Still running: scout-1\.$/);
});
