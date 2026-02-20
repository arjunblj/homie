import type { IncomingMessage } from '../agent/types.js';
import type { HomieToolsConfig } from '../config/types.js';
import type { ToolDef } from './types.js';

export function filterToolsForMessage(
  tools: readonly ToolDef[] | undefined,
  msg: IncomingMessage,
  toolsConfig: HomieToolsConfig,
): readonly ToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  /**
   * Tool tier config semantics:
   * - If an allowlist is empty, it means "allow all tools in this tier" (once the tier is enabled).
   * - If an allowlist is non-empty, it means "allow only these tool names" (deny by default).
   * - Deny always wins (if a tool isn't allowed by tier gating + allowlist, it is filtered out).
   */
  const allowRestricted = msg.isOperator && Boolean(toolsConfig.restricted.enabledForOperator);
  const allowDangerous = msg.isOperator && Boolean(toolsConfig.dangerous.enabledForOperator);

  const restrictedAllow = new Set(toolsConfig.restricted.allowlist);
  const dangerousAllow = new Set(toolsConfig.dangerous.allowlist);
  const dangerousAllowAll = Boolean(toolsConfig.dangerous.allowAll);

  let out = tools.filter((t) => {
    if (t.tier === 'safe') return true;
    if (t.tier === 'restricted') {
      if (!allowRestricted) return false;
      if (restrictedAllow.size === 0) return true;
      return restrictedAllow.has(t.name);
    }
    if (t.tier === 'dangerous') {
      if (!allowDangerous) return false;
      if (dangerousAllowAll) return true;
      return dangerousAllow.has(t.name);
    }
    return false;
  });

  if (!msg.isOperator) {
    out = out.filter((t) => {
      const eff = t.effects ?? [];
      if (eff.includes('filesystem')) return false;
      if (eff.includes('subprocess')) return false;
      return true;
    });
  }

  return out.length ? out : undefined;
}

export function buildToolGuidance(tools: readonly ToolDef[] | undefined): string {
  const policy: string[] = [];
  const hasNetwork = Boolean(tools?.some((t) => t.effects?.includes('network')));
  const hasFilesystem = Boolean(tools?.some((t) => t.effects?.includes('filesystem')));
  const hasSubprocess = Boolean(tools?.some((t) => t.effects?.includes('subprocess')));

  if (hasNetwork) {
    policy.push(
      '- network tools: use only when asked; only fetch URLs the user pasted or web_search returned',
    );
  }
  if (hasFilesystem) {
    policy.push('- filesystem tools: use only when explicitly asked');
  }
  if (hasSubprocess) {
    policy.push('- subprocess tools: use only when explicitly asked (local-first)');
  }

  const lines =
    tools
      ?.map((t) => (t.guidance ? `- ${t.name}: ${t.guidance.trim()}` : ''))
      .filter((s) => Boolean(s.trim())) ?? [];
  if (policy.length === 0 && lines.length === 0) return '';
  return ['=== TOOL GUIDANCE ===', ...policy, ...(policy.length ? [''] : []), ...lines].join('\n');
}
