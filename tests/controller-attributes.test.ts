import { describe, expect, it } from 'vitest';
import { controllerAttributes, STANDARD_RAID_LEVELS } from '../packages/extension/src/controller-attributes.js';

describe('storage controller classification', () => {
  it('classifies every standard RAID controller as multi-RAID and HDD/SSD capable', () => {
    expect(controllerAttributes('Generic RAID Controller w/4GB FBWC 12 Drives', 'raid')).toMatchObject({
      controllerType: 'standard', raidCapable: true, triMode: false,
      supportedRaidLevels: STANDARD_RAID_LEVELS, supportedDriveTypes: 'HDD,SSD', maxDrives: 12
    });
  });

  it('adds U.3 NVMe only for Tri-Mode standard RAID controllers', () => {
    expect(controllerAttributes('24G Tri-Mode RAID Controller 16Drv', 'raid')).toMatchObject({
      controllerType: 'standard', raidCapable: true, triMode: true,
      supportedRaidLevels: STANDARD_RAID_LEVELS, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 16
    });
  });

  it('keeps M.2 RAID controllers on the M.2 boot and RAID 1 path', () => {
    expect(controllerAttributes('M.2 SATA RAID Controller', 'boot')).toMatchObject({
      controllerType: 'M.2', raidCapable: true, supportedRaidLevels: '1', supportedDriveTypes: 'M.2', m2Protocol: 'SATA'
    });
    expect(controllerAttributes('M.2 NVMe non-RAID pass-through controller', 'boot')).toMatchObject({
      controllerType: 'M.2-passthrough', raidCapable: false, supportedRaidLevels: '', supportedDriveTypes: 'M.2', m2Protocol: 'NVMe'
    });
  });

  it('keeps an HBA on the separate pass-through path even when its description says Tri-Mode', () => {
    expect(controllerAttributes('24G Tri-Mode M1 HBA for 16 Drives', 'raid')).toMatchObject({
      controllerType: 'passthrough', raidCapable: false, triMode: false, supportedRaidLevels: '', maxDrives: 16
    });
  });

  it('uses the X-Series front-mezzanine controller RAID set exactly', () => {
    expect(controllerAttributes('UCSX-RAID-M1L6 Front Mezzanine RAID Controller', 'raid')).toMatchObject({
      controllerType: 'standard', supportedRaidLevels: '0,1,5,6,10,50', exactRaidLevels: true
    });
  });

  it('models each X210c front-mezzanine controller from the live CCW label', () => {
    expect(controllerAttributes('UCSX-X10C-PT4F-D UCS X10c Compute Pass Through Controller (Front)', 'raid')).toMatchObject({
      controllerType: 'passthrough', supportedDriveTypes: 'U.3 NVMe', maxDrives: 6, frontMezzanineType: 'u3-pass-through'
    });
    expect(controllerAttributes('UCSX-X10C-RAIDF-D UCS X10c Compute RAID Controller with LSI 3900 (Front)', 'raid')).toMatchObject({
      controllerType: 'standard', supportedRaidLevels: '0,1,5,6,10,50', supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 6, exactRaidLevels: true
    });
    expect(controllerAttributes('UCSX-RAID-M1L6 24G Tri-Mode M1 RAID Controller w/4GB FBWC 6Drv', 'raid')).toMatchObject({
      controllerType: 'standard', supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 6, frontMezzanineType: 'raid'
    });
    expect(controllerAttributes('UCSX-X10C-PTE3 UCS X10c Compute Pass Through Controller for E3.S (Front)', 'raid')).toMatchObject({
      controllerType: 'passthrough', supportedDriveTypes: 'E3.S NVMe', maxDrives: 9, frontMezzanineType: 'e3s-pass-through'
    });
  });

  it('uses the C220 M8 controller limits and rear M.2 slot placement from the spec', () => {
    expect(controllerAttributes('UCSC-HBA-M1L16 24G Tri-Mode M1 HBA for 16 Drives', 'raid', 'C220_M8')).toMatchObject({
      controllerType: 'passthrough', raidCapable: false, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 10
    });
    expect(controllerAttributes('UCSC-RAID-M1L16 24G Tri-Mode M1 RAID Controller w/4GB FBWC 16Drv', 'raid', 'C220_M8')).toMatchObject({
      controllerType: 'standard', raidCapable: true, supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 10
    });
    expect(controllerAttributes('UCSC-M2RM-M8 C220 M8 Boot RAID Controller for hot-swap M.2s in mLOM slot', 'boot')).toMatchObject({
      controllerType: 'M.2', supportedRaidLevels: '1,JBOD', maxDrives: 2, m2Protocol: 'SATA', bootLocation: 'MLOM'
    });
    expect(controllerAttributes('UCS-M2-HWRAID2 Cisco Boot optimized M.2 RAID controller for SATA drives', 'boot')).toMatchObject({
      controllerType: 'M.2', supportedRaidLevels: '1,JBOD', maxDrives: 2, m2Protocol: 'SATA', bootLocation: 'internal'
    });
  });

  it('uses the C240 M8 SFF controller quantities, drive limits, and all three M.2 placements from the spec', () => {
    expect(controllerAttributes('UCSC-HBA-M1L16 24G Tri-Mode M1 HBA for 16 Drives', 'raid', 'C240_M8_SFF')).toMatchObject({
      controllerType: 'passthrough', supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 14, maxQuantity: 2
    });
    expect(controllerAttributes('UCSC-RAID-M1L16 24G Tri-Mode M1 RAID Controller w/4GB FBWC 16Drv', 'raid', 'C240_M8_SFF')).toMatchObject({
      controllerType: 'standard', supportedDriveTypes: 'HDD,SSD,U.3 NVMe', maxDrives: 16, maxQuantity: 2
    });
    expect(controllerAttributes('UCSC-RAID-MP1L32 24G Tri-Mode RAID Controller for 28 Drives', 'raid', 'C240_M8_SFF')).toMatchObject({
      controllerType: 'standard', maxDrives: 28, maxQuantity: 1
    });
    expect(controllerAttributes('UCSC-M2RR-240M8 C240 M8 rear M.2 RAID controller by Riser 3', 'boot', 'C240_M8_SFF')).toMatchObject({
      controllerType: 'M.2', supportedRaidLevels: '1,JBOD', maxDrives: 2, m2Protocol: 'SATA', bootLocation: 'Riser 3'
    });
  });
});
