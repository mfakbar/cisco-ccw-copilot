import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractRequirements, normalizeExtractedRequirements, parseRequirements } from '../packages/companion/src/providers.js';

describe('provider response parsing', () => {
  const requirement = { id: 'memoryGb', label: 'Memory', value: 512, required: true, status: 'explicit' };
  const circuitToken = (expiresAt: number) => `header.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url')}.signature`;
  it('accepts the requested object envelope', () => expect(parseRequirements(JSON.stringify({ requirements: [requirement] }))[0]).toMatchObject(requirement));
  it('accepts a bare array for provider compatibility', () => expect(parseRequirements(JSON.stringify([requirement]))[0]).toMatchObject(requirement));
  it('accepts fenced JSON with surrounding prose', () => expect(parseRequirements(`Result:\n\`\`\`json\n${JSON.stringify({ requirements: [requirement] })}\n\`\`\``)[0]).toMatchObject(requirement));
  it('gives an actionable error when the array is missing', () => expect(() => parseRequirements('{"answer":"none"}')).toThrow('did not contain a requirements array'));
  it('preserves an extracted maximum lead-time constraint', () => expect(parseRequirements(JSON.stringify({ requirements: [{ id: 'maxLeadTimeDays', label: 'Delivery', value: 35, comparison: 'atMost', required: true, status: 'explicit' }] }))[0]).toMatchObject({ id: 'maxLeadTimeDays', value: 35, comparison: 'atMost' }));
  it('preserves storage units and discrete CPU and NIC fields', () => {
    const requirements = parseRequirements(JSON.stringify({ requirements: [
      { id: 'localStorageCapacity', label: 'Storage', value: 3.84, unit: 'TB', required: true, status: 'explicit' },
      { id: 'bootCapacity', label: 'Boot', value: 480, unit: 'GB', required: true, status: 'explicit' },
      { id: 'cpuSockets', label: 'CPUs', value: 2, required: true, status: 'explicit' },
      { id: 'cpuClockGhz', label: 'Clock', value: 2.6, unit: 'GHz', required: true, status: 'explicit' },
      { id: 'nicCardCount', label: 'NIC cards', value: 2, required: true, status: 'explicit' },
      { id: 'nicPortsPerCard', label: 'Ports/card', value: 4, required: true, status: 'explicit' },
      { id: 'nicSpeedGbpsPerPort', label: 'Speed/port', value: 25, unit: 'Gbps', required: true, status: 'explicit' }
    ] }));
    expect(requirements.map(({ id, value, unit }) => ({ id, value, unit }))).toEqual([
      { id: 'localStorageCapacity', value: 3.84, unit: 'TB' }, { id: 'bootCapacity', value: 480, unit: 'GB' },
      { id: 'cpuSockets', value: 2, unit: undefined }, { id: 'cpuClockGhz', value: 2.6, unit: 'GHz' },
      { id: 'nicCardCount', value: 2, unit: undefined }, { id: 'nicPortsPerCard', value: 4, unit: undefined }, { id: 'nicSpeedGbpsPerPort', value: 25, unit: 'Gbps' }
    ]);
  });
  it('calls the selected LLM first for structured multi-category input, then normalizes its output', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ done_reason: 'stop', message: { content: '{"requirements":[]}' } }), { status: 200 }); }) as typeof fetch;
    try {
      const requirements = await extractRequirements({ provider: 'local', model: 'qwen3.5:4b-q4_K_M' }, [
        'CPU: 2-socket 24 core, 2.2GHz',
        'Memory: 1TB',
        'Drive: 4TB SSD RAID5, 2TB U.3 NVMe RAID1, 4x 1.9TB RAID10',
        'NIC: 2-card 2x 10G SFP, 2-card 2x 32G FC'
      ].join('\n'));
      expect(requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'cpuSockets', value: 2 }),
        expect.objectContaining({ id: 'memoryGb', value: 1024 }),
        expect.objectContaining({ id: 'storageGroup3DriveCount', value: 4 }),
        expect.objectContaining({ id: 'nicGroup2Media', value: 'FC' })
      ]));
      expect(calls).toBe(1);
    } finally { globalThis.fetch = previousFetch; }
  });
  it('preserves a standalone 64GB DDR5 module specification alongside aggregate memory', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ done_reason: 'stop', message: { content: JSON.stringify({ requirements: [
        { id: 'memoryGb', label: 'Memory capacity', value: 1024, unit: 'GB', required: true, status: 'explicit' },
        { id: 'memoryModuleSizeGb', label: 'DIMM size', value: 64, unit: 'GB', required: true, status: 'explicit' }
      ] }) } }), { status: 200 });
    }) as typeof fetch;
    try {
      const requirements = await extractRequirements({ provider: 'local' }, 'Memory: 1TB using 64GB DDR5');
      expect(calls).toBe(1);
      expect(requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'memoryGb', value: 1024, unit: 'GB' }),
        expect.objectContaining({ id: 'memoryModuleSizeGb', value: 64, unit: 'GB', comparison: 'exact' })
      ]));
    } finally { globalThis.fetch = previousFetch; }
  });
  it('requests strict deterministic JSON Schema output from Ollama for free-form input', async () => {
    const previousFetch = globalThis.fetch;
    let request: any;
    globalThis.fetch = (async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: '{"requirements":[]}' } }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(extractRequirements({ provider: 'local', model: 'qwen3.5:4b-q4_K_M' }, 'Size an application server for a future workload.')).resolves.toEqual([]);
      expect(request.format).toMatchObject({ type: 'object', required: ['requirements'], additionalProperties: false });
      expect(request.format.properties.requirements.items.properties.id.enum).toContain('storageGroup3RaidLevel');
      expect(request.format.properties.requirements.items.properties.id.enum).toContain('nicGroup3PortsPerCard');
      const systemMessage = request.messages.find((message: { role: string }) => message.role === 'system');
      expect(systemMessage?.content).toContain('dual and dual-port always mean 2 ports on each NIC');
      expect(systemMessage?.content).toContain('"2x quad 10G" means CardCount 2, PortsPerCard 4, and SpeedGbpsPerPort 10');
      expect(request.options.temperature).toBe(0);
      expect(request.think).toBe(false);
    } finally { globalThis.fetch = previousFetch; }
  });
  it.each(['gemini-3.1-flash-lite', 'gpt-5-nano'])('calls the approved CircuIT deployment %s with the access token and app key', async (model) => {
    const previousFetch = globalThis.fetch;
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (url, init) => {
      requestUrl = String(url); requestInit = init;
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ requirements: [requirement] }) } }), { status: 200 });
    }) as typeof fetch;
    try {
      const token = circuitToken(Math.floor(Date.now() / 1000) + 3600);
      await expect(extractRequirements({ provider: 'circuit', model, apiKey: token, appKey: 'test-circuit-app-key' }, 'The server requires 512GB memory.')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'memoryGb', value: 512 })
      ]));
      expect(requestUrl).toBe(`https://chat-ai.cisco.com/openai/deployments/${model}/chat/completions`);
      expect(new Headers(requestInit?.headers).get('api-key')).toBe(token);
      const body = JSON.parse(String(requestInit?.body));
      expect(body.user).toBe(JSON.stringify({ appkey: 'test-circuit-app-key' }));
      expect(body.stop).toEqual(['<|im_end|>']);
      expect(body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user', content: 'The server requires 512GB memory.' })]));
    } finally { globalThis.fetch = previousFetch; }
  });
  it('does not call CircuIT when its application key is not configured', async () => {
    const previousFetch = globalThis.fetch;
    const previousAppKey = process.env.CIRCUIT_APP_KEY;
    delete process.env.CIRCUIT_APP_KEY;
    globalThis.fetch = (() => { throw new Error('An unconfigured CircuIT request must not be sent'); }) as typeof fetch;
    try {
      await expect(extractRequirements({ provider: 'circuit', apiKey: circuitToken(Math.floor(Date.now() / 1000) + 3600) }, 'Size a server for a future workload.')).rejects.toThrow('Set CIRCUIT_APP_KEY');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAppKey === undefined) delete process.env.CIRCUIT_APP_KEY;
      else process.env.CIRCUIT_APP_KEY = previousAppKey;
    }
  });
  it('requires manual refresh when a CircuIT access token has expired', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('An expired token must not be sent'); }) as typeof fetch;
    try {
      await expect(extractRequirements({ provider: 'circuit', apiKey: circuitToken(Math.floor(Date.now() / 1000) - 1) }, 'Size a server for a future workload.')).rejects.toThrow('access token expired');
    } finally { globalThis.fetch = previousFetch; }
  });
  it('turns CircuIT authentication failures into token-refresh guidance', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    try {
      await expect(extractRequirements({ provider: 'circuit', apiKey: circuitToken(Math.floor(Date.now() / 1000) + 3600), appKey: 'test-circuit-app-key' }, 'Size a server for a future workload.')).rejects.toThrow('rejected or expired');
    } finally { globalThis.fetch = previousFetch; }
  });
  it('falls back to grounded deterministic facts when a model still returns malformed JSON', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: 'not valid JSON' } }), { status: 200 })) as typeof fetch;
    try {
      await expect(extractRequirements({ provider: 'local' }, 'Intel processors are required.')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'cpuVendor', value: 'intel', status: 'explicit' })
      ]));
    } finally { globalThis.fetch = previousFetch; }
  });
  it('normalizes explicit rack requirements and defaults capacity without RAID to raw', () => {
    const normalized = normalizeExtractedRequirements([
      { id: 'cpuSockets', label: 'CPU', value: 2, status: 'derived', required: false, evidence: [] },
      { id: 'cpuClockGhz', label: 'Clock', value: 2.6, status: 'derived', required: false, evidence: [] },
      { id: 'localStorageCapacity', label: 'Storage', value: 4, unit: 'TB', status: 'derived', required: false, evidence: [] },
      { id: 'nicCardCount', label: 'NIC', value: 2, status: 'derived', required: false, evidence: [] },
      { id: 'nicPorts', label: 'Total ports', value: 8, status: 'explicit', required: true, evidence: [] }
    ], 'Two CPUs at 2.6 GHz, 4 TB storage, and two NIC cards.');
    expect(normalized.find((item) => item.id === 'cpuSockets')).toMatchObject({ comparison: 'exact', status: 'explicit', required: true });
    expect(normalized.find((item) => item.id === 'cpuClockGhz')).toMatchObject({ comparison: 'atLeast', unit: 'GHz' });
    expect(normalized.find((item) => item.id === 'localStorageCapacityType')).toMatchObject({ value: 'raw', status: 'derived', required: true });
    expect(normalized.some((item) => item.id === 'raidLevel')).toBe(false);
    expect(normalized.some((item) => item.id === 'nicPorts')).toBe(false);
  });
  it('recovers an explicit delivery deadline and CPU vendor from source text', () => {
    const normalized = normalizeExtractedRequirements([], 'Intel processors are required. Delivery must be within 35 calendar days.');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'maxLeadTimeDays', value: 35, unit: 'days', comparison: 'atMost' }),
      expect.objectContaining({ id: 'cpuVendor', value: 'intel', comparison: 'exact' })
    ]));
  });
  it('parses compact NIC notation deterministically', () => {
    const normalized = normalizeExtractedRequirements([], 'NIC 2x 10G SFP 2x card.');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nicCardCount', value: 2, comparison: 'exact' }),
      expect.objectContaining({ id: 'nicPortsPerCard', value: 2, comparison: 'atLeast' }),
      expect.objectContaining({ id: 'nicSpeedGbpsPerPort', value: 10, unit: 'Gbps' }),
      expect.objectContaining({ id: 'nicMedia', value: 'SFP', comparison: 'exact' })
    ]));
  });
  it.each([
    ['NIC 2x 10G Small Form-factor Pluggable 2x cards.', 'SFP'],
    ['NIC 2x 100G Quad Small Form-factor Pluggable 2x cards.', 'QSFP'],
    ['NIC 4x 1G RJ45 2x cards.', 'BASE-T'],
    ['NIC 4x 10G BASET 2x cards.', 'BASE-T'],
    ['NIC 2x 32G Fibre Channel 2x cards.', 'FC']
  ])('normalizes port type vocabulary in %s', (text, expected) => {
    expect(normalizeExtractedRequirements([], text)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'nicMedia', value: expected })]));
  });
  it('overrides an incorrect provider socket count with the explicit per-server value', () => {
    const normalized = normalizeExtractedRequirements([{ id: 'cpuSockets', label: 'CPU sockets', value: 4, status: 'explicit', required: true, evidence: [] }], 'Number of physical CPUs/sockets per server: 2');
    expect(normalized.find((item) => item.id === 'cpuSockets')).toMatchObject({ value: 2, comparison: 'exact' });
  });
  it.each([['Memory: 1 TB', 1024], ['512 GB of RAM', 512]])('normalizes %s to GB', (text, expected) => {
    const normalized = normalizeExtractedRequirements([{ id: 'memoryGb', label: 'Memory', value: 1, unit: 'TB', status: 'explicit', required: true, evidence: [] }], text);
    expect(normalized.find((item) => item.id === 'memoryGb')).toMatchObject({ value: expected, unit: 'GB' });
  });
  it.each([
    ['DIMM count: 8', 'memoryModuleCount', 8],
    ['DIMM size: 64GB', 'memoryModuleSizeGb', 64]
  ])('preserves a standalone memory sizing field from %s', (text, id, value) => {
    expect(normalizeExtractedRequirements([], text)).toEqual(expect.arrayContaining([expect.objectContaining({ id, value })]));
  });
  it('grounds key/value-style requirements without crossing lines', () => {
    const normalized = normalizeExtractedRequirements([], [
      'CPU = 2x 32 core, 2.8GHz',
      'Memory = 1 TB',
      'Drive usable = 8 TB RAID5',
      'NIC = 2x 10G SFP, 2x card'
    ].join('\n'));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuSockets', value: 2 }),
      expect.objectContaining({ id: 'cpuCoresPerSocket', value: 32 }),
      expect.objectContaining({ id: 'cpuTotalCores', value: 64 }),
      expect.objectContaining({ id: 'cpuClockGhz', value: 2.8, unit: 'GHz' }),
      expect.objectContaining({ id: 'memoryGb', value: 1024, unit: 'GB' }),
      expect.objectContaining({ id: 'localStorageCapacity', value: 8, unit: 'TB' }),
      expect.objectContaining({ id: 'localStorageCapacityType', value: 'usable' }),
      expect.objectContaining({ id: 'raidLevel', value: '5' }),
      expect.objectContaining({ id: 'nicCardCount', value: 2 }),
      expect.objectContaining({ id: 'nicPortsPerCard', value: 2 }),
      expect.objectContaining({ id: 'nicSpeedGbpsPerPort', value: 10, unit: 'Gbps' }),
      expect.objectContaining({ id: 'nicMedia', value: 'SFP' })
    ]));
  });
  it('preserves two usable RAID groups and two distinct NIC card groups', () => {
    const normalized = normalizeExtractedRequirements([], [
      'CPU: 2x 24 core, 3.0Ghz',
      'Memory: 2TB',
      'Drive usable: 8TB RAID5 and 4TB RAID1',
      'NIC: 2-card 2x 10G SFP, 1-card 2x 32G FC'
    ].join('\n'));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'memoryGb', value: 2048, unit: 'GB' }),
      expect.objectContaining({ id: 'storageGroup1Capacity', value: 8, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup1CapacityType', value: 'usable', status: 'explicit' }),
      expect.objectContaining({ id: 'storageGroup1RaidLevel', value: '5' }),
      expect.objectContaining({ id: 'storageGroup2Capacity', value: 4, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup2CapacityType', value: 'usable', status: 'explicit' }),
      expect.objectContaining({ id: 'storageGroup2RaidLevel', value: '1' }),
      expect.objectContaining({ id: 'nicGroup1CardCount', value: 2 }),
      expect.objectContaining({ id: 'nicGroup1PortsPerCard', value: 2 }),
      expect.objectContaining({ id: 'nicGroup1SpeedGbpsPerPort', value: 10, unit: 'Gbps' }),
      expect.objectContaining({ id: 'nicGroup1Media', value: 'SFP' }),
      expect.objectContaining({ id: 'nicGroup2CardCount', value: 1 }),
      expect.objectContaining({ id: 'nicGroup2PortsPerCard', value: 2 }),
      expect.objectContaining({ id: 'nicGroup2SpeedGbpsPerPort', value: 32, unit: 'Gbps' }),
      expect.objectContaining({ id: 'nicGroup2Media', value: 'FC' })
    ]));
  });
  it('segments cards-with wording when only the second NIC group states media', () => {
    const normalized = normalizeExtractedRequirements([], 'Dual socket, 48 cores total at 2.0 GHz; 1TB RAM. Create 8TB usable RAID5 and 4TB raw RAID10. Fit 2 NIC cards with 4x10Gbps ports per card, and 1 card with 2x 32G FC ports.');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nicGroup1CardCount', value: 2 }),
      expect.objectContaining({ id: 'nicGroup1PortsPerCard', value: 4 }),
      expect.objectContaining({ id: 'nicGroup1SpeedGbpsPerPort', value: 10 }),
      expect.objectContaining({ id: 'nicGroup2CardCount', value: 1 }),
      expect.objectContaining({ id: 'nicGroup2PortsPerCard', value: 2 }),
      expect.objectContaining({ id: 'nicGroup2SpeedGbpsPerPort', value: 32 }),
      expect.objectContaining({ id: 'nicGroup2Media', value: 'FC' })
    ]));
    expect(normalized.some((item) => item.id === 'nicGroup1Media')).toBe(false);
  });
  it('parses repeated card counts with dual and quad port shorthand into distinct NIC groups', () => {
    const normalized = normalizeExtractedRequirements([], 'NIC: 2x dual 25G SFP, 2x dual-port 32G FC, 1x quad-port 25G');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nicGroup1CardCount', value: 2 }),
      expect.objectContaining({ id: 'nicGroup1PortsPerCard', value: 2 }),
      expect.objectContaining({ id: 'nicGroup1SpeedGbpsPerPort', value: 25 }),
      expect.objectContaining({ id: 'nicGroup1Media', value: 'SFP' }),
      expect.objectContaining({ id: 'nicGroup2CardCount', value: 2 }),
      expect.objectContaining({ id: 'nicGroup2PortsPerCard', value: 2 }),
      expect.objectContaining({ id: 'nicGroup2SpeedGbpsPerPort', value: 32 }),
      expect.objectContaining({ id: 'nicGroup2Media', value: 'FC' }),
      expect.objectContaining({ id: 'nicGroup3CardCount', value: 1 }),
      expect.objectContaining({ id: 'nicGroup3PortsPerCard', value: 4 }),
      expect.objectContaining({ id: 'nicGroup3SpeedGbpsPerPort', value: 25 })
    ]));
    expect(normalized.some((item) => item.id === 'nicGroup3Media')).toBe(false);
    expect(normalized.some((item) => /^nic(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort|Media)$/.test(item.id))).toBe(false);
  });
  it('preserves three RAID groups with an independent drive type per group', () => {
    const normalized = normalizeExtractedRequirements([], [
      'CPU: 2x 24 core, 3.0Ghz',
      'Memory: 2TB',
      'Drive usable: 8TB SSD RAID5, 2TB HDD RAID1, and 4TB NVMe U.3 RAID10',
      'NIC: 2-card 2x 10G SFP, 1-card 2x 32G FC'
    ].join('\n'));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup1Capacity', value: 8, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup1CapacityType', value: 'usable' }),
      expect.objectContaining({ id: 'storageGroup1DriveType', value: 'SSD' }),
      expect.objectContaining({ id: 'storageGroup1RaidLevel', value: '5' }),
      expect.objectContaining({ id: 'storageGroup2Capacity', value: 2, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup2CapacityType', value: 'usable' }),
      expect.objectContaining({ id: 'storageGroup2DriveType', value: 'HDD' }),
      expect.objectContaining({ id: 'storageGroup2RaidLevel', value: '1' }),
      expect.objectContaining({ id: 'storageGroup3Capacity', value: 4, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup3CapacityType', value: 'usable' }),
      expect.objectContaining({ id: 'storageGroup3DriveType', value: 'U.3 NVMe' }),
      expect.objectContaining({ id: 'storageGroup3RaidLevel', value: '10' })
    ]));
    expect(normalized.some((item) => item.id === 'localDriveType')).toBe(false);
  });
  it('extracts hyphenated socket/core wording and applies capacity semantics per drive group', () => {
    const normalized = normalizeExtractedRequirements([], [
      'CPU: 2-socket 24 core, 2.2Ghz',
      'Memory: 2TB',
      'Drive: 6TB SSD RAID5, 4TB U.3 NVMe RAID10, and 1TB HDD RAID1',
      'NIC: 2-card 2x 10G SFP, 1-card 2x 32G FC'
    ].join('\n'));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuSockets', value: 2 }),
      expect.objectContaining({ id: 'cpuCoresPerSocket', value: 24 }),
      expect.objectContaining({ id: 'cpuTotalCores', value: 48 }),
      expect.objectContaining({ id: 'storageGroup1CapacityType', value: 'usable', status: 'derived' }),
      expect.objectContaining({ id: 'storageGroup2CapacityType', value: 'usable', status: 'derived' }),
      expect.objectContaining({ id: 'storageGroup3CapacityType', value: 'usable', status: 'derived' }),
      expect.objectContaining({ id: 'storageGroup2DriveType', value: 'U.3 NVMe' })
    ]));
  });
  it('does not treat aggregate RAID capacity as capacity per drive', () => {
    const normalized = normalizeExtractedRequirements([], [
      'CPU: 2-socket 24 core, 2.2Ghz',
      'Memory: 1TB',
      'Drive: 6TB SSD RAID5, 2TB U.3 NVMe RAID1',
      'NIC: 2-card 2x 10G SFP, 1-card 2x 32G FC'
    ].join('\n'));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup1Capacity', value: 6, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup2Capacity', value: 2, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup2DriveType', value: 'U.3 NVMe' }),
      expect.objectContaining({ id: 'storageGroup2DriveInterface', value: 'NVMe' })
    ]));
    expect(normalized.some((item) => item.id === 'storageGroup1DriveCapacity' || item.id === 'storageGroup2DriveCapacity')).toBe(false);
  });
  it('applies the requested per-group storage semantics to the supplied simulation', () => {
    const normalized = normalizeExtractedRequirements([], [
      'CPU: 2-socket 24 core, 2.2Ghz',
      'Memory: 1TB',
      'Drive: 5TB SSD RAID5, 2TB U.3 NVMe RAID1, 5x 1.9TB RAID5',
      'NIC: 2-card 2x 10G SFP, 1-card 2x 32G FC'
    ].join('\n'));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuSockets', value: 2 }),
      expect.objectContaining({ id: 'cpuCoresPerSocket', value: 24 }),
      expect.objectContaining({ id: 'cpuTotalCores', value: 48, status: 'derived' }),
      expect.objectContaining({ id: 'memoryGb', value: 1024, unit: 'GB' }),
      expect.objectContaining({ id: 'storageGroup1Capacity', value: 5, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup1CapacityType', value: 'usable', status: 'derived' }),
      expect.objectContaining({ id: 'storageGroup2Capacity', value: 2, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup2CapacityType', value: 'usable', status: 'derived' }),
      expect.objectContaining({ id: 'storageGroup3CapacityType', value: 'raw', status: 'derived' }),
      expect.objectContaining({ id: 'storageGroup3DriveCount', value: 5 }),
      expect.objectContaining({ id: 'storageGroup3DriveCapacity', value: 1.9, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup3RaidLevel', value: '5' }),
      expect.objectContaining({ id: 'nicGroup1CardCount', value: 2 }),
      expect.objectContaining({ id: 'nicGroup2Media', value: 'FC' })
    ]));
    expect(normalized.some((item) => item.id === 'storageGroup3Capacity')).toBe(false);
  });

  it('requires an explicit RAID or no-RAID choice for a discrete drive population without RAID text', () => {
    const normalized = normalizeExtractedRequirements([], 'Drive: 5x 1.9TB SSD');
    expect(normalized.find((item) => item.id === 'localStorageCapacityType')).toMatchObject({ value: 'raw', status: 'derived' });
    expect(normalized.find((item) => item.id === 'raidLevel')).toMatchObject({ status: 'unresolved', required: true });
  });
  it('keeps per-drive and resulting usable capacity in one storage group', () => {
    const normalized = normalizeExtractedRequirements([], `Configure one Cisco UCS X210c M8 compute node.
Local capacity storage must use front-facing drive slots only. Provide exactly two 1.9 TB U.3 NVMe drives configured as RAID 1, providing 1.9 TB usable capacity.
Include one 4-port 25 Gbps X-Series mLOM. Do not include a GPU, E3.S drives, SAS/SATA capacity drives, or rear capacity drives.`);
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'localDriveCount', value: 2 }),
      expect.objectContaining({ id: 'localDriveCapacity', value: 1.9, unit: 'TB' }),
      expect.objectContaining({ id: 'localStorageCapacityType', value: 'usable' }),
      expect.objectContaining({ id: 'raidLevel', value: '1' }),
      expect.objectContaining({ id: 'localDriveType', value: 'U.3 NVMe' }),
      expect.objectContaining({ id: 'localDriveInterface', value: 'NVMe' })
    ]));
    expect(normalized.some((item) => /^storageGroup2/.test(item.id))).toBe(false);
  });
  it('defaults a non-RAID group to raw while independently treating an adjacent RAID group as usable', () => {
    const normalized = normalizeExtractedRequirements([], 'Drive: 6TB SSD, and 4TB HDD RAID1');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup1CapacityType', value: 'raw', status: 'derived' }),
      expect.objectContaining({ id: 'storageGroup2CapacityType', value: 'usable', status: 'derived' })
    ]));
  });
  it('preserves four ports per card in card-first compact NIC notation', () => {
    expect(normalizeExtractedRequirements([], 'NIC: 2-card 4x 10G SFP')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nicCardCount', value: 2 }),
      expect.objectContaining({ id: 'nicPortsPerCard', value: 4 }),
      expect.objectContaining({ id: 'nicSpeedGbpsPerPort', value: 10 })
    ]));
  });
  it('extracts separate Ethernet and Fibre Channel groups without requiring card counts', () => {
    const normalized = normalizeExtractedRequirements([], 'NIC: 4x 10G SFP and FC NIC 4x 32G FC');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nicGroup1TotalPorts', value: 4 }),
      expect.objectContaining({ id: 'nicGroup1SpeedGbpsPerPort', value: 10 }),
      expect.objectContaining({ id: 'nicGroup1Media', value: 'SFP' }),
      expect.objectContaining({ id: 'nicGroup2TotalPorts', value: 4 }),
      expect.objectContaining({ id: 'nicGroup2SpeedGbpsPerPort', value: 32 }),
      expect.objectContaining({ id: 'nicGroup2Media', value: 'FC' })
    ]));
    expect(normalized.some((item) => /CardCount$|PortsPerCard$/.test(item.id))).toBe(false);
  });
  it('keeps missing NIC sibling fields optional', () => {
    const normalized = normalizeExtractedRequirements([], 'NIC: 2 cards');
    expect(normalized.find((item) => item.id === 'nicCardCount')).toMatchObject({ value: 2 });
    expect(normalized.find((item) => item.id === 'nicPortsPerCard')).toMatchObject({ status: 'unresolved', required: false });
    expect(normalized.find((item) => item.id === 'nicSpeedGbpsPerPort')).toMatchObject({ status: 'unresolved', required: false });
  });
  it('asks for a RAID level whenever usable storage omits RAID', () => {
    const single = normalizeExtractedRequirements([], 'Need 4 TB usable SSD storage.');
    expect(single.find((item) => item.id === 'raidLevel')).toMatchObject({ status: 'unresolved', required: true, note: expect.stringContaining('Which RAID level') });

    const grouped = normalizeExtractedRequirements([], 'Drive usable: 4TB SSD, and 2TB HDD RAID1');
    expect(grouped.find((item) => item.id === 'storageGroup1RaidLevel')).toMatchObject({ status: 'unresolved', required: true, note: expect.stringContaining('Which RAID level') });
    expect(grouped.find((item) => item.id === 'storageGroup2RaidLevel')).toMatchObject({ value: '1' });
  });
  it('normalizes the complete 16-core, 256 GB, four-drive, two-card requirement', () => {
    const normalized = normalizeExtractedRequirements([], [
      'CPU: Total 16 Core, Minimum 2.4 GHz',
      'Memory: 256GB LRDIMM/RDIMM',
      'Drive: 4x 960GB SAS SSD 12G',
      'NIC: 2-card 4x 10Gbps SFP'
    ].join('\n'));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuTotalCores', value: 16 }),
      expect.objectContaining({ id: 'cpuClockGhz', value: 2.4 }),
      expect.objectContaining({ id: 'memoryGb', value: 256 }),
      expect.objectContaining({ id: 'localStorageCapacity', value: 3840, unit: 'GB' }),
      expect.objectContaining({ id: 'localStorageCapacityType', value: 'raw' }),
      expect.objectContaining({ id: 'localDriveCount', value: 4 }),
      expect.objectContaining({ id: 'localDriveCapacity', value: 960, unit: 'GB' }),
      expect.objectContaining({ id: 'localDriveType', value: 'SAS SSD' }),
      expect.objectContaining({ id: 'localDriveInterface', value: 'SAS' }),
      expect.objectContaining({ id: 'localDriveTransferSpeedGbps', value: 12 }),
      expect.objectContaining({ id: 'nicCardCount', value: 2 }),
      expect.objectContaining({ id: 'nicPortsPerCard', value: 4 }),
      expect.objectContaining({ id: 'nicSpeedGbpsPerPort', value: 10 }),
      expect.objectContaining({ id: 'nicMedia', value: 'SFP' })
    ]));
  });
  it.each([
    ['Drive: 4x 960GB SAS 12Gbps SSD', 'SAS SSD', 'SAS', 12],
    ['Drive: 4x 960GB SAS SSD 12G', 'SAS SSD', 'SAS', 12],
    ['Drive: 4x 960GB SATA SSD', 'SATA SSD', 'SATA', undefined],
    ['Drive: 4x 960GB SSD', 'SSD', undefined, undefined]
  ])('extracts the discrete drive population and media details from %s', (text, driveType, driveInterface, transferSpeedGbps) => {
    const normalized = normalizeExtractedRequirements([], text);
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'localStorageCapacity', value: 3840, unit: 'GB' }),
      expect.objectContaining({ id: 'localStorageCapacityType', value: 'raw', status: 'derived' }),
      expect.objectContaining({ id: 'localDriveCount', value: 4 }),
      expect.objectContaining({ id: 'localDriveCapacity', value: 960, unit: 'GB' }),
      expect.objectContaining({ id: 'localDriveType', value: driveType })
    ]));
    if (driveInterface) expect(normalized).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'localDriveInterface', value: driveInterface })]));
    else expect(normalized.some((item) => item.id === 'localDriveInterface')).toBe(false);
    if (transferSpeedGbps) expect(normalized).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'localDriveTransferSpeedGbps', value: transferSpeedGbps, unit: 'Gbps' })]));
    else expect(normalized.some((item) => item.id === 'localDriveTransferSpeedGbps')).toBe(false);
  });
  it('keeps repeated drive population lines as independently typed groups', () => {
    const normalized = normalizeExtractedRequirements([], [
      'Drive: 4x 960GB SAS 12Gbps SSD',
      'Drive: 4x 960GB SATA SSD',
      'Drive: 4x 960GB SSD'
    ].join('\n'));
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup1DriveCount', value: 4 }),
      expect.objectContaining({ id: 'storageGroup1DriveCapacity', value: 960, unit: 'GB' }),
      expect.objectContaining({ id: 'storageGroup1DriveType', value: 'SAS SSD' }),
      expect.objectContaining({ id: 'storageGroup1DriveInterface', value: 'SAS' }),
      expect.objectContaining({ id: 'storageGroup1TransferSpeedGbps', value: 12 }),
      expect.objectContaining({ id: 'storageGroup2DriveType', value: 'SATA SSD' }),
      expect.objectContaining({ id: 'storageGroup2DriveInterface', value: 'SATA' }),
      expect.objectContaining({ id: 'storageGroup3DriveType', value: 'SSD' })
    ]));
    expect(normalized.some((item) => /^storageGroup\d+Capacity$/.test(item.id))).toBe(false);
  });
  it('records VIC or OCP only when explicitly requested', () => {
    expect(normalizeExtractedRequirements([], 'NIC: 1-card 2x 25G SFP OCP')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'nicAdapterType', value: 'OCP' })]));
    expect(normalizeExtractedRequirements([], 'NIC: 1-card 2x 25G SFP').some((item) => item.id === 'nicAdapterType')).toBe(false);
  });
  it('applies an all-drives SSD statement to every RAID group', () => {
    const normalized = normalizeExtractedRequirements([], 'Dual socket, 48 cores total at 2.0 GHz; 1TB RAM. Create 8TB usable RAID5 and 4TB raw RAID10 all drive are SSD type.');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup1DriveType', value: 'SSD' }),
      expect.objectContaining({ id: 'storageGroup2DriveType', value: 'SSD' })
    ]));
  });
  it('keeps boot media optional and documents the M.2 default', () => {
    const normalized = normalizeExtractedRequirements([{ id: 'bootCapacity', label: 'Boot', value: 480, unit: 'GB', status: 'explicit', required: true, evidence: [] }], 'Boot capacity is 480 GB.');
    expect(normalized.find((item) => item.id === 'bootDriveType')).toMatchObject({ status: 'unresolved', required: false, note: expect.stringContaining('M.2 will be recommended') });
  });
  it('treats every M.2 population as boot media even when boot is not stated', () => {
    const normalized = normalizeExtractedRequirements([], '2x 960GB M.2 NVMe drives');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bootCapacity', value: 960, unit: 'GB' }),
      expect.objectContaining({ id: 'bootDriveCount', value: 2 }),
      expect.objectContaining({ id: 'bootDriveType', value: 'M.2 NVMe' })
    ]));
    expect(normalized.some((item) => item.id === 'localStorageCapacity' || /^storageGroup\d+/.test(item.id))).toBe(false);
  });
  it.each([
    ['NIC: 1-card 2x 10G SFP+', 'SFP'],
    ['NIC: 1-card 2x 25G SFP28', 'SFP'],
    ['NIC: 1-card 2x 50G SFP56', 'SFP'],
    ['NIC: 1-card 2x 100G QSFP28', 'QSFP'],
    ['NIC: 1-card 2x 400G QSFP112', 'QSFP']
  ])('normalizes simplified connector family for %s', (text, media) => {
    expect(normalizeExtractedRequirements([], text)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'nicMedia', value: media })]));
  });
  it('extracts extended RAID levels and explicit GPU details', () => {
    const normalized = normalizeExtractedRequirements([], 'Drive: 12TB SSD RAID60. GPU: 2x NVIDIA L40S GPU, 48GB, PCIe Node.');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'raidLevel', value: '60' }),
      expect.objectContaining({ id: 'gpuCount', value: 2 }),
      expect.objectContaining({ id: 'gpuModel', value: 'L40S' }),
      expect.objectContaining({ id: 'gpuMemoryGb', value: 48, unit: 'GB' }),
      expect.objectContaining({ id: 'gpuDeploymentType', value: 'PCIe Node' })
    ]));
  });
  it.each(['H200', 'H200-NVL'])('preserves an explicit %s GPU model and quantity', (model) => {
    const normalized = normalizeExtractedRequirements([
      { id: 'gpuCount', label: 'GPU count', value: 2, required: true, status: 'explicit', evidence: [] },
      { id: 'gpuModel', label: 'GPU model', value: model, required: true, status: 'explicit', evidence: [] }
    ], `GPU: 2x ${model}`);
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpuCount', value: 2 }),
      expect.objectContaining({ id: 'gpuModel', value: model })
    ]));
  });
  it('keeps H200 fields from the LLM-first extraction path', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ done_reason: 'stop', message: { content: JSON.stringify({ requirements: [
        { id: 'gpuCount', label: 'GPU count', value: 2, required: true, status: 'explicit' },
        { id: 'gpuModel', label: 'GPU model', value: 'H200', required: true, status: 'explicit' }
      ] }) } }), { status: 200 });
    }) as typeof fetch;
    try {
      const requirements = await extractRequirements({ provider: 'local' }, 'GPU: 2x H200');
      expect(calls).toBe(1);
      expect(requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'gpuCount', value: 2 }),
        expect.objectContaining({ id: 'gpuModel', value: 'H200' })
      ]));
    } finally { globalThis.fetch = previousFetch; }
  });
  it('understands plain-language CPU and memory expressions', () => {
    const normalized = normalizeExtractedRequirements([], 'We need a pair of Intel 24-core processors running at two point two GHz, with sixteen memory sticks of 64 gigabytes each.');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuSockets', value: 2 }),
      expect.objectContaining({ id: 'cpuCoresPerSocket', value: 24 }),
      expect.objectContaining({ id: 'cpuTotalCores', value: 48, status: 'derived' }),
      expect.objectContaining({ id: 'cpuClockGhz', value: 2.2 }),
      expect.objectContaining({ id: 'memoryModuleCount', value: 16 }),
      expect.objectContaining({ id: 'memoryModuleSizeGb', value: 64 }),
      expect.objectContaining({ id: 'memoryGb', value: 1024, status: 'derived' })
    ]));
  });
  it('understands plain-language RAID storage and distinct adapter groups', () => {
    const normalized = normalizeExtractedRequirements([], 'Please provide five terabytes of SSD storage protected by RAID five. Networking should use two dual-port 10 gig SFP adapters plus one dual-port 32 gig Fibre Channel HBA.');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'localStorageCapacity', value: 5, unit: 'TB' }),
      expect.objectContaining({ id: 'localStorageCapacityType', value: 'usable' }),
      expect.objectContaining({ id: 'raidLevel', value: '5' }),
      expect.objectContaining({ id: 'localDriveType', value: 'SSD' }),
      expect.objectContaining({ id: 'nicGroup1CardCount', value: 2 }),
      expect.objectContaining({ id: 'nicGroup1PortsPerCard', value: 2 }),
      expect.objectContaining({ id: 'nicGroup1SpeedGbpsPerPort', value: 10 }),
      expect.objectContaining({ id: 'nicGroup2CardCount', value: 1 }),
      expect.objectContaining({ id: 'nicGroup2SpeedGbpsPerPort', value: 32 }),
      expect.objectContaining({ id: 'nicGroup2Media', value: 'FC' })
    ]));
  });
  it('keeps materially ambiguous plain language unresolved with direct questions', () => {
    const normalized = normalizeExtractedRequirements([], 'Use 2 processors with 48 cores and 5 TB of storage.');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuTotalCores', status: 'unresolved', required: false, note: expect.stringContaining('total cores per server or cores per CPU?') }),
      expect.objectContaining({ id: 'localDriveType', status: 'unresolved', note: expect.stringContaining('HDD, SSD, or NVMe?') })
    ]));
  });
  it.each([
    ['markdown bullets', '- CPU: 2x 24 core, 2.2GHz\n- Memory: 1TB\n- Drive: 4TB SSD RAID5\n- NIC: 2-card 2x 10G SFP'],
    ['numbered list', '1. CPU: 2x 24 core, 2.2GHz\n2. Memory: 1TB\n3. Drive: 4TB SSD RAID5\n4. NIC: 2-card 2x 10G SFP'],
    ['markdown table', '| Category | Requirement |\n|---|---|\n| CPU | 2x 24 core, 2.2GHz |\n| Memory | 1TB |\n| Drive | 4TB SSD RAID5 |\n| NIC | 2-card 2x 10G SFP |'],
    ['alternate labels', 'Processor: 2x 24 core, 2.2GHz\nRAM Capacity: 1TB\nLocal Storage: 4TB SSD RAID5\nNetwork Adapters: 2-card 2x 10G SFP'],
    ['hyphen separators', 'CPU - 2x 24 core, 2.2GHz\nMemory - 1TB\nDrive - 4TB SSD RAID5\nNIC - 2-card 2x 10G SFP'],
    ['one line', 'CPU: 2x 24 core, 2.2GHz; Memory: 1TB; Drive: 4TB SSD RAID5; NIC: 2-card 2x 10G SFP'],
    ['nested fields', 'CPU:\n Sockets: 2\n Cores per socket: 24\n Clock: 2.2GHz\nMemory:\n Capacity: 1TB\nDrive:\n Capacity: 4TB\n Type: SSD\n RAID: 5\nNIC:\n Cards: 2\n Ports per card: 2\n Speed: 10G\n Media: SFP']
  ])('calls the LLM first for structured %s input', async (_name, text) => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ done_reason: 'stop', message: { content: '{"requirements":[]}' } }), { status: 200 }); }) as typeof fetch;
    try {
      await expect(extractRequirements({ provider: 'local' }, text)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'cpuSockets', value: 2 }),
        expect.objectContaining({ id: 'cpuCoresPerSocket', value: 24 }),
        expect.objectContaining({ id: 'memoryGb', value: 1024 }),
        expect.objectContaining({ id: 'localStorageCapacity', value: 4 }),
        expect.objectContaining({ id: 'raidLevel', value: '5' }),
        expect.objectContaining({ id: 'nicCardCount', value: 2 }),
        expect.objectContaining({ id: 'nicPortsPerCard', value: 2 })
      ]));
      expect(calls).toBe(1);
    } finally { globalThis.fetch = previousFetch; }
  });
  it('normalizes binary units, clock units, thousands separators, and RAID 1+0', () => {
    const normalized = normalizeExtractedRequirements([], 'CPU: 48 cores total at 2200MHz\nMemory: 1,024GiB\nDrive: 4TB SSD RAID 1+0');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuTotalCores', value: 48 }),
      expect.objectContaining({ id: 'cpuClockGhz', value: 2.2 }),
      expect.objectContaining({ id: 'memoryGb', value: 1024 }),
      expect.objectContaining({ id: 'raidLevel', value: '10' })
    ]));
    expect(normalized.some((item) => item.id === 'cpuSockets')).toBe(false);
  });
  it('keeps boot RAID separate from local-storage RAID', () => {
    const normalized = normalizeExtractedRequirements([], 'CPU: 24 cores total\nBoot: 2x 960GB M.2 NVMe RAID1\nDrive: 8TB SSD RAID5');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bootDriveCount', value: 2 }),
      expect.objectContaining({ id: 'bootCapacity', value: 960 }),
      expect.objectContaining({ id: 'raidLevel', value: '5' })
    ]));
  });
  it('preserves more than three drive groups and more than two NIC groups without silent loss', () => {
    const normalized = normalizeExtractedRequirements([], 'Drive: 8TB SSD RAID5, 4TB HDD RAID1, 2TB U.3 NVMe RAID10, 1TB SATA SSD RAID1\nNIC: 2x 10G SFP, 2x 25G SFP28, 2x 32G FC');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup4Capacity', value: 1 }),
      expect.objectContaining({ id: 'storageGroup4RaidLevel', value: '1' }),
      expect.objectContaining({ id: 'nicGroup3SpeedGbpsPerPort', value: 32 }),
      expect.objectContaining({ id: 'nicGroup3Media', value: 'FC' })
    ]));
  });
  it('blocks conflicting profiles and multiple server roles instead of flattening them', () => {
    const conflict = normalizeExtractedRequirements([], 'CPU: 2 sockets, 24 cores each\nCPU: 4 sockets, 16 cores each\nMemory: 1TB');
    expect(conflict.find((item) => item.id === 'structuredRfpConflict')).toMatchObject({ status: 'unresolved', required: true });
    expect(conflict.some((item) => /^cpu(?:Sockets|CoresPerSocket|TotalCores)$/.test(item.id))).toBe(false);
    const roles = normalizeExtractedRequirements([], 'Database servers (quantity 2): CPU 2x32 cores, Memory 1TB\nApplication servers (quantity 4): CPU 2x16 cores, Memory 512GB');
    expect(roles.find((item) => item.id === 'serverRoleScope')).toMatchObject({ status: 'unresolved', required: true, note: expect.stringContaining('one role at a time') });
  });
  it('uses minimum values as hard constraints and records preferred targets', () => {
    const normalized = normalizeExtractedRequirements([], 'CPU: minimum 32 cores, preferred 48 cores\nMemory: minimum 512GB, preferred 1TB');
    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuTotalCores', value: 32, note: expect.stringContaining('preferred target is 48') }),
      expect.objectContaining({ id: 'memoryGb', value: 512, note: expect.stringContaining('preferred target is 1024') })
    ]));
  });
  it.each(JSON.parse(readFileSync(new URL('../benchmark/requirement-cases.json', import.meta.url), 'utf8')) as Array<{ id: string; input: string; expected: Record<string, { value?: number | string; unit?: string; status?: string }>; absent?: string[] }>)('matches benchmark ground truth for $id', (testCase) => {
    const normalized = normalizeExtractedRequirements([], testCase.input);
    const byId = new Map(normalized.map((requirement) => [requirement.id, requirement]));
    for (const [id, expected] of Object.entries(testCase.expected)) expect(byId.get(id), `${testCase.id}: ${id}`).toMatchObject(expected);
    for (const id of testCase.absent ?? []) expect(byId.has(id), `${testCase.id}: ${id} must remain absent`).toBe(false);
  });
});
