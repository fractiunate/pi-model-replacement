import type { Model } from "@mariozechner/pi-ai";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildAliasMap,
  getAgentDir,
  readModelReplacements,
  resolveAlias,
  splitQualified,
  type AliasMap,
} from "./alias-resolver.js";
import { injectAliases, notify } from "./registry-inject.js";

export default function modelReplacementsExtension(pi: ExtensionAPI) {
  let aliases: AliasMap = new Map();

  // Resolve `model` (possibly an alias) to a concrete Model and make it active.
  // Self-terminating: the target is always a concrete "provider/model-id", never an
  // alias key, so the resulting model_select fires with a non-alias id (no loop).
  async function swapIfAlias(ctx: ExtensionContext, model: string | undefined): Promise<void> {
    const target = resolveAlias(model, aliases);
    if (!target) return;
    const split = splitQualified(target);
    const concrete: Model<any> | undefined = split
      ? ctx.modelRegistry.find(split[0], split[1])
      : undefined;
    if (!concrete) {
      notify(
        ctx,
        `[pi-model-replacements] cannot swap "${model}" -> "${target}" (concrete model not found).`,
        "warning",
      );
      return;
    }
    await pi.setModel(concrete);
  }

  // Phase 2 + 3: inject synthetic alias models, then swap the active model if it is an alias.
  pi.on("session_start", async (event, ctx) => {
    aliases = buildAliasMap(readModelReplacements(getAgentDir()));
    if (aliases.size === 0) return;
    injectAliases(pi, ctx, aliases);

    if (event.reason === "reload") {
      // On reload, ctx.model?.id is the previously-concretized target (e.g. "claude-haiku"),
      // which is not in the alias map. Recover the original alias name from the session log
      // and re-swap to the (possibly changed) new concrete target.
      const entries = ctx.sessionManager.getEntries();
      const lastAlias = [...entries]
        .reverse()
        .find((e): e is CustomEntry<{ alias: string }> =>
          e.type === "custom" && e.customType === "pi-mr-last-alias",
        );
      await swapIfAlias(ctx, lastAlias?.data?.alias ?? ctx.model?.id);
    } else {
      await swapIfAlias(ctx, ctx.model?.id);
    }
  });

  // Phase 3: reactive swap whenever an alias becomes the active session model
  // (e.g. pi-prompt-template-model selecting a `model: low` frontmatter value).
  // Persist the alias name so a subsequent reload can re-swap to the updated target.
  pi.on("model_select", async (event, ctx) => {
    const modelId = event.model?.id;
    if (resolveAlias(modelId, aliases)) {
      pi.appendEntry<{ alias: string }>("pi-mr-last-alias", { alias: modelId! });
    }
    await swapIfAlias(ctx, modelId);
  });

  // Phase 4: rewrite explicit `subagent` tool-call model param from alias to concrete
  // before pi-subagents' execute() resolves it. event.input is mutable in place.
  //
  // Thinking suffix handling: a value like "high:thinking" must have its alias base
  // ("high") resolved to the concrete target with the suffix re-attached, yielding
  // e.g. "github-copilot/claude-opus-4.8:thinking". pi-subagents' resolveModelCandidate()
  // only matches the base id against the registry and would otherwise resolve the
  // *synthetic* alias entry ("github-copilot/high"), which is not a real API model.
  pi.on("tool_call", (event) => {
    if (event.toolName === "subagent" && typeof (event.input as any)?.model === "string") {
      const raw = (event.input as any).model as string;
      const colon = raw.lastIndexOf(":");
      const base = colon > 0 ? raw.slice(0, colon) : raw;
      const suffix = colon > 0 ? raw.slice(colon) : "";
      const target = resolveAlias(base, aliases);
      if (target) (event.input as any).model = target + suffix;
    }
  });

  // Phase 5: per-turn safety net for the frontmatter `model: medium` path and any
  // ordering where model_select did not fire (e.g. child startup). Self-terminating.
  pi.on("before_agent_start", async (_event, ctx) => {
    await swapIfAlias(ctx, ctx.model?.id);
  });
}
