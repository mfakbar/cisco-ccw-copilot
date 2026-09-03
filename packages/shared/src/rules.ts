import type { CatalogOption, ProductFamily, RackServerProfile, Selection } from './types.js';

export interface PlatformLimits {
  family: ProductFamily;
  maxSockets: number;
  maxDimmSlots: number;
  maxDriveSlots: number;
  maxPcieSlots?: number;
  requiresChassis: boolean;
  requiresFabric: boolean;
}

export const MAX_DIMM_SLOTS = 32;

export function extractUcsParentSku(text: string): string | undefined {
  return text.match(/\b(?:UCSC-C(?:21|22|24)[05]-M\d+[A-Z0-9-]*|UCSX-21\dC-M\d+[A-Z0-9-]*)\b/i)?.[0]?.toUpperCase();
}

export function physicalNicSlotKey(categoryName: string): string | undefined {
  if (/\b(?:MLOM|OCP)\b/i.test(categoryName)) return 'PCIe MLOM/OCP';
  const slot = categoryName.match(/\bSlot\s*(\d+)\b/i);
  if (slot) return `PCIe Slot ${slot[1]}`;
  const riser = categoryName.match(/\bRiser\s+(\d+)\b/i);
  return riser ? `Riser ${riser[1]}` : undefined;
}

export function pcieRiserVariant(categoryName: string): string | undefined {
  const compact = categoryName.match(/^R(\d+)([A-Z])\s+Slot/i);
  const verbose = categoryName.match(/^Riser\s+(\d+)([A-Z])\b/i);
  const match = compact ?? verbose;
  return match ? `R${match[1]}${match[2]!.toUpperCase()}` : undefined;
}

export function nicPlacementRank(categoryName: string): number {
  if (/\b(?:MLOM|OCP)\b/i.test(categoryName)) return 0;
  const slot = Number(categoryName.match(/\bSlot\s*(\d+)\b/i)?.[1] ?? categoryName.match(/\bRiser\s+(\d+)\b/i)?.[1] ?? 999);
  const variant = pcieRiserVariant(categoryName)?.match(/([A-Z])$/)?.[1];
  const variantRank = variant ? variant.charCodeAt(0) - 64 : 0;
  return slot * 100 + variantRank;
}

export const platformLimits: Record<ProductFamily, PlatformLimits> = {
  C_SERIES: { family: 'C_SERIES', maxSockets: 2, maxDimmSlots: MAX_DIMM_SLOTS, maxDriveSlots: 28, requiresChassis: false, requiresFabric: false },
  X_SERIES: { family: 'X_SERIES', maxSockets: 2, maxDimmSlots: MAX_DIMM_SLOTS, maxDriveSlots: 6, maxPcieSlots: 2, requiresChassis: true, requiresFabric: true }
};

export function validatePlatform(family: ProductFamily, catalog: CatalogOption[], selections: Selection[]): string[] {
  const limits = platformLimits[family];
  const qty = (category: CatalogOption['category']) => selections.reduce((sum, s) => sum + (catalog.find((o) => o.id === s.optionId)?.category === category ? s.quantity : 0), 0);
  const pcie = selections.reduce((sum, s) => {
    const o = catalog.find((item) => item.id === s.optionId);
    return sum + (typeof o?.attributes.pcieSlots === 'number' ? o.attributes.pcieSlots * s.quantity : 0);
  }, 0);
  const errors: string[] = [];
  if (qty('cpu') > limits.maxSockets) errors.push(`Maximum ${limits.maxSockets} CPU sockets`);
  if (qty('memory') > limits.maxDimmSlots) errors.push(`Maximum ${limits.maxDimmSlots} DIMM slots`);
  if (qty('storage') > limits.maxDriveSlots) errors.push(`Maximum ${limits.maxDriveSlots} drive slots`);
  if (limits.maxPcieSlots !== undefined && pcie > limits.maxPcieSlots) errors.push(`Maximum ${limits.maxPcieSlots} PCIe slots`);
  if (limits.requiresChassis && qty('chassis') < 1) errors.push('X-Series requires a chassis');
  if (limits.requiresFabric && qty('fabric') < 1) errors.push('X-Series requires fabric connectivity');
  return errors;
}

export function inferRackServerProfile(model: string, riserSlotNames: string[] = []): RackServerProfile {
  const normalized = model.toUpperCase();
  const xSeries = normalized.match(/UCSX-21([05])C-M(\d+)/);
  if (xSeries) return { model: normalized, generation: `M${xSeries[2]}`, series: 'X21X', cpuVendor: xSeries[1] === '0' ? 'intel' : 'amd', riserSlotNames: [...new Set(riserSlotNames)] };
  const match = normalized.match(/UCSC-C(21|22|24)(0|5)-M(\d+)/);
  if (!match) return { model, generation: 'unknown', series: 'UNKNOWN', cpuVendor: 'unknown', riserSlotNames: [...new Set(riserSlotNames)] };
  return {
    model: normalized,
    generation: `M${match[3]}`,
    series: match[1] === '21' ? 'C21X' : match[1] === '22' ? 'C22X' : 'C24X',
    rackUnits: match[1] === '24' ? 2 : 1,
    cpuVendor: match[2] === '0' ? 'intel' : 'amd',
    riserSlotNames: [...new Set(riserSlotNames)]
  };
}
