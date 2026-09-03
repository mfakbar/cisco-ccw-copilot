import { describe, expect, it } from 'vitest';
import { calculateMetrics, clarificationQuestions, extractUcsParentSku, inferRackServerProfile, raidUsableCapacity, rankCandidates, recommendCheapest, recommendRackComponents, scoreCandidate, unresolvedBlockers, validatePlatform, validateSelection, type CatalogOption, type Requirement, type Selection } from '../packages/shared/src/index.js';

const catalog: CatalogOption[] = [
  { id: 'cpu-32', sku: 'UCS-CPU-32', name: '32 core CPU', category: 'cpu', unitListPrice: 3000, currency: 'USD', available: true, attributes: { cores: 32, leadTimeDays: 35 } },
  { id: 'cpu-fast', sku: 'UCS-CPU-16-FAST', name: '16 core CPU', category: 'cpu', unitListPrice: 2000, currency: 'USD', available: true, attributes: { cores: 16, leadTimeDays: 7 } },
  { id: 'dimm-64', sku: 'UCS-MR-X64G2RT-H', name: '64 GB DIMM', category: 'memory', unitListPrice: 400, currency: 'USD', available: true, attributes: { capacityGb: 64, leadTimeDays: 14 } },
  { id: 'ssd-4', sku: 'UCS-SD-4T', name: '4 TB SSD', category: 'storage', unitListPrice: 1000, currency: 'USD', available: true, attributes: { capacityTb: 4, leadTimeDays: 21 } },
  { id: 'vic', sku: 'UCSC-PCIE-C25Q-04', name: '4 port 25G VIC', category: 'nic', unitListPrice: 1200, currency: 'USD', available: true, attributes: { ports: 4, speedGbps: 25, pcieSlots: 1, leadTimeDays: 7 } },
  { id: 'gpu', sku: 'UCSC-GPU-A100', name: 'GPU', category: 'gpu', unitListPrice: 9000, currency: 'USD', available: true, attributes: { pcieSlots: 2, leadTimeDays: 60 } },
  { id: 'chassis', sku: 'UCSX-9508', name: 'X chassis', category: 'chassis', unitListPrice: 11000, currency: 'USD', available: true, attributes: {} },
  { id: 'fabric', sku: 'UCSX-I-9108-25G', name: 'Fabric module', category: 'fabric', unitListPrice: 6000, currency: 'USD', available: true, attributes: {} }
];

describe('compute sizing', () => {
  it('calculates CPU, memory, storage, ports, throughput, GPU and PCIe use', () => {
    const result = calculateMetrics(catalog, [{ optionId: 'cpu-32', quantity: 2 }, { optionId: 'dimm-64', quantity: 8 }, { optionId: 'ssd-4', quantity: 6 }, { optionId: 'vic', quantity: 2 }, { optionId: 'gpu', quantity: 1 }]);
    expect(result).toEqual({ cpuCores: 64, memoryGb: 512, rawStorageTb: 24, usableStorageTb: 24, nicPorts: 8, nicThroughputGbps: 200, gpuCount: 1, pcieSlots: 4, maxLeadTimeDays: 60, unknownLeadTimeCount: 0 });
  });
  it.each([['0', 8, 0, 32], ['1', 8, 0, 16], ['5', 8, 1, 24], ['6', 8, 1, 20], ['10', 8, 0, 16]])('calculates RAID %s usable capacity', (raid, count, spares, expected) => expect(raidUsableCapacity(4, count, raid, spares)).toBe(expected));
});

describe('safe optimization', () => {
  const requirements: Requirement[] = [
    { id: 'cpuCores', label: 'CPU cores', value: 32, status: 'explicit', required: true, evidence: [] },
    { id: 'memoryGb', label: 'Memory', value: 256, status: 'explicit', required: true, evidence: [] }
  ];
  it('blocks unresolved requirements that represent a material document conflict', () => expect(unresolvedBlockers([
    { id: 'structuredRfpConflict', label: 'Conflicting requirements', status: 'unresolved', required: true, evidence: [] }
  ])).toHaveLength(1));
  it('turns unresolved requirements into direct clarification questions without blocking abstract NIC ports', () => {
    expect(clarificationQuestions([
      { id: 'storageGroup1DriveType', label: 'Drive type', status: 'unresolved', required: true, evidence: [], note: 'What drive type should drive group 1 use: HDD, SSD, or NVMe?' },
      { id: 'nicTotalPorts', label: 'Total ports', value: 4, status: 'explicit', required: true, evidence: [] }
    ])).toEqual([{ requirementId: 'storageGroup1DriveType', question: 'What drive type should drive group 1 use: HDD, SSD, or NVMe?' }]);
    expect(clarificationQuestions([
      { id: 'nicTotalPorts', label: 'Total ports', value: 4, status: 'explicit', required: true, evidence: [] },
      { id: 'nicGroup1CardCount', label: 'Card count', status: 'unresolved', required: true, evidence: [] }
    ])).toEqual([]);
    const cpuQuestion = 'Does 48 cores mean total cores per server or cores per CPU?';
    expect(clarificationQuestions([
      { id: 'cpuTotalCores', label: 'Total cores', status: 'unresolved', required: false, evidence: [], note: cpuQuestion },
      { id: 'cpuCoresPerSocket', label: 'Cores per socket', status: 'unresolved', required: false, evidence: [], note: cpuQuestion }
    ])).toEqual([{ requirementId: 'cpuTotalCores', question: cpuQuestion }]);
  });
  it('ranks by complete list price and rejects invalid candidates', () => {
    const cheap = scoreCandidate('cheap', 'C_SERIES', requirements, catalog, [{ optionId: 'cpu-32', quantity: 1 }, { optionId: 'dimm-64', quantity: 4 }]);
    const expensive = scoreCandidate('expensive', 'C_SERIES', requirements, catalog, [{ optionId: 'cpu-32', quantity: 2 }, { optionId: 'dimm-64', quantity: 8 }]);
    const invalid = scoreCandidate('invalid', 'C_SERIES', requirements, catalog, [{ optionId: 'cpu-32', quantity: 1 }]);
    expect(rankCandidates([expensive, invalid, cheap]).map((x) => x.id)).toEqual(['cheap', 'expensive']);
  });
  it('generates the cheapest complete valid configuration', () => {
    const ranked = recommendCheapest('C_SERIES', requirements, catalog);
    expect(ranked[0]?.selections).toEqual(expect.arrayContaining([{ optionId: 'cpu-32', quantity: 1 }, { optionId: 'dimm-64', quantity: 4 }]));
    expect(ranked[0]?.totalListPrice).toBe(4600);
  });
  it('chooses the cheapest technically valid configuration within the target lead time', () => {
    const deadline: Requirement = { id: 'maxLeadTimeDays', label: 'Lead time', value: 14, unit: 'days', comparison: 'atMost', status: 'explicit', required: true, evidence: [] };
    const ranked = recommendCheapest('C_SERIES', [...requirements, deadline], catalog);
    expect(ranked[0]?.selections).toEqual(expect.arrayContaining([{ optionId: 'cpu-fast', quantity: 2 }, { optionId: 'dimm-64', quantity: 4 }]));
    expect(ranked[0]?.totalListPrice).toBe(5600);
    expect(ranked[0]?.calculations.find((item) => item.requirementId === 'maxLeadTimeDays')).toMatchObject({ actual: 14, required: 14, passed: true });
  });
  it('returns no recommendation when no technically valid option meets the deadline', () => {
    const deadline: Requirement = { id: 'maxLeadTimeDays', label: 'Lead time', value: 7, unit: 'days', comparison: 'atMost', status: 'explicit', required: true, evidence: [] };
    expect(recommendCheapest('C_SERIES', [...requirements, deadline], catalog)).toEqual([]);
  });
  it('enforces X-Series shared dependencies and slot limits', () => {
    const missing: Selection[] = [{ optionId: 'cpu-32', quantity: 2 }];
    expect(validatePlatform('X_SERIES', catalog, missing)).toEqual(expect.arrayContaining(['X-Series requires a chassis', 'X-Series requires fabric connectivity']));
    expect(validatePlatform('X_SERIES', catalog, [{ optionId: 'chassis', quantity: 1 }, { optionId: 'fabric', quantity: 2 }, { optionId: 'gpu', quantity: 2 }])).toContain('Maximum 2 PCIe slots');
  });
  it('rejects any selected capacity drive outside a front-facing category', () => {
    const rearDrive: CatalogOption = { ...catalog.find((option) => option.id === 'ssd-4')!, id: 'rear-drive', attributes: { storageLocation: 'rear' } };
    expect(validateSelection([...catalog, rearDrive], [{ optionId: 'rear-drive', quantity: 1 }])).toContain('UCS-SD-4T is not a front-facing drive option');
  });
});

describe('M8 rack platform inference', () => {
  it.each([
    ['Configure UCSC-C240-M8SX in CCW', 'UCSC-C240-M8SX'],
    ['Parent SKU: UCSC-C210-M2', 'UCSC-C210-M2'],
    ['Server node UCSX-210C-M8', 'UCSX-210C-M8']
  ])('extracts the parent SKU from %s', (text, expected) => expect(extractUcsParentSku(text)).toBe(expected));

  it.each([
    ['UCSC-C220-M8S', 'C22X', 1, 'intel'],
    ['UCSC-C225-M8S', 'C22X', 1, 'amd'],
    ['UCSC-C240-M8SX', 'C24X', 2, 'intel'],
    ['UCSC-C245-M8SX', 'C24X', 2, 'amd']
  ] as const)('infers %s', (model, series, rackUnits, cpuVendor) => {
    expect(inferRackServerProfile(model, ['Riser 1', 'Riser 2'])).toMatchObject({ model, generation: 'M8', series, rackUnits, cpuVendor, riserSlotNames: ['Riser 1', 'Riser 2'] });
  });
});

describe('rack component recommendation', () => {
  const option = (id: string, category: CatalogOption['category'], price: number, attributes: CatalogOption['attributes']): CatalogOption => ({ id, sku: id.toUpperCase(), name: id, category, unitListPrice: price, currency: 'USD', available: true, attributes: { leadTimeDays: 35, maxQuantity: 999, ...(category === 'storage' ? { storageLocation: 'front', frontDriveCapacity: 24 } : {}), ...attributes } });
  const rackCatalog: CatalogOption[] = [
    option('cpu-cheap-slow', 'cpu', 5000, { cores: 32, clockGhz: 2.6, cpuVendor: 'intel', leadTimeDays: 70, maxQuantity: 2 }),
    option('cpu-valid', 'cpu', 6000, { cores: 32, clockGhz: 2.6, cpuVendor: 'intel', maxQuantity: 2 }),
    option('cpu-fast-clock', 'cpu', 8000, { cores: 32, clockGhz: 3.0, cpuVendor: 'intel', maxQuantity: 2 }),
    option('dimm-64', 'memory', 1000, { capacityGb: 64, maxQuantity: 32 }),
    option('hba', 'raid', 1000, { raidCapable: false, controllerType: 'passthrough', maxQuantity: 1 }),
    option('raid', 'raid', 1500, { raidCapable: true, supportedRaidLevels: '0,1,5,6,10,50,60,JBOD', controllerType: 'standard', triMode: true, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxQuantity: 1 }),
    option('ssd-960', 'storage', 800, { capacityGb: 960, driveType: 'SSD', maxQuantity: 10 }),
    option('hdd-2000', 'storage', 5_000, { capacityGb: 2000, driveType: 'HDD', maxQuantity: 10 }),
    option('u2-1920', 'storage', 1000, { capacityGb: 1920, driveType: 'U.2 NVMe', maxQuantity: 10 }),
    option('u3-2000', 'storage', 6_000, { capacityGb: 2000, driveType: 'U.3 NVMe', maxQuantity: 10 }),
    option('mlom', 'nic', 900, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'PCIe MLOM', subgroupName: 'PCIe MLOM', maxQuantity: 1 }),
    option('riser1-nic', 'nic', 1000, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'Riser 1A x16 HH Slot 1', subgroupName: 'PCIe NIC', maxQuantity: 1 }),
    option('riser1b-nic', 'nic', 950, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'Riser 1B x16 FH Slot 1', subgroupName: 'PCIe NIC', maxQuantity: 1 }),
    option('riser2-nic', 'nic', 1100, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'Riser 2A x16 HH Slot 2', subgroupName: 'PCIe NIC', maxQuantity: 1 }),
    option('riser3-fc', 'hba', 1200, { ports: 2, supportedSpeedsGbps: '32,64', nicMedia: 'FC', categoryName: 'Riser 3A x16 HH Slot 3', subgroupName: 'Fibre Channel HBA', maxQuantity: 1 }),
    option('boot-controller', 'boot', 200, { raidCapable: true, supportedRaidLevels: '1', controllerType: 'M.2', maxQuantity: 1 }),
    option('m2-240', 'bootDrive', 300, { capacityGb: 240, maxQuantity: 2 }),
    option('m2-480', 'bootDrive', 500, { capacityGb: 480, maxQuantity: 2 })
  ];
  const req = (id: string, value: number | string, unit?: string): Requirement => ({ id, label: id, value, ...(unit ? { unit } : {}), status: 'explicit', required: true, evidence: [] });
  const riserKitName = (items: CatalogOption[], id: string, name: string) => { const item = items.find((option) => option.id === id); if (item) item.name = name; };

  it('recommends all applicable components using per-card NIC constraints and preserved capacity units', () => {
    const result = recommendRackComponents([
      req('cpuSockets', 2), req('cpuTotalCores', 64), req('cpuClockGhz', 2.5, 'GHz'), req('cpuVendor', 'intel'), req('memoryGb', 512, 'GB'),
      req('localStorageCapacity', 3.8, 'TB'), req('raidLevel', '1'), req('nicCardCount', 2), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 25, 'Gbps'),
      req('bootCapacity', 240, 'GB'), req('bootDriveCount', 2), req('bootDriveType', 'M.2'), { ...req('maxLeadTimeDays', 35, 'days'), comparison: 'atMost' }
    ], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.map((component) => component.component)).toEqual(['cpu', 'memory', 'raid', 'storage', 'riserNic', 'bootController', 'bootDrive']);
    expect(result.components.find((component) => component.component === 'cpu')?.selections).toEqual([{ optionId: 'cpu-valid', quantity: 2 }]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'hdd-2000', quantity: 2 }]);
    expect(result.components.find((component) => component.component === 'bootDrive')?.selections).toEqual([{ optionId: 'm2-240', quantity: 2 }]);
    expect(result.maxLeadTimeDays).toBe(35);
  });

  it('reports a precise violation when card-level NIC requirements cannot be placed', () => {
    const result = recommendRackComponents([req('nicCardCount', 4), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 25)], rackCatalog);
    expect(result.violations).toContain('Only 3 physical NIC slot(s) meet the requirement; 4 requested.');
  });
  it('never recommends a CCW-fixed quantity at a different requested quantity', () => {
    const fixedCatalog = [option('cpu-fixed-one', 'cpu', 1000, { cores: 32, clockGhz: 3, cpuVendor: 'intel', maxQuantity: 2, quantityFixed: true, fixedQuantity: 1 })];
    const result = recommendRackComponents([req('cpuSockets', 2), req('cpuCoresPerSocket', 24)], fixedCatalog);
    expect(result.components).toEqual([]);
    expect(result.violations).toContain('No CPU option meets socket, core, clock-speed, and lead-time requirements.');
  });
  it('recommends distinct Ethernet and Fibre Channel card groups without reusing a slot', () => {
    const result = recommendRackComponents([
      req('nicGroup1CardCount', 2), req('nicGroup1PortsPerCard', 2), req('nicGroup1SpeedGbpsPerPort', 10), req('nicGroup1Media', 'SFP'),
      req('nicGroup2CardCount', 1), req('nicGroup2PortsPerCard', 2), req('nicGroup2SpeedGbpsPerPort', 32), req('nicGroup2Media', 'FC')
    ], rackCatalog);
    expect(result.violations).toEqual([]);
    const optionIds = result.components.flatMap((component) => component.selections).map((selection) => selection.optionId);
    expect(optionIds).toEqual(expect.arrayContaining(['riser1-nic', 'riser2-nic', 'riser3-fc']));
    expect(optionIds).not.toContain('mlom');
    expect(result.components.map((component) => component.reason).join(' ')).toContain('SFP');
    expect(result.components.map((component) => component.reason).join(' ')).toContain('FC');
  });
  it('prioritizes risers, falls back to PCIe MLOM when risers are full, and honors explicit OCP', () => {
    const defaultPlacement = recommendRackComponents([req('nicCardCount', 1), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 10), req('nicMedia', 'SFP')], rackCatalog);
    expect(defaultPlacement.components.flatMap((component) => component.selections)).toEqual([{ optionId: 'riser1-nic', quantity: 1 }]);
    const fallbackPlacement = recommendRackComponents([req('nicCardCount', 3), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 10), req('nicMedia', 'SFP')], rackCatalog);
    expect(fallbackPlacement.violations).toEqual([]);
    expect(fallbackPlacement.components.flatMap((component) => component.selections)).toEqual(expect.arrayContaining([
      { optionId: 'riser1-nic', quantity: 1 }, { optionId: 'riser2-nic', quantity: 1 }, { optionId: 'mlom', quantity: 1 }
    ]));
    expect(fallbackPlacement.components.find((component) => component.component === 'mlom')?.reason).toContain('riser slots exhausted; PCIe MLOM fallback');
    const ocpPlacement = recommendRackComponents([req('nicCardCount', 1), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 10), req('nicMedia', 'SFP'), req('nicAdapterType', 'OCP')], rackCatalog);
    expect(ocpPlacement.components.flatMap((component) => component.selections)).toEqual([{ optionId: 'mlom', quantity: 1 }]);
  });
  it('honors explicit Ethernet media instead of substituting a cheaper connector type', () => {
    const mediaCatalog = [
      option('slot1-base-t', 'nic', 1, { ports: 2, supportedSpeedsGbps: '10', nicMedia: 'BASE-T', categoryName: 'Riser 1A x16 HH Slot 1', maxQuantity: 1 }),
      option('slot2-sfp', 'nic', 1000, { ports: 2, supportedSpeedsGbps: '10', nicMedia: 'SFP', categoryName: 'Riser 2A x16 HH Slot 2', maxQuantity: 1 })
    ];
    const result = recommendRackComponents([req('nicCardCount', 1), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 10), req('nicMedia', 'SFP')], mediaCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.flatMap((component) => component.selections)).toEqual([{ optionId: 'slot2-sfp', quantity: 1 }]);
  });
  it('uses PCIe MLOM only after total demand across NIC groups exhausts matching risers', () => {
    const result = recommendRackComponents([
      req('nicGroup1CardCount', 2), req('nicGroup1PortsPerCard', 2), req('nicGroup1SpeedGbpsPerPort', 10), req('nicGroup1Media', 'SFP'),
      req('nicGroup2CardCount', 1), req('nicGroup2PortsPerCard', 2), req('nicGroup2SpeedGbpsPerPort', 10), req('nicGroup2Media', 'SFP')
    ], rackCatalog);
    expect(result.violations).toEqual([]);
    const optionIds = result.components.flatMap((component) => component.selections).map((selection) => selection.optionId);
    expect(optionIds).toEqual(expect.arrayContaining(['riser1-nic', 'riser2-nic', 'mlom']));
    expect(optionIds).toHaveLength(3);
  });
  it('places Fibre Channel HBAs first in risers before allocating non-FC NICs', () => {
    const sharedSlotCatalog = [
      option('slot1-fc', 'hba', 1200, { ports: 2, supportedSpeedsGbps: '32,64', nicMedia: 'FC', categoryName: 'Riser 1A Slot 1', maxQuantity: 1 }),
      option('slot2-fc', 'hba', 900, { ports: 2, supportedSpeedsGbps: '32,64', nicMedia: 'FC', categoryName: 'Riser 2A Slot 2', maxQuantity: 1 }),
      option('slot1-sfp', 'nic', 100, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'Riser 1A Slot 1', maxQuantity: 1 }),
      option('slot2-sfp', 'nic', 100, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'Riser 2A Slot 2', maxQuantity: 1 }),
      option('shared-mlom', 'nic', 1, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'PCIe MLOM', maxQuantity: 1 })
    ];
    const result = recommendRackComponents([
      req('nicGroup1CardCount', 1), req('nicGroup1PortsPerCard', 2), req('nicGroup1SpeedGbpsPerPort', 10), req('nicGroup1Media', 'SFP'),
      req('nicGroup2CardCount', 1), req('nicGroup2PortsPerCard', 2), req('nicGroup2SpeedGbpsPerPort', 32), req('nicGroup2Media', 'FC')
    ], sharedSlotCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.flatMap((component) => component.selections)).toEqual(expect.arrayContaining([
      { optionId: 'slot1-fc', quantity: 1 }, { optionId: 'slot2-sfp', quantity: 1 }
    ]));
    expect(result.components.flatMap((component) => component.selections).map((selection) => selection.optionId)).not.toContain('shared-mlom');
  });
  it('places mixed NIC groups across C24x slot labels', () => {
    const c24Catalog = [
      option('c24-slot1a-sfp', 'nic', 5000, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'R1A Slot1 x8 FH', subgroupName: 'PCIe NIC', maxQuantity: 1 }),
      option('c24-slot1c-sfp', 'nic', 1, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'R1C Slot1 x16 FH', subgroupName: 'PCIe NIC', maxQuantity: 1 }),
      option('c24-slot2a-sfp', 'nic', 4000, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'R2A Slot2 x16 FH', subgroupName: 'PCIe NIC', maxQuantity: 1 }),
      option('c24-slot3a-sfp', 'nic', 1, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'SFP', categoryName: 'R3A Slot3 x16 FH', subgroupName: 'PCIe NIC', maxQuantity: 1 }),
      option('c24-slot7-fc', 'hba', 1200, { ports: 2, supportedSpeedsGbps: '32,64', nicMedia: 'FC', categoryName: 'R3A Slot7 x8 FH', subgroupName: 'Fibre Channel HBA', maxQuantity: 1 })
    ];
    const result = recommendRackComponents([
      req('nicGroup1CardCount', 2), req('nicGroup1PortsPerCard', 2), req('nicGroup1SpeedGbpsPerPort', 10), req('nicGroup1Media', 'SFP'),
      req('nicGroup2CardCount', 1), req('nicGroup2PortsPerCard', 2), req('nicGroup2SpeedGbpsPerPort', 32), req('nicGroup2Media', 'FC')
    ], c24Catalog);
    expect(result.violations).toEqual([]);
    expect(result.components.flatMap((component) => component.selections)).toEqual(expect.arrayContaining([
      { optionId: 'c24-slot1a-sfp', quantity: 1 }, { optionId: 'c24-slot2a-sfp', quantity: 1 }, { optionId: 'c24-slot7-fc', quantity: 1 }
    ]));
    expect(result.components.flatMap((component) => component.selections).map((selection) => selection.optionId)).not.toContain('c24-slot1c-sfp');
    expect(result.components.flatMap((component) => component.selections).map((selection) => selection.optionId)).not.toContain('c24-slot3a-sfp');
  });
  it('uses exactly two drives for RAID 1 usable capacity', () => {
    const result = recommendRackComponents([req('localStorageCapacity', 0.96, 'TB'), req('localStorageCapacityType', 'usable'), req('raidLevel', '1')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'ssd-960', quantity: 2 }]);
    expect(result.components.find((component) => component.component === 'storage')?.reason).toBe('2 × 960 GB = 1.92 TB raw → RAID 1 = 960 GB usable · front-facing bays only');
  });
  it('uses the standard RAID controller and Local Storage options for non-M.2 boot drives', () => {
    const result = recommendRackComponents([req('bootCapacity', 480, 'GB'), req('bootDriveCount', 2), req('bootDriveType', 'SSD'), req('raidLevel', '1')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'raid', quantity: 1 }]);
    expect(result.components.some((component) => component.component === 'bootController')).toBe(false);
    expect(result.components.find((component) => component.component === 'bootDrive')?.selections).toEqual([{ optionId: 'ssd-960', quantity: 2 }]);
  });
  it('never substitutes an M.2 controller or pass-through HBA for standard local RAID', () => {
    const controllerCatalog = [option('m2-misclassified', 'raid', 1, { raidCapable: true, controllerType: 'M.2', maxQuantity: 1 }), ...rackCatalog];
    const result = recommendRackComponents([req('localStorageCapacity', 1.92, 'TB'), req('localStorageCapacityType', 'usable'), req('localDriveType', 'SSD'), req('raidLevel', '5')], controllerCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'raid', quantity: 1 }]);
  });
  it('fills front-facing drive bays before considering cheaper rear-riser drives', () => {
    const driveCatalog = [
      option('front-ssd', 'storage', 1000, { capacityGb: 960, driveType: 'SSD', storageLocation: 'front', frontDriveCapacity: 10, maxQuantity: 10 }),
      option('rear-ssd', 'storage', 1, { capacityGb: 960, driveType: 'SSD', storageLocation: 'rear', maxQuantity: 2 }),
      ...rackCatalog.filter((item) => item.category !== 'storage')
    ];
    const result = recommendRackComponents([req('localStorageCapacity', 1.92, 'TB'), req('localStorageCapacityType', 'raw'), req('localDriveType', 'SSD')], driveCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'front-ssd', quantity: 2 }]);
  });
  it('matches exact drive population, SAS/SATA interface, and transfer speed', () => {
    const driveCatalog = [
      option('sas-6-ssd', 'storage', 1, { capacityGb: 960, driveType: 'SAS SSD', driveInterface: 'SAS', transferSpeedGbps: 6, maxQuantity: 10 }),
      option('sas-12-ssd', 'storage', 1000, { capacityGb: 960, driveType: 'SAS SSD', driveInterface: 'SAS', transferSpeedGbps: 12, maxQuantity: 10 }),
      option('sata-ssd', 'storage', 1, { capacityGb: 960, driveType: 'SATA SSD', driveInterface: 'SATA', transferSpeedGbps: 6, maxQuantity: 10 }),
      ...rackCatalog.filter((item) => item.category !== 'storage')
    ];
    const result = recommendRackComponents([
      req('storageGroup1Capacity', 3840, 'GB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveCount', 4), req('storageGroup1DriveCapacity', 960, 'GB'),
      req('storageGroup1DriveType', 'SAS SSD'), req('storageGroup1DriveInterface', 'SAS'), req('storageGroup1TransferSpeedGbps', 12), req('maxLocalDriveCount', 10, 'drives')
    ], driveCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'sas-12-ssd', quantity: 4 }]);
    expect(result.components.find((component) => component.component === 'storage')?.reason).toContain('4 × 960 GB = 3.84 TB raw');
  });
  it('rejects rear-riser overflow when aggregate front-drive capacity is full', () => {
    const driveCatalog = [
      option('front-ssd', 'storage', 1000, { capacityGb: 1000, driveType: 'SSD', storageLocation: 'front', frontDriveCapacity: 3, maxQuantity: 3 }),
      option('rear-ssd', 'storage', 1, { capacityGb: 1000, driveType: 'SSD', storageLocation: 'rear', maxQuantity: 2 }),
      ...rackCatalog.filter((item) => item.category !== 'storage')
    ];
    const result = recommendRackComponents([
      req('storageGroup1Capacity', 2, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'SSD'),
      req('storageGroup2Capacity', 2, 'TB'), req('storageGroup2CapacityType', 'raw'), req('storageGroup2DriveType', 'SSD')
    ], driveCatalog);
    expect(result.components.find((component) => component.component === 'storage')).toBeUndefined();
    expect(result.violations).toContain('No front-facing local-storage option meets capacity, platform bay limits, and lead-time requirements.');
  });
  it('never spans one large drive group into rear-riser bays', () => {
    const driveCatalog = [
      option('front-ssd', 'storage', 1000, { capacityGb: 1000, driveType: 'SSD', storageLocation: 'front', frontDriveCapacity: 10, maxQuantity: 10 }),
      { ...option('rear-ssd', 'storage', 1, { capacityGb: 1000, driveType: 'SSD', storageLocation: 'rear', maxQuantity: 2 }), sku: 'FRONT-SSD' },
      ...rackCatalog.filter((item) => item.category !== 'storage')
    ];
    const result = recommendRackComponents([req('localStorageCapacity', 12, 'TB'), req('localStorageCapacityType', 'raw'), req('localDriveType', 'SSD')], driveCatalog);
    expect(result.components.find((component) => component.component === 'storage')).toBeUndefined();
    expect(result.violations).toContain('No front-facing local-storage option meets capacity, platform bay limits, and lead-time requirements.');
  });
  it('honors exact DIMM population instead of substituting a different module size', () => {
    const result = recommendRackComponents([req('memoryGb', 512, 'GB'), req('memoryModuleCount', 8), req('memoryModuleSizeGb', 64, 'GB')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'memory')?.selections).toEqual([{ optionId: 'dimm-64', quantity: 8 }]);
  });
  it('enforces the 32-DIMM ceiling for C2xx and X21x servers', () => {
    const invalid = recommendRackComponents([req('memoryGb', 2112, 'GB'), req('memoryModuleCount', 33)], rackCatalog);
    expect(invalid.components.find((component) => component.component === 'memory')).toBeUndefined();
    expect(invalid.violations).toContain('Memory module count must be between 1 and 32 DIMMs.');
    const valid = recommendRackComponents([req('memoryGb', 2048, 'GB'), req('memoryModuleCount', 32)], rackCatalog);
    expect(valid.violations).toEqual([]);
    expect(valid.components.find((component) => component.component === 'memory')?.selections).toEqual([{ optionId: 'dimm-64', quantity: 32 }]);
  });
  it('caps total local capacity drives across all storage groups without counting boot drives', () => {
    const withinLimit = recommendRackComponents([req('localStorageCapacity', 3.84, 'TB'), req('localStorageCapacityType', 'raw'), req('maxLocalDriveCount', 4, 'drives')], rackCatalog);
    expect(withinLimit.violations).toEqual([]);
    expect(withinLimit.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'ssd-960', quantity: 4 }]);
    const overLimit = recommendRackComponents([
      req('storageGroup1Capacity', 1.92, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'SSD'),
      req('storageGroup2Capacity', 0.96, 'TB'), req('storageGroup2CapacityType', 'raw'), req('storageGroup2DriveType', 'SSD'),
      req('maxLocalDriveCount', 2, 'drives')
    ], rackCatalog);
    expect(overLimit.components.find((component) => component.component === 'storage')).toBeUndefined();
    expect(overLimit.violations).toContain('No front-facing local-storage plan meets capacity, the 2-drive server limit, and lead-time requirements.');
  });
  it('caps boot-drive quantity at two independently of the local capacity-drive limit', () => {
    const result = recommendRackComponents([req('bootCapacity', 240, 'GB'), req('bootDriveCount', 3), req('bootDriveType', 'M.2'), req('maxLocalDriveCount', 1, 'drives')], rackCatalog);
    expect(result.components.some((component) => component.component === 'bootController' || component.component === 'bootDrive')).toBe(false);
    expect(result.violations).toContain('Boot drive count must be 1 or 2 drives per server.');
  });
  it('sizes two RAID groups independently and shares a compatible controller', () => {
    const result = recommendRackComponents([
      req('storageGroup1Capacity', 1.92, 'TB'), req('storageGroup1CapacityType', 'usable'), req('storageGroup1RaidLevel', '1'),
      req('storageGroup2Capacity', 0.96, 'TB'), req('storageGroup2CapacityType', 'raw'), req('storageGroup2RaidLevel', '10')
    ], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'raid', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([
      { optionId: 'hdd-2000', quantity: 2 }, { optionId: 'ssd-960', quantity: 4 }
    ]);
  });
  it('recognizes a scanned multi-RAID controller whose description does not enumerate RAID levels', () => {
    const m1Catalog = [
      option('UCSC-RAID-M1L16', 'raid', 7950, { raidCapable: true, supportedRaidLevels: '', controllerType: 'standard', triMode: true, maxDrives: 16, maxQuantity: 1, leadTimeDays: 70 }),
      option('ssd-4000', 'storage', 4000, { capacityGb: 4000, driveType: 'SSD', maxQuantity: 10, leadTimeDays: 21 }),
      option('u3-2000', 'storage', 3000, { capacityGb: 2000, driveType: 'U.3 NVMe', maxQuantity: 10, leadTimeDays: 21 }),
      option('ssd-1900', 'storage', 1900, { capacityGb: 1900, driveType: 'SSD', maxQuantity: 10, leadTimeDays: 21 })
    ];
    const storageRequirements = [
      req('storageGroup1Capacity', 4, 'TB'), req('storageGroup1CapacityType', 'usable'), req('storageGroup1DriveType', 'SSD'), req('storageGroup1RaidLevel', '5'),
      req('storageGroup2Capacity', 2, 'TB'), req('storageGroup2CapacityType', 'usable'), req('storageGroup2DriveType', 'U.3 NVMe'), req('storageGroup2RaidLevel', '1'),
      req('storageGroup3DriveCount', 4), req('storageGroup3DriveCapacity', 1.9, 'TB'), req('storageGroup3CapacityType', 'raw'), req('storageGroup3DriveType', 'SSD'), req('storageGroup3RaidLevel', '5')
    ];
    const result = recommendRackComponents(storageRequirements, m1Catalog, inferRackServerProfile('UCSC-C220-M8S'));
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'UCSC-RAID-M1L16', quantity: 1 }]);
    expect(result.violations).toEqual([]);

    const blockedByDeadline = recommendRackComponents([...storageRequirements, { ...req('maxLeadTimeDays', 35, 'days'), comparison: 'atMost' }], m1Catalog, inferRackServerProfile('UCSC-C220-M8S'));
    expect(blockedByDeadline.components.find((component) => component.component === 'raid')).toBeUndefined();
    expect(blockedByDeadline.violations).toContain('UCSC-RAID-M1L16 supports RAID 5 and 1, but its 70-day lead time exceeds the 35-day target.');
    expect(blockedByDeadline.violations.join(' ')).not.toContain('No standard RAID/storage controller supports RAID 5 and 1');
  });
  it('applies standard and Tri-Mode media rules to every RAID controller SKU', () => {
    const controllers = [
      option('standard-raid', 'raid', 100, { raidCapable: true, controllerType: 'standard', triMode: false, supportedDriveTypes: 'HDD,SSD', maxDrives: 16, maxQuantity: 1 }),
      option('tri-mode-raid', 'raid', 200, { raidCapable: true, controllerType: 'standard', triMode: true, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 16, maxQuantity: 1 }),
      option('u3-2000', 'storage', 3000, { capacityGb: 2000, driveType: 'U.3 NVMe', maxQuantity: 10 })
    ];
    const requirements = [
      req('storageGroup1Capacity', 2, 'TB'), req('storageGroup1CapacityType', 'usable'), req('storageGroup1DriveType', 'U.3 NVMe'), req('storageGroup1RaidLevel', '1')
    ];
    const result = recommendRackComponents(requirements, controllers);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'tri-mode-raid', quantity: 1 }]);

    const nonTriOnly = recommendRackComponents(requirements, controllers.filter((option) => option.id !== 'tri-mode-raid'));
    expect(nonTriOnly.components.find((component) => component.component === 'raid')).toBeUndefined();
    expect(nonTriOnly.violations).toContain('No standard RAID/storage controller supports RAID 1 media and drive-count requirements.');
  });
  it('lets a non-Tri-Mode RAID controller serve HDD and SSD groups with RAID and JBOD', () => {
    const nonTriCatalog = [
      option('non-tri-raid', 'raid', 100, { raidCapable: true, controllerType: 'standard', triMode: false, supportedRaidLevels: '1', supportedDriveTypes: 'HDD,SSD', maxDrives: 16, maxQuantity: 1 }),
      option('ssd-1000', 'storage', 1000, { capacityGb: 1000, driveType: 'SSD', maxQuantity: 10 }),
      option('hdd-2000-local', 'storage', 500, { capacityGb: 2000, driveType: 'HDD', maxQuantity: 10 })
    ];
    const result = recommendRackComponents([
      req('storageGroup1Capacity', 2, 'TB'), req('storageGroup1CapacityType', 'usable'), req('storageGroup1DriveType', 'SSD'), req('storageGroup1RaidLevel', '5'),
      req('storageGroup2DriveCount', 2), req('storageGroup2DriveCapacity', 2, 'TB'), req('storageGroup2CapacityType', 'raw'), req('storageGroup2DriveType', 'HDD'), req('storageGroup2RaidLevel', 'JBOD')
    ], nonTriCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'non-tri-raid', quantity: 1 }]);
  });
  it('does not apply standard multi-RAID behavior to M.2 controllers', () => {
    const m2Only = [
      option('m2-raid', 'raid', 1, { raidCapable: true, controllerType: 'M.2', supportedRaidLevels: '1', supportedDriveTypes: 'M.2', maxQuantity: 1 }),
      option('ssd-960-local', 'storage', 100, { capacityGb: 960, driveType: 'SSD', maxQuantity: 10 })
    ];
    const result = recommendRackComponents([req('localStorageCapacity', 1.92, 'TB'), req('localStorageCapacityType', 'usable'), req('localDriveType', 'SSD'), req('raidLevel', '5')], m2Only);
    expect(result.components.find((component) => component.component === 'raid')).toBeUndefined();
    expect(result.violations).toContain('No standard RAID/storage controller supports RAID 5 media and drive-count requirements.');
  });
  it('sizes three RAID groups with one drive type and one SKU per group', () => {
    const result = recommendRackComponents([
      req('storageGroup1Capacity', 8, 'TB'), req('storageGroup1CapacityType', 'usable'), req('storageGroup1DriveType', 'SSD'), req('storageGroup1RaidLevel', '5'),
      req('storageGroup2Capacity', 2, 'TB'), req('storageGroup2CapacityType', 'usable'), req('storageGroup2DriveType', 'HDD'), req('storageGroup2RaidLevel', '1'),
      req('storageGroup3Capacity', 4, 'TB'), req('storageGroup3CapacityType', 'usable'), req('storageGroup3DriveType', 'U.3 NVMe'), req('storageGroup3RaidLevel', '10')
    ], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual(expect.arrayContaining([
      { optionId: 'ssd-960', quantity: 10 }, { optionId: 'hdd-2000', quantity: 2 }, { optionId: 'u3-2000', quantity: 4 }
    ]));
    expect(result.components.find((component) => component.component === 'storage')?.reason).toContain('Group 3 (U.3 NVMe)');
    expect(result.components.find((component) => component.component === 'storage')?.reason.split('\n')).toHaveLength(3);
  });
  it('enforces RAID layout minimums for raw-capacity groups', () => {
    const result = recommendRackComponents([req('localStorageCapacity', 1.92, 'TB'), req('localStorageCapacityType', 'raw'), req('raidLevel', '10')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'ssd-960', quantity: 4 }]);
  });
  it('sizes card topology when only abstract NIC ports are provided', () => {
    const result = recommendRackComponents([req('nicTotalPorts', 4), req('nicSpeedGbpsPerPort', 25)], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'riserNic')?.selections).toEqual([
      { optionId: 'riser1-nic', quantity: 1 }, { optionId: 'riser2-nic', quantity: 1 }
    ]);
  });

  it('recommends complete categories while skipping only an unresolved storage group', () => {
    const result = recommendRackComponents([
      req('cpuTotalCores', 32), req('memoryGb', 256, 'GB'),
      req('storageGroup1Capacity', 4, 'TB'), req('storageGroup1CapacityType', 'usable')
    ], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.map((component) => component.component)).toEqual(['cpu', 'memory']);
    expect(result.notices).toEqual(['Skipped drive group 1 RAID level until clarified.']);
  });

  it('uses one available field to recommend CPU, memory, NIC, and GPU categories', () => {
    const result = recommendRackComponents([
      req('cpuSockets', 1), req('memoryModuleSizeGb', 64, 'GB'), req('nicMedia', 'SFP'), req('gpuModel', 'L40S')
    ], [...rackCatalog, option('l40s', 'gpu', 9000, { gpuMemoryGb: 48, categoryName: 'Riser 3A Slot 3', maxQuantity: 1 })]);
    expect(result.violations).toEqual([]);
    expect(result.components.map((component) => component.component)).toEqual(expect.arrayContaining(['cpu', 'memory', 'riserNic', 'gpu']));
  });
  it('prefers a low-power C240 GPU for a single-CPU topology', () => {
    const c240Catalog = [
      option('cpu-single', 'cpu', 50, { cores: 24, clockGhz: 2.5, cpuVendor: 'intel', maxQuantity: 1, maxSocketCount: 1 }),
      option('gpu-high', 'gpu', 100, { gpuMemoryGb: 64, tdpWatts: 250, categoryName: 'R1A Slot1 x8 FH', maxQuantity: 1 }),
      { ...option('gpu-l4', 'gpu', 200, { gpuMemoryGb: 24, tdpWatts: 70, categoryName: 'R1A Slot1 x8 FH', maxQuantity: 1 }), name: 'NVIDIA L4' },
      option('gpu-airduct', 'accessory', 25, { categoryName: 'GPU Airduct', subgroupName: 'GPU Airduct', maxQuantity: 1 }),
      option('riser1', 'riser', 50, { categoryName: 'PCIe Riser Option', subgroupName: 'PCIe Riser 1 Option', maxQuantity: 1 })
    ];
    riserKitName(c240Catalog, 'riser1', 'UCSC-RIS1A-240M8 C240 M8 Riser 1A');
    const result = recommendRackComponents([req('cpuSockets', 1), req('gpuCount', 1), req('gpuMemoryGb', 24, 'GB')], c240Catalog, inferRackServerProfile('UCSC-C240-M8SX'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'gpu')?.selections).toEqual([{ optionId: 'gpu-l4', quantity: 1 }]);
  });
  it('uses a standard RAID controller for non-M.2 raw JBOD', () => {
    const result = recommendRackComponents([req('localStorageCapacity', 1.92, 'TB'), req('localStorageCapacityType', 'raw'), req('raidLevel', 'JBOD'), req('localDriveCount', 2), req('localDriveCapacity', 960, 'GB')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'raid', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'ssd-960', quantity: 2 }]);
  });
  it('uses a pass-through HBA for U.2 NVMe and rejects a RAID request', () => {
    const raw = recommendRackComponents([req('localStorageCapacity', 3.84, 'TB'), req('localStorageCapacityType', 'raw'), req('raidLevel', 'JBOD'), req('localDriveType', 'U.2 NVMe')], rackCatalog);
    expect(raw.violations).toEqual([]);
    expect(raw.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'hba', quantity: 1 }]);
    expect(raw.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'u2-1920', quantity: 2 }]);
    expect(recommendRackComponents([req('localStorageCapacity', 3.84, 'TB'), req('localStorageCapacityType', 'usable'), req('raidLevel', '5'), req('localDriveType', 'U.2 NVMe')], rackCatalog).violations).toContain('U.2 NVMe does not support RAID; specify raw/pass-through storage instead.');
  });
  it('derives storage sizing from drive count and capacity when aggregate capacity is empty', () => {
    const result = recommendRackComponents([
      { id: 'storageGroup1Capacity', label: 'Capacity', status: 'unresolved', required: false, evidence: [] },
      req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveCount', 4), req('storageGroup1DriveCapacity', 0.96, 'TB'), req('storageGroup1DriveType', 'SSD'), req('storageGroup1RaidLevel', '5')
    ], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'ssd-960', quantity: 4 }]);
  });

  it('ignores zero-valued optional drive details when usable capacity and RAID are sufficient', () => {
    const result = recommendRackComponents([
      req('storageGroup1Capacity', 3, 'TB'), req('storageGroup1CapacityType', 'usable'),
      req('storageGroup1DriveCapacity', 0, 'GB'), req('storageGroup1TransferSpeedGbps', 0, 'Gbps'),
      req('storageGroup1RaidLevel', '10')
    ], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'ssd-960', quantity: 8 }]);
  });

  it('uses minimum single-category inputs and ignores zero sibling placeholders', () => {
    const result = recommendRackComponents([
      req('cpuTotalCores', 32), req('cpuSockets', 0),
      req('memoryGb', 256, 'GB'), req('memoryModuleCount', 0),
      req('nicMedia', 'SFP'), req('nicSpeedGbpsPerPort', 0),
      req('gpuModel', 'L40S'), req('gpuCount', 0)
    ], [...rackCatalog, option('l40s', 'gpu', 9000, { gpuMemoryGb: 48, categoryName: 'Riser 3A Slot 3', maxQuantity: 1 })]);
    expect(result.violations).toEqual([]);
    expect(result.components.map((component) => component.component)).toEqual(expect.arrayContaining(['cpu', 'memory', 'riserNic', 'gpu']));
  });

  it('chooses a pass-through HBA when no RAID is explicitly selected', () => {
    const result = recommendRackComponents([req('localStorageCapacity', 1.92, 'TB'), req('localStorageCapacityType', 'raw'), req('raidLevel', 'NONE'), req('localDriveCount', 2), req('localDriveCapacity', 960, 'GB')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.label).toBe('Pass-through HBA');
  });
  it('defaults M.2 boot to two drives and RAID 1 independently of local RAID', () => {
    const result = recommendRackComponents([req('bootCapacity', 240, 'GB'), req('bootDriveType', 'M.2'), req('localStorageCapacity', 1.92, 'TB'), req('localStorageCapacityType', 'usable'), req('raidLevel', '5')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'bootController')?.reason).toBe('M.2 boot controller with RAID 1');
    expect(result.components.find((component) => component.component === 'bootDrive')?.selections).toEqual([{ optionId: 'm2-240', quantity: 2 }]);
  });
  it('recommends M.2 boot components from capacity alone', () => {
    const result = recommendRackComponents([req('bootCapacity', 480, 'GB')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'bootController')?.selections).toEqual([{ optionId: 'boot-controller', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'bootDrive')?.selections).toEqual([{ optionId: 'm2-480', quantity: 2 }]);
  });
  it('enforces a one-socket C225 platform limit', () => {
    const result = recommendRackComponents([req('cpuSockets', 2), req('cpuCoresPerSocket', 24)], rackCatalog, inferRackServerProfile('UCSC-C225-M8S'));
    expect(result.components.find((component) => component.component === 'cpu')).toBeUndefined();
    expect(result.violations).toContain('No CPU option meets socket, core, clock-speed, and lead-time requirements.');
  });
  it('keeps every drive in one RAID group at one exact capacity', () => {
    const drives = [
      option('ssd-1900', 'storage', 1000, { capacityGb: 1900, driveType: 'SSD', maxQuantity: 10 }),
      option('ssd-2000-cheap', 'storage', 1, { capacityGb: 2000, driveType: 'SSD', maxQuantity: 10 }),
      option('raid-extended', 'raid', 100, { raidCapable: true, supportedRaidLevels: '5,50,60', controllerType: 'standard', maxQuantity: 1 })
    ];
    const result = recommendRackComponents([
      req('storageGroup1DriveCount', 5), req('storageGroup1DriveCapacity', 1.9, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'SSD'), req('storageGroup1RaidLevel', '5')
    ], drives);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'ssd-1900', quantity: 5 }]);
  });
  it('uses M.2 NVMe pass-through when the platform does not support M.2 NVMe RAID', () => {
    const bootCatalog = [
      option('m2-sata-raid', 'boot', 1, { raidCapable: true, supportedRaidLevels: '1', controllerType: 'M.2', m2Protocol: 'SATA', maxQuantity: 1 }),
      option('m2-nvme-pass', 'boot', 100, { raidCapable: false, controllerType: 'M.2-passthrough', m2Protocol: 'NVMe', maxQuantity: 1 }),
      option('m2-nvme-drive', 'bootDrive', 200, { capacityGb: 960, driveInterface: 'NVMe', maxQuantity: 2 }),
      option('x-mlom', 'nic', 300, { ports: 2, supportedSpeedsGbps: '25', categoryName: 'Rear mLOM Adapter', maxQuantity: 1 })
    ];
    bootCatalog.find((item) => item.id === 'x-mlom')!.sku = 'UCSX-ML-V5Q50G-D';
    bootCatalog.find((item) => item.id === 'x-mlom')!.name = 'Cisco VIC 15420 4x25G mLOM X-Series';
    const result = recommendRackComponents([req('bootCapacity', 960, 'GB'), req('bootDriveType', 'M.2 NVMe')], bootCatalog, inferRackServerProfile('UCSX-210C-M8'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'bootController')?.selections).toEqual([{ optionId: 'm2-nvme-pass', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'bootDrive')?.selections).toEqual([{ optionId: 'm2-nvme-drive', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'mlom')?.selections).toEqual([{ optionId: 'x-mlom', quantity: 1 }]);
  });
  it('uses the auto-included X210 SATA M.2 controller without recommending it again', () => {
    const bootCatalog = [
      option('included-sata-m2', 'boot', 0, { selected: true, selectedQuantity: 1, quantityFixed: true, fixedQuantity: 1, raidCapable: true, supportedRaidLevels: '1,JBOD', controllerType: 'M.2', m2Protocol: 'SATA', maxQuantity: 1 }),
      option('m2-sata-drive', 'bootDrive', 200, { capacityGb: 480, driveInterface: 'SATA', maxQuantity: 2 }),
      option('x-mlom', 'nic', 300, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 })
    ];
    bootCatalog[0]!.sku = 'UCSX-M2I-HWRD-FPS';
    bootCatalog[2]!.sku = 'UCSX-ML-V5Q50G-D'; bootCatalog[2]!.name = 'Cisco VIC 15420 4x25G mLOM X-Series';
    const result = recommendRackComponents([req('bootCapacity', 480, 'GB'), req('bootDriveType', 'M.2 SATA')], bootCatalog, inferRackServerProfile('UCSX-210C-M8-U'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'bootController')).toBeUndefined();
    expect(result.components.find((component) => component.component === 'bootDrive')?.selections).toEqual([{ optionId: 'm2-sata-drive', quantity: 2 }]);
  });
  it('selects the exact X210c E3.S front-mezzanine controller for nine front drives', () => {
    const x210Catalog = [
      option('x-pt4f', 'raid', 100, { controllerType: 'passthrough', raidCapable: false, supportedDriveTypes: 'U.3 NVMe', maxDrives: 6, frontMezzanine: true, categoryName: 'Front MEZZ - Controller', maxQuantity: 1 }),
      option('x-pte3', 'raid', 200, { controllerType: 'passthrough', raidCapable: false, supportedDriveTypes: 'E3.S NVMe', maxDrives: 9, frontMezzanine: true, categoryName: 'Front MEZZ - Controller', maxQuantity: 1 }),
      option('x-e3s', 'storage', 500, { capacityGb: 1600, driveType: 'E3.S NVMe', storageLocation: 'front', frontDriveCapacity: 9, maxQuantity: 9 }),
      option('x-mlom', 'nic', 300, { ports: 2, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 })
    ];
    x210Catalog.find((item) => item.id === 'x-mlom')!.sku = 'UCSX-ML-V5Q50G-D';
    x210Catalog.find((item) => item.id === 'x-mlom')!.name = 'Cisco VIC 15420 4x25G mLOM X-Series';
    const result = recommendRackComponents([
      req('storageGroup1DriveCount', 9), req('storageGroup1DriveCapacity', 1.6, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'E3.S NVMe'), req('storageGroup1RaidLevel', 'NONE')
    ], x210Catalog, inferRackServerProfile('UCSX-210C-M8-U'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'x-pte3', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'x-e3s', quantity: 9 }]);
  });
  it('does not expose dependent X210 E3.S drives for approval when hardware RAID is impossible', () => {
    const x210Catalog = [
      option('x-pte3', 'raid', 200, { controllerType: 'passthrough', raidCapable: false, supportedDriveTypes: 'E3.S NVMe', maxDrives: 9, frontMezzanine: true, categoryName: 'Front MEZZ - Controller', maxQuantity: 1 }),
      option('x-e3s', 'storage', 500, { capacityGb: 1600, driveType: 'E3.S NVMe', storageLocation: 'front', frontDriveCapacity: 9, maxQuantity: 9 }),
      option('x-mlom', 'nic', 300, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 })
    ];
    x210Catalog[2]!.sku = 'UCSX-ML-V5Q50G-D'; x210Catalog[2]!.name = 'Cisco VIC 15420 4x25G mLOM X-Series';
    const result = recommendRackComponents([
      req('storageGroup1DriveCount', 2), req('storageGroup1DriveCapacity', 1.6, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'E3.S NVMe'), req('storageGroup1RaidLevel', '1')
    ], x210Catalog, inferRackServerProfile('UCSX-210C-M8-U'));
    expect(result.violations).toContain('No standard RAID/storage controller supports RAID 1 media and drive-count requirements.');
    expect(result.components.find((component) => component.component === 'storage')).toBeUndefined();
  });
  it('uses one X210c front-mezzanine RAID controller for a two-drive RAID 1 plan', () => {
    const x210Catalog = [
      option('x-raidf', 'raid', 100, { controllerType: 'standard', raidCapable: true, supportedRaidLevels: '0,1,5,6,10,50', exactRaidLevels: true, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 6, frontMezzanine: true, categoryName: 'Front MEZZ - Controller', maxQuantity: 1 }),
      option('x-m1l6', 'raid', 200, { controllerType: 'standard', raidCapable: true, supportedRaidLevels: '0,1,5,6,10,50', exactRaidLevels: true, supportedDriveTypes: 'U.3 NVMe', maxDrives: 6, frontMezzanine: true, categoryName: 'Front MEZZ - Controller', maxQuantity: 1 }),
      option('x-u3', 'storage', 500, { capacityGb: 1900, driveType: 'U.3 NVMe', storageLocation: 'front', frontDriveCapacity: 6, maxQuantity: 6 }),
      option('x-mlom', 'nic', 300, { ports: 2, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 })
    ];
    x210Catalog.find((item) => item.id === 'x-mlom')!.sku = 'UCSX-ML-V5Q50G-D';
    x210Catalog.find((item) => item.id === 'x-mlom')!.name = 'Cisco VIC 15420 4x25G mLOM X-Series';
    const result = recommendRackComponents([
      req('localStorageCapacity', 1.9, 'TB'), req('localStorageCapacityType', 'usable'), req('localDriveType', 'U.3 NVMe'), req('raidLevel', '1')
    ], x210Catalog, inferRackServerProfile('UCSX-210C-M8-U'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'x-raidf', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'x-u3', quantity: 2 }]);
  });
  it('enforces the X210c GPU front-mezzanine two-drive limit and shared connector', () => {
    const x210Catalog = [
      option('x-raidf', 'raid', 100, { controllerType: 'standard', raidCapable: true, supportedRaidLevels: '1', exactRaidLevels: true, supportedDriveTypes: 'U.3 NVMe', maxDrives: 6, frontMezzanine: true, categoryName: 'Front MEZZ - Controller', maxQuantity: 1 }),
      option('x-u3', 'storage', 500, { capacityGb: 1900, driveType: 'U.3 NVMe', storageLocation: 'front', frontDriveCapacity: 6, maxQuantity: 6 }),
      option('x-gpufm', 'accessory', 50, { frontMezzanine: true, categoryName: 'Front MEZZ - Controller', maxQuantity: 1 }),
      { ...option('x-l4', 'gpu', 1000, { gpuMemoryGb: 24, tdpWatts: 70, maxQuantity: 1 }), name: 'NVIDIA L4 GPU' },
      option('x-mlom', 'nic', 300, { ports: 2, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 })
    ];
    x210Catalog.find((item) => item.id === 'x-gpufm')!.sku = 'UCSX-X10C-GPUFM-D';
    x210Catalog.find((item) => item.id === 'x-mlom')!.sku = 'UCSX-ML-V5Q50G-D';
    x210Catalog.find((item) => item.id === 'x-mlom')!.name = 'Cisco VIC 15420 4x25G mLOM X-Series';
    const tooManyDrives = recommendRackComponents([
      req('gpuCount', 1), req('gpuDeploymentType', 'front mezzanine'), req('storageGroup1DriveCount', 3), req('storageGroup1DriveCapacity', 1.9, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'U.3 NVMe'), req('storageGroup1RaidLevel', 'NONE')
    ], x210Catalog, inferRackServerProfile('UCSX-210C-M8-U'));
    expect(tooManyDrives.violations).toContain('The X210c GPU front-mezzanine adapter supports at most 2 front U.3 NVMe drives.');
    expect(tooManyDrives.components.find((component) => component.component === 'raid')).toBeUndefined();
    expect(tooManyDrives.components.find((component) => component.component === 'storage')).toBeUndefined();
    expect(tooManyDrives.components.find((component) => component.component === 'gpu')?.selections).toEqual(expect.arrayContaining([{ optionId: 'x-gpufm', quantity: 1 }]));

    const selectedRaid = { ...x210Catalog.find((item) => item.id === 'x-raidf')!, attributes: { ...x210Catalog.find((item) => item.id === 'x-raidf')!.attributes, selected: true, selectedQuantity: 1 } };
    const conflict = recommendRackComponents([req('gpuCount', 1), req('gpuDeploymentType', 'front mezzanine')], [...x210Catalog.filter((item) => item.id !== 'x-raidf'), selectedRaid], inferRackServerProfile('UCSX-210C-M8-U'));
    expect(conflict.violations.some((message) => message.includes('only front-mezzanine connector'))).toBe(true);
    expect(conflict.components.find((component) => component.component === 'gpu')?.selections).not.toEqual(expect.arrayContaining([{ optionId: 'x-gpufm', quantity: 1 }]));
  });
  it('does not mistake the cheaper X210c rear PCIe mezzanine for the mandatory mLOM', () => {
    const xMlom = option('x-mlom', 'nic', 2600, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 });
    xMlom.sku = 'UCSX-ML-V5Q50G-D'; xMlom.name = 'Cisco VIC 15420 4x25G mLOM X-Series';
    const rearPcie = option('rear-pcie', 'nic', 800, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 });
    rearPcie.sku = 'UCSX-V4-PCIME-D'; rearPcie.name = 'UCS PCI Mezz Card for X-Fabric';
    const result = recommendRackComponents([], [rearPcie, xMlom], inferRackServerProfile('UCSX-210C-M8-U'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'mlom')?.selections).toEqual([{ optionId: 'x-mlom', quantity: 1 }]);
  });
  it('uses the optional X210 rear VIC as a separate slot and enforces its two-CPU dependency', () => {
    const nicCatalog = [
      option('current-cpu', 'cpu', 0, { selected: true, selectedQuantity: 1, cores: 64, cpuVendor: 'intel', maxQuantity: 2 }),
      option('x-mlom', 'nic', 2600, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 }),
      option('x-rear-vic', 'nic', 3491, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'Rear MEZZ - MLOM/PCI', maxQuantity: 1 })
    ];
    nicCatalog[1]!.sku = 'UCSX-ML-V5Q50G-D'; nicCatalog[1]!.name = 'Cisco VIC 15420 4x25G mLOM X-Series';
    nicCatalog[2]!.sku = 'UCSX-ME-V5Q50G-D'; nicCatalog[2]!.name = 'Cisco VIC 15422 4x25G Mezz X-Series';
    const requirements = [req('nicCardCount', 2), req('nicPortsPerCard', 4), req('nicSpeedGbpsPerPort', 25)];
    const oneCpu = recommendRackComponents(requirements, nicCatalog, inferRackServerProfile('UCSX-210C-M8-U'));
    expect(oneCpu.components.flatMap((component) => component.selections)).toEqual(expect.arrayContaining([{ optionId: 'x-mlom', quantity: 1 }]));
    expect(oneCpu.components.flatMap((component) => component.selections)).not.toContainEqual({ optionId: 'x-rear-vic', quantity: 1 });
    expect(oneCpu.violations).toContain('The X210c optional rear mezzanine adapter requires two CPUs.');

    nicCatalog[0]!.attributes.selectedQuantity = 2;
    const twoCpu = recommendRackComponents(requirements, nicCatalog, inferRackServerProfile('UCSX-210C-M8-U'));
    expect(twoCpu.violations).toEqual([]);
  });
  it('uses one M.2 drive without RAID only when one boot drive is explicit', () => {
    const result = recommendRackComponents([req('bootCapacity', 240, 'GB'), req('bootDriveCount', 1), req('bootDriveType', 'M.2')], rackCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'bootDrive')?.selections).toEqual([{ optionId: 'm2-240', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'bootDrive')?.reason).toContain('non-mirrored/JBOD');
  });
  it('uses the scanned CPU count when enforcing the 75 W C240 GPU boundary', () => {
    const currentCpu = option('current-cpu', 'cpu', 0, { selected: true, selectedQuantity: 1, cores: 32, cpuVendor: 'intel', maxQuantity: 2 });
    const gpu = option('gpu-75w', 'gpu', 100, { gpuMemoryGb: 24, tdpWatts: 75, categoryName: 'R1A Slot1 x8 FH', maxQuantity: 1 });
    const result = recommendRackComponents([req('gpuCount', 1)], [currentCpu, gpu], inferRackServerProfile('UCSC-C240-M8SX'));
    expect(result.components.find((component) => component.component === 'gpu')).toBeUndefined();
    expect(result.violations).toContain('No set of 1 identical GPU(s) fits the available platform slots and requested GPU requirements.');
  });
  it('does not reuse a PCIe slot occupied by a scanned selection', () => {
    const currentNic = option('current-nic', 'nic', 0, { selected: true, selectedQuantity: 1, ports: 2, categoryName: 'Riser 1A Slot 1', maxQuantity: 1 });
    const gpu = option('gpu-slot1', 'gpu', 100, { gpuMemoryGb: 24, tdpWatts: 70, categoryName: 'Riser 1A Slot 1', maxQuantity: 1 });
    const result = recommendRackComponents([req('gpuCount', 1)], [currentNic, gpu]);
    expect(result.components.find((component) => component.component === 'gpu')).toBeUndefined();
  });
  it('adds C240 LFF Riser 1B when a front-drive storage controller is selected', () => {
    const storageCatalog = [
      option('raid-lff', 'raid', 100, { raidCapable: true, controllerType: 'standard', supportedRaidLevels: '1', maxQuantity: 1 }),
      option('front-lff', 'storage', 100, { capacityGb: 2000, driveType: 'HDD', storageLocation: 'front', frontDriveCapacity: 12, maxQuantity: 12 }),
      { ...option('riser-1b', 'riser', 50, { categoryName: 'PCIe Riser Option', subgroupName: 'PCIe Riser 1 Option', maxQuantity: 1 }), name: 'UCSC-RIS1B-240M8 Riser 1B storage riser' }
    ];
    const result = recommendRackComponents([req('localStorageCapacity', 4, 'TB'), req('localStorageCapacityType', 'raw'), req('localDriveType', 'HDD'), req('raidLevel', '1')], storageCatalog, inferRackServerProfile('UCSC-C240-M8L'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'riser')?.selections).toEqual([{ optionId: 'riser-1b', quantity: 1 }]);
  });
  it('uses requested NIC speed as the hard gate and connector family as a preference', () => {
    const nicCatalog = [option('qsfp-25', 'nic', 100, { ports: 2, supportedSpeedsGbps: '10,25', nicMedia: 'QSFP', categoryName: 'Riser 1A Slot 1', maxQuantity: 1 })];
    const result = recommendRackComponents([req('nicCardCount', 1), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 25), req('nicMedia', 'SFP28')], nicCatalog);
    expect(result.violations).toEqual([]);
    expect(result.components.flatMap((component) => component.selections)).toEqual([{ optionId: 'qsfp-25', quantity: 1 }]);
  });
  it('restricts C240 LFF Fibre Channel HBAs to risers 2 and 3 and includes the riser kit', () => {
    const fcCatalog = [
      option('fc-r1', 'hba', 1, { ports: 2, supportedSpeedsGbps: '32', nicMedia: 'FC', categoryName: 'Riser 1A Slot 1', maxQuantity: 1 }),
      option('fc-r2', 'hba', 100, { ports: 2, supportedSpeedsGbps: '32', nicMedia: 'FC', categoryName: 'Riser 2A Slot 2', maxQuantity: 1 }),
      option('riser-2a', 'riser', 50, { categoryName: 'PCIe Riser Option', subgroupName: 'PCIe Riser 2 Option', maxQuantity: 1 })
    ];
    riserKitName(fcCatalog, 'riser-2a', 'UCS C240 M8 Riser 2A PCIe Gen5');
    const result = recommendRackComponents([req('nicCardCount', 1), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 32), req('nicMedia', 'FC')], fcCatalog, inferRackServerProfile('UCSC-C240-M8L'));
    expect(result.violations).toEqual([]);
    expect(result.components.flatMap((component) => component.selections)).toEqual(expect.arrayContaining([{ optionId: 'fc-r2', quantity: 1 }, { optionId: 'riser-2a', quantity: 1 }]));
    expect(result.components.flatMap((component) => component.selections).map((selection) => selection.optionId)).not.toContain('fc-r1');
  });
  it('selects riser kits only from the numbered PCIe Riser Option subgroups', () => {
    const riserCatalog = [
      option('fc-r1a', 'hba', 100, { ports: 2, supportedSpeedsGbps: '32', nicMedia: 'FC', categoryName: 'Riser 1A x16 HH Slot 1', maxQuantity: 1 }),
      option('fc-r2a', 'hba', 100, { ports: 2, supportedSpeedsGbps: '32', nicMedia: 'FC', categoryName: 'Riser 2A x16 HH Slot 2', maxQuantity: 1 }),
      option('nic-r3a', 'nic', 100, { ports: 2, supportedSpeedsGbps: '10', nicMedia: 'SFP', categoryName: 'Riser 3A x16 HH Slot 3', maxQuantity: 1 }),
      option('nv-opt-r1', 'riser', 0, { categoryName: 'Riser 1A x16 HH Slot 1', subgroupName: 'NVIDIA Opt Out', maxQuantity: 1 }),
      option('nv-opt-r2', 'riser', 0, { categoryName: 'Riser 2A x16 HH Slot 2', subgroupName: 'NVIDIA Opt Out', maxQuantity: 1 }),
      option('nv-opt-r3', 'riser', 0, { categoryName: 'Riser 3A x16 HH Slot 3', subgroupName: 'NVIDIA Opt Out', maxQuantity: 1 }),
      option('kit-r1a', 'riser', 508.05, { categoryName: 'PCIe Riser Option', subgroupName: 'PCIe Riser 1 Option', maxQuantity: 1 }),
      option('kit-r2a', 'riser', 508.05, { categoryName: 'PCIe Riser Option', subgroupName: 'PCIe Riser 2 Option', maxQuantity: 1 }),
      option('kit-r3a', 'riser', 508.05, { categoryName: 'PCIe Riser Option', subgroupName: 'PCIe Riser 3 Option', maxQuantity: 1 })
    ];
    riserKitName(riserCatalog, 'nv-opt-r1', 'NVIDIA GRID SW OPT-OUT');
    riserKitName(riserCatalog, 'nv-opt-r2', 'NVIDIA GRID SW OPT-OUT');
    riserKitName(riserCatalog, 'nv-opt-r3', 'NVIDIA GRID SW OPT-OUT');
    riserKitName(riserCatalog, 'kit-r1a', 'UCS C220 M8 Riser 1A PCIe Gen5 x16 HH');
    riserKitName(riserCatalog, 'kit-r2a', 'UCS C220 M8 Riser 2A PCIe Gen5 x16 HH');
    riserKitName(riserCatalog, 'kit-r3a', 'UCS C220 M8 Riser 3A PCIe Gen5 x16 HH');
    const result = recommendRackComponents([
      req('nicGroup1CardCount', 2), req('nicGroup1PortsPerCard', 2), req('nicGroup1SpeedGbpsPerPort', 32), req('nicGroup1Media', 'FC'),
      req('nicGroup2CardCount', 1), req('nicGroup2PortsPerCard', 2), req('nicGroup2SpeedGbpsPerPort', 10), req('nicGroup2Media', 'SFP')
    ], riserCatalog, inferRackServerProfile('UCSC-C220-M8S'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'riser')?.selections).toEqual([
      { optionId: 'kit-r1a', quantity: 1 }, { optionId: 'kit-r2a', quantity: 1 }, { optionId: 'kit-r3a', quantity: 1 }
    ]);
    const optionIds = result.components.flatMap((component) => component.selections).map((selection) => selection.optionId);
    expect(optionIds).not.toContain('nv-opt-r1');
    expect(optionIds).not.toContain('nv-opt-r2');
    expect(optionIds).not.toContain('nv-opt-r3');
  });
  it('uses the C220 HBA for ten front U.3 drives without applying the direct-attach NVMe limit', () => {
    const c220Catalog = [
      option('c220-hba', 'raid', 100, { controllerType: 'passthrough', raidCapable: false, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 10, maxQuantity: 1 }),
      option('c220-u3', 'storage', 200, { capacityGb: 1900, driveType: 'U.3 NVMe', storageLocation: 'front', frontDriveCapacity: 10, maxQuantity: 10 })
    ];
    const result = recommendRackComponents([
      req('storageGroup1DriveCount', 10), req('storageGroup1DriveCapacity', 1.9, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'U.3 NVMe'), req('storageGroup1RaidLevel', 'NONE')
    ], c220Catalog, inferRackServerProfile('UCSC-C220-M8S'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'c220-hba', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'c220-u3', quantity: 10 }]);
  });
  it('keeps one-CPU C220 U.2 storage direct-attached and suppresses an over-limit drive plan', () => {
    const currentCpu = option('current-cpu', 'cpu', 0, { selected: true, selectedQuantity: 1, quantityFixed: true, fixedQuantity: 1, cores: 64, cpuVendor: 'intel', maxQuantity: 2 });
    const u2Drive = option('c220-u2', 'storage', 200, { capacityGb: 61400, driveType: 'U.2 NVMe', storageLocation: 'front', frontDriveCapacity: 10, maxQuantity: 10 });
    const requirements = (count: number) => [
      req('storageGroup1DriveCount', count), req('storageGroup1DriveCapacity', 61.4, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'U.2 NVMe'), req('storageGroup1RaidLevel', 'NONE')
    ];
    const valid = recommendRackComponents(requirements(4), [currentCpu, u2Drive], inferRackServerProfile('UCSC-C220-M8S'));
    expect(valid.violations).toEqual([]);
    expect(valid.components.find((component) => component.component === 'raid')).toBeUndefined();
    expect(valid.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'c220-u2', quantity: 4 }]);

    const invalid = recommendRackComponents(requirements(5), [currentCpu, u2Drive], inferRackServerProfile('UCSC-C220-M8S'));
    expect(invalid.violations).toContain('UCSC-C220-M8S supports at most 4 direct-attach NVMe drive(s) with 1 CPU(s).');
    expect(invalid.components.find((component) => component.component === 'raid')).toBeUndefined();
    expect(invalid.components.find((component) => component.component === 'storage')).toBeUndefined();
  });
  it('blocks the C220 rear hot-plug M.2 controller when a required VIC occupies mLOM', () => {
    const c220Catalog = [
      option('c220-mlom', 'nic', 100, { ports: 4, supportedSpeedsGbps: '50', categoryName: 'PCIe MLOM', maxQuantity: 1 }),
      option('c220-rear-m2', 'boot', 200, { controllerType: 'M.2', raidCapable: true, supportedRaidLevels: '1,JBOD', m2Protocol: 'SATA', bootLocation: 'MLOM', maxQuantity: 1 }),
      option('c220-m2-drive', 'bootDrive', 300, { capacityGb: 480, driveInterface: 'SATA', maxQuantity: 2 })
    ];
    const result = recommendRackComponents([
      req('nicCardCount', 1), req('nicPortsPerCard', 4), req('nicSpeedGbpsPerPort', 50), req('nicAdapterType', 'VIC'),
      req('bootCapacity', 480, 'GB'), req('bootDriveType', 'M.2 SATA')
    ], c220Catalog, inferRackServerProfile('UCSC-C220-M8S'));
    expect(result.violations).toContain('No compatible SATA M.2 controller is available; the rear hot-plug M.2 controller can use the mLOM slot only when that slot is empty.');
    expect(result.components.find((component) => component.component === 'bootController')).toBeUndefined();
    expect(result.components.find((component) => component.component === 'bootDrive')).toBeUndefined();
  });
  it('uses two C240 M1 HBAs for twenty-four front U.3 drives', () => {
    const c240Catalog = [
      option('c240-hba', 'raid', 100, { controllerType: 'passthrough', raidCapable: false, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 14, maxQuantity: 2 }),
      option('c240-u3', 'storage', 200, { capacityGb: 1900, driveType: 'U.3 NVMe', storageLocation: 'front', frontDriveCapacity: 24, maxQuantity: 24 })
    ];
    const result = recommendRackComponents([
      req('storageGroup1DriveCount', 24), req('storageGroup1DriveCapacity', 1.9, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'U.3 NVMe'), req('storageGroup1RaidLevel', 'NONE')
    ], c240Catalog, inferRackServerProfile('UCSC-C240-M8SX'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'c240-hba', quantity: 2 }]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'c240-u3', quantity: 24 }]);
  });
  it('honors the quantity of an already selected C240 storage controller', () => {
    const selectedHba = option('selected-c240-hba', 'raid', 100, { selected: true, selectedQuantity: 2, controllerType: 'passthrough', raidCapable: false, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 14, maxQuantity: 2 });
    const drive = option('c240-u3-selected', 'storage', 200, { capacityGb: 1900, driveType: 'U.3 NVMe', storageLocation: 'front', frontDriveCapacity: 24, maxQuantity: 24 });
    const result = recommendRackComponents([
      req('storageGroup1DriveCount', 24), req('storageGroup1DriveCapacity', 1.9, 'TB'), req('storageGroup1CapacityType', 'raw'), req('storageGroup1DriveType', 'U.3 NVMe'), req('storageGroup1RaidLevel', 'NONE')
    ], [selectedHba, drive], inferRackServerProfile('UCSC-C240-M8SX'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'c240-u3-selected', quantity: 24 }]);
  });
  it('resizes the C240 controller after capacity-based drive sizing determines the exact population', () => {
    const c240Catalog = [
      option('c240-m1', 'raid', 100, { controllerType: 'standard', raidCapable: true, supportedRaidLevels: '60', supportedDriveTypes: 'SSD', maxDrives: 16, maxQuantity: 2 }),
      option('c240-mp1', 'raid', 150, { controllerType: 'standard', raidCapable: true, supportedRaidLevels: '60', supportedDriveTypes: 'SSD', maxDrives: 28, maxQuantity: 1 }),
      option('c240-1tb-ssd', 'storage', 10, { capacityGb: 1000, driveType: 'SSD', storageLocation: 'front', frontDriveCapacity: 24, maxQuantity: 24 })
    ];
    const result = recommendRackComponents([
      req('localStorageCapacity', 18, 'TB'), req('localStorageCapacityType', 'raw'), req('localDriveType', 'SSD'), req('raidLevel', '60')
    ], c240Catalog, inferRackServerProfile('UCSC-C240-M8SX'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'raid')?.selections).toEqual([{ optionId: 'c240-mp1', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'storage')?.selections).toEqual([{ optionId: 'c240-1tb-ssd', quantity: 18 }]);
  });
  it('limits C240 plug-in VICs by CPU count and to one VIC per riser', () => {
    const baseC240VicCatalog = [
      { ...option('c240-mlom-vic', 'nic', 300, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'PCIe MLOM', maxQuantity: 1 }), sku: 'UCSC-MLOM-C25Q-04', name: 'Cisco VIC mLOM' },
      { ...option('c240-r1-vic-a', 'nic', 100, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'R1A Slot1 x8 FH', maxQuantity: 1 }), sku: 'UCSC-P-V5Q50G', name: 'Cisco VIC Riser 1 slot 1' },
      { ...option('c240-r1-vic-b', 'nic', 110, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'R1A Slot4 x16 FH', maxQuantity: 1 }), sku: 'UCSC-P-V5Q50G', name: 'Cisco VIC Riser 1 slot 4' },
      { ...option('c240-r2-vic', 'nic', 120, { ports: 4, supportedSpeedsGbps: '25', categoryName: 'R2A Slot2 x16 FH', maxQuantity: 1 }), sku: 'UCSC-P-V5Q50G', name: 'Cisco VIC Riser 2' },
      { ...option('c240-riser1', 'riser', 50, { categoryName: 'PCIe Riser Option', subgroupName: 'PCIe Riser 1 Option', maxQuantity: 1 }), name: 'UCSC-RIS1A-240M8 C240 M8 Riser 1A' },
      { ...option('c240-riser2', 'riser', 50, { categoryName: 'PCIe Riser Option', subgroupName: 'PCIe Riser 2 Option', maxQuantity: 1 }), name: 'UCSC-RIS2A-240M8 C240 M8 Riser 2A' }
    ];
    const oneCpuCatalog = [option('selected-one-cpu', 'cpu', 0, { selected: true, selectedQuantity: 1, cores: 64, maxQuantity: 2 }), ...baseC240VicCatalog];
    const oneCpu = recommendRackComponents([req('nicCardCount', 2), req('nicPortsPerCard', 4), req('nicSpeedGbpsPerPort', 25), req('nicAdapterType', 'VIC')], oneCpuCatalog, inferRackServerProfile('UCSC-C240-M8SX'));
    expect(oneCpu.violations).toEqual([]);
    expect(oneCpu.components.flatMap((component) => component.selections).map((selection) => selection.optionId)).toEqual(expect.arrayContaining(['c240-mlom-vic', 'c240-r1-vic-a']));

    const twoCpuCatalog = [option('selected-two-cpu', 'cpu', 0, { selected: true, selectedQuantity: 2, cores: 64, maxQuantity: 2 }), ...baseC240VicCatalog];
    const twoCpu = recommendRackComponents([req('nicCardCount', 3), req('nicPortsPerCard', 4), req('nicSpeedGbpsPerPort', 25), req('nicAdapterType', 'VIC')], twoCpuCatalog, inferRackServerProfile('UCSC-C240-M8SX'));
    expect(twoCpu.violations).toEqual([]);
    const selectedIds = twoCpu.components.flatMap((component) => component.selections).map((selection) => selection.optionId);
    expect(selectedIds).toEqual(expect.arrayContaining(['c240-mlom-vic', 'c240-r2-vic']));
    expect(selectedIds.filter((id) => id.startsWith('c240-r1-vic'))).toHaveLength(1);
  });
  it('uses the C240 Riser 3 M.2 controller when mLOM is occupied and the internal controller is unavailable', () => {
    const bootCatalog = [
      { ...option('c240-ocp', 'nic', 100, { ports: 2, supportedSpeedsGbps: '25', categoryName: 'PCIe MLOM', maxQuantity: 1 }), name: 'OCP 3.0 Ethernet adapter' },
      option('c240-m2-riser3', 'boot', 200, { controllerType: 'M.2', raidCapable: true, supportedRaidLevels: '1,JBOD', m2Protocol: 'SATA', bootLocation: 'Riser 3', maxQuantity: 1 }),
      option('c240-m2-drive', 'bootDrive', 300, { capacityGb: 480, driveInterface: 'SATA', maxQuantity: 2 })
    ];
    const result = recommendRackComponents([
      req('nicCardCount', 1), req('nicPortsPerCard', 2), req('nicSpeedGbpsPerPort', 25), req('nicAdapterType', 'OCP'),
      req('bootCapacity', 480, 'GB'), req('bootDriveType', 'M.2 SATA')
    ], bootCatalog, inferRackServerProfile('UCSC-C240-M8SX'));
    expect(result.violations).toEqual([]);
    expect(result.components.find((component) => component.component === 'bootController')?.selections).toEqual([{ optionId: 'c240-m2-riser3', quantity: 1 }]);
    expect(result.components.find((component) => component.component === 'bootDrive')?.selections).toEqual([{ optionId: 'c240-m2-drive', quantity: 2 }]);
  });
});
