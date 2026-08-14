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

const ENV_PLACEHOLDER = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-(?:([^}]*)))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveHeader(
  raw: string,
  sourceEnv: Readonly<Record<string, string | undefined>>,
): { found: boolean; complete: boolean; value: string } {
  let found = false;
  let complete = true;
  const value = raw.replace(
    ENV_PLACEHOLDER,
    (match, bracedName: string | undefined, fallback: string | undefined,
      bareName: string | undefined) => {
      found = true;
      const supplied = sourceEnv[bracedName ?? bareName!];
      const resolved = supplied !== undefined && supplied !== '' ? supplied : fallback;
      if (resolved === undefined) {
        complete = false;
        return match;
      }
      return resolved;
    },
  );
  return { found, complete, value };
}

/** Pure and synthetic-fixture friendly: live credentials are supplied
 * explicitly by the caller, never read implicitly. */
export function secureMcpHeaderCredentials(
  input: Record<string, unknown>,
  sourceEnv: Readonly<Record<string, string | undefined>> = {},
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
        if (typeof rawValue !== 'string') {
          headers[headerName] = rawValue;
          continue;
        }
        const resolved = resolveHeader(rawValue, sourceEnv);
        if (resolved.found && !resolved.complete) {
          // Keep the native placeholder so Claude Code can produce its own
          // missing-variable diagnostic. Strict remote launch will reject the
          // same unresolved placeholder before starting a container.
          headers[headerName] = rawValue;
          continue;
        }
        index += 1;
        const envName = `WEAVER_INTERNAL_MCP_HEADER_${index}`;
        env[envName] = resolved.value;
        headers[headerName] = `\${${envName}}`;
      }
      config.headers = headers;
    }
    servers[serverName] = config;
  }

  return { servers, env };
}
