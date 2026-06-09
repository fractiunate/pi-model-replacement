import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildAliasMap,
  getAgentDir,
  readModelReplacements,
  resolveAlias,
  splitQualified,
} from "./alias-resolver.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mr-"));
}

test("readModelReplacements: missing file -> {}", () => {
  assert.deepEqual(readModelReplacements(path.join(tmpDir(), "nope")), {});
});

test("readModelReplacements: malformed JSON -> {}", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), "{not json");
  assert.deepEqual(readModelReplacements(dir), {});
});

test("readModelReplacements: reads model_replacements object", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ model_replacements: { low: "p/m" } }),
  );
  assert.deepEqual(readModelReplacements(dir), { low: "p/m" });
});

test("readModelReplacements: non-object model_replacements -> {}", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model_replacements: [1, 2] }));
  assert.deepEqual(readModelReplacements(dir), {});
});

test("buildAliasMap: trims and drops empty / non-string", () => {
  const map = buildAliasMap({
    low: " p/a ",
    " high ": "p/b",
    empty: "   ",
    bad: 5 as unknown as string,
  });
  assert.equal(map.get("low"), "p/a");
  assert.equal(map.get("high"), "p/b");
  assert.equal(map.has("empty"), false);
  assert.equal(map.has("bad"), false);
});

test("resolveAlias: hit / miss / undefined", () => {
  const map = buildAliasMap({ low: "p/a" });
  assert.equal(resolveAlias("low", map), "p/a");
  assert.equal(resolveAlias("gpt-x", map), undefined);
  assert.equal(resolveAlias(undefined, map), undefined);
});

test("splitQualified: valid and invalid", () => {
  assert.deepEqual(splitQualified("openai/gpt-y"), ["openai", "gpt-y"]);
  assert.deepEqual(splitQualified("provider/a/b"), ["provider", "a/b"]);
  assert.equal(splitQualified("nostash"), undefined);
  assert.equal(splitQualified("/leading"), undefined);
  assert.equal(splitQualified("trailing/"), undefined);
});

test("getAgentDir: honours PI_CODING_AGENT_DIR", () => {
  const prev = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/tmp/some/dir";
    assert.equal(getAgentDir(), "/tmp/some/dir");
    process.env.PI_CODING_AGENT_DIR = "~/foo";
    assert.equal(getAgentDir(), path.join(os.homedir(), "foo"));
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(getAgentDir(), path.join(os.homedir(), ".pi", "agent"));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("buildAliasMap: chained alias (target matches alias key) is skipped", () => {
  // low -> medium (medium is an alias key) — low must be skipped
  const warnMessages: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => warnMessages.push(args.join(" "));
  try {
    const map = buildAliasMap({ low: "medium", medium: "p/m" });
    assert.equal(map.has("low"), false, "chained alias 'low' must be removed");
    assert.equal(map.get("medium"), "p/m", "'medium' (direct, not chained) must stay");
    assert.ok(
      warnMessages.some((msg) => msg.includes('"low"') && msg.includes('"medium"')),
      "warning must mention the skipped alias and its target",
    );
  } finally {
    console.warn = origWarn;
  }
});

test("buildAliasMap: chained alias with provider prefix (p/medium -> medium alias) is skipped", () => {
  const warnMessages: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => warnMessages.push(args.join(" "));
  try {
    const map = buildAliasMap({ low: "p/medium", medium: "p/m" });
    assert.equal(map.has("low"), false, "chained alias 'low' (target p/medium) must be removed");
    assert.equal(map.get("medium"), "p/m", "'medium' must stay");
    assert.ok(warnMessages.some((msg) => msg.includes('"low"')));
  } finally {
    console.warn = origWarn;
  }
});

test("buildAliasMap: non-chained aliases are not affected", () => {
  // "low" points to a concrete id that is not an alias name
  const map = buildAliasMap({ low: "p/concrete-id", high: "p/other" });
  assert.equal(map.get("low"), "p/concrete-id");
  assert.equal(map.get("high"), "p/other");
});
