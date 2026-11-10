import type { Herdr, LayoutNode } from "./herdr.ts";

/** Main keeps the left 40% of its pane; specialists share the right 60%. */
export const MAIN_RATIO = 0.4;

interface Leaf { pane: string; path: boolean[]; depth: number }

function leaves(node: LayoutNode, path: boolean[] = [], depth = 0): Leaf[] {
  if (node.type === "pane") return node.pane_id ? [{ pane: node.pane_id, path, depth }] : [];
  return [...leaves(node.first, [...path, false], depth + 1), ...leaves(node.second, [...path, true], depth + 1)];
}

function leafCount(node: LayoutNode): number {
  return node.type === "pane" ? 1 : leafCount(node.first) + leafCount(node.second);
}

/** Largest subtrees whose panes are all specialists, with their paths from the tab root. */
function specialistAreas(node: LayoutNode, children: Set<string>, path: boolean[] = []): { node: LayoutNode; path: boolean[] }[] {
  const panes = leaves(node);
  if (panes.length && panes.every((leaf) => children.has(leaf.pane))) return [{ node, path }];
  if (node.type === "pane") return [];
  return [...specialistAreas(node.first, children, [...path, false]), ...specialistAreas(node.second, children, [...path, true])];
}

export type SplitPlan = { target: string; direction: "right" | "down"; ratio?: number };

/**
 * Where the next specialist goes: right of Main for the first one, otherwise
 * below the shallowest specialist so the stack stays a balanced tree. Balanced
 * trees keep every equalizing ratio inside herdr's 0.1–0.9 clamp, so the stack
 * has no size limit.
 */
export function planSplit(root: LayoutNode | undefined, mainPane: string, children: string[]): SplitPlan {
  const set = new Set(children);
  const area = root ? specialistAreas(root, set).sort((a, b) => leafCount(b.node) - leafCount(a.node))[0] : undefined;
  if (!area) {
    const last = children.at(-1);
    return last ? { target: last, direction: "down" } : { target: mainPane, direction: "right", ratio: MAIN_RATIO };
  }
  const candidates = leaves(area.node);
  const depth = Math.min(...candidates.map((leaf) => leaf.depth));
  return { target: candidates.filter((leaf) => leaf.depth === depth).at(-1)!.pane, direction: "down" };
}

/** Ratios that give every specialist the same height: each split gets first's share of panes. */
export function equalizingRatios(root: LayoutNode, children: string[]): { path: boolean[]; ratio: number }[] {
  const updates: { path: boolean[]; ratio: number }[] = [];
  const visit = (node: LayoutNode, path: boolean[]) => {
    if (node.type === "pane") return;
    if (node.direction === "down") {
      const ratio = leafCount(node.first) / leafCount(node);
      if (Math.abs(node.ratio - ratio) > 0.001) updates.push({ path, ratio });
    }
    visit(node.first, [...path, false]);
    visit(node.second, [...path, true]);
  };
  for (const area of specialistAreas(root, new Set(children))) visit(area.node, area.path);
  return updates;
}

export async function rebalance(herdr: Herdr, anchorPane: string, children: string[]): Promise<void> {
  if (!children.length) return;
  const layout = await herdr.layoutExport(anchorPane);
  for (const { path, ratio } of equalizingRatios(layout.root, children)) {
    await herdr.layoutSetSplitRatio(layout.tab_id, path, ratio);
  }
}
