import assert from "node:assert/strict";
import { test } from "node:test";
import modelReplacementsExtension from "./index.js";

// Build a fake pi that captures handlers and setModel calls, and lets us fire events.
function harness(modelRegistryModels: Array<{ provider: string; id: string }>) {
  const handlers = new Map<string, Function>();
  const setModelCalls: any[] = [];
  const pi: any = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerProvider: () => {},
    setModel: async (m: any) => {
      setModelCalls.push(m);
      return true;
    },
    appendEntry: () => {},
  };
  modelReplacementsExtension(pi);
  const ctx: any = {
    hasUI: false,
    ui: { notify() {} },
    model: undefined,
    modelRegistry: {
      getAll: () => modelRegistryModels,
      find: (provider: string, id: string) =>
        modelRegistryModels.find((m) => m.provider === provider && m.id === id),
    },
    sessionManager: { getEntries: () => [] },
  };
  return { handlers, setModelCalls, ctx };
}

const REG = [
  { provider: "github-copilot", id: "claude-haiku-4.5" },
  { provider: "github-copilot", id: "claude-opus-4.8" },
];

async function loadAliases(h: ReturnType<typeof harness>, dir: string) {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await h.handlers.get("session_start")!({ type: "session_start" }, h.ctx);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function settingsDir(replacements: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-swap-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ model_replacements: replacements }),
  );
  return dir;
}

test("model_select with alias swaps to concrete model exactly once", async () => {
  const h = harness(REG);
  await loadAliases(h, settingsDir({ low: "github-copilot/claude-haiku-4.5" }));
  h.setModelCalls.length = 0; // ignore any session_start swap
  await h.handlers.get("model_select")!(
    { type: "model_select", model: { provider: "github-copilot", id: "low" } },
    h.ctx,
  );
  assert.equal(h.setModelCalls.length, 1);
  assert.deepEqual(h.setModelCalls[0], { provider: "github-copilot", id: "claude-haiku-4.5" });
});

test("model_select with concrete (non-alias) id does not swap (no loop)", async () => {
  const h = harness(REG);
  await loadAliases(h, settingsDir({ low: "github-copilot/claude-haiku-4.5" }));
  h.setModelCalls.length = 0;
  await h.handlers.get("model_select")!(
    { type: "model_select", model: { provider: "github-copilot", id: "claude-haiku-4.5" } },
    h.ctx,
  );
  assert.equal(h.setModelCalls.length, 0);
});

test("before_agent_start swaps active alias model", async () => {
  const h = harness(REG);
  await loadAliases(h, settingsDir({ high: "github-copilot/claude-opus-4.8" }));
  h.setModelCalls.length = 0;
  h.ctx.model = { provider: "github-copilot", id: "high" };
  await h.handlers.get("before_agent_start")!({ type: "before_agent_start" }, h.ctx);
  assert.equal(h.setModelCalls.length, 1);
  assert.deepEqual(h.setModelCalls[0], { provider: "github-copilot", id: "claude-opus-4.8" });
});

test("session_start(reload) re-swaps active alias to updated concrete target", async () => {
  const handlers2 = new Map<string, Function>();
  const setModelCalls2: any[] = [];
  const entries2: Array<{ type: string; customType: string; data: unknown }> = [];
  const fakePi: any = {
    on: (event: string, handler: Function) => handlers2.set(event, handler),
    registerProvider: () => {},
    setModel: async (m: any) => { setModelCalls2.push(m); return true; },
    appendEntry: (customType: string, data?: unknown) => {
      entries2.push({ type: "custom", customType, data });
    },
  };
  modelReplacementsExtension(fakePi);
  const ctx2: any = {
    hasUI: false,
    ui: { notify() {} },
    model: undefined,
    modelRegistry: {
      getAll: () => REG,
      find: (provider: string, id: string) =>
        REG.find((m) => m.provider === provider && m.id === id),
    },
    sessionManager: { getEntries: () => entries2 },
  };

  // --- Step 1: initial session_start with model-A as the target for "low" ---
  const dirA = settingsDir({ low: "github-copilot/claude-haiku-4.5" });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dirA;
  try {
    await handlers2.get("session_start")!({ type: "session_start", reason: "startup" }, ctx2);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
  setModelCalls2.length = 0;

  // --- Step 2: model_select fires with alias "low" — should persist and swap to haiku ---
  await handlers2.get("model_select")!(
    { type: "model_select", model: { provider: "github-copilot", id: "low" } },
    ctx2,
  );
  assert.equal(entries2.filter((e) => e.customType === "pi-mr-last-alias").length, 1);
  assert.deepEqual(
    (entries2.find((e) => e.customType === "pi-mr-last-alias") as any).data,
    { alias: "low" },
  );

  // --- Step 3: settings change to model-B ---
  const dirB = settingsDir({ low: "github-copilot/claude-opus-4.8" });
  setModelCalls2.length = 0;

  // --- Step 4: session_start fires with reason:"reload" ---
  process.env.PI_CODING_AGENT_DIR = dirB;
  try {
    await handlers2.get("session_start")!({ type: "session_start", reason: "reload" }, ctx2);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }

  // Assert active model re-swapped to claude-opus-4.8 (model-B), not left on haiku.
  assert.equal(setModelCalls2.length, 1);
  assert.deepEqual(setModelCalls2[0], { provider: "github-copilot", id: "claude-opus-4.8" });
});

test("session_start(reload) without prior alias selection falls back to ctx.model?.id (no-op for concrete)", async () => {
  const handlers3 = new Map<string, Function>();
  const setModelCalls3: any[] = [];
  const fakePi2: any = {
    on: (event: string, handler: Function) => handlers3.set(event, handler),
    registerProvider: () => {},
    setModel: async (m: any) => { setModelCalls3.push(m); return true; },
    appendEntry: () => {},
  };
  modelReplacementsExtension(fakePi2);
  const ctx3: any = {
    hasUI: false,
    ui: { notify() {} },
    model: { provider: "github-copilot", id: "claude-haiku-4.5" }, // concrete, not alias
    modelRegistry: {
      getAll: () => REG,
      find: (provider: string, id: string) => REG.find((m) => m.provider === provider && m.id === id),
    },
    sessionManager: { getEntries: () => [] }, // no prior alias entry
  };
  const dir = settingsDir({ low: "github-copilot/claude-haiku-4.5" });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await handlers3.get("session_start")!({ type: "session_start", reason: "reload" }, ctx3);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
  // No swap: ctx.model.id is concrete, not in alias map → no-op
  assert.equal(setModelCalls3.length, 0);
});
