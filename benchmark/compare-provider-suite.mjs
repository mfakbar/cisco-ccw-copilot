import { readFile } from 'node:fs/promises';
import { extractRequirements } from '../packages/companion/dist/providers.js';

const cases = JSON.parse(await readFile(new URL('./requirement-cases.json', import.meta.url), 'utf8'));
const token = process.env.CIRCUIT_ACCESS_TOKEN;
if (!token) throw new Error('Set CIRCUIT_ACCESS_TOKEN before running the provider suite.');

const providers = [
  { name: 'Local Ollama · qwen3.5:4b-q4_K_M', config: { provider: 'local', model: 'qwen3.5:4b-q4_K_M' } },
  { name: 'CircuIT · gemini-3.1-flash-lite', config: { provider: 'circuit', model: 'gemini-3.1-flash-lite', apiKey: token } }
];

const sameValue = (actual, expected) => typeof expected === 'number'
  ? typeof actual === 'number' && Math.abs(actual - expected) < 0.000001
  : String(actual).toLowerCase() === String(expected).toLowerCase();
const assertionCount = (testCase) => Object.values(testCase.expected)
  .reduce((total, expected) => total + ['value', 'unit', 'status'].filter((field) => field in expected).length, 0)
  + (testCase.absent?.length ?? 0);
const percentile = (values, fraction) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] : 0;

async function runProvider(provider) {
  const results = [];
  for (const testCase of cases) {
    const startedAt = Date.now();
    let providerCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { providerCalls += 1; return originalFetch(...args); };
    try {
      const requirements = await extractRequirements(provider.config, testCase.input);
      const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
      const discrepancies = [];
      let assertions = 0;
      let passed = 0;
      for (const [id, expected] of Object.entries(testCase.expected)) {
        const actual = byId.get(id);
        for (const field of ['value', 'unit', 'status']) {
          if (!(field in expected)) continue;
          assertions += 1;
          if (actual && sameValue(actual[field], expected[field])) passed += 1;
          else discrepancies.push({ id, field, expected: expected[field], actual: actual?.[field] });
        }
      }
      for (const id of testCase.absent ?? []) {
        assertions += 1;
        if (!byId.has(id)) passed += 1;
        else discrepancies.push({ id, field: 'absent', expected: true, actual: byId.get(id) });
      }
      results.push({ id: testCase.id, assertions, passed, accuracy: passed / assertions, elapsedMs: Date.now() - startedAt, providerCalled: providerCalls > 0, discrepancies });
    } catch (error) {
      results.push({ id: testCase.id, assertions: assertionCount(testCase), passed: 0, accuracy: 0, elapsedMs: Date.now() - startedAt, providerCalled: providerCalls > 0, error: error instanceof Error ? error.message : String(error) });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  const assertions = results.reduce((total, result) => total + result.assertions, 0);
  const passed = results.reduce((total, result) => total + result.passed, 0);
  const elapsed = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  return {
    name: provider.name,
    cases: results.length,
    llmRequests: results.filter((result) => result.providerCalled).length,
    missingLlmRequests: results.filter((result) => !result.providerCalled).length,
    assertions,
    passed,
    accuracy: passed / assertions,
    elapsedMs: elapsed.reduce((total, value) => total + value, 0),
    latencyMs: { p50: percentile(elapsed, 0.5), p95: percentile(elapsed, 0.95) },
    failedCases: results.filter((result) => result.accuracy < 1 || result.error)
  };
}

const results = [];
for (const provider of providers) results.push(await runProvider(provider));
console.log(JSON.stringify({ benchmark: '16 representative RFP cases', results }, null, 2));
