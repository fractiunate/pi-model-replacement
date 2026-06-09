import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import modelReplacementsExtension from "./index.js";

function harness(replacements: Record<string, string>) {
  const handlers = new Map<string, Function>();
  const pi: any = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerProvider: () => {},
    setModel: async () => true,
  };
  modelReplacementsExtension(pi);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-tc-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ model_replacements: replacements }),
  );
  const ctx: any = {
    hasUI: false,
    ui: { notify() {} },
    model: undefined,
    modelRegistry: { getAll: () => [], find: () => undefined },
  };
  return { handlers, ctx, dir };
}

async function start(h: ReturnType<typeof harness>) {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = h.dir;
  try {
    await h.handlers.get("session_start")!({ type: "session_start" }, h.ctx);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
}

test("subagent tool_call: alias model is rewritten to concrete", async () => {
  const h = harness({ high: "github-copilot/claude-opus-4.8" });
  await start(h);
  const event: any = { type: "tool_call", toolName: "subagent", input: { model: "high" } };
  h.handlers.get("tool_call")!(event, h.ctx);
  assert.equal(event.input.model, "github-copilot/claude-opus-4.8");
});

test("subagent tool_call: non-alias model unchanged", async () => {
  const h = harness({ high: "github-copilot/claude-opus-4.8" });
  await start(h);
  const event: any = { type: "tool_call", toolName: "subagent", input: { model: "openai/gpt-real" } };
  h.handlers.get("tool_call")!(event, h.ctx);
  assert.equal(event.input.model, "openai/gpt-real");
});

test("subagent tool_call: missing model does not throw", async () => {
  const h = harness({ high: "github-copilot/claude-opus-4.8" });
  await start(h);
  const event: any = { type: "tool_call", toolName: "subagent", input: {} };
  h.handlers.get("tool_call")!(event, h.ctx);
  assert.deepEqual(event.input, {});
});

test("non-subagent tool_call: model param untouched", async () => {
  const h = harness({ high: "github-copilot/claude-opus-4.8" });
  await start(h);
  const event: any = { type: "tool_call", toolName: "bash", input: { model: "high" } };
  h.handlers.get("tool_call")!(event, h.ctx);
  assert.equal(event.input.model, "high");
});

test("subagent tool_call: suffixed alias ('high:thinking') resolves base alias and re-attaches suffix", async () => {
  // resolveAlias matches alias keys exactly, so the handler splits the ":thinking"
  // suffix, resolves the base alias "high" -> concrete target, then re-attaches the
  // suffix. pi-subagents only does registry id-matching and would otherwise resolve
  // the synthetic alias entry, so pi-model-replacements must do the alias resolution.
  const h = harness({ high: "github-copilot/claude-opus-4.8" });
  await start(h);
  const event: any = {
    type: "tool_call",
    toolName: "subagent",
    input: { model: "high:thinking" },
  };
  h.handlers.get("tool_call")!(event, h.ctx);
  assert.equal(
    event.input.model,
    "github-copilot/claude-opus-4.8:thinking",
    "suffixed alias must resolve to concrete target with suffix preserved",
  );
});
