import { describe, expect, it } from 'vitest';
import { catalogGroupLabel, groupCatalogOptions, isFcHba } from '../packages/extension/src/catalog-options.js';
import type { CatalogOption } from '../packages/shared/src/index.js';

const option = (sku: string, category: CatalogOption['category'], price: number, leadTimeDays?: number, attributes: CatalogOption['attributes'] = {}): CatalogOption => ({
  id: sku, sku, name: sku, category, unitListPrice: price, currency: 'USD', available: true,
  attributes: { ...attributes, ...(leadTimeDays === undefined ? {} : { leadTimeDays }) }
});

describe('catalog option presentation', () => {
  it('places Fibre Channel HBAs under connectivity and storage HBAs under storage', () => {
    const fc = option('FC-HBA', 'hba', 100, 5, { nicMedia: 'FC' });
    const storage = option('STORAGE-HBA', 'hba', 90, 4);
    expect(isFcHba(fc)).toBe(true);
    expect(catalogGroupLabel(fc)).toBe('Connectivity');
    expect(catalogGroupLabel(storage)).toBe('Storage');
  });

  it('preserves category order while filtering and sorting each category', () => {
    const groups = groupCatalogOptions([
      option('NIC-EXPENSIVE', 'nic', 500, 7),
      option('CPU-LATE', 'cpu', 200, 30),
      option('CPU-B', 'cpu', 150, 5),
      option('CPU-A', 'cpu', 100, 5),
      option('MEMORY', 'memory', 75, 4)
    ], { sort: 'price-asc', maxLeadDays: 10, minPrice: 80 });
    expect(groups.map((group) => group.label)).toEqual(['CPU', 'Connectivity']);
    expect(groups[0]?.options.map((item) => item.sku)).toEqual(['CPU-A', 'CPU-B']);
    expect(groups[1]?.options.map((item) => item.sku)).toEqual(['NIC-EXPENSIVE']);
  });

  it('places unknown lead times last for shortest-first sorting', () => {
    const groups = groupCatalogOptions([
      option('UNKNOWN', 'gpu', 100),
      option('SLOW', 'gpu', 200, 9),
      option('FAST', 'gpu', 300, 2)
    ], { sort: 'lead-asc' });
    expect(groups[0]?.options.map((item) => item.sku)).toEqual(['FAST', 'SLOW', 'UNKNOWN']);
  });
});
