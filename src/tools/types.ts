import type { IncomingAttachment } from '../agent/attachments.js';

export type ToolTier = 'safe' | 'restricted' | 'dangerous';

export type ToolSource = 'builtin' | 'identity' | 'skill';

export interface ToolContext {
  now: Date;
  signal: AbortSignal;
  /**
   * Attachments available for the current turn (ephemeral). Tools must never assume
   * these exist outside the current turn.
   */
  attachments?: readonly IncomingAttachment[] | undefined;
  /**
   * Safe attachment-by-id bytes loader for the current turn. Tools must not accept
   * arbitrary filesystem paths; they should request bytes via this API.
   */
  getAttachmentBytes?: ((attachmentId: string) => Promise<Uint8Array>) | undefined;
  /**
   * Best-effort URL allowlist populated from user text and web_search results.
   * This is a UX guardrail to prevent the model from speculatively fetching
   * unrelated URLs — NOT a security boundary. The actual SSRF protection lives
   * in assertUrlAllowed (DNS resolution + private IP blocking).
   */
  verifiedUrls?: Set<string> | undefined;
  /**
   * Per-turn tool-output budgeting and telemetry. This is used by the tool wrapper
   * to cap result size and to record truncation events; tools themselves should
   * ignore it unless they need to introspect budgets.
   */
  toolOutput?:
    | {
        /** Remaining token budget across all tool outputs in this turn. Mutable. */
        remainingTokens: number;
        /** Max tokens allowed for a single tool output. */
        maxTokensPerTool: number;
        onToolOutput?:
          | ((event: { toolName: string; tokensUsed: number; truncated: boolean }) => void)
          | undefined;
      }
    | undefined;
  net?:
    | {
        /**
         * Optional DNS resolver for SSRF-safe tools (used for tests and special runtimes).
         * Should resolve a hostname to a list of IP string literals.
         */
        dnsLookupAll?: (hostname: string) => Promise<readonly string[]>;
        /**
         * Optional DNS resolution timeout override (ms). Primarily used by tests to
         * avoid slow wall-clock waits while still exercising timeout behavior.
         */
        dnsTimeoutMs?: number;
      }
    | undefined;
}

/**
 * Advisory effect tags for model prompt guidance. These are NOT enforced at
 * runtime — they surface as policy hints to the model (e.g. "network tools:
 * use only when asked"). The real security boundary is in assertUrlAllowed
 * and tool tier gating.
 */
export type ToolEffect = 'network' | 'filesystem' | 'subprocess';

export interface ToolDef {
  name: string;
  tier: ToolTier;
  source?: ToolSource | undefined;
  description: string;
  guidance?: string | undefined;
  /** Advisory effect tags surfaced as guidance to the model. Not enforced at runtime. */
  effects?: readonly ToolEffect[] | undefined;
  inputSchema: import('zod').ZodTypeAny;
  timeoutMs?: number | undefined;
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
}

export interface ToolRegistry {
  all: Record<string, ToolDef>;
  byTier: Record<ToolTier, Record<string, ToolDef>>;
}
