import { describe, expect, it } from 'vitest';
import { includedPlatformOptions } from '../packages/extension/src/current-platform-options.js';

describe('auto-included platform options', () => {
  it('models the X210 SATA M.2 RAID controller shown only in Product Expansion', () => {
    expect(includedPlatformOptions('Product Expansion UCSX-M2I-HWRD-FPS Included')).toEqual([
      expect.objectContaining({
        sku: 'UCSX-M2I-HWRD-FPS', category: 'boot', available: true,
        attributes: expect.objectContaining({
          selected: true, quantityFixed: true, controllerType: 'M.2',
          supportedRaidLevels: '1,JBOD', m2Protocol: 'SATA', maxDrives: 2
        })
      })
    ]);
  });

  it('does not invent the controller when it is absent from the current summary', () => {
    expect(includedPlatformOptions('No boot option selected')).toEqual([]);
  });
});
