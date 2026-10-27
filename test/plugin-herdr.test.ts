import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { HerdrCli, type HerdrEvent } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/herdr.ts";
import { HyError } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/util.ts";

const fixture = mkdtempSync(path.join(tmpdir(), "hyagents-plugin-herdr-"));
after(() => rmSync(fixture, { recursive: true, force: true }));

// A stand-in for the herdr CLI: logs argv and answers like herdr's print_response.
const bin = path.join(fixture, "herdr");
const log = path.join(fixture, "argv.log");
writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const key = args.slice(0, 2).join(" ");
const ok = (result) => { console.log(JSON.stringify({ id: "cli", result })); };
const fail = (code, message) => { console.error(JSON.stringify({ id: "cli", error: { code, message } })); process.exit(1); };
if (key === "pane split") ok({ type: "pane_info", pane: { pane_id: "w1:p7", tab_id: "w1:t1", workspace_id: "w1", agent_status: "idle" } });
else if (key === "agent start") ok({ type: "agent_started", agent: { pane_id: args[5], name: args[2], agent: args[4], agent_status: "idle" }, argv: [] });
else if (key === "agent get") args[2] === "w1:p404" ? fail("agent_not_found", "no agent") : ok({ type: "agent_info", agent: { pane_id: args[2], agent_status: "working", state_change_seq: 9 } });
else if (key === "agent prompt") fail("agent_blocked", "agent is blocked");
else if (key === "pane close") fail("pane_not_found", "pane not found");
else if (key === "pane read") process.stdout.write("line 1\\nline 2\\n");
else if (args[0] === "--version") console.log("herdr 0.9.5");
else fail("unknown_method", key);
`);
chmodSync(bin, 0o755);
const argv = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);

test("CLI commands pass arguments verbatim and parse herdr's JSON responses", async () => {
  const herdr = new HerdrCli({ HYAGENTS_HERDR_BIN: bin });
  const pane = await herdr.paneSplit("w1:p1", { direction: "right", ratio: 0.4, cwd: "/my repo", env: { HYAGENTS_ROLE: "worker", HYAGENTS_MAIN: "w1:p1" } });
  assert.equal(pane.pane_id, "w1:p7");
  const agent = await herdr.agentStart("worker-1", "claude", "w1:p7", ["--model", "claude-opus-5-5", "--settings", '{"fastMode":true}'], 90_000);
  assert.equal(agent.name, "worker-1");
  assert.equal((await herdr.agentGet("w1:p7"))?.state_change_seq, 9);
  assert.equal(await herdr.agentGet("w1:p404"), undefined);
  await herdr.paneClose("w1:p404");
  assert.equal(await herdr.paneRead("w1:p7"), "line 1\nline 2\n");
  assert.equal(await herdr.version(), "herdr 0.9.5");
  await assert.rejects(herdr.agentPrompt("w1:p7", "hello"), (error: HyError) => error.code === "agent_blocked" && error.message === "agent is blocked");
  assert.deepEqual(argv().slice(0, 2), [
    ["pane", "split", "w1:p1", "--direction", "right", "--cwd", "/my repo", "--no-focus", "--ratio", "0.4", "--env", "HYAGENTS_ROLE=worker", "--env", "HYAGENTS_MAIN=w1:p1"],
    ["agent", "start", "worker-1", "--kind", "claude", "--pane", "w1:p7", "--timeout", "90000", "--", "--model", "claude-opus-5-5", "--settings", '{"fastMode":true}'],
  ]);
});

test("a missing herdr binary is reported clearly", async () => {
  const herdr = new HerdrCli({ HYAGENTS_HERDR_BIN: path.join(fixture, "nope") });
  await assert.rejects(herdr.version(), (error: HyError) => error.code === "herdr_missing");
});

test("socket requests and event subscriptions use herdr's newline-delimited JSON protocol", async () => {
  const socketPath = path.join(fixture, "herdr.sock");
  const requests: Record<string, any>[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      requests.push(request);
      const reply = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
      if (request.method === "layout.export") reply({ id: request.id, result: { type: "layout_export", layout: { workspace_id: "w1", tab_id: "w1:t1", root: { type: "pane", pane_id: "w1:p1" } } } });
      else if (request.method === "layout.set_split_ratio") reply({ id: request.id, error: { code: "split_not_found", message: "split path not found" } });
      else if (request.method === "events.subscribe") {
        // Two events in one write, then a partial line, then events_lost.
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        socket.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p2", agent_status: "working" } })}\n${JSON.stringify({ event: "pane.closed", data: { type: "pane_closed", pane_id: "w1:p3" } })}\n{"event":"pane.ex`);
        setTimeout(() => socket.write(`ited","data":{"pane_id":"w1:p4"}}\n${JSON.stringify({ id: request.id, error: { code: "events_lost", message: "fell behind" } })}\n`), 20);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const herdr = new HerdrCli({ HERDR_SOCKET_PATH: socketPath });
    assert.equal((await herdr.layoutExport("w1:p1")).tab_id, "w1:t1");
    await assert.rejects(herdr.layoutSetSplitRatio("w1:t1", [true, false], 0.5), (error: HyError) => error.code === "split_not_found");
    const events: HerdrEvent[] = [];
    const closed = new Promise<Error | undefined>((resolve) => {
      void herdr.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p2" }, { type: "pane.closed" }], (event) => events.push(event), resolve);
    });
    const error = await closed;
    assert.equal((error as HyError).code, "events_lost");
    assert.deepEqual(events.map((event) => [event.event, event.data.pane_id]), [["pane.agent_status_changed", "w1:p2"], ["pane.closed", "w1:p3"], ["pane.exited", "w1:p4"]]);
    assert.deepEqual(requests.map((request) => [request.method, request.params]), [
      ["layout.export", { pane_id: "w1:p1" }],
      ["layout.set_split_ratio", { tab_id: "w1:t1", path: [true, false], ratio: 0.5 }],
      ["events.subscribe", { subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p2" }, { type: "pane.closed" }] }],
    ]);
  } finally {
    server.close();
  }
});

test("socket operations outside herdr fail with a clear error", async () => {
  await assert.rejects(new HerdrCli({}).layoutExport("w1:p1"), (error: HyError) => error.code === "herdr_socket_missing");
});
