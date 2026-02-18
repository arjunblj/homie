# Tools

Homie v1 supports a three-source tool model:

- `builtin` tools shipped with `homie-ai`
- `identity` tools shipped with the identity package (`identity/tools/...`)
- `skill` tools loaded from the project `skills/` directory

Tools are always passed to the model explicitly by the harness. A tool is just code: it can be fast (pure) or slow (network), but it must be safe to cancel.

## Tool definition

Tools implement `ToolDef` (`packages/homie-ai/src/tools/types.ts`).

Important fields:

- `tier`: `safe | restricted | dangerous`
- `guidance`: one-line social guidance injected into the system prompt
- `timeoutMs`: default timeout for tool execution
- `execute(input, ctx)` where `ctx.signal` is aborted on timeout / shutdown

## Tier policy (enforced)

The harness enforces a strict default:

- non-operator chats: `safe` tools only
- operator chats: `safe` + `restricted`
- `dangerous`: operator-only and only when enabled in `config.tools.dangerous`

This is enforced in `TurnEngine` by filtering tools before they are shown to the model.

## Cancellation and timeouts

Every tool receives an `AbortSignal`:

- it is aborted on tool timeout
- it is aborted when the process is shutting down

Network tools should pass `ctx.signal` to `fetch()` so they can be cancelled.

## Identity tools

Identity tools are loaded from:

`<identityDir>/tools/<tool-pack>/index.js` (or `index.mjs` / `index.ts`)

The module must export:

- `tools: ToolDef[]`

Optional:

- `manifest.json` with `{ name, tier }`

Example:

```js
export const tools = [
  {
    name: 'identity_ping',
    tier: 'safe',
    description: 'Ping (identity tool).',
    guidance: 'Use only when the user explicitly asks to test identity tools.',
    timeoutMs: 1000,
    inputSchema: { safeParse: (x) => ({ success: true, data: x }) },
    execute: () => 'ok',
  },
];
```

## Skills tools

Skills tools are loaded from:

`<skillsDir>/<skillName>/index.js` (or `index.mjs` / `index.ts`)

Same export shape as identity tools.

## Tool guidance injection

If a tool provides `guidance`, the harness injects a `=== TOOL GUIDANCE ===` section into the system prompt, so tools feel like an extension of the friend identity rather than a generic assistant toolkit.

