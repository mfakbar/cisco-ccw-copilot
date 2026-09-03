export const CIRCUIT_MODELS = ['gemini-3.1-flash-lite', 'gpt-5-nano'] as const;

export type CircuitModel = typeof CIRCUIT_MODELS[number];

export const CIRCUIT_MODEL_OPTIONS = [
  { value: CIRCUIT_MODELS[0], label: 'Gemini 3.1 Flash Lite' },
  { value: CIRCUIT_MODELS[1], label: 'GPT-5 Nano' }
] as const;

const circuitModelSet = new Set<string>(CIRCUIT_MODELS);

export function isCircuitModel(model: string): model is CircuitModel {
  return circuitModelSet.has(model);
}
