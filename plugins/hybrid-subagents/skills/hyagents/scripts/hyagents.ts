#!/usr/bin/env node
// Hybrid Subagents helper for Claude Code, Codex and Copilot CLI running in herdr.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  claimWatcher, close, configReset, configSet, configShow, doctor, list, readPid, releaseWatcher, send, start, wakeWatcher,
  type Deps,
} from "./lib/commands.ts";
import { HerdrCli } from "./lib/herdr.ts";
import { HyError } from "./lib/util.ts";
import { Watcher } from "./lib/watcher.ts";

const USAGE = `Usage: node hyagents.ts <command>

  start --role <worker|scout|reviewer|designer> [--name <name>] [--cwd <dir>]   task on stdin
  send <name>                                    follow-up message on stdin
  close <name> | close --all
  list
  doctor
  config show
  config set <role> [--runtime <claude|codex|copilot>] [--model <id>] [--effort <level|default>]
                    [--fast <on|off>] [--args '<JSON array>'] --scope <user|project>
  config reset --scope <user|project> [--role <role>]`;

const BOOLEAN_FLAGS = new Set(["all", "help"]);

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[key] = inline;
    else if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
    else if (i + 1 < argv.length) flags[key] = argv[++i];
    else throw new HyError("usage", `--${key} needs a value.\n${USAGE}`);
  }
  return { positional, flags };
}

/** Reads piped input; gives up if nothing arrives, so an open but idle stdin cannot hang the call. */
function readStdin(idleMs = 5000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    const timer = setTimeout(() => { process.stdin.pause(); resolve(text); }, idleMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { clearTimeout(timer); text += chunk; });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(text); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(text); });
  });
}

const flag = (flags: Record<string, string | true>, name: string) => (typeof flags[name] === "string" ? flags[name] as string : undefined);

async function runWatcher(dir: string): Promise<void> {
  if (!claimWatcher(dir)) {
    const pid = readPid(dir);
    if (pid) process.kill(pid, "SIGHUP");
    return;
  }
  const watcher = new Watcher({
    herdr: new HerdrCli(),
    dir,
    log: (message) => console.log(`${new Date().toISOString()} ${message}`),
    onStop: () => { releaseWatcher(dir); setTimeout(() => process.exit(0), 50); },
  });
  process.on("SIGHUP", () => void watcher.reload());
  process.on("SIGTERM", () => watcher.stop("terminated"));
  process.on("SIGINT", () => watcher.stop("interrupted"));
  await watcher.start();
}

async function main(argv: string[]): Promise<unknown> {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  const deps: Deps = { env: process.env, cwd: process.cwd(), herdr: new HerdrCli(), wakeWatcher };
  if (!command || command === "help" || flags.help) return { usage: USAGE };
  switch (command) {
    case "start": {
      const role = flag(flags, "role");
      if (!role) throw new HyError("usage", `start needs --role.\n${USAGE}`);
      return start(deps, { role, task: await readStdin(), name: flag(flags, "name"), cwd: flag(flags, "cwd") });
    }
    case "send":
      if (!rest[0]) throw new HyError("usage", `send needs a specialist name.\n${USAGE}`);
      return send(deps, rest[0], await readStdin());
    case "close":
      if (flags.all) return close(deps, { all: true });
      if (!rest[0]) throw new HyError("usage", `close needs a name or --all.\n${USAGE}`);
      return close(deps, { name: rest[0] });
    case "list":
      return list(deps);
    case "doctor":
      return doctor(deps);
    case "config": {
      const [sub, role] = rest;
      if (sub === "show") return configShow(deps.cwd, deps.env);
      if (sub === "set") {
        if (!role) throw new HyError("usage", `config set needs a role.\n${USAGE}`);
        return configSet(deps.cwd, deps.env, role, {
          runtime: flag(flags, "runtime"), model: flag(flags, "model"), effort: flag(flags, "effort"),
          fast: flag(flags, "fast"), args: flag(flags, "args"), scope: flag(flags, "scope"),
        });
      }
      if (sub === "reset") return configReset(deps.cwd, deps.env, { scope: flag(flags, "scope"), role: flag(flags, "role") });
      throw new HyError("usage", USAGE);
    }
    case "watch": {
      const dir = flag(flags, "dir");
      if (!dir) throw new HyError("usage", "watch needs --dir.");
      await runWatcher(dir);
      return undefined;
    }
    default:
      throw new HyError("usage", `Unknown command "${command}".\n${USAGE}`);
  }
}

function isEntry(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isEntry()) {
  main(process.argv.slice(2)).then((result) => {
    if (result !== undefined) console.log(JSON.stringify({ ok: true, ...(result as object) }));
  }, (error: unknown) => {
    const failure = error instanceof HyError
      ? { ok: false, error: error.code, message: error.message, ...error.details }
      : { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) };
    console.log(JSON.stringify(failure));
    process.exitCode = 1;
  });
}
