/**
 * Operator MCP configuration crosses a process boundary through the Agent SDK.
 * The SDK serializes mcpServers into its --mcp-config argument, so literal
 * header credentials would be visible in process listings. Claude Code
 * officially expands environment variables in MCP HTTP/SSE headers; replace
 * literal values with placeholders and carry the values only in the child
 * environment.
 */

export interface SecuredMcpConfiguration {
  servers: Record<string, unknown>;
  env: Record<string, string>;
}

const ENV_CREDENTIAL = /^(?:Bearer\s+|Basic\s+)?(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Pure and synthetic-fixture friendly: never reads live credentials itself. */
export function secureMcpHeaderCredentials(
  input: Record<string, unknown>,
): SecuredMcpConfiguration {
  const servers: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  let index = 0;

  for (const [serverName, rawConfig] of Object.entries(input)) {
    if (!plainRecord(rawConfig)) {
      servers[serverName] = rawConfig;
      continue;
    }
    const config = { ...rawConfig };
    if (plainRecord(rawConfig.headers)) {
      const headers: Record<string, unknown> = {};
      for (const [headerName, rawValue] of Object.entries(rawConfig.headers)) {
        if (typeof rawValue !== 'string' || ENV_CREDENTIAL.test(rawValue.trim())) {
          headers[headerName] = rawValue;
          continue;
        }
        index += 1;
        const envName = `WEAVER_INTERNAL_MCP_HEADER_${index}`;
        env[envName] = rawValue;
        headers[headerName] = `\${${envName}}`;
      }
      config.headers = headers;
    }
    servers[serverName] = config;
  }

  return { servers, env };
}
