import { afterEach, describe, expect, it, vi } from 'vitest';
import { listOllamaModels } from '../packages/companion/src/ollama.js';

describe('Ollama model discovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns unique installed model names in a stable order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [
      { name: 'qwen3.5:9b-q4_K_M' },
      { model: 'qwen3.5:4b-q4_K_M' },
      { name: 'qwen3.5:4b-q4_K_M' }
    ] }), { status: 200 })));
    await expect(listOllamaModels()).resolves.toEqual(['qwen3.5:4b-q4_K_M', 'qwen3.5:9b-q4_K_M']);
  });

  it('reports an Ollama discovery failure without inventing models', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    await expect(listOllamaModels()).rejects.toThrow('Ollama model discovery failed: 503');
  });
});
