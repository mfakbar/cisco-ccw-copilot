import type { CatalogOption } from '@ccw/shared';

export const STANDARD_RAID_LEVELS = '0,1,5,6,10,50,60,JBOD';

export function controllerAttributes(text: string, optionCategory: CatalogOption['category'], platformKind = 'UNKNOWN'): CatalogOption['attributes'] {
  if (optionCategory !== 'raid' && optionCategory !== 'boot') return {};
  const numberBefore = (pattern: string) => Number(text.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${pattern}`, 'i'))?.[1] ?? 0);
  const m2 = optionCategory === 'boot' || /\bM\.?\s*2\b/i.test(text);
  const passThrough = /\b(?:HBA|pass[ -]?through|non-?raid)\b/i.test(text);
  const controllerType = m2 ? (passThrough ? 'M.2-passthrough' : 'M.2') : passThrough ? 'passthrough' : 'standard';
  const triMode = controllerType === 'standard' && /\btri[ -]?mode\b/i.test(text);
  const raidCapable = controllerType === 'standard' || controllerType === 'M.2' && /\braid\b/i.test(text);
  const x210PassThrough = /\bUCSX-X10C-PT4F-D\b/i.test(text);
  const x210Raid = /\bUCSX-X10C-RAIDF-D\b/i.test(text);
  const x210M1 = /\bUCSX-RAID-M1L6\b/i.test(text);
  const x210E3s = /\bUCSX-X10C-PTE3\b/i.test(text);
  const c220M1Hba = /\bUCSC-HBA-M1L16\b/i.test(text);
  const c220M1Raid = /\bUCSC-RAID-M1L16\b/i.test(text);
  const c220RearM2 = /\bUCSC-M2RM-M8\b/i.test(text);
  const c220InternalM2 = /\bUCS-M2-HWRAID2\b/i.test(text);
  const c240Mp1Raid = /\bUCSC-RAID-MP1L32\b/i.test(text);
  const c240RearRiserM2 = /\bUCSC-M2RR-240M8\b/i.test(text);
  const c220Platform = platformKind === 'C220_M8';
  const c240SffPlatform = platformKind === 'C240_M8_SFF';
  const knownRaidLevels = x210Raid || x210M1 ? '0,1,5,6,10,50' : undefined;
  const knownMaxDrives = x210E3s ? 9
    : x210PassThrough || x210Raid || x210M1 ? 6
      : c240SffPlatform && c240Mp1Raid ? 28
        : c240SffPlatform && c220M1Hba ? 14
          : c240SffPlatform && c220M1Raid ? 16
            : c220Platform && (c220M1Hba || c220M1Raid) ? 10
              : c220RearM2 || c220InternalM2 || c240RearRiserM2 ? 2
                : undefined;
  const knownDriveTypes = x210E3s ? 'E3.S NVMe' : x210PassThrough ? 'U.3 NVMe' : x210Raid || x210M1 || c220M1Hba || c220M1Raid ? 'HDD,SSD,U.3 NVMe' : undefined;
  const frontMezzanineType = x210E3s ? 'e3s-pass-through' : x210PassThrough ? 'u3-pass-through' : x210Raid || x210M1 ? 'raid' : undefined;
  const knownMaxQuantity = c240SffPlatform && (c220M1Hba || c220M1Raid) ? 2 : 1;

  return {
    raidCapable,
    controllerType,
    triMode,
    supportedRaidLevels: controllerType === 'standard' ? knownRaidLevels ?? STANDARD_RAID_LEVELS : controllerType === 'M.2' && raidCapable ? c220RearM2 || c220InternalM2 || c240RearRiserM2 ? '1,JBOD' : '1' : '',
    ...(knownRaidLevels ? { exactRaidLevels: true } : {}),
    supportedDriveTypes: knownDriveTypes ?? (controllerType === 'standard' ? triMode ? 'HDD,SSD,U.3 NVMe' : 'HDD,SSD' : m2 ? 'M.2' : ''),
    maxDrives: knownMaxDrives ?? (numberBefore('Drives?') || numberBefore('Drv') || 0),
    maxQuantity: knownMaxQuantity,
    ...(frontMezzanineType ? { frontMezzanine: true, frontMezzanineType } : {}),
    m2Protocol: c220RearM2 || c220InternalM2 || c240RearRiserM2 ? 'SATA' : /\bNVMe\b/i.test(text) ? 'NVMe' : /\bSATA\b/i.test(text) ? 'SATA' : 'any',
    ...(c220RearM2 ? { bootLocation: 'MLOM' } : c220InternalM2 ? { bootLocation: 'internal' } : c240RearRiserM2 ? { bootLocation: 'Riser 3' } : {})
  };
}
