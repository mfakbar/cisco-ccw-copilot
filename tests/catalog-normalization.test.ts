import { describe, expect, it } from 'vitest';
import { catalogAttributes, catalogCategory } from '../packages/extension/src/catalog-normalization.js';

describe('CCW catalog normalization', () => {
  it('keeps NVIDIA software rows out of GPU hardware recommendations', () => {
    expect(catalogCategory('Standard License NV-AIE-S-1Y NVIDIA AI Enterprise Essentials Subscription per GPU')).toBe('license');
    expect(catalogCategory('PCIe - GPU UCSC-GPU-L4 NVIDIA L4:70W, 24GB, 1-slot HHHL GPU')).toBe('gpu');
  });

  it('totals multi-chip GPU memory on a physical adapter', () => {
    expect(catalogAttributes('UCSC-GPU-A16-D NVIDIA A16 PCIE 250W 4X16GB', 'gpu').gpuMemoryGb).toBe(64);
  });

  it('keeps X-Series controller and GPU dependencies in their hardware paths', () => {
    expect(catalogCategory('UCSX Front Mezzanine Pass-through Controller')).toBe('raid');
    expect(catalogCategory('UCSX-X10C-GPUFM-D GPU Front Mezzanine Adapter')).toBe('accessory');
    expect(catalogCategory('UCSX-X10C-GPUFM-D UCS X10c Compute Node GPU Front Mezz')).toBe('accessory');
  });

  it('normalizes C240 controller limits with the platform context', () => {
    expect(catalogAttributes('UCSC-HBA-M1L16 24G Tri-Mode M1 HBA for 16 Drives', 'raid', 'C240_M8_SFF')).toMatchObject({ maxDrives: 14, maxQuantity: 2 });
    expect(catalogAttributes('UCSC-RAID-MP1L32 24G Tri-Mode RAID Controller for 28 Drives', 'raid', 'C240_M8_SFF')).toMatchObject({ maxDrives: 28, maxQuantity: 1 });
  });

  it('keeps the Xeon 6511P single-socket only', () => {
    expect(catalogAttributes('UCS-CPU-I6511P Intel Xeon 6511P 16C 2.3GHz', 'cpu')).toMatchObject({ maxSocketCount: 1 });
  });
});
