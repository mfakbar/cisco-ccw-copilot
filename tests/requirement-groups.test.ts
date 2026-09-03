import { describe, expect, it } from 'vitest';
import { createDriveGroup, createNicGroup, ensureAlternativeSizingRequirements, ensureManualCpuRequirements, ensureManualMemoryRequirements, redundantDriveInterfaceIds, redundantStandaloneCapacityTypeIds, redundantStandaloneStorageIds, relaxOptionalComponentRequirements, removeRequirementGroupAndReindex, requirementGroupNumbers } from '../packages/extension/src/requirement-groups.js';
import type { Requirement } from '../packages/shared/src/index.js';

const requirement = (id: string): Requirement => ({ id, label: id, value: 1, status: 'explicit', required: true, evidence: [] });

describe('manual requirement groups', () => {
  it('creates complete drive and NIC group editors', () => {
    expect(createDriveGroup(1).map((item) => item.id)).toEqual([
      'storageGroup1Capacity', 'storageGroup1CapacityType', 'storageGroup1DriveCount', 'storageGroup1DriveCapacity',
      'storageGroup1DriveType', 'storageGroup1TransferSpeedGbps', 'storageGroup1RaidLevel'
    ]);
    expect(createNicGroup(1).map((item) => item.id)).toEqual([
      'nicGroup1CardCount', 'nicGroup1PortsPerCard', 'nicGroup1TotalPorts', 'nicGroup1SpeedGbpsPerPort', 'nicGroup1Media', 'nicGroup1AdapterType'
    ]);
  });

  it('hides legacy aggregate capacity type fields when grouped capacity types exist', () => {
    const requirements: Requirement[] = [
      { ...requirement('localStorageCapacityType'), label: 'Local storage capacity type', value: 'usable' },
      { ...requirement('aggregate-type-2'), label: 'Local-drive usable or raw capacity type - aggregate inference 2', value: 'usable' },
      { ...requirement('storageGroup1CapacityType'), label: 'Capacity type', value: 'usable' }
    ];
    expect([...redundantStandaloneCapacityTypeIds(requirements)]).toEqual(['localStorageCapacityType', 'aggregate-type-2']);
    expect(redundantStandaloneCapacityTypeIds(requirements.slice(0, 2)).size).toBe(0);
  });

  it('hides legacy standalone storage fields when drive groups exist', () => {
    const requirements = [
      requirement('localStorageCapacity'), requirement('localDriveCount'), requirement('localDriveType'),
      requirement('maxLocalDriveCount'), requirement('storageGroup1Capacity'), requirement('storageGroup1DriveCount')
    ];
    expect([...redundantStandaloneStorageIds(requirements)]).toEqual(['localStorageCapacity', 'localDriveCount', 'localDriveType']);
    expect(redundantStandaloneStorageIds(requirements.slice(0, 4)).size).toBe(0);
  });

  it('adds empty alternative representations without requiring both sides', () => {
    const result = ensureAlternativeSizingRequirements([
      requirement('cpuTotalCores'), requirement('memoryGb'), requirement('storageGroup1Capacity'), requirement('storageGroup1CapacityType')
    ]);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpuSockets', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'cpuCoresPerSocket', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'memoryModuleCount', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'memoryModuleSizeGb', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'storageGroup1DriveCount', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'storageGroup1DriveCapacity', status: 'unresolved', required: false })
    ]));
  });

  it('treats zero and unresolved sibling parameters as optional omissions', () => {
    const result = relaxOptionalComponentRequirements([
      { ...requirement('storageGroup1Capacity'), value: 7, unit: 'TB' },
      { ...requirement('storageGroup1DriveCapacity'), value: 0, unit: 'GB' },
      { ...requirement('storageGroup1TransferSpeedGbps'), value: 0, unit: 'Gbps' },
      { ...requirement('nicGroup1CardCount'), value: undefined, status: 'unresolved' }
    ]);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup1Capacity', value: 7 }),
      expect.objectContaining({ id: 'storageGroup1DriveCapacity', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'storageGroup1TransferSpeedGbps', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'nicGroup1CardCount', value: undefined, status: 'unresolved', required: false })
    ]));
    expect(result.find((item) => item.id === 'storageGroup1DriveCapacity')).not.toHaveProperty('value');
    expect(result.find((item) => item.id === 'storageGroup1TransferSpeedGbps')).not.toHaveProperty('value');
  });

  it('turns a discrete legacy drive population into one group with empty aggregate capacity', () => {
    const result = ensureAlternativeSizingRequirements([
      { ...requirement('localStorageCapacity'), value: 3840, unit: 'GB', status: 'derived' },
      { ...requirement('localStorageCapacityType'), value: 'raw' },
      { ...requirement('localDriveCount'), value: 4 },
      { ...requirement('localDriveCapacity'), value: 960, unit: 'GB' },
      { ...requirement('localDriveType'), value: 'SSD' }
    ]);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup1Capacity', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'storageGroup1DriveCount', value: 4 }),
      expect.objectContaining({ id: 'storageGroup1DriveCapacity', value: 960, unit: 'GB' })
    ]));
    expect(result.some((item) => item.id.startsWith('localStorage') || item.id.startsWith('localDrive'))).toBe(false);
  });

  it('turns aggregate-only storage into one group with empty drive count and per-drive capacity', () => {
    const result = ensureAlternativeSizingRequirements([
      { ...requirement('localStorageCapacity'), value: 5, unit: 'TB' },
      { ...requirement('localStorageCapacityType'), value: 'usable' },
      { ...requirement('raidLevel'), value: '5' }
    ]);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'storageGroup1Capacity', value: 5, unit: 'TB' }),
      expect.objectContaining({ id: 'storageGroup1DriveCount', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'storageGroup1DriveCapacity', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'storageGroup1RaidLevel', value: '5' })
    ]));
  });

  it('keeps derived memory capacity for DIMMs and adds empty DIMM fields for capacity-only memory', () => {
    const dimms = ensureAlternativeSizingRequirements([
      { ...requirement('memoryModuleCount'), value: 8 },
      { ...requirement('memoryModuleSizeGb'), value: 64, unit: 'GB' },
      { ...requirement('memoryGb'), value: 512, unit: 'GB', status: 'derived' }
    ]);
    expect(dimms.find((item) => item.id === 'memoryGb')).toMatchObject({ value: 512, status: 'derived' });

    const capacityOnly = ensureAlternativeSizingRequirements([{ ...requirement('memoryGb'), value: 1024, unit: 'GB' }]);
    expect(capacityOnly).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'memoryModuleCount', status: 'unresolved', required: false }),
      expect.objectContaining({ id: 'memoryModuleSizeGb', status: 'unresolved', required: false })
    ]));
  });

  it('hides only drive interfaces already encoded by drive type', () => {
    const requirements = [
      { ...requirement('storageGroup1DriveType'), value: 'U.3 NVMe' }, { ...requirement('storageGroup1DriveInterface'), value: 'NVMe' },
      { ...requirement('storageGroup2DriveType'), value: 'SSD' }, { ...requirement('storageGroup2DriveInterface'), value: 'SAS' },
      { ...requirement('storageGroup3DriveType'), value: 'SAS SSD' }, { ...requirement('storageGroup3DriveInterface'), value: 'SATA' }
    ];
    expect([...redundantDriveInterfaceIds(requirements)]).toEqual(['storageGroup1DriveInterface']);
  });

  it('deletes a group and reindexes all later groups from one', () => {
    const requirements = [requirement('storageGroup1Capacity'), requirement('storageGroup2Capacity'), requirement('storageGroup2DriveType'), requirement('storageGroup4Capacity'), requirement('cpuSockets')];
    const result = removeRequirementGroupAndReindex(requirements, 'storage', 2);
    expect(result.map((item) => item.id)).toEqual(['storageGroup1Capacity', 'storageGroup2Capacity', 'cpuSockets']);
    expect(requirementGroupNumbers(result, 'storage')).toEqual([1, 2]);
  });

  it('adds only missing CPU and memory parameters', () => {
    const result = ensureManualMemoryRequirements(ensureManualCpuRequirements([requirement('cpuSockets'), requirement('memoryGb')]));
    expect(result.filter((item) => item.id === 'cpuSockets')).toHaveLength(1);
    expect(result.filter((item) => item.id === 'memoryGb')).toHaveLength(1);
    expect(result.map((item) => item.id)).toEqual(expect.arrayContaining(['cpuCoresPerSocket', 'cpuClockGhz', 'cpuVendor', 'memoryModuleCount', 'memoryModuleSizeGb']));
  });

  it('canonicalizes legacy single NIC fields and removes legacy duplicates', () => {
    const converted = ensureAlternativeSizingRequirements([
      { ...requirement('nicTotalPorts'), value: 4 },
      { ...requirement('nicSpeedGbpsPerPort'), value: 10 },
      { ...requirement('nicMedia'), value: 'SFP' }
    ]);
    expect(converted.map((item) => item.id)).toEqual(['nicGroup1TotalPorts', 'nicGroup1SpeedGbpsPerPort', 'nicGroup1Media']);

    const deduplicated = ensureAlternativeSizingRequirements([
      requirement('nicGroup1TotalPorts'), requirement('nicTotalPorts'), requirement('nicMedia')
    ]);
    expect(deduplicated.map((item) => item.id)).toEqual(['nicGroup1TotalPorts']);
  });
});
