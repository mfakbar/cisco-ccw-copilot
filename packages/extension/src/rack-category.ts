const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();

export function isPhysicalPcieCategory(categoryName: string): boolean {
  const name = normalized(categoryName);
  return /^Riser\s+.*\bSlot\s*\d+/i.test(name) || /^R\d+[A-Z]?\s+Slot\s*\d+/i.test(name);
}

export function isMlomCategory(categoryName: string): boolean {
  const name = normalized(categoryName);
  return /^PCIe\s+(?:MLOM|OCP)(?:\/OCP)?(?:\s+Option)?$/i.test(name)
    || /^Rear\s+MEZZ(?:ANINE)?\s*-\s*MLOM\/PCI$/i.test(name);
}

export function isFrontDriveCategory(categoryName: string): boolean {
  return /^(?:Local Storage|Front Facing Drive Option|Storage Drives)$/i.test(normalized(categoryName));
}

export function isRearDriveCategory(categoryName: string): boolean {
  return /\bREAR Facing Drive$/i.test(normalized(categoryName));
}

export function frontDriveCapacityForSeries(series: 'C21X' | 'C22X' | 'C24X' | 'X21X' | 'UNKNOWN'): number {
  return series === 'C22X' ? 10 : series === 'C24X' ? 24 : series === 'X21X' ? 9 : 999;
}

export function rackClassificationText(categoryName: string, subgroupName: string, productText: string): string {
  return isPhysicalPcieCategory(categoryName) ? `${subgroupName} ${productText}` : `${categoryName} ${subgroupName} ${productText}`;
}

export function rackOwnerCategory(categoryName: string): 'accessory' | 'boot' | 'bootDrive' | 'raid' | 'storage' | 'riser' | undefined {
  const name = normalized(categoryName);
  if (/^GPU Airduct$/i.test(name)) return 'accessory';
  if (/^M\.2 (?:BOOT|NVMe Boot|Controller) Option$/i.test(name) || /^NVMe BOOT$/i.test(name)) return 'boot';
  if (/^M\.2 (?:SATA|NVMe) Drives$/i.test(name) || /^SATA M\.2$/i.test(name)) return 'bootDrive';
  if (/^PCIe Riser(?:\s+\d+)? Option$/i.test(name)) return 'riser';
  if (/^RAID Controller$/i.test(name)) return 'raid';
  if (isFrontDriveCategory(name) || isRearDriveCategory(name)) return 'storage';
  return undefined;
}

export function rackOwnerCategoryForProduct(categoryName: string, productText: string): ReturnType<typeof rackOwnerCategory> {
  const name = normalized(categoryName);
  if (/^NVMe BOOT$/i.test(name)) return /\bUCSX-M2-PT-FPN\b|pass[ -]?through|front\s+panel/i.test(productText) ? 'boot' : 'bootDrive';
  return rackOwnerCategory(name);
}

export function isRackCategoryBreadcrumb(breadcrumb: string, categoryName: string): boolean {
  return normalized(breadcrumb).endsWith(`> ${normalized(categoryName)}`);
}

export function isRackScanCategory(categoryName: string): boolean {
  const name = normalized(categoryName);
  return /^(?:Processor|Memory$|PCIe Riser(?:\s+\d+)? Option$|RAID Controller$|PCIe MLOM(?:\/OCP)?(?: Option)?$|Rear mLOM Adapter$|Rear MEZZ(?:ANINE)?.*|Front MEZZ(?:ANINE)?.*|GPU.*|M\.2 (?:BOOT|NVMe Boot|Controller) Option$|M\.2 (?:SATA|NVMe) Drives$|SATA M\.2$|NVMe BOOT$)/i.test(name)
    || isPhysicalPcieCategory(name) || isFrontDriveCategory(name) || isRearDriveCategory(name);
}
