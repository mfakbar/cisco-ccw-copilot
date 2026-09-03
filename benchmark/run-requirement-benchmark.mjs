import { readFile } from 'node:fs/promises';
import { extractRequirements, normalizeExtractedRequirements } from '../packages/companion/dist/providers.js';

const cases = JSON.parse(await readFile(new URL('./requirement-cases.json', import.meta.url), 'utf8'));
const model = process.argv[2] || 'qwen3.5:4b-q4_K_M';
const sameValue = (actual, expected) => typeof expected === 'number'
  ? typeof actual === 'number' && Math.abs(actual - expected) < 0.000001
  : String(actual).toLowerCase() === String(expected).toLowerCase();
const assertionCount = (testCase) => Object.values(testCase.expected)
  .reduce((total, expected) => total + ['value', 'unit', 'status'].filter((field) => field in expected).length, 0)
  + (testCase.absent?.length ?? 0);

const results = [];
for (const testCase of cases) {
  const startedAt = Date.now();
  try {
    const requirements = model === 'deterministic' ? normalizeExtractedRequirements([], testCase.input) : await extractRequirements({ provider: 'local', model }, testCase.input);
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
    for (const id of testCase.absent || []) {
      assertions += 1;
      if (!byId.has(id)) passed += 1;
      else discrepancies.push({ id, field: 'absent', expected: true, actual: byId.get(id) });
    }
    results.push({ id: testCase.id, assertions, passed, accuracy: passed / assertions, elapsedMs: Date.now() - startedAt, discrepancies, requirements });
  } catch (error) {
    results.push({ id: testCase.id, assertions: assertionCount(testCase), passed: 0, accuracy: 0, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
  }
}

const totals = results.reduce((summary, result) => ({ assertions: summary.assertions + result.assertions, passed: summary.passed + result.passed, elapsedMs: summary.elapsedMs + result.elapsedMs }), { assertions: 0, passed: 0, elapsedMs: 0 });
const report = { model, caseCount: cases.length, ...totals, accuracy: totals.passed / totals.assertions, results };
if (process.argv.includes('--summary')) console.log(JSON.stringify({ ...report, results: results.map(({ id, assertions, passed, accuracy, elapsedMs, discrepancies, error }) => ({ id, assertions, passed, accuracy, elapsedMs, discrepancies, ...(error ? { error } : {}) })) }, null, 2));
else console.log(JSON.stringify(report, null, 2));
