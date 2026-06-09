import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAliasMap } from "./alias-resolver.js";
import { injectAliases } from "./registry-inject.js";

function makeCtx(models: Array<{ provider: string; id: string; name?: string; baseUrl?: string }>) {
  return {
    hasUI: false as const,
    ui: { notify() {} } as any,
    modelRegistry: { getAll: () => models } as any,
  };
}

function makePi() {
  const calls: Array<{ provider: string; config: any }> = [];
  return {
    pi: { registerProvider: (provider: string, config: any) => calls.push({ provider, config }) },
    calls,
  };
}

test("registers one provider call per provider with alias entries", () => {
  const ctx = makeCtx([
    { provider: "anthropic", id: "claude-x", baseUrl: "https://a" },
    { provider: "openai", id: "gpt-y", baseUrl: "https://o" },
  ]);
  const { pi, calls } = makePi();
  const aliases = buildAliasMap({ low: "anthropic/claude-x", high: "openai/gpt-y" });
  const res = injectAliases(pi, ctx, aliases);

  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.registered.sort(), ["high", "low"]);
  assert.equal(calls.length, 2);

  const anthropic = calls.find((c) => c.provider === "anthropic")!;
  assert.equal(anthropic.config.baseUrl, "https://a");
  assert.ok(anthropic.config.models.some((m: any) => m.id === "low"));
  const openai = calls.find((c) => c.provider === "openai")!;
  assert.equal(openai.config.baseUrl, "https://o");
  assert.ok(openai.config.models.some((m: any) => m.id === "high"));
});

test("invalid alias is skipped with no provider call", () => {
  const ctx = makeCtx([{ provider: "anthropic", id: "claude-x" }]);
  const { pi, calls } = makePi();
  const res = injectAliases(pi, ctx, buildAliasMap({ bad: "nope/missing" }));
  assert.deepEqual(res.skipped, ["bad"]);
  assert.deepEqual(res.registered, []);
  assert.equal(calls.length, 0);
});

test("idempotent: existing alias entries are not duplicated", () => {
  // Registry already contains the alias entry from a prior inject.
  const ctx = makeCtx([
    { provider: "anthropic", id: "claude-x" },
    { provider: "anthropic", id: "low" },
  ]);
  const { pi, calls } = makePi();
  injectAliases(pi, ctx, buildAliasMap({ low: "anthropic/claude-x" }));
  const models = calls[0].config.models as any[];
  assert.equal(models.filter((m) => m.id === "low").length, 1);
});
