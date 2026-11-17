// Adapter selection from configuration. Model credentials come from the key
// store (<stateDir>/keys/model.key by default), never from config.
import { MockAdapter } from './mock.ts';
import type { MockAdapterConfig } from './mock.ts';
import { CliAdapter } from './cli.ts';
import type { CliAdapterConfig } from './cli.ts';
import { AnthropicAdapter } from './anthropic.ts';
import type { AnthropicConfig } from './anthropic.ts';
import type { ModelAdapter } from './types.ts';
import type { KeyStore } from '../keystore.ts';
import type { WrapperConfig } from '../config.ts';
import type { LogFn } from '../util.ts';

export function createAdapter(cfg: WrapperConfig, keys: KeyStore, log: LogFn): ModelAdapter {
  switch (cfg.adapter.kind) {
    case 'mock':
      return new MockAdapter(cfg.adapter as unknown as MockAdapterConfig);
    case 'anthropic': {
      const key = keys.readModelKey();
      if (!key) throw new Error(`model API key not found at ${keys.modelKeyPath} (0600 file outside the agent directory)`);
      return new AnthropicAdapter(cfg.adapter as unknown as AnthropicConfig, key);
    }
    case 'cli':
      return new CliAdapter(cfg.adapter as unknown as CliAdapterConfig, { stateDir: cfg.stateDir, agentDir: cfg.agentDir, credential: keys.readModelKey() }, log);
    default:
      throw new Error('unknown adapter kind');
  }
}
