import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AliasMap = Map<string, string>; // alias name -> concrete "provider/model-id"

// Matches pi-subagents/src/shared/utils.ts:16 — honours PI_CODING_AGENT_DIR.
export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return os.homedir();
  if (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return configured || path.join(os.homedir(), ".pi", "agent");
}

// Reads model_replacements from <agentDir>/settings.json. Returns {} on any failure.
export function readModelReplacements(agentDir: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    const mr = parsed?.model_replacements;
    return mr && typeof mr === "object" && !Array.isArray(mr) ? (mr as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// Normalize: keep only string, non-empty (trimmed) target values.
export function buildAliasMap(raw: Record<string, string>): AliasMap {
  const map: AliasMap = new Map();
  for (const [alias, target] of Object.entries(raw ?? {})) {
    if (typeof target !== "string") continue;
    const a = alias.trim();
    const t = target.trim();
    if (a && t) map.set(a, t);
  }

  // Detect chained aliases: if the target (sans any "provider/" prefix) matches
  // another alias key, skip it and warn. We do not support transitive resolution.
  // Note: keying off the alias map (not the model registry) means a concrete model
  // whose id coincidentally equals an alias name could be falsely flagged — but
  // alias names ("low", "medium", "high") are never valid provider model ids in
  // practice. Collect before deleting to avoid mutation-during-iteration.
  const chained: string[] = [];
  for (const [alias, target] of map) {
    const slash = target.indexOf("/");
    const localId = slash > 0 ? target.slice(slash + 1) : target;
    if (map.has(localId)) {
      chained.push(alias);
      console.warn(
        `[pi-model-replacements] alias "${alias}" -> "${target}" targets another alias "${localId}"; skipping.`,
      );
    }
  }
  for (const alias of chained) map.delete(alias);

  return map;
}

// Returns concrete target if `model` is an alias key; otherwise undefined (no-op).
export function resolveAlias(model: string | undefined, aliases: AliasMap): string | undefined {
  if (!model) return undefined;
  return aliases.get(model);
}

// Split "provider/model-id" into [provider, modelId]. Returns undefined if not qualified.
export function splitQualified(target: string): [string, string] | undefined {
  const i = target.indexOf("/");
  if (i <= 0 || i === target.length - 1) return undefined;
  return [target.slice(0, i), target.slice(i + 1)];
}
