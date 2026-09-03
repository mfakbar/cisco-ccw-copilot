import type { CatalogOption } from '@ccw/shared';

export function includedPlatformOptions(selectedConfigurationSummary: string): CatalogOption[] {
  if (!/\bUCSX-M2I-HWRD-FPS\b/i.test(selectedConfigurationSummary)) return [];
  return [{
    id: 'current:UCSX-M2I-HWRD-FPS',
    sku: 'UCSX-M2I-HWRD-FPS',
    name: 'UCSX Front panel with included M.2 RAID controller for SATA drives',
    category: 'boot',
    unitListPrice: 0,
    currency: 'USD',
    available: true,
    attributes: {
      categoryName: 'Product Expansion', subgroupName: 'Product Expansion', leadTimeDays: 0,
      maxQuantity: 1, selected: true, selectedQuantity: 1, quantityFixed: true, fixedQuantity: 1,
      raidCapable: true, controllerType: 'M.2', supportedRaidLevels: '1,JBOD',
      supportedDriveTypes: 'M.2', maxDrives: 2, m2Protocol: 'SATA'
    }
  }];
}
