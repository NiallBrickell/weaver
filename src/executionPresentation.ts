/**
 * Human-facing execution identity.
 *
 * Executor names describe implementation substrates (`local-sdk`,
 * `openhands`); operators care first about which account/provider is doing
 * the work. Keep the raw executor on typed Attempt provenance and technical
 * views, but never make a container implementation look like the model
 * provider in ordinary UI.
 */
export function executionTargetLabel(target: {
  executor?: string;
  provider?: string;
  model?: string;
}): string {
  const model = target.model ?? 'model unknown';
  const provider = target.provider ?? providerFromQualifiedModel(target.model);
  if (provider === 'openrouter') return `OpenRouter · ${stripProvider(model, 'openrouter')}`;
  if (target.executor === 'codex-sdk' || provider === 'openai') return `Codex subscription · ${model}`;
  if (target.executor === 'local-sdk' && (provider === 'anthropic' || provider === undefined)) {
    return `Claude subscription · ${model}`;
  }
  if (provider) return `${displayProvider(provider)} · ${stripProvider(model, provider)}`;
  return model;
}

function providerFromQualifiedModel(model: string | undefined): string | undefined {
  const slash = model?.indexOf('/') ?? -1;
  return slash > 0 ? model!.slice(0, slash) : undefined;
}

function stripProvider(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

function displayProvider(provider: string): string {
  return provider.split(/[-_]/g).map((part) =>
    part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part,
  ).join(' ');
}
