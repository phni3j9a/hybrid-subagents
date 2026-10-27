import assert from "node:assert/strict";
import { test } from "node:test";
import type { LayoutNode } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/herdr.ts";
import { MAIN_RATIO, equalizingRatios, planSplit, rebalance } from "../plugins/hybrid-subagents/skills/hyagents/scripts/lib/layout.ts";
import { FakeHerdr } from "./helpers/fake-herdr.ts";

const MAIN = "w1:p1";

/** Adds specialists the way `start` does: plan, split, then equalize. */
async function addChildren(herdr: FakeHerdr, count: number, children: string[] = []): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    const plan = planSplit((await herdr.layoutExport()).root, MAIN, children);
    const pane = await herdr.paneSplit(plan.target, { direction: plan.direction, ratio: plan.ratio, cwd: "/repo", env: {} });
    children.push(pane.pane_id);
    await rebalance(herdr, MAIN, children);
  }
  return children;
}

test("the first specialist takes the right 60% of Main's pane", () => {
  assert.deepEqual(planSplit({ type: "pane", pane_id: MAIN }, MAIN, []), { target: MAIN, direction: "right", ratio: MAIN_RATIO });
});

test("specialists stack vertically in the right 60% with equal heights, without a limit", async () => {
  for (const count of [1, 2, 3, 4, 5, 7, 12, 17]) {
    const herdr = new FakeHerdr();
    const children = await addChildren(herdr, count);
    const sizes = herdr.sizes();
    assert.ok(Math.abs(sizes[MAIN].width - 0.4) < 1e-6, `Main keeps 40% with ${count} specialists`);
    for (const child of children) {
      assert.ok(Math.abs(sizes[child].width - 0.6) < 1e-6, `${child} spans the right 60%`);
      assert.ok(Math.abs(sizes[child].height - 1 / count) < 1e-6, `${child} gets 1/${count} of the height (${sizes[child].height})`);
    }
    for (const call of herdr.ratioCalls) assert.ok(call.ratio >= 0.1 && call.ratio <= 0.9, "ratios stay inside herdr's clamp");
  }
});

test("closing specialists keeps the remaining ones equal, and closing all returns the space to Main", async () => {
  const herdr = new FakeHerdr();
  const children = await addChildren(herdr, 5);
  for (const gone of [children[1], children[3]]) await herdr.paneClose(gone);
  const remaining = children.filter((child) => herdr.panes.has(child));
  await rebalance(herdr, MAIN, remaining);
  const sizes = herdr.sizes();
  for (const child of remaining) assert.ok(Math.abs(sizes[child].height - 1 / 3) < 1e-6);
  // A new specialist after closures still lands in the stack.
  await addChildren(herdr, 1, remaining);
  for (const child of remaining) assert.ok(Math.abs(herdr.sizes()[child].height - 1 / 4) < 1e-6);
  for (const child of remaining) await herdr.paneClose(child);
  assert.deepEqual(herdr.root, { type: "pane", pane_id: MAIN });
});

test("only splits made of specialists are adjusted; the user's own panes are left alone", () => {
  const root: LayoutNode = {
    type: "split", direction: "down", ratio: 0.7,
    first: { type: "split", direction: "right", ratio: 0.4, first: { type: "pane", pane_id: MAIN },
      second: { type: "split", direction: "down", ratio: 0.8, first: { type: "pane", pane_id: "c1" }, second: { type: "pane", pane_id: "c2" } } },
    second: { type: "pane", pane_id: "user-shell" },
  };
  assert.deepEqual(equalizingRatios(root, ["c1", "c2"]), [{ path: [false, true], ratio: 0.5 }]);
  assert.deepEqual(planSplit(root, MAIN, ["c1", "c2"]), { target: "c2", direction: "down" });
});

test("specialists outside Main's tab fall back to stacking under the last one", () => {
  assert.deepEqual(planSplit({ type: "pane", pane_id: MAIN }, MAIN, ["w2:p9"]), { target: "w2:p9", direction: "down" });
});
