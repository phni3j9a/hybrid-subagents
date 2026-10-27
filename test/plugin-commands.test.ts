import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { close, list, mainContext, send, start, type Deps } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/commands.ts";
import { listChildren, readChild } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/state.ts";
import { HyError } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/util.ts";
import { FakeHerdr } from "./helpers/fake-herdr.ts";

const fixture = mkdtempSync(path.join(tmpdir(), "hyagents-plugin-commands-"));
after(() => rmSync(fixture, { recursive: true, force: true }));

let herdr: FakeHerdr;
let wakes: string[];
let deps: Deps;
const env = {
  HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/herdr/test.sock",
  XDG_STATE_HOME: path.join(fixture, "state"), XDG_CONFIG_HOME: path.join(fixture, "config"),
};
beforeEach(() => {
  rmSync(fixture, { recursive: true, force: true });
  herdr = new FakeHerdr();
  wakes = [];
  deps = { env, cwd: "/repo", herdr, wakeWatcher: (dir) => wakes.push(dir) };
});
const dir = () => mainContext(env).dir;

test("start opens a full-access specialist right of Main, writes its brief and prompts it in one line", async () => {
  const result = await start(deps, { role: "worker", task: "Fix the parser.\nKeep the API." });
  assert.equal(result.name, "worker-1");
  assert.equal(result.pane, "w1:p2");
  assert.deepEqual(herdr.root, { type: "split", direction: "right", ratio: 0.4, first: { type: "pane", pane_id: "w1:p1" }, second: { type: "pane", pane_id: "w1:p2" } });
  const pane = herdr.panes.get("w1:p2")!;
  assert.deepEqual(pane.env, { HYAGENTS_ROLE: "worker", HYAGENTS_MAIN: "w1:p1" });
  assert.equal(pane.cwd, "/repo");
  assert.deepEqual(herdr.starts[0], {
    name: "worker-1", kind: "codex", pane: "w1:p2",
    args: ["-m", "gpt-6-luna", "-c", 'model_reasoning_effort="max"', "--dangerously-bypass-approvals-and-sandbox"],
  });
  const record = readChild(dir(), "worker-1")!;
  assert.equal(record.blockedAtStart, false);
  assert.equal(record.promptSeq, pane.seq);
  assert.match(readFileSync(record.brief, "utf8"), /Fix the parser\.\nKeep the API\./);
  assert.deepEqual(herdr.prompts, [{ target: "w1:p2", text: `Read and follow ${record.brief}. When finished, write your final report to ${record.report} and end your turn.` }]);
  assert.equal(result.report, path.join(dir(), "children", "worker-1", "report.md"));
  assert.deepEqual(wakes, [dir()]);
});

test("later specialists stack below with equal heights and skip names herdr already uses", async () => {
  herdr.panes.get("w1:p1")!.name = "designer-1";
  await start(deps, { role: "worker", task: "a" });
  const second = await start(deps, { role: "designer", task: "b" });
  const third = await start(deps, { role: "reviewer", task: "c" });
  assert.equal(second.name, "designer-2");
  assert.equal(third.report.endsWith("report.json"), true);
  assert.equal(herdr.starts[1].kind, "claude");
  const sizes = herdr.sizes();
  for (const pane of ["w1:p2", "w1:p3", "w1:p4"]) assert.ok(Math.abs(sizes[pane].height - 1 / 3) < 1e-6);
  await assert.rejects(start(deps, { role: "worker", task: "d", name: "worker-1" }), /already exists/);
});

test("start refuses outside herdr, inside a specialist, and without a valid role or task", async () => {
  await assert.rejects(start({ ...deps, env: { ...env, HERDR_ENV: undefined } }, { role: "worker", task: "x" }), (error: HyError) => error.code === "not_in_herdr");
  await assert.rejects(start({ ...deps, env: { ...env, HYAGENTS_ROLE: "worker" } }, { role: "worker", task: "x" }), (error: HyError) => error.code === "specialist");
  await assert.rejects(start(deps, { role: "planner", task: "x" }), /Unknown role "planner"/);
  await assert.rejects(start(deps, { role: "scout", task: "  " }), (error: HyError) => error.code === "task_missing");
  assert.equal(herdr.panes.size, 1);
});

test("recognized startup dialogs are accepted before the task is sent", async () => {
  herdr.onStart = (pane, kind) => {
    pane.agent = kind;
    pane.status = "blocked";
    pane.screen = "Do you trust the files in this folder?\n\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel";
  };
  herdr.onKeys = (pane) => { pane.status = "idle"; pane.screen = "> "; };
  const result = await start(deps, { role: "designer", task: "Design the form." });
  assert.deepEqual(herdr.keys, [{ pane: result.pane, keys: ["enter"] }]);
  assert.equal(herdr.prompts.length, 1);
});

test("an unknown startup screen keeps the pane for the user; send then delivers the task", async () => {
  herdr.onStart = (pane, kind) => { pane.agent = kind; pane.status = "blocked"; pane.screen = "Log in to continue\nOpen https://example.test/device"; };
  await assert.rejects(start(deps, { role: "worker", task: "Fix it." }), (error: HyError) =>
    error.code === "startup_blocked" && error.details?.name === "worker-1" && /Log in to continue/.test(String(error.details?.screen)));
  assert.equal(readChild(dir(), "worker-1")!.blockedAtStart, true);
  assert.equal(herdr.prompts.length, 0);
  herdr.panes.get("w1:p2")!.status = "idle";
  const sent = await send(deps, "worker-1", "The user logged in.");
  assert.equal(sent.turn, 1);
  assert.equal(herdr.prompts.length, 1);
  assert.match(readFileSync(readChild(dir(), "worker-1")!.brief, "utf8"), /Additional note from Main\n\nThe user logged in\./);
});

test("a CLI that fails to start is cleaned up and its screen is returned", async () => {
  herdr.onStart = (pane) => { pane.screen = "zsh: command not found: codex"; };
  await assert.rejects(start(deps, { role: "worker", task: "x" }), (error: HyError) =>
    error.code === "start_failed" && /command not found: codex/.test(String(error.details?.screen)));
  assert.equal(herdr.panes.size, 1);
  assert.deepEqual(listChildren(dir()), []);
});

test("send starts a new turn with its own brief and report, but not while the specialist works", async () => {
  await start(deps, { role: "reviewer", task: "Review." });
  herdr.setStatus("w1:p2", "working");
  await assert.rejects(send(deps, "reviewer-1", "Also check tests."), (error: HyError) => error.code === "busy");
  herdr.setStatus("w1:p2", "idle");
  const result = await send(deps, "reviewer-1", "Also check tests.");
  assert.equal(result.turn, 2);
  assert.ok(result.report.endsWith(path.join("reviewer-1", "report-2.json")));
  const record = readChild(dir(), "reviewer-1")!;
  assert.match(readFileSync(record.brief, "utf8"), /# Follow-up 2 for reviewer-1/);
  assert.match(herdr.prompts.at(-1)!.text, /brief-2\.md/);
  await assert.rejects(send(deps, "nobody", "x"), (error: HyError) => error.code === "unknown_child");
});

test("close removes one specialist and rebalances; close --all removes every pane and the state", async () => {
  for (const role of ["worker", "scout", "designer"]) await start(deps, { role, task: "x" });
  const listed = await list(deps);
  assert.deepEqual(listed.children.map((child) => [child.name, child.status, child.reportStatus]),
    [["designer-1", "idle", "missing"], ["scout-1", "idle", "missing"], ["worker-1", "idle", "missing"]]);
  assert.deepEqual(await close(deps, { name: "scout-1" }), { closed: ["scout-1"] });
  assert.equal(herdr.panes.has("w1:p3"), false);
  for (const pane of ["w1:p2", "w1:p4"]) assert.ok(Math.abs(herdr.sizes()[pane].height - 0.5) < 1e-6);
  await assert.rejects(close(deps, { name: "scout-1" }), (error: HyError) => error.code === "unknown_child");
  assert.deepEqual((await close(deps, { all: true })).closed.sort(), ["designer-1", "worker-1"]);
  assert.deepEqual(herdr.root, { type: "pane", pane_id: "w1:p1" });
  assert.equal(existsSync(dir()), false);
  assert.deepEqual(await close(deps, { all: true }), { closed: [] });
});
