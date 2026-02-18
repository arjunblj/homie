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
   * Verified-URL allowlist for network fetch tools. Populate from user text
   * and (optionally) from trusted search tool results.
   */
  verifiedUrls?: Set<string> | undefined;
  net?:
    | {
        /**
         * Optional DNS resolver for SSRF-safe tools (used for tests and special runtimes).
         * Should resolve a hostname to a list of IP string literals.
         */
        dnsLookupAll?: (hostname: string) => Promise<readonly string[]>;
      }
    | undefined;
}

export type ToolEffect = 'network' | 'filesystem' | 'subprocess';

export interface ToolDef {
  name: string;
  tier: ToolTier;
  source?: ToolSource | undefined;
  description: string;
  guidance?: string | undefined;
  effects?: readonly ToolEffect[] | undefined;
  inputSchema: import('zod').ZodTypeAny;
  timeoutMs?: number | undefined;
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
}

export interface ToolRegistry {
  all: Record<string, ToolDef>;
  byTier: Record<ToolTier, Record<string, ToolDef>>;
}
