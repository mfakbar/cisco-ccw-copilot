import { describe, expect, it } from 'vitest';
import { catalogId, chooseStoredCatalog, updateStoredCatalogSnapshot, upsertScannedCatalog } from '../packages/extension/src/catalog-library.js';
import type { PageSnapshot } from '../packages/shared/src/index.js';

const snapshot = (model: string, capturedAt: string, price = 100): PageSnapshot => ({
  url: 'https://apps.cisco.com/ccw', title: model, capturedAt, adapterVersion: 'test',
  platformProfile: { model, generation: 'M8', series: model.includes('240') ? 'C24X' : 'C22X', cpuVendor: 'intel', riserSlotNames: [] },
  options: [{ id: 'cpu', sku: 'CPU-SKU', name: 'CPU', category: 'cpu', unitListPrice: price, currency: 'USD', available: true, attributes: { leadTimeDays: 14 } }],
  validationMessages: [], pageFingerprint: `${model}-${capturedAt}`
});

describe('stored CCW catalog library', () => {
  it('keeps one latest scanned catalog per UCS parent SKU', () => {
    const first = snapshot('UCSC-C240-M8SX', '2026-08-14T10:00:00.000Z');
    const refreshed = snapshot('UCSC-C240-M8SX', '2026-08-15T10:00:00.000Z', 120);
    const other = snapshot('UCSC-C220-M8S', '2026-08-15T09:00:00.000Z');
    const catalogs = upsertScannedCatalog(upsertScannedCatalog(upsertScannedCatalog([], first), other), refreshed);
    expect(catalogs).toHaveLength(2);
    expect(catalogs[0]).toMatchObject({ id: catalogId(refreshed), parentSku: 'UCSC-C240-M8SX', updatedAt: refreshed.capturedAt });
    expect(catalogs[0]?.snapshot.options[0]?.unitListPrice).toBe(120);
  });

  it('chooses the manual selection and otherwise falls back to the newest catalog', () => {
    const newest = upsertScannedCatalog([], snapshot('UCSC-C240-M8SX', '2026-08-15T10:00:00.000Z'));
    const catalogs = upsertScannedCatalog(newest, snapshot('UCSC-C220-M8S', '2026-08-14T10:00:00.000Z'));
    expect(chooseStoredCatalog(catalogs, 'UCSC-C220-M8S')?.parentSku).toBe('UCSC-C220-M8S');
    expect(chooseStoredCatalog(catalogs, 'missing')?.parentSku).toBe('UCSC-C240-M8SX');
  });

  it('updates applied-state data without changing the last scan timestamp', () => {
    const scanned = snapshot('UCSC-C240-M8SX', '2026-08-15T10:00:00.000Z');
    const applied = { ...scanned, capturedAt: '2026-08-15T11:00:00.000Z', pageFingerprint: 'after-approval' };
    const catalogs = updateStoredCatalogSnapshot(upsertScannedCatalog([], scanned), applied);
    expect(catalogs[0]?.updatedAt).toBe(scanned.capturedAt);
    expect(catalogs[0]?.snapshot.pageFingerprint).toBe('after-approval');
  });

  it('falls back from an unknown detected model to the CCW configuration identity', () => {
    const unknown = { ...snapshot('unknown', '2026-08-15T10:00:00.000Z'), configurationId: 'UCSC-C210-M2' };
    expect(catalogId(unknown)).toBe('UCSC-C210-M2');
  });
});
