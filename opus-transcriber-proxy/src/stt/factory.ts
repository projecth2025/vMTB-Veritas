import { SelfHostedSTTProvider } from './selfHosted.js';
import { DummySTTProvider } from './dummy.js';
import type { STTProvider } from './types.js';
import type { Config } from '../config.js';

export type ProviderName = Config['provider'];

export interface ProviderOptions {
  sttWsUrl: string;
  sttUseIdToken?: boolean;
}

export function createSTTProvider(name: ProviderName, options: ProviderOptions): STTProvider {
  switch (name) {
    case 'dummy':
      return new DummySTTProvider();
    case 'self-hosted':
      return new SelfHostedSTTProvider({
        url: options.sttWsUrl,
        useIdToken: options.sttUseIdToken,
      });
    default:
      throw new Error(`Unknown STT provider: ${name}`);
  }
}