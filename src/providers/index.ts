import { OpenAIChatProvider } from './openaiChat';
import { OpenAIResponsesProvider } from './openaiResponses';
import { ProviderRegistry } from './provider';

export * from './provider';

export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register('openai-responses', (o) => new OpenAIResponsesProvider(o));
  registry.register('openai-chat', (o) => new OpenAIChatProvider(o));
  return registry;
}
