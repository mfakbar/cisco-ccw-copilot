import { describe, expect, it } from 'vitest';
import { buildProductContext } from '../packages/extension/src/product-context.js';

describe('CCW product context extraction', () => {
  it('combines the SKU with the description below it for classification', () => {
    const context = buildProductContext(
      'UCSC-P-B7D32GF-D',
      'UCSC-P-B7D32GF-D  Cisco-Emulex LPe35002-M2-2x32GFC Gen 7 PCIe HBA',
      'UCSC-P-B7D32GF-D Cisco-Emulex LPe35002-M2-2x32GFC Gen 7 PCIe HBA 1 35 days 4,798.94'
    );
    expect(context).toEqual({
      description: 'Cisco-Emulex LPe35002-M2-2x32GFC Gen 7 PCIe HBA',
      productText: 'UCSC-P-B7D32GF-D Cisco-Emulex LPe35002-M2-2x32GFC Gen 7 PCIe HBA'
    });
    expect(context.productText).toContain('2x32GFC');
    expect(context.productText).toContain('PCIe HBA');
  });

  it('falls back to the complete row when the dedicated item cell is unavailable', () => {
    const context = buildProductContext('UCSC-RAID-M1L16', '', 'UCSC-RAID-M1L16 24G Tri-Mode M1 RAID Controller w/4GB FBWC 16Drv');
    expect(context.productText).toContain('24G Tri-Mode M1 RAID Controller');
  });
});
