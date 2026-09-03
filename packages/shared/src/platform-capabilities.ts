import type { RackServerProfile } from './types.js';

export type PlatformKind = 'C220_M8' | 'C225_M8' | 'C240_M8_LFF' | 'C240_M8_SFF' | 'C245_M8' | 'X210C_M8' | 'X215C_M8' | 'UNKNOWN';

export interface PlatformCapabilities {
  kind: PlatformKind;
  maxSockets: 1 | 2;
  dimmsPerCpu: number;
  memoryChannelsPerCpu: number;
  dimmsPerChannel: number;
  balancedMemoryAcrossCpus: boolean;
  frontDriveCapacity: number;
  allowedRisersByCpuCount: Record<1 | 2, number[]>;
  fcHbaRisers: number[];
  mandatoryMlom: boolean;
  raidNvmeDriveTypes: string[];
  directAttachNvmeMaxByCpuCount: Record<1 | 2, number>;
  m2SataRaid: boolean;
  m2NvmeRaidCpuGenerations: number[];
  m2NvmePassThrough: boolean;
  gpuRequiresTwoCpusAtOrAboveWatts?: number;
  gpuRequiresAllRisersAtOrAboveWatts?: number;
  gpuDisallows256GbDimmsAboveWatts?: number;
  cpuPowerCapWithGpuWatts?: number;
  gpuMemoryMultiplierForPcieNode?: number;
}

const base = (overrides: Partial<PlatformCapabilities>): PlatformCapabilities => ({
  kind: 'UNKNOWN', maxSockets: 2, dimmsPerCpu: 16, memoryChannelsPerCpu: 8, dimmsPerChannel: 2,
  balancedMemoryAcrossCpus: true, frontDriveCapacity: 999,
  allowedRisersByCpuCount: { 1: [1, 2, 3], 2: [1, 2, 3] }, fcHbaRisers: [1, 2, 3], mandatoryMlom: false,
  raidNvmeDriveTypes: ['U.3 NVMe'], directAttachNvmeMaxByCpuCount: { 1: 4, 2: 999 },
  m2SataRaid: true, m2NvmeRaidCpuGenerations: [], m2NvmePassThrough: false,
  ...overrides
});

const capabilities: Record<Exclude<PlatformKind, 'UNKNOWN'>, PlatformCapabilities> = {
  C220_M8: base({ kind: 'C220_M8', frontDriveCapacity: 10, allowedRisersByCpuCount: { 1: [1, 2], 2: [1, 2, 3] }, directAttachNvmeMaxByCpuCount: { 1: 4, 2: 8 } }),
  C225_M8: base({ kind: 'C225_M8', maxSockets: 1, dimmsPerCpu: 12, memoryChannelsPerCpu: 12, dimmsPerChannel: 1, frontDriveCapacity: 10, allowedRisersByCpuCount: { 1: [1, 2, 3], 2: [] }, directAttachNvmeMaxByCpuCount: { 1: 4, 2: 0 }, m2NvmeRaidCpuGenerations: [4] }),
  C240_M8_LFF: base({ kind: 'C240_M8_LFF', frontDriveCapacity: 12, allowedRisersByCpuCount: { 1: [1], 2: [1, 2, 3] }, fcHbaRisers: [2, 3], directAttachNvmeMaxByCpuCount: { 1: 0, 2: 0 }, gpuRequiresTwoCpusAtOrAboveWatts: 75, gpuRequiresAllRisersAtOrAboveWatts: 75, gpuDisallows256GbDimmsAboveWatts: 0, cpuPowerCapWithGpuWatts: 330 }),
  C240_M8_SFF: base({ kind: 'C240_M8_SFF', frontDriveCapacity: 24, allowedRisersByCpuCount: { 1: [1], 2: [1, 2, 3] }, directAttachNvmeMaxByCpuCount: { 1: 4, 2: 8 }, gpuRequiresTwoCpusAtOrAboveWatts: 75, gpuRequiresAllRisersAtOrAboveWatts: 75, gpuDisallows256GbDimmsAboveWatts: 75, cpuPowerCapWithGpuWatts: 330 }),
  C245_M8: base({ kind: 'C245_M8', dimmsPerCpu: 12, memoryChannelsPerCpu: 12, dimmsPerChannel: 1, frontDriveCapacity: 24, allowedRisersByCpuCount: { 1: [1], 2: [1, 2, 3] }, directAttachNvmeMaxByCpuCount: { 1: 0, 2: 4 }, m2NvmeRaidCpuGenerations: [4], gpuRequiresTwoCpusAtOrAboveWatts: 150, gpuRequiresAllRisersAtOrAboveWatts: 150, gpuDisallows256GbDimmsAboveWatts: 75, cpuPowerCapWithGpuWatts: 320 }),
  X210C_M8: base({ kind: 'X210C_M8', frontDriveCapacity: 9, allowedRisersByCpuCount: { 1: [], 2: [] }, fcHbaRisers: [], mandatoryMlom: true, raidNvmeDriveTypes: ['U.3 NVMe'], directAttachNvmeMaxByCpuCount: { 1: 6, 2: 9 }, m2NvmePassThrough: true }),
  X215C_M8: base({ kind: 'X215C_M8', dimmsPerCpu: 12, memoryChannelsPerCpu: 12, dimmsPerChannel: 1, frontDriveCapacity: 8, allowedRisersByCpuCount: { 1: [], 2: [] }, fcHbaRisers: [], mandatoryMlom: true, raidNvmeDriveTypes: ['U.2 NVMe', 'U.3 NVMe'], directAttachNvmeMaxByCpuCount: { 1: 6, 2: 8 }, m2NvmePassThrough: true, gpuMemoryMultiplierForPcieNode: 3 }),
};

export function platformKind(model: string | undefined): PlatformKind {
  const value = String(model ?? '').toUpperCase();
  if (/UCSC-C220-M8/.test(value)) return 'C220_M8';
  if (/UCSC-C225-M8/.test(value)) return 'C225_M8';
  if (/UCSC-C240-M8L/.test(value)) return 'C240_M8_LFF';
  if (/UCSC-C240-M8/.test(value)) return 'C240_M8_SFF';
  if (/UCSC-C245-M8/.test(value)) return 'C245_M8';
  if (/UCSX-210C-M8/.test(value)) return 'X210C_M8';
  if (/UCSX-215C-M8/.test(value)) return 'X215C_M8';
  return 'UNKNOWN';
}

export function platformCapabilities(profile?: RackServerProfile): PlatformCapabilities {
  const kind = platformKind(profile?.model);
  if (kind === 'UNKNOWN') return base({});
  const capability = capabilities[kind];
  if (kind === 'C225_M8' && /UCSC-C225-M8N/i.test(String(profile?.model ?? ''))) {
    return { ...capability, directAttachNvmeMaxByCpuCount: { 1: 10, 2: 0 } };
  }
  return capability;
}

/** Product policy: capacity drives are placed only in front-facing bays. */
export function frontDriveLimit(capability: PlatformCapabilities, driveType: unknown): number {
  const type = String(driveType ?? '').toUpperCase();
  if (capability.kind === 'X210C_M8') return /E3\.?S/.test(type) ? 9 : 6;
  if (capability.kind === 'X215C_M8') return /E3\.?S/.test(type) ? 8 : 6;
  return capability.frontDriveCapacity;
}

export function compatiblePlatformRiserVariants(kind: PlatformKind, variants: string[]): boolean {
  const unique = [...new Set(variants.filter(Boolean))];
  if (kind === 'C220_M8') return new Set(unique.map((variant) => variant.slice(-1))).size <= 1;
  if (kind === 'C225_M8') {
    const hasFullHeight = unique.some((variant) => variant.endsWith('C'));
    return !hasFullHeight || unique.every((variant) => variant.endsWith('C'));
  }
  if (kind === 'C245_M8') {
    const byNumber = new Map(unique.map((variant) => [Number(variant[1]), variant]));
    const r1 = byNumber.get(1); const r2 = byNumber.get(2); const r3 = byNumber.get(3);
    if (r1 === 'R1A' && r2 && r2 !== 'R2A') return false;
    if (r1 === 'R1C' && r2 && r2 !== 'R2C') return false;
    if (r1 === 'R1B' && r3 && r3 !== 'R3B') return false;
    if (r1 !== 'R1B' && r3 === 'R3B') return false;
  }
  return true;
}

export function riserNumber(value: string): number | undefined {
  return Number(value.match(/\bRiser\s*(\d+)/i)?.[1] ?? value.match(/^R(\d+)[A-Z]?\s*Slot/i)?.[1] ?? 0) || undefined;
}

export function riserVariant(value: string): string | undefined {
  const match = value.match(/\bRiser\s*(\d+)([A-Z])/i) ?? value.match(/^R(\d+)([A-Z])\s*Slot/i);
  return match ? `R${match[1]}${match[2]!.toUpperCase()}` : undefined;
}

export function canonicalNicMedia(value: unknown): string {
  const text = String(value ?? '');
  if (/\b(?:RJ-?45|BASE-?T|BASET|UTP)\b/i.test(text)) return 'BASE-T';
  if (/\bQSFP(?:\+|28|56|112)?\b/i.test(text)) return 'QSFP';
  if (/\bSFP(?:\+|28|56)?\b/i.test(text)) return 'SFP';
  if (/(?:\bFC\b|\d+\s*GFC\b|Fib(?:re|er)\s+Channel)/i.test(text)) return 'FC';
  return '';
}

export function supportedNicSpeeds(value: unknown): number[] {
  return [...new Set(String(value ?? '').split(',').map(Number).filter((speed) => Number.isFinite(speed) && speed > 0))];
}

export function supportsRequestedNicSpeed(value: unknown, requested: number | undefined): boolean {
  return requested === undefined || supportedNicSpeeds(value).includes(requested);
}

export function raidDriveCountError(level: string, count: number): string | undefined {
  if (!Number.isInteger(count) || count < 1) return 'drive count must be a positive whole number';
  if (level === '0' || level === '00') return count >= 2 ? undefined : `RAID ${level} requires at least 2 drives`;
  if (level === '1') return count === 2 ? undefined : 'RAID 1 requires exactly 2 drives';
  if (level === '5') return count >= 3 ? undefined : 'RAID 5 requires at least 3 drives';
  if (level === '6') return count >= 4 ? undefined : 'RAID 6 requires at least 4 drives';
  if (level === '10') return count >= 4 && count % 2 === 0 ? undefined : 'RAID 10 requires an even number of drives, minimum 4';
  if (level === '50') return count >= 6 && count % 2 === 0 ? undefined : 'RAID 50 requires at least 6 drives across equal spans';
  if (level === '60') return count >= 8 && count % 2 === 0 ? undefined : 'RAID 60 requires at least 8 drives across equal spans';
  return undefined;
}
