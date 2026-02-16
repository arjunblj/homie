import { z } from 'zod';
import type { ToolDef, ToolTier } from './types.js';

export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly tier?: ToolTier | undefined;
}

export async function loadMcpTools(config: McpServerConfig): Promise<ToolDef[]> {
  try {
    // @ts-expect-error — optional dependency; absence caught by surrounding try/catch
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    // @ts-expect-error — optional dependency; absence caught by surrounding try/catch
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ? [...config.args] : [],
      env: config.env ? { ...process.env, ...config.env } : undefined,
    });

    const client = new Client({ name: 'homie', version: '0.1.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();

    const tier = config.tier ?? 'restricted';

    return tools.map((mcpTool: { name: string; description?: string; inputSchema?: unknown }) => ({
      name: mcpTool.name,
      tier,
      description: mcpTool.description ?? mcpTool.name,
      inputSchema: z.any(),
      execute: async (input: unknown) => {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input as Record<string, unknown>,
        });
        return result;
      },
    }));
  } catch {
    // MCP SDK not installed or server failed to start — skip gracefully
    return [];
  }
}
