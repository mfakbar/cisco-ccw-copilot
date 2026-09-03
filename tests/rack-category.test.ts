import { describe, expect, it } from 'vitest';
import { frontDriveCapacityForSeries, isMlomCategory, isPhysicalPcieCategory, isRackCategoryBreadcrumb, isRackScanCategory, rackClassificationText, rackOwnerCategory, rackOwnerCategoryForProduct } from '../packages/extension/src/rack-category.js';
import { physicalNicSlotKey } from '../packages/shared/src/index.js';

describe('rack CCW category and slot normalization', () => {
  it.each([
    'PCIe MLOM/OCP Option',
    'R1A Slot1 x8 FH',
    'R1C Slot1 x16 FH',
    'R2A Slot6 x8 FH',
    'R3A Slot8 x8 FH',
    'Riser 1A x16 HH Slot 1',
    'Front Facing Drive Option',
    'Front MEZZ - Controller',
    'Rear MEZZ - MLOM/PCI',
    'Storage Drives',
    'SATA M.2',
    'Riser 1B REAR Facing Drive'
  ])('discovers %s as a supported rack category', (name) => expect(isRackScanCategory(name)).toBe(true));

  it('recognizes C24x physical slots and MLOM/OCP ownership', () => {
    expect(isPhysicalPcieCategory('R3A Slot8 x8 FH')).toBe(true);
    expect(isMlomCategory('PCIe MLOM/OCP Option')).toBe(true);
    expect(isMlomCategory('Rear MEZZ - MLOM/PCI')).toBe(true);
  });

  it('collapses alternate riser layouts onto the same physical slot number', () => {
    expect(physicalNicSlotKey('R1A Slot1 x8 FH')).toBe('PCIe Slot 1');
    expect(physicalNicSlotKey('R1C Slot1 x16 FH')).toBe('PCIe Slot 1');
    expect(physicalNicSlotKey('Riser 1A x16 HH Slot 1')).toBe('PCIe Slot 1');
    expect(physicalNicSlotKey('PCIe MLOM/OCP Option')).toBe('PCIe MLOM/OCP');
  });

  it('keeps M.2 boot, standard RAID, and local-drive category ownership separate', () => {
    expect(rackOwnerCategory('GPU Airduct')).toBe('accessory');
    expect(rackOwnerCategory('M.2 BOOT option')).toBe('boot');
    expect(rackOwnerCategory('M.2 Sata Drives')).toBe('bootDrive');
    expect(rackOwnerCategory('RAID Controller')).toBe('raid');
    expect(rackOwnerCategory('PCIe Riser Option')).toBe('riser');
    expect(rackOwnerCategory('Front Facing Drive Option')).toBe('storage');
    expect(rackOwnerCategory('Storage Drives')).toBe('storage');
    expect(rackOwnerCategory('SATA M.2')).toBe('bootDrive');
    expect(rackOwnerCategory('Riser 3B REAR Facing Drive')).toBe('storage');
  });

  it('separates NVMe M.2 drives from their pass-through controller in the mixed X210 category', () => {
    expect(rackOwnerCategoryForProduct('NVMe Boot', 'UCSX-NVM2-960GB 960GB M.2 NVMe drive')).toBe('bootDrive');
    expect(rackOwnerCategoryForProduct('NVMe Boot', 'UCSX-M2-PT-FPN X-Series M.2 NVMe front panel pass-through')).toBe('boot');
  });

  it('accepts a category only after the CCW breadcrumb matches it', () => {
    expect(isRackCategoryBreadcrumb('UCSC-C240-M8SX > GPU Airduct', 'GPU Airduct')).toBe(true);
    expect(isRackCategoryBreadcrumb('UCSC-C240-M8SX > R1A Slot2 x16 FH', 'GPU Airduct')).toBe(false);
  });

  it('does not let a physical slot label classify its ordinary child options as riser kits', () => {
    expect(rackClassificationText('Riser 1A x16 HH Slot 1', 'NVIDIA Opt Out', 'NV-GRID-OPT-OUT — NVIDIA GRID SW OPT-OUT')).toBe('NVIDIA Opt Out NV-GRID-OPT-OUT — NVIDIA GRID SW OPT-OUT');
    expect(rackClassificationText('PCIe Riser Option', 'PCIe Riser 1 Option', 'UCSC-RIS1A-220M8 UCS C220 M8 Riser 1A')).toContain('PCIe Riser Option PCIe Riser 1 Option');
  });

  it('uses the chassis front-drive limits for C22x and C24x', () => {
    expect(frontDriveCapacityForSeries('C22X')).toBe(10);
    expect(frontDriveCapacityForSeries('C24X')).toBe(24);
  });
});
