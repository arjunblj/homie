import type { IncomingAttachment } from '../agent/attachments.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionStore } from '../session/types.js';
import type { ChatId } from '../types/ids.js';

export type ToolTier = 'safe' | 'restricted' | 'dangerous';

export type ToolSource = 'builtin' | 'identity' | 'skill';

export type OutgoingMediaKind = 'image' | 'audio' | 'animation' | 'file';

export interface ToolMediaAttachment {
  readonly kind: OutgoingMediaKind;
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly fileName?: string | undefined;
  readonly altText: string;
  readonly asVoiceNote?: boolean | undefined;
}

export interface ToolResultWithMedia {
  readonly text: string;
  readonly media: readonly ToolMediaAttachment[];
}

export const isToolResultWithMedia = (v: unknown): v is ToolResultWithMedia => {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as { text?: unknown; media?: unknown };
  if (typeof obj.text !== 'string') return false;
  if (!Array.isArray(obj.media)) return false;
  return obj.media.every((m) => {
    if (typeof m !== 'object' || m === null) return false;
    const mm = m as { kind?: unknown; mime?: unknown; bytes?: unknown; altText?: unknown };
    const kind = mm.kind;
    if (kind !== 'image' && kind !== 'audio' && kind !== 'animation' && kind !== 'file')
      return false;
    if (typeof mm.mime !== 'string' || !mm.mime.trim()) return false;
    if (!(mm.bytes instanceof Uint8Array)) return false;
    if (typeof mm.altText !== 'string') return false;
    return true;
  });
};

export interface ToolContext {
  now: Date;
  signal: AbortSignal;
  /**
   * Chat metadata for the current turn. Present only when the tool is invoked
   * during a normal engine turn (not when tools are used in isolation).
   */
  chat?:
    | {
        chatId: ChatId;
        channel: string;
        channelUserId?: string | undefined;
        isGroup: boolean;
        isOperator: boolean;
      }
    | undefined;
  /**
   * Pre-initialized services the runtime already owns. Tools must prefer these
   * over opening their own stores/connections.
   */
  services?:
    | {
        memoryStore?: MemoryStore | undefined;
        sessionStore?: SessionStore | undefined;
      }
    | undefined;
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
  /**
   * Side-channel for tools to emit binary media without including it in the LLM context.
   * The engine/channel layer may deliver these attachments out-of-band.
   */
  outgoingMedia?:
    | {
        add: (attachment: ToolMediaAttachment) => void;
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
  execute: (
    input: unknown,
    ctx: ToolContext,
  ) => Promise<unknown | ToolResultWithMedia> | unknown | ToolResultWithMedia;
}

export interface ToolRegistry {
  all: Record<string, ToolDef>;
  byTier: Record<ToolTier, Record<string, ToolDef>>;
}
