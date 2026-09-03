import { extractRequirements } from '../packages/companion/dist/providers.js';

const profiles = Array.from({ length: 20 }, (_, index) => ({
  id: `profile-${String(index + 1).padStart(2, '0')}`,
  sockets: index % 4 === 0 ? 1 : 2,
  coresPerSocket: [16, 20, 24, 32, 48][index % 5],
  clockGhz: [2.0, 2.2, 2.4, 2.6][index % 4],
  memoryGb: [256, 512, 1024, 1536, 2048][index % 5],
  storageTb: [2, 4, 6, 8, 12][index % 5],
  raid: ['1', '5', '6', '10'][index % 4],
  nicCards: index % 3 + 1,
  nicPorts: [2, 4][index % 2],
  nicSpeed: [10, 25, 40, 100][index % 4],
  nicMedia: index % 4 === 3 ? 'QSFP' : 'SFP'
}));

const values = (profile) => ({
  cpu: `${profile.sockets}x ${profile.coresPerSocket} core, ${profile.clockGhz}GHz`,
  memory: profile.memoryGb % 1024 === 0 ? `${profile.memoryGb / 1024}TB` : `${profile.memoryGb}GB`,
  drive: `${profile.storageTb}TB SSD RAID${profile.raid}`,
  nic: `${profile.nicCards}-card ${profile.nicPorts}x ${profile.nicSpeed}G ${profile.nicMedia}`
});

const formats = [
  ['colon-lines', (profile) => { const v = values(profile); return `CPU: ${v.cpu}\nMemory: ${v.memory}\nDrive: ${v.drive}\nNIC: ${v.nic}`; }],
  ['markdown-bullets', (profile) => { const v = values(profile); return `- CPU: ${v.cpu}\n- Memory: ${v.memory}\n- Drive: ${v.drive}\n- NIC: ${v.nic}`; }],
  ['numbered-list', (profile) => { const v = values(profile); return `1. CPU: ${v.cpu}\n2. Memory: ${v.memory}\n3. Drive: ${v.drive}\n4. NIC: ${v.nic}`; }],
  ['markdown-table', (profile) => { const v = values(profile); return `| Category | Requirement |\n|---|---|\n| CPU | ${v.cpu} |\n| Memory | ${v.memory} |\n| Drive | ${v.drive} |\n| NIC | ${v.nic} |`; }],
  ['alternate-labels', (profile) => { const v = values(profile); return `Processor = ${v.cpu}\nRAM Capacity = ${v.memory}\nLocal Storage = ${v.drive}\nNetwork Adapters = ${v.nic}`; }]
];

const cases = profiles.flatMap((profile) => formats.map(([format, render]) => ({ profile, format, input: render(profile) })));
const expectedFor = (profile) => ({
  cpuSockets: profile.sockets,
  cpuCoresPerSocket: profile.coresPerSocket,
  cpuTotalCores: profile.sockets * profile.coresPerSocket,
  cpuClockGhz: profile.clockGhz,
  memoryGb: profile.memoryGb,
  localStorageCapacity: profile.storageTb,
  raidLevel: profile.raid,
  nicCardCount: profile.nicCards,
  nicPortsPerCard: profile.nicPorts,
  nicSpeedGbpsPerPort: profile.nicSpeed,
  nicMedia: profile.nicMedia
});
const sameValue = (actual, expected) => typeof expected === 'number'
  ? typeof actual === 'number' && Math.abs(actual - expected) < 0.000001
  : String(actual).toLowerCase() === String(expected).toLowerCase();

const previousFetch = globalThis.fetch;
let modelCalls = 0;
globalThis.fetch = (async () => {
  modelCalls += 1;
  return new Response(JSON.stringify({ done_reason: 'stop', message: { content: '{"requirements":[]}' } }), { status: 200 });
});
const results = [];
try {
  for (const testCase of cases) {
    const startedAt = performance.now();
    const requirements = await extractRequirements({ provider: 'local' }, testCase.input);
    const elapsedMs = performance.now() - startedAt;
    const byId = new Map(requirements.map((requirement) => [requirement.id, requirement.value]));
    const failures = Object.entries(expectedFor(testCase.profile)).flatMap(([id, expected]) => sameValue(byId.get(id), expected) ? [] : [{ id, expected, actual: byId.get(id) }]);
    results.push({ id: `${testCase.profile.id}-${testCase.format}`, elapsedMs, failures });
  }
} finally {
  globalThis.fetch = previousFetch;
}

const sortedLatency = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
const passingCases = results.filter((result) => result.failures.length === 0).length;
const assertions = cases.length * Object.keys(expectedFor(profiles[0])).length;
const failedAssertions = results.reduce((total, result) => total + result.failures.length, 0);
const report = {
  caseCoverage: { passed: passingCases, total: cases.length, rate: passingCases / cases.length, target: 0.85 },
  fieldAccuracy: { passed: assertions - failedAssertions, total: assertions, rate: (assertions - failedAssertions) / assertions },
  llmFirstRequests: { calls: modelCalls, expected: cases.length, rate: modelCalls / cases.length },
  postLlmNormalizationLatencyMs: { p50: sortedLatency[Math.floor(sortedLatency.length * 0.5)], p95: sortedLatency[Math.floor(sortedLatency.length * 0.95)], targetP95Maximum: 100 },
  failures: results.filter((result) => result.failures.length > 0)
};
console.log(JSON.stringify(report, null, 2));
if (report.caseCoverage.rate < 0.85 || report.llmFirstRequests.rate !== 1 || report.postLlmNormalizationLatencyMs.p95 > 100) process.exitCode = 1;
