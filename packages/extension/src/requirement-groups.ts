import type { Requirement } from '@ccw/shared';

export type RequirementGroupKind = 'storage' | 'nic';

const manualRequirement = (id: string, label: string, options: { unit?: string; required?: boolean; comparison?: Requirement['comparison'] } = {}): Requirement => ({
  id,
  label,
  ...(options.unit ? { unit: options.unit } : {}),
  comparison: options.comparison ?? 'exact',
  status: 'unresolved',
  required: options.required ?? true,
  evidence: [],
  note: 'User-entered requirement.'
});

const optionalComponentParameter = (id: string): boolean => /^(?:cpu(?:Cores|TotalCores|Sockets|CoresPerSocket|ClockGhz|Vendor)|memory(?:Gb|ModuleCount|ModuleSizeGb)|localDrive(?:Count|Capacity|Type|Interface|TransferSpeedGbps)|raidLevel|boot(?:Capacity|CapacityGb|DriveCount|DriveType)|maxLocalDriveCount|nic(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort|Media|AdapterType)|nicGroup\d+(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort|Media|AdapterType)|gpu(?:Count|Model|MemoryGb|DeploymentType)|storageGroup\d+(?:Capacity|DriveCount|DriveCapacity|DriveType|DriveInterface|TransferSpeedGbps|RaidLevel))$/.test(id);
const positiveComponentValue = (requirement: Requirement): boolean => !/^(?:cpu(?:Cores|TotalCores|Sockets|CoresPerSocket|ClockGhz)|memory(?:Gb|ModuleCount|ModuleSizeGb)|localStorageCapacity|localDrive(?:Count|Capacity|TransferSpeedGbps)|boot(?:Capacity|CapacityGb|DriveCount)|maxLocalDriveCount|nic(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort)|nicGroup\d+(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort)|gpu(?:Count|MemoryGb)|storageGroup\d+(?:Capacity|DriveCount|DriveCapacity|TransferSpeedGbps))$/.test(requirement.id)
  || typeof requirement.value !== 'number' || requirement.value > 0;

export function relaxOptionalComponentRequirements(requirements: Requirement[]): Requirement[] {
  return requirements.map((requirement) => {
    if (!optionalComponentParameter(requirement.id)) return requirement;
    const next = { ...requirement };
    if (!positiveComponentValue(next)) { delete next.value; next.status = 'unresolved'; }
    if (next.status === 'unresolved' || next.value === undefined) next.required = false;
    return next;
  });
}

export function requirementGroupNumbers(requirements: Requirement[], kind: RequirementGroupKind): number[] {
  const prefix = kind === 'storage' ? 'storageGroup' : 'nicGroup';
  return [...new Set(requirements.flatMap((requirement) => {
    const match = requirement.id.match(new RegExp(`^${prefix}(\\d+)`));
    return match ? [Number(match[1])] : [];
  }))].sort((a, b) => a - b);
}

export function removeRequirementGroupAndReindex(requirements: Requirement[], kind: RequirementGroupKind, deletedNumber: number): Requirement[] {
  const prefix = kind === 'storage' ? 'storageGroup' : 'nicGroup';
  const pattern = new RegExp(`^${prefix}(\\d+)(.*)$`);
  const remainingNumbers = requirementGroupNumbers(requirements, kind).filter((number) => number !== deletedNumber);
  const nextNumber = new Map(remainingNumbers.map((number, index) => [number, index + 1]));
  return requirements.flatMap((requirement) => {
    const match = requirement.id.match(pattern);
    if (!match) return [requirement];
    const oldNumber = Number(match[1]);
    if (oldNumber === deletedNumber) return [];
    return [{ ...requirement, id: `${prefix}${nextNumber.get(oldNumber)}${match[2]}` }];
  });
}

export function createDriveGroup(number: number): Requirement[] {
  const prefix = `storageGroup${number}`;
  return [
    manualRequirement(`${prefix}Capacity`, 'Capacity', { unit: 'TB', required: false, comparison: 'atLeast' }),
    manualRequirement(`${prefix}CapacityType`, 'Capacity type', { required: false }),
    manualRequirement(`${prefix}DriveCount`, 'Drive count', { required: false }),
    manualRequirement(`${prefix}DriveCapacity`, 'Capacity per drive', { unit: 'GB', required: false }),
    manualRequirement(`${prefix}DriveType`, 'Drive type', { required: false }),
    manualRequirement(`${prefix}TransferSpeedGbps`, 'Transfer speed', { unit: 'Gbps', required: false, comparison: 'atLeast' }),
    manualRequirement(`${prefix}RaidLevel`, 'RAID level or no RAID', { required: false })
  ];
}

export function redundantDriveInterfaceIds(requirements: Requirement[]): Set<string> {
  const values = new Map(requirements.map((requirement) => [requirement.id, requirement.value]));
  return new Set(requirements.flatMap((requirement) => {
    const group = requirement.id.match(/^(storageGroup\d+)DriveInterface$/)?.[1];
    const typeId = group ? `${group}DriveType` : requirement.id === 'localDriveInterface' ? 'localDriveType' : undefined;
    if (!typeId || typeof requirement.value !== 'string' || typeof values.get(typeId) !== 'string') return [];
    const type = String(values.get(typeId)).toUpperCase();
    const implied = /\bNVME\b/.test(type) ? 'NVME' : /\bSAS\b/.test(type) ? 'SAS' : /\bSATA\b/.test(type) ? 'SATA' : undefined;
    return implied === requirement.value.toUpperCase() ? [requirement.id] : [];
  }));
}

export function redundantStandaloneCapacityTypeIds(requirements: Requirement[]): Set<string> {
  const hasGroupedCapacityType = requirements.some((requirement) => /^storageGroup\d+CapacityType$/.test(requirement.id));
  if (!hasGroupedCapacityType) return new Set();
  return new Set(requirements.flatMap((requirement) => {
    const legacyId = requirement.id === 'localStorageCapacityType';
    const legacyInferenceLabel = /local[- ]drive.*(?:usable|raw).*capacity type.*aggregate inference/i.test(requirement.label);
    return legacyId || legacyInferenceLabel ? [requirement.id] : [];
  }));
}

export function redundantStandaloneStorageIds(requirements: Requirement[]): Set<string> {
  if (!requirements.some((requirement) => /^storageGroup\d+/.test(requirement.id))) return new Set();
  const legacyIds = new Set([
    'localStorageCapacity', 'localStorageCapacityType', 'raidLevel', 'localDriveCount',
    'localDriveCapacity', 'localDriveType', 'localDriveInterface', 'localDriveTransferSpeedGbps'
  ]);
  return new Set(requirements.flatMap((requirement) => legacyIds.has(requirement.id) ? [requirement.id] : []));
}

export function createNicGroup(number: number): Requirement[] {
  const prefix = `nicGroup${number}`;
  return [
    manualRequirement(`${prefix}CardCount`, 'Card count', { required: false }),
    manualRequirement(`${prefix}PortsPerCard`, 'Ports per card', { required: false, comparison: 'atLeast' }),
    manualRequirement(`${prefix}TotalPorts`, 'Total ports', { required: false, comparison: 'atLeast' }),
    manualRequirement(`${prefix}SpeedGbpsPerPort`, 'Speed per port', { unit: 'Gbps', required: false, comparison: 'atLeast' }),
    manualRequirement(`${prefix}Media`, 'Port type', { required: false }),
    manualRequirement(`${prefix}AdapterType`, 'Adapter type', { required: false })
  ];
}

function ensureRequirements(requirements: Requirement[], templates: Requirement[]): Requirement[] {
  const existing = new Set(requirements.map((requirement) => requirement.id));
  return [...requirements, ...templates.filter((requirement) => !existing.has(requirement.id))];
}

export function ensureManualCpuRequirements(requirements: Requirement[]): Requirement[] {
  return ensureRequirements(requirements, [
    manualRequirement('cpuTotalCores', 'Total CPU cores', { required: false, comparison: 'atLeast' }),
    manualRequirement('cpuSockets', 'CPU sockets', { required: false }),
    manualRequirement('cpuCoresPerSocket', 'Physical cores per CPU/socket', { required: false, comparison: 'atLeast' }),
    manualRequirement('cpuClockGhz', 'Minimum CPU base clock', { unit: 'GHz', required: false, comparison: 'atLeast' }),
    manualRequirement('cpuVendor', 'CPU vendor', { required: false })
  ]);
}

export function ensureManualMemoryRequirements(requirements: Requirement[]): Requirement[] {
  return ensureRequirements(requirements, [
    manualRequirement('memoryGb', 'Capacity', { unit: 'GB', required: false, comparison: 'atLeast' }),
    manualRequirement('memoryModuleCount', 'DIMM count', { required: false }),
    manualRequirement('memoryModuleSizeGb', 'DIMM size', { unit: 'GB', required: false })
  ]);
}

export function ensureAlternativeSizingRequirements(requirements: Requirement[]): Requirement[] {
  let result = relaxOptionalComponentRequirements(requirements);
  if (requirements.some((item) => /^cpu(?:Sockets|Cores|TotalCores|CoresPerSocket|ClockGhz|Vendor)$/.test(item.id))) result = ensureManualCpuRequirements(result);
  if (requirements.some((item) => /^memory(?:Gb|ModuleCount|ModuleSizeGb)$/.test(item.id))) result = ensureManualMemoryRequirements(result);
  const legacyStorageIds = new Map<string, { suffix: string; label: string }>([
    ['localStorageCapacity', { suffix: 'Capacity', label: 'Capacity' }],
    ['localStorageCapacityType', { suffix: 'CapacityType', label: 'Capacity type' }],
    ['localDriveCount', { suffix: 'DriveCount', label: 'Drive count' }],
    ['localDriveCapacity', { suffix: 'DriveCapacity', label: 'Capacity per drive' }],
    ['localDriveType', { suffix: 'DriveType', label: 'Drive type' }],
    ['localDriveInterface', { suffix: 'DriveInterface', label: 'Drive interface' }],
    ['localDriveTransferSpeedGbps', { suffix: 'TransferSpeedGbps', label: 'Transfer speed' }],
    ['raidLevel', { suffix: 'RaidLevel', label: 'RAID level or no RAID' }]
  ]);
  const hasGroupedStorage = requirementGroupNumbers(result, 'storage').length > 0;
  const hasLegacyStorage = result.some((item) => legacyStorageIds.has(item.id));
  if (!hasGroupedStorage && hasLegacyStorage) {
    const discretePopulation = result.some((item) => item.id === 'localDriveCount' && typeof item.value === 'number')
      && result.some((item) => item.id === 'localDriveCapacity' && typeof item.value === 'number');
    result = result.flatMap((item) => {
      const mapped = legacyStorageIds.get(item.id);
      if (!mapped) return [item];
      if (item.id === 'localStorageCapacity' && discretePopulation && item.status === 'derived') return [];
      return [{ ...item, id: `storageGroup1${mapped.suffix}`, label: mapped.label }];
    });
  } else if (hasGroupedStorage && hasLegacyStorage) {
    result = result.filter((item) => !legacyStorageIds.has(item.id));
  }
  for (const number of requirementGroupNumbers(result, 'storage')) {
    const alternatives = createDriveGroup(number).filter((item) => /(?:Capacity|DriveCount|DriveCapacity)$/.test(item.id));
    result = ensureRequirements(result, alternatives);
  }
  const legacyNicIds = new Map<string, { suffix: string; label: string }>([
    ['nicCardCount', { suffix: 'CardCount', label: 'Card count' }],
    ['nicPortsPerCard', { suffix: 'PortsPerCard', label: 'Ports per card' }],
    ['nicTotalPorts', { suffix: 'TotalPorts', label: 'Total ports' }],
    ['nicSpeedGbpsPerPort', { suffix: 'SpeedGbpsPerPort', label: 'Speed per port' }],
    ['nicMedia', { suffix: 'Media', label: 'Port type' }],
    ['nicAdapterType', { suffix: 'AdapterType', label: 'Adapter type' }]
  ]);
  const hasGroupedNic = requirementGroupNumbers(result, 'nic').length > 0;
  const hasLegacyNic = result.some((item) => legacyNicIds.has(item.id));
  if (!hasGroupedNic && hasLegacyNic) {
    result = result.map((item) => {
      const mapped = legacyNicIds.get(item.id);
      return mapped ? { ...item, id: `nicGroup1${mapped.suffix}`, label: mapped.label } : item;
    });
  } else if (hasGroupedNic && hasLegacyNic) {
    result = result.filter((item) => !legacyNicIds.has(item.id));
  }
  return relaxOptionalComponentRequirements(result);
}
