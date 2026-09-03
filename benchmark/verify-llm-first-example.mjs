import { extractRequirements } from '../packages/companion/dist/providers.js';

const prompt = `CPU: 2-socket 24 core, 2.2Ghz
Memory: 1TB using 64GB DDR5
Drive: 4TB SSD RAID5, 2TB U.3 NVMe RAID1, 4x 1.9TB RAID10
NIC: 2 card 2x 10G SFP and 2 card 2x 32G FC`;
const token = process.env.CIRCUIT_ACCESS_TOKEN;
if (!token) throw new Error('Set CIRCUIT_ACCESS_TOKEN before running the live LLM-first verification.');

const providers = [
  { name: 'Local Ollama · qwen3.5:4b-q4_K_M', config: { provider: 'local', model: 'qwen3.5:4b-q4_K_M' } },
  { name: 'CircuIT · gemini-3.1-flash-lite', config: { provider: 'circuit', model: 'gemini-3.1-flash-lite', apiKey: token } }
];

const results = [];
for (const provider of providers) {
  const startedAt = Date.now();
  let llmRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { llmRequests += 1; return originalFetch(...args); };
  try {
    const requirements = await extractRequirements(provider.config, prompt);
    const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
    results.push({
      name: provider.name,
      llmRequests,
      elapsedMs: Date.now() - startedAt,
      memoryGb: byId.get('memoryGb')?.value,
      memoryModuleSizeGb: byId.get('memoryModuleSizeGb')?.value,
      requirementCount: requirements.length
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(JSON.stringify({ benchmark: 'LLM-first exact RFP verification', results }, null, 2));
if (results.some((result) => result.llmRequests !== 1 || result.memoryGb !== 1024 || result.memoryModuleSizeGb !== 64)) process.exitCode = 1;
