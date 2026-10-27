import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { close, mainContext, send, start, type Deps } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/commands.ts";
import { readChild } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/state.ts";
import { Watcher } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/watcher.ts";
import { FakeHerdr } from "./helpers/fake-herdr.ts";

const fixture = mkdtempSync(path.join(tmpdir(), "hyagents-plugin-watcher-"));
after(() => rmSync(fixture, { recursive: true, force: true }));

const MAIN = "w1:p1";
const env = {
  HERDR_ENV: "1", HERDR_PANE_ID: MAIN, HERDR_SOCKET_PATH: "/run/herdr/test.sock",
  XDG_STATE_HOME: path.join(fixture, "state"), XDG_CONFIG_HOME: path.join(fixture, "config"),
};
let herdr: FakeHerdr;
let deps: Deps;
let watcher: Watcher;
let stopped: string[];
const dir = () => mainContext(env).dir;

beforeEach(() => {
  rmSync(fixture, { recursive: true, force: true });
  herdr = new FakeHerdr(MAIN);
  deps = { env, cwd: "/repo", herdr, wakeWatcher: () => undefined };
  stopped = [];
  watcher = new Watcher({ herdr, dir: dir(), debounceMs: 5, mainGraceMs: 10, recheckMs: 20, onStop: (reason) => stopped.push(reason) });
});

async function settle(ms = 40): Promise<void> {
  for (let i = 0; i < 3; i++) { await new Promise((resolve) => setTimeout(resolve, ms)); await watcher.queue; }
}

const mainPrompts = () => herdr.prompts.filter((prompt) => prompt.target === MAIN).map((prompt) => prompt.text);
const childPrompts = (pane: string) => herdr.prompts.filter((prompt) => prompt.target === pane).map((prompt) => prompt.text);
const report = (name: string, text = "# Done\n") => writeFileSync(readChild(dir(), name)!.report, text);

async function finish(pane: string, name: string, text?: string): Promise<void> {
  herdr.setStatus(pane, "working");
  if (text !== null) report(name, text);
  herdr.setStatus(pane, "idle");
  await settle();
}

test("completions reach Main as one notice when Main is idle, never while it works", async () => {
  const worker = await start(deps, { role: "worker", task: "a" });
  const designer = await start(deps, { role: "designer", task: "b" });
  const scout = await start(deps, { role: "scout", task: "c" });
  await watcher.start();
  herdr.setStatus(worker.pane, "working");
  herdr.setStatus(designer.pane, "working");
  report("worker-1");
  report("designer-1");
  herdr.setStatus(worker.pane, "idle");
  herdr.setStatus(designer.pane, "done");
  await settle();
  assert.deepEqual(mainPrompts(), [
    `[hybrid-subagents] Notice for Main, not from the user: worker-1 completed; report: ${worker.report}. designer-1 completed; report: ${designer.report}. Still running: scout-1.`,
  ]);

  herdr.setStatus(MAIN, "working");
  await finish(scout.pane, "scout-1");
  assert.equal(mainPrompts().length, 1, "no notice while Main works");
  herdr.setStatus(MAIN, "idle");
  await settle();
  assert.match(mainPrompts()[1], /scout-1 completed/);
  assert.doesNotMatch(mainPrompts()[1], /Still running/);
});

test("a specialist that stops without a report is asked once, then reported", async () => {
  const worker = await start(deps, { role: "worker", task: "a" });
  await watcher.start();
  herdr.setStatus(worker.pane, "working");
  herdr.setStatus(worker.pane, "idle");
  await settle();
  assert.equal(childPrompts(worker.pane).length, 2);
  assert.match(childPrompts(worker.pane)[1], /ended without a report/);
  assert.deepEqual(mainPrompts(), []);
  herdr.setStatus(worker.pane, "working");
  herdr.setStatus(worker.pane, "idle");
  await settle();
  assert.match(mainPrompts()[0], /worker-1 stopped without a report/);
});

test("an invalid review is sent back once, then reported with its errors", async () => {
  const reviewer = await start(deps, { role: "reviewer", task: "Review." });
  await watcher.start();
  await finish(reviewer.pane, "reviewer-1", '{"overall_correctness":"maybe"}');
  assert.match(childPrompts(reviewer.pane)[1], /is invalid: .*\$\.overall_correctness must be one of correct, incorrect/);
  await finish(reviewer.pane, "reviewer-1", "{}");
  assert.match(mainPrompts()[0], /reviewer-1 wrote an invalid report .*overall_correctness is required/);
});

test("a valid review after a fix request completes normally", async () => {
  const reviewer = await start(deps, { role: "reviewer", task: "Review." });
  await watcher.start();
  await finish(reviewer.pane, "reviewer-1", "not json");
  await finish(reviewer.pane, "reviewer-1", JSON.stringify({ overall_correctness: "correct", explanation: "Fine.", confidence: 0.8, findings: [] }));
  assert.match(mainPrompts()[0], /reviewer-1 completed/);
});

test("unknown prompts are reported once; recognized dialogs are answered silently", async () => {
  const worker = await start(deps, { role: "worker", task: "a" });
  const codex = herdr.panes.get(worker.pane)!;
  await watcher.start();
  codex.screen = "  Update available · 0.164.0 -> 0.165.0\n\n  enter continue · esc skip";
  herdr.setStatus(worker.pane, "blocked");
  await settle();
  assert.deepEqual(herdr.keys, [{ pane: worker.pane, keys: ["esc"] }]);
  assert.deepEqual(mainPrompts(), []);
  codex.screen = "Implement this plan?\n› 1. Yes, implement\n  2. No, keep planning";
  herdr.setStatus(worker.pane, "blocked");
  herdr.setStatus(worker.pane, "blocked");
  await settle();
  assert.equal(mainPrompts().length, 1);
  assert.match(mainPrompts()[0], /worker-1 needs input in its pane: "Implement this plan\? \/ › 1\. Yes, implement \/ 2\. No, keep planning"/);
  assert.match(mainPrompts()[0], /Still running: worker-1/);
});

test("a specialist pane that disappears is reported; one closed by Main is not", async () => {
  const worker = await start(deps, { role: "worker", task: "a" });
  const scout = await start(deps, { role: "scout", task: "b" });
  await watcher.start();
  await close(deps, { name: "scout-1" });
  await herdr.paneClose(worker.pane);
  await settle();
  assert.deepEqual(mainPrompts(), ["[hybrid-subagents] Notice for Main, not from the user: worker-1 exited; its pane is gone."]);
  assert.equal(herdr.panes.has(scout.pane), false);
  assert.deepEqual(stopped, ["no specialists left"]);
});

test("closing Main's pane closes every specialist and removes the state", async () => {
  const worker = await start(deps, { role: "worker", task: "a" });
  const designer = await start(deps, { role: "designer", task: "b" });
  await watcher.start();
  await herdr.paneClose(MAIN);
  await settle();
  assert.equal(herdr.panes.has(worker.pane), false);
  assert.equal(herdr.panes.has(designer.pane), false);
  assert.equal(existsSync(dir()), false);
  assert.deepEqual(stopped, ["Main pane closed"]);
});

test("Main's agent must stay gone through the grace period before specialists are closed", async () => {
  const worker = await start(deps, { role: "worker", task: "a" });
  await watcher.start();
  herdr.setStatus(MAIN, "idle", null);
  herdr.panes.get(MAIN)!.agent = "claude";
  await settle(60);
  assert.equal(herdr.panes.has(worker.pane), true, "a brief detection gap is ignored");
  herdr.setStatus(MAIN, "idle", null);
  await settle(60);
  assert.equal(herdr.panes.has(worker.pane), false);
  assert.deepEqual(stopped, ["Main agent exited"]);
});

test("work finished before the watcher started is still reported, and follow-up turns are tracked", async () => {
  const worker = await start(deps, { role: "worker", task: "a" });
  herdr.setStatus(worker.pane, "working");
  report("worker-1");
  herdr.setStatus(worker.pane, "idle");
  await watcher.start();
  await settle();
  assert.match(mainPrompts()[0], /worker-1 completed/);

  const followUp = await send(deps, "worker-1", "Also update the docs.");
  await finish(worker.pane, "worker-1");
  assert.match(mainPrompts()[1], new RegExp(`worker-1 completed; report: ${followUp.report.replaceAll(".", "\\.")}`));
});
