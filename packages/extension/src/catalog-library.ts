import type { PageSnapshot } from '@ccw/shared';

export interface StoredCatalog {
  id: string;
  parentSku: string;
  updatedAt: string;
  snapshot: PageSnapshot;
}

export const catalogParentSku = (snapshot: PageSnapshot): string => {
  const model = snapshot.platformProfile?.model?.trim();
  return model && model.toLowerCase() !== 'unknown'
    ? model
    : snapshot.configurationId?.trim() || snapshot.title.trim() || 'Unknown UCS server';
};

export const catalogId = (snapshot: PageSnapshot): string => catalogParentSku(snapshot).toUpperCase();

export function upsertScannedCatalog(catalogs: StoredCatalog[], snapshot: PageSnapshot): StoredCatalog[] {
  const id = catalogId(snapshot);
  const entry: StoredCatalog = { id, parentSku: catalogParentSku(snapshot), updatedAt: snapshot.capturedAt, snapshot };
  return [entry, ...catalogs.filter((catalog) => catalog.id !== id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateStoredCatalogSnapshot(catalogs: StoredCatalog[], snapshot: PageSnapshot): StoredCatalog[] {
  const id = catalogId(snapshot);
  return catalogs.map((catalog) => catalog.id === id ? { ...catalog, snapshot } : catalog);
}

export function chooseStoredCatalog(catalogs: StoredCatalog[], selectedId?: string): StoredCatalog | undefined {
  return catalogs.find((catalog) => catalog.id === selectedId) ?? catalogs[0];
}
