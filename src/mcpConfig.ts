/**
 * Operator MCP configuration crosses an executor boundary and, for the local
 * SDK executor, a process boundary. The SDK serializes mcpServers into its
 * --mcp-config argument, so literal header and stdio-env credentials would be
 * visible in process listings. Claude Code expands environment variables in
 * MCP commands, args, env, URLs, and headers; move literal credential-bearing
 * fields and carry every referenced value with config as one capability.
 */

export interface SecuredMcpConfiguration {
  servers: Record<string, unknown>;
  env: Record<string, string>;
}

const ENV_REFERENCE =
  /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\})/g;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function referencedEnvNames(value: string): string[] {
  return [...value.matchAll(ENV_REFERENCE)].map((match) => match[1] ?? match[2]!);
}

function collectReferencedEnvNames(value: unknown, names: Set<string>): void {
  if (typeof value === 'string') {
    for (const name of referencedEnvNames(value)) names.add(name);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectReferencedEnvNames(child, names);
    return;
  }
  if (plainRecord(value)) {
    for (const child of Object.values(value)) collectReferencedEnvNames(child, names);
  }
}

/** Pure and synthetic-fixture friendly: never reads live credentials itself. */
export function secureMcpConfiguration(
  input: Record<string, unknown>,
  ambientEnv: Record<string, string | undefined> = {},
  forbiddenEnvNames: readonly string[] = [],
): SecuredMcpConfiguration {
  const servers: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const reservedEnvNames = new Set(Object.keys(ambientEnv));
  const forbidden = new Set(forbiddenEnvNames);
  collectReferencedEnvNames(input, reservedEnvNames);
  const generatedIndexes: Record<string, number> = {};

  function copyReferencedEnv(value: string): boolean {
    const names = referencedEnvNames(value);
    for (const name of names) {
      if (forbidden.has(name)) {
        throw new Error(`MCP configuration references reserved executor credential ${name}`);
      }
      const ambientValue = ambientEnv[name];
      if (ambientValue !== undefined) env[name] = ambientValue;
    }
    return names.length > 0;
  }

  function hoistLiteral(kind: 'HEADER' | 'ENV', value: string): string {
    let envName: string;
    do {
      generatedIndexes[kind] = (generatedIndexes[kind] ?? 0) + 1;
      envName = `WEAVER_INTERNAL_MCP_${kind}_${generatedIndexes[kind]}`;
    } while (reservedEnvNames.has(envName));
    reservedEnvNames.add(envName);
    env[envName] = value;
    return `\${${envName}}`;
  }

  for (const [serverName, rawConfig] of Object.entries(input)) {
    if (!plainRecord(rawConfig)) {
      servers[serverName] = rawConfig;
      continue;
    }
    const config = { ...rawConfig };
    if (typeof rawConfig.command === 'string') copyReferencedEnv(rawConfig.command);
    if (Array.isArray(rawConfig.args)) {
      for (const arg of rawConfig.args) {
        if (typeof arg === 'string') copyReferencedEnv(arg);
      }
    }
    if (typeof rawConfig.url === 'string') copyReferencedEnv(rawConfig.url);
    if (plainRecord(rawConfig.headers)) {
      const headers: Record<string, unknown> = {};
      for (const [headerName, rawValue] of Object.entries(rawConfig.headers)) {
        if (typeof rawValue === 'string' && copyReferencedEnv(rawValue)) {
          headers[headerName] = rawValue;
          continue;
        }
        if (typeof rawValue !== 'string') {
          headers[headerName] = rawValue;
          continue;
        }
        headers[headerName] = hoistLiteral('HEADER', rawValue);
      }
      config.headers = headers;
    }
    if (plainRecord(rawConfig.env)) {
      const serverEnv: Record<string, unknown> = {};
      for (const [name, rawValue] of Object.entries(rawConfig.env)) {
        if (typeof rawValue === 'string' && copyReferencedEnv(rawValue)) {
          serverEnv[name] = rawValue;
        } else if (typeof rawValue === 'string') {
          serverEnv[name] = hoistLiteral('ENV', rawValue);
        } else {
          serverEnv[name] = rawValue;
        }
      }
      config.env = serverEnv;
    }
    servers[serverName] = config;
  }

  return { servers, env };
}
