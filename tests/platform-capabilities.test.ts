import { describe, expect, it } from 'vitest';
import { canonicalNicMedia, compatiblePlatformRiserVariants, frontDriveLimit, inferRackServerProfile, platformCapabilities, raidDriveCountError, supportsRequestedNicSpeed } from '../packages/shared/src/index.js';

describe('M8 platform capabilities', () => {
  it('maps each supported parent SKU to its model-specific topology', () => {
    expect(platformCapabilities(inferRackServerProfile('UCSC-C225-M8S'))).toMatchObject({ kind: 'C225_M8', maxSockets: 1, dimmsPerCpu: 12 });
    expect(platformCapabilities(inferRackServerProfile('UCSC-C240-M8L'))).toMatchObject({ kind: 'C240_M8_LFF', frontDriveCapacity: 12, fcHbaRisers: [2, 3] });
    expect(platformCapabilities(inferRackServerProfile('UCSX-215C-M8'))).toMatchObject({ kind: 'X215C_M8', frontDriveCapacity: 8, mandatoryMlom: true, gpuMemoryMultiplierForPcieNode: 3 });
  });

  it.each([
    ['0', 1], ['1', 3], ['5', 2], ['6', 3], ['10', 3], ['50', 5], ['60', 7]
  ])('rejects invalid RAID %s drive count %d', (level, count) => expect(raidDriveCountError(level, count)).toBeTruthy());

  it('allows exactly two drives for RAID 1', () => {
    expect(raidDriveCountError('1', 2)).toBeUndefined();
    expect(raidDriveCountError('1', 4)).toBe('RAID 1 requires exactly 2 drives');
  });

  it('applies exact front-only direct-NVMe and form-factor limits', () => {
    expect(platformCapabilities(inferRackServerProfile('UCSC-C220-M8S')).directAttachNvmeMaxByCpuCount).toEqual({ 1: 4, 2: 8 });
    expect(platformCapabilities(inferRackServerProfile('UCSC-C225-M8S')).directAttachNvmeMaxByCpuCount[1]).toBe(4);
    expect(platformCapabilities(inferRackServerProfile('UCSC-C225-M8N')).directAttachNvmeMaxByCpuCount[1]).toBe(10);
    expect(platformCapabilities(inferRackServerProfile('UCSC-C240-M8SX')).directAttachNvmeMaxByCpuCount).toEqual({ 1: 4, 2: 8 });
    expect(platformCapabilities(inferRackServerProfile('UCSC-C240-M8L')).directAttachNvmeMaxByCpuCount).toEqual({ 1: 0, 2: 0 });
    const x210 = platformCapabilities(inferRackServerProfile('UCSX-210C-M8'));
    expect(frontDriveLimit(x210, 'SSD')).toBe(6);
    expect(frontDriveLimit(x210, 'E3.S NVMe')).toBe(9);
  });

  it('rejects documented incompatible riser mixes', () => {
    expect(compatiblePlatformRiserVariants('C220_M8', ['R1A', 'R2B'])).toBe(false);
    expect(compatiblePlatformRiserVariants('C225_M8', ['R1A', 'R2C'])).toBe(false);
    expect(compatiblePlatformRiserVariants('C245_M8', ['R1A', 'R2C'])).toBe(false);
    expect(compatiblePlatformRiserVariants('C245_M8', ['R1B', 'R3B'])).toBe(true);
  });

  it('normalizes connector generations while matching requested speed exactly', () => {
    for (const value of ['SFP+', 'SFP28', 'SFP56']) expect(canonicalNicMedia(value)).toBe('SFP');
    for (const value of ['QSFP+', 'QSFP28', 'QSFP56', 'QSFP112']) expect(canonicalNicMedia(value)).toBe('QSFP');
    expect(supportsRequestedNicSpeed('10,25,50', 25)).toBe(true);
    expect(supportsRequestedNicSpeed('100,200', 25)).toBe(false);
  });
});
