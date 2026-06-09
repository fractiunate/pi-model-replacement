# pi-model-replacements

A standalone [pi](https://github.com/earendil-works/pi) extension that lets
agents, subagents, and prompt templates reference **abstract model tiers** (`low` /
`medium` / `high`, or any alias name) instead of hard-coding `provider/model-id`. A single
change in `settings.json` re-points every template and subagent.

## How it works

Add a `model_replacements` map to the active agent dir's `settings.json` (the dir selected
by `PI_CODING_AGENT_DIR`, e.g. `~/.pi/agent/settings.json`):

```json
{
  "model_replacements": {
    "low": "github-copilot/claude-haiku-4.5",
    "medium": "github-copilot/claude-sonnet-4.6",
    "high": "github-copilot/claude-opus-4.8"
  }
}
```

Now any `model: low` in a prompt-template frontmatter, an agent definition, or a
`subagent` tool call resolves to the concrete model — no file writes, no edits to other
extensions.

### Mechanism

1. **`session_start`** — each alias is injected into the live model registry as a synthetic
   model cloned from its concrete target (grouped per provider, idempotent across
   `/reload`). Unresolvable targets warn once and are skipped.
2. **`model_select`** + initial swap — when an alias becomes the active model, it is swapped
   to the concrete `Model` object via `pi.setModel`. Self-terminating (the target is never
   an alias key, so no loop).
3. **`tool_call`** — an explicit `subagent` `model: "high"` argument is rewritten in place to
   the concrete `provider/model-id` before the child process spawns.
4. **`before_agent_start`** — a per-turn safety net that swaps any still-active alias
   immediately before the API call (covers the agent-frontmatter path and child startup
   ordering). The same extension code runs fresh inside subagent child processes.

## Configuration resolution

`PI_CODING_AGENT_DIR` is honoured exactly like `pi-subagents`:
`~` / `~/...` are expanded; otherwise the literal value is used; default is `~/.pi/agent`.
Reading is fail-soft — a missing or malformed `settings.json`, or absent
`model_replacements`, yields no aliases (extension is a no-op).

## Development

```sh
npm install
npm test   # tsx --test *.test.ts
```

## Works well with

- [**pi-prompt-template-model**](https://github.com/nicobailon/pi-prompt-template-model) — Abstract model tiers in your prompt templates.
- [**pi-subagents**](https://github.com/nicobailon/pi-subagents) — Delegate work to subagents with model-tier overrides in `subagent` tool calls.

## Contracts and limitations

### Thinking-suffix handling

`pi-model-replacements` resolves aliases by **exact key match**. A suffixed string
such as `"high:thinking"` does not match alias key `"high"` directly, so the
`tool_call` handler splits the trailing `:thinking` suffix, resolves the base alias
(`"high"`) to its concrete target, and re-attaches the suffix — producing e.g.
`"github-copilot/claude-opus-4.8:thinking"`.

This is required because `pi-subagents`' `resolveModelCandidate()` only matches the
base model id against the live registry. Since `pi-model-replacements` injects each
alias as a *synthetic* registry entry, passing `"high:thinking"` through unresolved
would make pi-subagents select the synthetic alias id (`"github-copilot/high"`),
which is not a real API model and fails with `400 model not supported`. The alias
must therefore be resolved to its concrete target here, before the child spawns.

This behaviour is locked by a regression test in `tool-call.test.ts`
(`"subagent tool_call: suffixed alias ('high:thinking') resolves base alias and re-attaches suffix"`).

### Unsupported: alias chaining

A configuration like `{ "low": "medium", "medium": "provider/model" }` — where an
alias target is itself another alias key — is **not supported**. `buildAliasMap`
detects chained entries at map-build time, emits a `console.warn`, and skips them.
Only direct `alias → "provider/model-id"` mappings are accepted.

### Code note: `getAgentDir()` duplication

`alias-resolver.ts:getAgentDir()` is a character-for-character copy of
`pi-subagents/src/shared/utils.ts:getAgentDir()`. Both are intentionally kept
separate to avoid cross-package coupling. Any future change to path-expansion
logic (e.g., Windows normalisation) must be applied to both files.
