import type { CalculationTrace, CatalogOption, Requirement, Selection } from './types.js';

const selected = (catalog: CatalogOption[], selections: Selection[], category: CatalogOption['category']) =>
  selections.flatMap((s) => {
    const option = catalog.find((item) => item.id === s.optionId);
    return option?.category === category ? [{ option, quantity: s.quantity }] : [];
  });

const numberAttr = (option: CatalogOption, key: string): number => {
  const value = option.attributes[key];
  return typeof value === 'number' ? value : 0;
};

export function raidUsableCapacity(driveCapacityTb: number, driveCount: number, raidLevel: string, hotSpares = 0): number {
  const usableDrives = Math.max(0, driveCount - hotSpares);
  const parity = raidLevel === '1' || raidLevel === '10' ? Math.ceil(usableDrives / 2)
    : raidLevel === '5' ? 1 : raidLevel === '6' ? 2 : raidLevel === '50' ? 2 : raidLevel === '60' ? 4 : 0;
  return Math.max(0, usableDrives - parity) * driveCapacityTb;
}

export function calculateMetrics(catalog: CatalogOption[], selections: Selection[]) {
  const cpus = selected(catalog, selections, 'cpu');
  const dimms = selected(catalog, selections, 'memory');
  const drives = selected(catalog, selections, 'storage');
  const nics = selected(catalog, selections, 'nic');
  const gpus = selected(catalog, selections, 'gpu');
  const rawStorageTb = drives.reduce((sum, x) => sum + numberAttr(x.option, 'capacityTb') * x.quantity, 0);
  const storageGroups = drives.map((x) => raidUsableCapacity(numberAttr(x.option, 'capacityTb'), x.quantity, String(x.option.attributes.raidLevel ?? '0'), numberAttr(x.option, 'hotSpares')));
  const chosenOptions = selections.flatMap((selection) => {
    const option = catalog.find((item) => item.id === selection.optionId);
    return option ? [option] : [];
  });
  const leadTimes = chosenOptions.map((option) => option.attributes.leadTimeDays).filter((value): value is number => typeof value === 'number' && value >= 0);
  return {
    cpuCores: cpus.reduce((sum, x) => sum + numberAttr(x.option, 'cores') * x.quantity, 0),
    memoryGb: dimms.reduce((sum, x) => sum + numberAttr(x.option, 'capacityGb') * x.quantity, 0),
    rawStorageTb,
    usableStorageTb: storageGroups.length ? storageGroups.reduce((sum, value) => sum + value, 0) : rawStorageTb,
    nicPorts: nics.reduce((sum, x) => sum + numberAttr(x.option, 'ports') * x.quantity, 0),
    nicThroughputGbps: nics.reduce((sum, x) => sum + numberAttr(x.option, 'ports') * numberAttr(x.option, 'speedGbps') * x.quantity, 0),
    gpuCount: gpus.reduce((sum, x) => sum + x.quantity, 0),
    pcieSlots: [...nics, ...gpus].reduce((sum, x) => sum + numberAttr(x.option, 'pcieSlots') * x.quantity, 0),
    maxLeadTimeDays: leadTimes.length ? Math.max(...leadTimes) : 0,
    unknownLeadTimeCount: chosenOptions.length - leadTimes.length
  };
}

const keyMap: Record<string, keyof ReturnType<typeof calculateMetrics>> = {
  cpuCores: 'cpuCores', memoryGb: 'memoryGb', rawStorageTb: 'rawStorageTb',
  usableStorageTb: 'usableStorageTb', nicPorts: 'nicPorts', nicTotalPorts: 'nicPorts', nicThroughputGbps: 'nicThroughputGbps', gpuCount: 'gpuCount',
  maxLeadTimeDays: 'maxLeadTimeDays'
};

export function capacityInGb(value: number, unit: string | undefined): number {
  return unit?.toUpperCase() === 'TB' ? value * 1000 : value;
}

export function evaluateRequirements(requirements: Requirement[], catalog: CatalogOption[], selections: Selection[]): CalculationTrace[] {
  const metrics = calculateMetrics(catalog, selections);
  return requirements.flatMap((req) => {
    const metric = keyMap[req.id];
    if (!metric || typeof req.value !== 'number') return [];
    const actual = metrics[metric];
    const comparison = req.comparison ?? (req.id === 'maxLeadTimeDays' ? 'atMost' : 'atLeast');
    const passed = req.id === 'maxLeadTimeDays' && metrics.unknownLeadTimeCount > 0 ? false : comparison === 'atMost' ? actual <= req.value : comparison === 'exact' ? actual === req.value : actual >= req.value;
    const operator = comparison === 'atMost' ? '<=' : comparison === 'exact' ? '=' : '>=';
    return [{ requirementId: req.id, expression: `${String(metric)} ${operator} ${req.value}`, actual, required: req.value, passed }];
  });
}
