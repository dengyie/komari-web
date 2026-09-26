import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { isConfiguredMiner, showsMiningControls } from "../../utils/miningControl.ts";

const idle = { tags: "", miner_configured: false, miner_controllable: false };

test("startup flags keep a stopped miner visible and controllable", () => {
  const info = { ...idle, miner_configured: true, miner_controllable: true };
  assert.equal(isConfiguredMiner(info, false, false), true);
  assert.equal(showsMiningControls(info, false, false), true);
});

test("api url without a control template is configured but not controllable", () => {
  const info = { ...idle, miner_configured: true };
  assert.equal(isConfiguredMiner(info, false, false), true);
  assert.equal(showsMiningControls(info, false, false), false);
});

test("an old agent that is mining or tagged still gets the buttons", () => {
  assert.equal(showsMiningControls(idle, true, false), true);
  assert.equal(showsMiningControls(idle, false, true), true);
  assert.equal(showsMiningControls({ ...idle, tags: "Miner" }, false, false), true);
});

test("a machine with no miner flags, history, or tag stays unconfigured", () => {
  assert.equal(isConfiguredMiner(idle, false, false), false);
  assert.equal(showsMiningControls(idle, false, false), false);
});

test("mining page uses the shared identity helper for both the table and history query", () => {
  const page = readFileSync(new URL("./mining.tsx", import.meta.url), "utf8");
  assert.equal(page.split("isConfiguredMiner(").length - 1, 2);
  assert.ok(page.includes("showsMiningControls("));
  assert.ok(!page.includes("isMiner && m.info.miner_controllable"));
});
