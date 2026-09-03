import type { CatalogOption } from '@ccw/shared';

export type CatalogSort = 'price-desc' | 'price-asc' | 'lead-asc' | 'lead-desc';
export type CatalogGroupLabel = 'CPU' | 'Memory' | 'GPU' | 'Storage' | 'Connectivity';

export interface CatalogFilters {
  sort: CatalogSort;
  maxLeadDays?: number;
  minPrice?: number;
  maxPrice?: number;
}

export interface CatalogOptionGroup {
  label: CatalogGroupLabel;
  options: CatalogOption[];
}

const GROUP_ORDER: CatalogGroupLabel[] = ['CPU', 'Memory', 'GPU', 'Storage', 'Connectivity'];

export function isFcHba(option: CatalogOption): boolean {
  return option.category === 'hba' && (
    String(option.attributes.nicMedia).toUpperCase() === 'FC'
    || /\b(?:fibre|fiber) channel\b|\bFC\s+HBA\b/i.test(`${option.name} ${String(option.attributes.subgroupName ?? '')}`)
  );
}

export function catalogGroupLabel(option: CatalogOption): CatalogGroupLabel | undefined {
  if (option.category === 'cpu') return 'CPU';
  if (option.category === 'memory') return 'Memory';
  if (option.category === 'gpu') return 'GPU';
  if (['storage', 'boot', 'bootDrive', 'raid'].includes(option.category) || option.category === 'hba' && !isFcHba(option)) return 'Storage';
  if (option.category === 'nic' || isFcHba(option)) return 'Connectivity';
  return undefined;
}

const leadTimeDays = (option: CatalogOption): number => {
  const value = option.attributes.leadTimeDays;
  return typeof value === 'number' && value >= 0 ? value : Number.POSITIVE_INFINITY;
};

export function compareCatalogOptions(a: CatalogOption, b: CatalogOption, sort: CatalogSort): number {
  if (sort === 'price-asc') return a.unitListPrice - b.unitListPrice || a.sku.localeCompare(b.sku);
  if (sort === 'lead-asc') return leadTimeDays(a) - leadTimeDays(b) || b.unitListPrice - a.unitListPrice;
  if (sort === 'lead-desc') return leadTimeDays(b) - leadTimeDays(a) || b.unitListPrice - a.unitListPrice;
  return b.unitListPrice - a.unitListPrice || a.sku.localeCompare(b.sku);
}

export function catalogOptionMatchesFilters(option: CatalogOption, filters: CatalogFilters): boolean {
  const lead = option.attributes.leadTimeDays;
  return (filters.maxLeadDays === undefined || typeof lead === 'number' && lead >= 0 && lead <= filters.maxLeadDays)
    && (filters.minPrice === undefined || option.unitListPrice >= filters.minPrice)
    && (filters.maxPrice === undefined || option.unitListPrice <= filters.maxPrice);
}

export function groupCatalogOptions(options: CatalogOption[], filters: CatalogFilters): CatalogOptionGroup[] {
  const grouped = new Map<CatalogGroupLabel, CatalogOption[]>();
  for (const option of options) {
    const label = catalogGroupLabel(option);
    if (!label || !catalogOptionMatchesFilters(option, filters)) continue;
    grouped.set(label, [...(grouped.get(label) ?? []), option]);
  }
  return GROUP_ORDER.flatMap((label) => {
    const items = grouped.get(label);
    return items?.length ? [{ label, options: items.sort((a, b) => compareCatalogOptions(a, b, filters.sort)) }] : [];
  });
}
