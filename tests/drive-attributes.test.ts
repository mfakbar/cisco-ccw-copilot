import { describe, expect, it } from 'vitest';
import { driveCapacityGbFromText, driveInterfaceFromText, driveTransferSpeedGbpsFromText, driveTypeFromText } from '../packages/extension/src/drive-attributes.js';

describe('CCW drive attributes', () => {
  it.each([
    ['960GB SAS 12Gbps SSD', 'SAS SSD', 'SAS', 12],
    ['960GB SAS SSD 12G', 'SAS SSD', 'SAS', 12],
    ['960GB SATA 6G SSD', 'SATA SSD', 'SATA', 6],
    ['960GB SSD', 'SSD', undefined, undefined],
    ['2.4TB 12Gbps SAS HDD', 'SAS HDD', 'SAS', 12],
    ['3.2TB E3.S NVMe SSD', 'E3.S NVMe', 'NVMe', undefined]
  ])('classifies %s', (text, driveType, driveInterface, speed) => {
    expect(driveTypeFromText(text)).toBe(driveType);
    expect(driveInterfaceFromText(text)).toBe(driveInterface);
    expect(driveTransferSpeedGbpsFromText(text)).toBe(speed);
  });

  it('ignores capacity-like digits embedded in a SKU and reads the human description', () => {
    expect(driveCapacityGbFromText('UCS-SD19TBM1XEV-D 1.9TB 2.5in Enter Value 6G SATA SSD')).toBe(1900);
    expect(driveCapacityGbFromText('UCS-M2-240G-D 240GB M.2 SATA SSD')).toBe(240);
  });
});
