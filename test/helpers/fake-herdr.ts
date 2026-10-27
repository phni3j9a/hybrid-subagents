import type {
  AgentInfo, AgentStatus, Herdr, HerdrEvent, LayoutDescription, LayoutNode, PaneInfo, SplitOptions, Subscription,
} from "../../plugins/hybrid-subagents/skills/hyagents/scripts/lib/herdr.ts";
import { HerdrError } from "../../plugins/hybrid-subagents/skills/hyagents/scripts/lib/herdr.ts";

interface FakePane { id: string; agent?: string; name?: string; status: AgentStatus; seq: number; screen: string; env: Record<string, string>; cwd: string }
interface Subscriber { subscriptions: Subscription[]; onEvent: (event: HerdrEvent) => void; onClose: (error?: Error) => void; closed: boolean }

/** In-memory herdr: one tab, a BSP layout, agents with status sequences, and event subscribers. */
export class FakeHerdr implements Herdr {
  tab = "w1:t1";
  panes = new Map<string, FakePane>();
  root: LayoutNode;
  next = 2;
  prompts: { target: string; text: string }[] = [];
  keys: { pane: string; keys: string[] }[] = [];
  starts: { name: string; kind: string; pane: string; args: string[] }[] = [];
  notifications: { title: string; body: string }[] = [];
  ratioCalls: { path: boolean[]; ratio: number }[] = [];
  subscribers: Subscriber[] = [];
  /** Decides how `agent start` behaves; defaults to an idle, ready agent of the requested kind. */
  onStart: (pane: FakePane, kind: string) => void = (pane, kind) => { pane.agent = kind; pane.status = "idle"; };
  /** Lets a test react to keys, for example by dismissing a dialog. */
  onKeys: (pane: FakePane, keys: string[]) => void = () => undefined;

  constructor(main = "w1:p1", mainAgent = "claude") {
    this.panes.set(main, { id: main, agent: mainAgent, status: "idle", seq: 1, screen: "", env: {}, cwd: "/repo" });
    this.root = { type: "pane", pane_id: main };
  }

  pane(id: string): FakePane {
    const pane = this.panes.get(id);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${id} not found`);
    return pane;
  }

  agent(target: string): FakePane {
    const pane = this.panes.get(target) ?? [...this.panes.values()].find((item) => item.name === target);
    if (!pane?.agent) throw new HerdrError("agent_not_found", `agent ${target} not found`);
    return pane;
  }

  info(pane: FakePane): AgentInfo {
    return { pane_id: pane.id, tab_id: this.tab, workspace_id: "w1", agent_status: pane.status, name: pane.name, agent: pane.agent, state_change_seq: pane.seq, cwd: pane.cwd };
  }

  /** Changes an agent's status the way herdr would and pushes the event; `null` means the agent left. */
  setStatus(id: string, status: AgentStatus, agentOrNull?: string | null): void {
    const pane = this.pane(id);
    const agent = agentOrNull === null ? undefined : agentOrNull ?? pane.agent;
    pane.status = status;
    pane.agent = agent;
    pane.seq += 1;
    this.emit({ event: "pane.agent_status_changed", data: { pane_id: id, workspace_id: "w1", agent_status: status, ...(agent ? { agent } : {}) } });
  }

  emit(event: HerdrEvent): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      const wanted = subscriber.subscriptions.some((item) => item.type === event.event
        && (item.type !== "pane.agent_status_changed" || item.pane_id === event.data.pane_id));
      if (wanted) subscriber.onEvent(event);
    }
  }

  leaves(node: LayoutNode = this.root): string[] {
    return node.type === "pane" ? [node.pane_id!] : [...this.leaves(node.first), ...this.leaves(node.second)];
  }

  /** Each pane's share of the tab, for checking proportions. */
  sizes(node: LayoutNode = this.root, width = 1, height = 1): Record<string, { width: number; height: number }> {
    if (node.type === "pane") return { [node.pane_id!]: { width, height } };
    const [a, b] = node.direction === "right"
      ? [[width * node.ratio, height], [width * (1 - node.ratio), height]]
      : [[width, height * node.ratio], [width, height * (1 - node.ratio)]];
    return { ...this.sizes(node.first, a[0], a[1]), ...this.sizes(node.second, b[0], b[1]) };
  }

  async paneSplit(target: string, options: SplitOptions): Promise<PaneInfo> {
    this.pane(target);
    const id = `w1:p${this.next++}`;
    this.panes.set(id, { id, status: "idle", seq: 1, screen: "$ ", env: options.env, cwd: options.cwd });
    const replace = (node: LayoutNode): LayoutNode => {
      if (node.type === "pane") {
        return node.pane_id === target
          ? { type: "split", direction: options.direction, ratio: options.ratio ?? 0.5, first: node, second: { type: "pane", pane_id: id } }
          : node;
      }
      return { ...node, first: replace(node.first), second: replace(node.second) };
    };
    this.root = replace(this.root);
    return { pane_id: id, tab_id: this.tab, workspace_id: "w1", agent_status: "idle", cwd: options.cwd };
  }

  async paneGet(pane: string): Promise<PaneInfo | undefined> {
    const item = this.panes.get(pane);
    return item && { pane_id: item.id, tab_id: this.tab, workspace_id: "w1", agent_status: item.status, agent: item.agent, cwd: item.cwd };
  }

  async paneClose(pane: string): Promise<void> {
    if (!this.panes.delete(pane)) return;
    const remove = (node: LayoutNode): LayoutNode | undefined => {
      if (node.type === "pane") return node.pane_id === pane ? undefined : node;
      const first = remove(node.first);
      const second = remove(node.second);
      return first && second ? { ...node, first, second } : first ?? second;
    };
    this.root = remove(this.root) ?? this.root;
    this.emit({ event: "pane.closed", data: { type: "pane_closed", pane_id: pane } });
  }

  async paneRead(pane: string): Promise<string> { return this.pane(pane).screen; }

  async paneSendKeys(pane: string, keys: string[]): Promise<void> {
    this.keys.push({ pane, keys });
    this.onKeys(this.pane(pane), keys);
  }

  async agentStart(name: string, kind: string, paneId: string, args: string[]): Promise<AgentInfo> {
    const pane = this.pane(paneId);
    this.starts.push({ name, kind, pane: paneId, args });
    pane.name = name;
    this.onStart(pane, kind);
    if (pane.status === "blocked") throw new HerdrError("agent_not_ready", `agent ${name} is blocked during startup`);
    if (!pane.agent) throw new HerdrError("agent_start_failed", "agent process exited before becoming interactive");
    return this.info(pane);
  }

  async agentGet(target: string): Promise<AgentInfo | undefined> {
    try { return this.info(this.agent(target)); } catch { return undefined; }
  }

  async agentList(): Promise<AgentInfo[]> {
    return [...this.panes.values()].filter((pane) => pane.agent).map((pane) => this.info(pane));
  }

  async agentPrompt(target: string, text: string): Promise<AgentInfo> {
    const pane = this.agent(target);
    if (pane.status === "blocked") throw new HerdrError("agent_blocked", "agent is blocked");
    this.prompts.push({ target, text });
    return this.info(pane);
  }

  async agentRename(target: string, name: string): Promise<void> { this.agent(target).name = name; }

  async agentWait(target: string): Promise<AgentInfo | undefined> { return this.info(this.agent(target)); }

  async layoutExport(): Promise<LayoutDescription> { return { workspace_id: "w1", tab_id: this.tab, root: structuredClone(this.root) }; }

  async layoutSetSplitRatio(_tab: string, path: boolean[], ratio: number): Promise<void> {
    this.ratioCalls.push({ path, ratio });
    let node = this.root;
    for (const step of path) {
      if (node.type !== "split") throw new HerdrError("split_not_found", "split path not found");
      node = step ? node.second : node.first;
    }
    if (node.type !== "split") throw new HerdrError("split_not_found", "split path not found");
    node.ratio = Math.min(0.9, Math.max(0.1, ratio));
  }

  async subscribe(subscriptions: Subscription[], onEvent: (event: HerdrEvent) => void, onClose: (error?: Error) => void) {
    for (const item of subscriptions) {
      if (item.type === "pane.agent_status_changed") this.pane(item.pane_id);
    }
    const subscriber: Subscriber = { subscriptions, onEvent, onClose, closed: false };
    this.subscribers.push(subscriber);
    return { close: () => { subscriber.closed = true; } };
  }

  async notify(title: string, body: string): Promise<void> { this.notifications.push({ title, body }); }

  async version(): Promise<string> { return "herdr 0.9.5"; }
}
