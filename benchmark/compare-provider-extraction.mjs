import { extractRequirements } from '../packages/companion/dist/providers.js';

const prompt = 'We need one Cisco C-Series application server with two Intel CPUs, 32 physical cores per CPU, and a 2.8 GHz minimum base clock. Install 1 TB RAM. Provide 8 TB usable local SSD storage protected by RAID 5. Networking must include two cards, each with two 25 Gbps SFP ports. Delivery is required within 45 days.';
const expected = {
  serverQuantity: 1,
  cpuSockets: 2,
  cpuCoresPerSocket: 32,
  cpuTotalCores: 64,
  cpuClockGhz: 2.8,
  cpuVendor: 'intel',
  memoryGb: 1024,
  localStorageCapacity: 8,
  localStorageCapacityType: 'usable',
  localDriveType: 'SSD',
  raidLevel: '5',
  nicCardCount: 2,
  nicPortsPerCard: 2,
  nicSpeedGbpsPerPort: 25,
  nicMedia: 'SFP',
  maxLeadTimeDays: 45
};

const sameValue = (actual, wanted) => typeof wanted === 'number'
  ? typeof actual === 'number' && Math.abs(actual - wanted) < 0.000001
  : String(actual).toLowerCase() === String(wanted).toLowerCase();

async function measure(name, config) {
  const startedAt = Date.now();
  try {
    const requirements = await extractRequirements(config, prompt);
    const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
    const checks = Object.entries(expected).map(([id, wanted]) => ({ id, expected: wanted, actual: byId.get(id)?.value, passed: sameValue(byId.get(id)?.value, wanted) }));
    const passed = checks.filter((check) => check.passed).length;
    return { name, status: 'completed', passed, assertions: checks.length, accuracy: passed / checks.length, elapsedMs: Date.now() - startedAt, discrepancies: checks.filter((check) => !check.passed) };
  } catch (error) {
    return { name, status: 'failed', passed: 0, assertions: Object.keys(expected).length, accuracy: 0, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

const circuitToken = process.env.CIRCUIT_ACCESS_TOKEN;
const results = [
  await measure('Local Ollama · qwen3.5:4b-q4_K_M', { provider: 'local', model: 'qwen3.5:4b-q4_K_M' })
];

if (circuitToken) {
  results.push(
    await measure('CircuIT · gemini-3.1-flash-lite', { provider: 'circuit', model: 'gemini-3.1-flash-lite', apiKey: circuitToken }),
    await measure('CircuIT · gpt-5-nano', { provider: 'circuit', model: 'gpt-5-nano', apiKey: circuitToken })
  );
} else {
  for (const model of ['gemini-3.1-flash-lite', 'gpt-5-nano']) results.push({ name: `CircuIT · ${model}`, status: 'skipped', reason: 'Set CIRCUIT_ACCESS_TOKEN for a live comparison.' });
}

console.log(JSON.stringify({ benchmark: 'same dummy RFP provider extraction', prompt, expected, results }, null, 2));
