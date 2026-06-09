import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { splitQualified, type AliasMap } from "./alias-resolver.js";

export function notify(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  message: string,
  type: "info" | "warning" | "error",
) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  process.stderr.write(`${message}\n`);
}

export interface InjectResult {
  registered: string[];
  skipped: string[];
}

// Convert a full Model object into a ProviderModelConfig entry preserving its
// per-model api/headers/compat so re-registration does not corrupt the model.
function toModelConfig(model: any) {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat,
  };
}

// Register each alias as a synthetic model cloned from its concrete target, grouped
// by provider, idempotently. Unresolvable targets warn and are skipped.
//
// `registerProvider` replaces ALL models for a provider and requires a provider-level
// baseUrl + apiKey/oauth. We pass through every existing model (minus prior alias
// entries, for /reload idempotency) plus the alias clones, and supply the target
// model's baseUrl. A placeholder apiKey only satisfies validation — for OAuth /
// auth.json providers the real credential in authStorage (keyed by provider name)
// always takes precedence, so auth is preserved.
export function injectAliases(
  pi: Pick<ExtensionAPI, "registerProvider">,
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "modelRegistry">,
  aliases: AliasMap,
): InjectResult {
  const registered: string[] = [];
  const skipped: string[] = [];
  const aliasNames = new Set(aliases.keys());
  const all = ctx.modelRegistry.getAll();

  // Group resolved targets by provider: provider -> Array<{ alias, model }>
  const byProvider = new Map<string, Array<{ alias: string; model: any }>>();
  for (const [alias, target] of aliases) {
    const split = splitQualified(target);
    const model = split
      ? all.find((m) => m.provider === split[0] && m.id === split[1])
      : undefined;
    if (!model) {
      notify(
        ctx,
        `[pi-model-replacements] alias "${alias}" -> "${target}" not found in registry; skipping.`,
        "warning",
      );
      skipped.push(alias);
      continue;
    }
    const list = byProvider.get(model.provider) ?? [];
    list.push({ alias, model });
    byProvider.set(model.provider, list);
  }

  for (const [provider, entries] of byProvider) {
    // Existing models for this provider, stripping any prior alias entries so repeated
    // calls (/reload) never duplicate aliases.
    const existing = all.filter((m) => m.provider === provider && !aliasNames.has(m.id));
    const aliasModels = entries.map((e) => ({
      ...toModelConfig(e.model),
      id: e.alias,
      name: `${e.model.name ?? e.model.id} (alias: ${e.alias})`,
    }));
    // Provider-level baseUrl applies to every model; use the first alias target's
    // baseUrl (aliases under the same provider share the endpoint in practice).
    const baseUrl = entries[0].model.baseUrl ?? existing[0]?.baseUrl;
    pi.registerProvider(provider, {
      baseUrl,
      apiKey: "pi-model-replacements-placeholder",
      models: [...existing.map(toModelConfig), ...aliasModels],
    } as any);
    for (const e of entries) registered.push(e.alias);
  }

  return { registered, skipped };
}
