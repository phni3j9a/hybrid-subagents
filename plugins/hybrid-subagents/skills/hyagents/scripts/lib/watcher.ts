import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fixLine, nudgeLine } from "./brief.ts";
import { dialogStep } from "./dialogs.ts";
import type { AgentStatus, Herdr, HerdrEvent, Subscription } from "./herdr.ts";
import { rebalance } from "./layout.ts";
import { formatNotices, type Notice } from "./notify.ts";
import { checkReport } from "./report.ts";
import {
  listChildren, readChild, readMain, readWatch, removeChild, writeWatch,
  type ChildRecord, type MainRecord, type WatchRecord,
} from "./state.ts";
import { HyError, oneLine, readJson, writeJsonAtomic } from "./util.ts";

const settled = (status: AgentStatus | undefined) => status === "idle" || status === "done";
const tail = (text: string, lines = 5) => text.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join(" / ");

export interface WatcherOptions {
  herdr: Herdr;
  dir: string;
  log?: (message: string) => void;
  /** Coalesces notices that arrive together into one prompt. */
  debounceMs?: number;
  /** How long Main may look absent before its specialists are closed. */
  mainGraceMs?: number;
  /** Re-check interval while notices wait for Main. */
  recheckMs?: number;
  onStop?: (reason: string) => void;
}

/**
 * Follows one Main pane's specialists through herdr events, without polling
 * Main: notices are delivered to Main as one prompt when Main is idle.
 */
export class Watcher {
  herdr: Herdr;
  dir: string;
  log: (message: string) => void;
  debounceMs: number;
  mainGraceMs: number;
  recheckMs: number;
  onStop: (reason: string) => void;
  main: MainRecord | undefined;
  mainStatus: AgentStatus | undefined;
  pending: Notice[] = [];
  subscription: { close(): void } | undefined;
  queue: Promise<void> = Promise.resolve();
  timers = new Set<ReturnType<typeof setTimeout>>();
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  recheckTimer: ReturnType<typeof setTimeout> | undefined;
  mainCheck: ReturnType<typeof setTimeout> | undefined;
  childChecks = new Set<string>();
  retries = 0;
  stopped = false;

  constructor(options: WatcherOptions) {
    this.herdr = options.herdr;
    this.dir = options.dir;
    this.log = options.log ?? (() => undefined);
    this.debounceMs = options.debounceMs ?? 1500;
    this.mainGraceMs = options.mainGraceMs ?? 5000;
    this.recheckMs = options.recheckMs ?? 15_000;
    this.onStop = options.onStop ?? (() => undefined);
  }

  /** Runs one handler at a time, so events and reloads never interleave. */
  run(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(() => (this.stopped ? undefined : task())).catch((error) => {
      this.log(`error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    });
    return this.queue;
  }

  later(ms: number, task: () => Promise<void>): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); void this.run(task); }, ms);
    this.timers.add(timer);
    return timer;
  }

  start(): Promise<void> { return this.run(() => this.resubscribe()); }
  reload(): Promise<void> { return this.run(() => this.resubscribe()); }

  async resubscribe(): Promise<void> {
    try { await this.subscribeAll(); }
    catch (error) { await this.onDisconnect(error instanceof Error ? error : new Error(String(error))); }
  }

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.subscription?.close();
    for (const timer of this.timers) clearTimeout(timer);
    this.log(`stop: ${reason}`);
    this.onStop(reason);
  }

  async subscribeAll(): Promise<void> {
    this.subscription?.close();
    this.subscription = undefined;
    this.main = existsSync(this.dir) ? readMain(this.dir) : undefined;
    if (!this.main) return this.stop("state removed");
    // Notices undelivered by an earlier watcher; watch.json already marks them notified.
    if (!this.pending.length) this.pending = readJson<Notice[]>(this.pendingFile()) ?? [];
    const main = this.main.mainPane;
    if (!await this.herdr.paneGet(main)) return this.cleanupAll("Main pane is gone");
    const children: ChildRecord[] = [];
    for (const child of listChildren(this.dir)) {
      if (this.watch(child).gone) continue;
      if (await this.herdr.paneGet(child.paneId)) children.push(child);
      else await this.childGone(child);
    }
    if (!children.length && !this.pending.length) return this.stop("no specialists left");
    const subscriptions: Subscription[] = [
      { type: "pane.agent_status_changed", pane_id: main },
      ...children.map((child) => ({ type: "pane.agent_status_changed" as const, pane_id: child.paneId })),
      { type: "pane.closed" },
      { type: "pane.exited" },
    ];
    this.subscription = await this.herdr.subscribe(subscriptions, (event) => void this.run(() => this.onEvent(event)),
      (error) => void this.run(() => this.onDisconnect(error)));
    this.retries = 0;
    // Subscriptions report changes only, so read the current state once.
    const mainInfo = await this.herdr.agentGet(main);
    if (mainInfo) this.mainStatus = mainInfo.agent_status; else this.suspectMainGone();
    for (const child of children) {
      const info = await this.herdr.agentGet(child.paneId);
      if (info) await this.evaluate(child, info.agent_status, info.state_change_seq);
    }
    this.scheduleFlush();
  }

  async onDisconnect(error?: Error): Promise<void> {
    if (this.stopped) return;
    this.subscription = undefined;
    this.retries += 1;
    this.log(`subscription closed (${error?.message ?? "connection closed"}); retry ${this.retries}`);
    if (this.retries > 60) return this.stop("herdr is unreachable");
    this.later(Math.min(10_000, 500 * 2 ** Math.min(this.retries, 5)), () => this.resubscribe());
  }

  async onEvent(event: HerdrEvent): Promise<void> {
    const pane = typeof event.data.pane_id === "string" ? event.data.pane_id : undefined;
    if (!pane || !this.main) return;
    if (event.event === "pane.closed" || event.event === "pane.exited") {
      if (pane === this.main.mainPane) return this.cleanupAll("Main pane closed");
      const child = this.childByPane(pane);
      if (child) await this.childGone(child);
      return;
    }
    if (event.event !== "pane.agent_status_changed") return;
    const status = event.data.agent_status as AgentStatus;
    if (pane === this.main.mainPane) {
      this.mainStatus = status;
      if (!event.data.agent) this.suspectMainGone();
      // flush checks readiness itself; Codex Main reports `unknown` rather than idle.
      else this.scheduleFlush();
      return;
    }
    const child = this.childByPane(pane);
    if (!child) return;
    if (!event.data.agent) this.suspectChildGone(child);
    else await this.evaluate(child, status);
  }

  /** The CLI left its pane (for example after /exit) while the shell stayed open. */
  suspectChildGone(child: ChildRecord): void {
    if (this.childChecks.has(child.name)) return;
    this.childChecks.add(child.name);
    this.later(this.mainGraceMs * 2, async () => {
      this.childChecks.delete(child.name);
      const info = await this.herdr.agentGet(child.paneId).catch(() => undefined);
      const current = readChild(this.dir, child.name);
      if (!current) return;
      if (info?.agent) await this.evaluate(current, info.agent_status, info.state_change_seq);
      else await this.childGone(current);
    });
  }

  /** Records are re-read on every event, so turns started by `send` are seen at once. */
  childByPane(pane: string): ChildRecord | undefined {
    return listChildren(this.dir).find((child) => child.paneId === pane);
  }

  watch(child: ChildRecord): WatchRecord {
    const saved = readWatch(this.dir, child.name);
    if (saved && saved.turn === child.turn) return saved;
    return { turn: child.turn, afterSeq: child.promptSeq, active: false, nudged: false, fixRequested: false, notified: false, blockedNotified: false, gone: saved?.gone ?? false };
  }

  async evaluate(child: ChildRecord, status: AgentStatus, seq?: number): Promise<void> {
    if (child.blockedAtStart) return;
    const w = this.watch(child);
    if (w.gone || w.notified) return;
    if (status === "working") {
      w.active = true;
      w.blockedNotified = false;
    } else if (status === "blocked") {
      await this.blocked(child, w);
    } else if (settled(status)) {
      if (!w.active) {
        const current = seq ?? (await this.herdr.agentGet(child.paneId))?.state_change_seq;
        w.active = current !== undefined && current > w.afterSeq;
      }
      if (w.active) await this.finished(child, w);
    }
    writeWatch(this.dir, child.name, w);
  }

  async blocked(child: ChildRecord, w: WatchRecord): Promise<void> {
    const screen = await this.herdr.paneRead(child.paneId).catch(() => "");
    const step = dialogStep(child.config.runtime, screen);
    if (step) {
      this.log(`${child.name}: accepting ${step.id}`);
      await this.herdr.paneSendKeys(child.paneId, step.keys);
      return;
    }
    if (w.blockedNotified) return;
    w.blockedNotified = true;
    this.enqueue({ kind: "needs_input", name: child.name, screen: tail(screen) });
  }

  async finished(child: ChildRecord, w: WatchRecord): Promise<void> {
    const report = checkReport(child.role, child.report);
    if (report.status === "ok") {
      w.notified = true;
      this.enqueue({ kind: "completed", name: child.name, report: child.report });
      return;
    }
    const retry = report.status === "missing" ? !w.nudged : !w.fixRequested;
    if (!retry) {
      w.notified = true;
      this.enqueue(report.status === "missing"
        ? { kind: "no_report", name: child.name, report: child.report }
        : { kind: "invalid_report", name: child.name, report: child.report, errors: report.errors });
      return;
    }
    const before = await this.herdr.agentGet(child.paneId);
    if (report.status === "missing") w.nudged = true; else w.fixRequested = true;
    w.active = false;
    w.afterSeq = before?.state_change_seq ?? w.afterSeq;
    const text = report.status === "missing" ? nudgeLine(child.report) : fixLine(child.report, report.errors);
    this.log(`${child.name}: ${report.status} report, asking again`);
    try { await this.herdr.agentPrompt(child.paneId, oneLine(text, 1500)); }
    catch (error) {
      // Without the retry there is nothing left to wait for; report what we have.
      this.log(`${child.name}: retry prompt failed (${error instanceof Error ? error.message : String(error)})`);
      w.notified = true;
      this.enqueue(report.status === "missing"
        ? { kind: "no_report", name: child.name, report: child.report }
        : { kind: "invalid_report", name: child.name, report: child.report, errors: report.errors });
    }
  }

  async childGone(child: ChildRecord): Promise<void> {
    if (!readChild(this.dir, child.name)) return;
    const w = this.watch(child);
    if (w.gone) return;
    w.gone = true;
    writeWatch(this.dir, child.name, w);
    this.enqueue({ kind: "exited", name: child.name });
    const remaining = listChildren(this.dir).filter((item) => !this.watch(item).gone).map((item) => item.paneId);
    if (this.main) await rebalance(this.herdr, this.main.mainPane, remaining).catch(() => undefined);
  }

  enqueue(notice: Notice): void {
    this.pending.push(notice);
    this.savePending();
    this.log(`notice: ${notice.kind} ${notice.name}`);
    this.scheduleFlush();
  }

  pendingFile(): string { return path.join(this.dir, "pending.json"); }

  /** Kept on disk until delivered, so a restarted watcher still delivers it. */
  savePending(): void {
    if (!existsSync(this.dir)) return;
    if (this.pending.length) writeJsonAtomic(this.pendingFile(), this.pending);
    else rmSync(this.pendingFile(), { force: true });
  }

  scheduleFlush(): void {
    if (!this.pending.length || this.flushTimer) return;
    this.flushTimer = this.later(this.debounceMs, async () => { this.flushTimer = undefined; await this.flush(); });
  }

  running(): string[] {
    return listChildren(this.dir).filter((child) => {
      const w = this.watch(child);
      return !child.blockedAtStart && !w.gone && !w.notified;
    }).map((child) => child.name);
  }

  /** Main's status events normally trigger delivery; this is the fallback while Main stays busy. */
  recheck(): void {
    if (this.recheckTimer) return;
    this.recheckTimer = this.later(this.recheckMs, async () => { this.recheckTimer = undefined; await this.flush(); });
  }

  async flush(): Promise<void> {
    if (!this.pending.length || !this.main) return;
    const main = this.main.mainPane;
    const info = await this.herdr.agentGet(main);
    if (!info) { this.suspectMainGone(); return; }
    this.mainStatus = info.agent_status;
    // Codex reports `unknown` once it is interactive; treat that like idle.
    const ready = settled(info.agent_status) || (info.agent_status === "unknown" && info.interactive_ready === true);
    if (!ready) { this.recheck(); return; }
    const text = formatNotices(this.pending, this.running());
    try {
      await this.herdr.agentPrompt(main, text);
      this.mainStatus = "working";
    } catch (error) {
      if (error instanceof HyError && error.code === "agent_blocked") { this.recheck(); return; }
      this.log(`prompt to Main failed (${error instanceof Error ? error.message : String(error)}); showing a herdr notification`);
      await this.herdr.notify("Hybrid Subagents", text).catch(() => undefined);
    }
    this.pending = [];
    this.savePending();
    if (!listChildren(this.dir).some((child) => !this.watch(child).gone)) this.stop("no specialists left");
  }

  /** An agent can vanish briefly; close everything only if Main stays gone. */
  suspectMainGone(): void {
    if (this.mainCheck || !this.main) return;
    const main = this.main.mainPane;
    const check = async (attempt: number): Promise<void> => {
      const info = await this.herdr.agentGet(main).catch(() => undefined);
      if (info?.agent) { this.mainCheck = undefined; this.mainStatus = info.agent_status; this.scheduleFlush(); return; }
      if (attempt < 2) { this.mainCheck = this.later(this.mainGraceMs * 2, () => check(attempt + 1)); return; }
      this.mainCheck = undefined;
      await this.cleanupAll("Main agent exited");
    };
    this.mainCheck = this.later(this.mainGraceMs, () => check(1));
  }

  async cleanupAll(reason: string): Promise<void> {
    this.log(`cleanup: ${reason}`);
    const children = listChildren(this.dir);
    for (const child of children) {
      removeChild(this.dir, child.name);
      await this.herdr.paneClose(child.paneId).catch(() => undefined);
    }
    rmSync(this.dir, { recursive: true, force: true });
    this.stop(reason);
  }
}
