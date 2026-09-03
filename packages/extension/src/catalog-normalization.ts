import { canonicalNicMedia, type CatalogOption } from '@ccw/shared';
import { controllerAttributes } from './controller-attributes.js';
import { driveCapacityGbFromText, driveInterfaceFromText, driveTransferSpeedGbpsFromText, driveTypeFromText } from './drive-attributes.js';

const portType = (text: string): string => canonicalNicMedia(text) || 'unknown';

export function catalogCategory(text: string): CatalogOption['category'] {
  const lower = text.toLowerCase();
  if (/processor|\bcpu\b/.test(lower)) return 'cpu';
  if (/memory|dimm/.test(lower)) return 'memory';
  if (/license|subscription|nvidia\s+(?:grid\s+)?(?:sw\s+)?opt[- ]?out/.test(lower)) return 'license';
  if (/gpu.*front mezz(?:anine)?|front mezz(?:anine)?.*gpu/.test(lower)) return 'accessory';
  if (/raid controller|pass[ -]?through controller|\braid\b/.test(lower)) return 'raid';
  if (/m\.2 sata drives|m\.2.*(?:ssd|drive)/.test(lower)) return 'bootDrive';
  if (/drive|ssd|hdd|nvme/.test(lower)) return 'storage';
  if (/gpu|graphics/.test(lower)) return 'gpu';
  if (/\bhba\b/.test(lower)) return 'hba';
  if (portType(text) === 'FC') return 'hba';
  if (/nic|vic|mlom|adapter|ethernet/.test(lower)) return 'nic';
  if (portType(text) !== 'unknown' || /\b\d+\s*x\s*[\d/]+\s*G(?:bE|BASE|bps|FC)?\b/i.test(text)) return 'nic';
  if (/boot|m\.2/.test(lower)) return 'boot';
  if (/riser/.test(lower)) return 'riser';
  if (/management mode/.test(lower)) return 'management';
  if (/chassis/.test(lower)) return 'chassis';
  if (/fabric|iom|ifm/.test(lower)) return 'fabric';
  if (/power|psu|power cable/.test(lower)) return 'power';
  if (/security|tpm/.test(lower)) return 'security';
  if (/accessory|rail kit|cma|bezel/.test(lower)) return 'accessory';
  if (/operating system|microsoft|red hat|rhel|suse|sles/.test(lower)) return 'operatingSystem';
  return 'other';
}

export function catalogAttributes(text: string, optionCategory: CatalogOption['category'], platformKind = 'UNKNOWN'): CatalogOption['attributes'] {
  const result: CatalogOption['attributes'] = {};
  const numberBefore = (pattern: string) => Number(text.match(new RegExp(`(?:^|[^A-Za-z0-9.])(\\d+(?:\\.\\d+)?)\\s*${pattern}`, 'i'))?.[1] ?? 0);
  if (optionCategory === 'cpu') {
    result.cores = numberBefore('cores?') || numberBefore('C(?:/|\\b)'); result.clockGhz = numberBefore('GHz');
    result.cpuVendor = /\bamd\b/i.test(text) || /(?:UCSX?|UCSC)-CPU-A\d+/i.test(text) ? 'amd' : /\bintel\b/i.test(text) || /(?:UCSX?|UCSC)-CPU-I\d+/i.test(text) ? 'intel' : 'unknown';
    result.cpuGeneration = Number(text.match(/\b([456])(?:th|st|nd|rd)\s+Gen/i)?.[1] ?? text.match(/(?:UCSX?|UCSC)-CPU-A\d{3}([45])\b/i)?.[1] ?? (/CPU-I\d+P/i.test(text) ? 6 : 0)) || 0;
    result.tdpWatts = numberBefore('W(?:atts?)?');
    result.maxSocketCount = /\b1S\b/i.test(text) || /CPU-I(?:6781|6761|6741|6731|6521|6511)P\b/i.test(text) ? 1 : 2;
  }
  if (optionCategory === 'memory') { result.capacityGb = numberBefore('GB'); result.ratedMemorySpeedMtps = numberBefore('MT/s') || numberBefore('MHz'); }
  if (optionCategory === 'storage' || optionCategory === 'bootDrive') {
    const capacityGb = driveCapacityGbFromText(text) ?? 0;
    const driveInterface = driveInterfaceFromText(text);
    const transferSpeedGbps = driveTransferSpeedGbpsFromText(text);
    result.capacityGb = capacityGb; result.capacityTb = capacityGb / 1000;
    result.driveType = driveTypeFromText(text);
    if (driveInterface) result.driveInterface = driveInterface;
    if (transferSpeedGbps) result.transferSpeedGbps = transferSpeedGbps;
  }
  if (optionCategory === 'nic' || optionCategory === 'hba') {
    const speedMatch = text.match(/(\d+)\s*x\s*([\d/]+)\s*G(?:bE|BASE|bps)?/i);
    result.ports = numberBefore('ports?') || (/\bquad[ -]?ports?\b/i.test(text) ? 4 : /\bdual[ -]?ports?\b/i.test(text) ? 2 : Number(speedMatch?.[1] ?? 0));
    result.supportedSpeedsGbps = speedMatch?.[2]?.split('/').join(',') ?? String(numberBefore('G(?:b(?:ps)?)?'));
    result.speedGbps = Math.max(...String(result.supportedSpeedsGbps).split(',').map(Number).filter(Number.isFinite), 0);
    result.pcieSlots = 1;
    result.nicMedia = portType(text);
  }
  if (optionCategory === 'raid' || optionCategory === 'boot') Object.assign(result, controllerAttributes(text, optionCategory, platformKind));
  if (optionCategory === 'gpu') {
    const memoryBreakdown = text.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*GB/i);
    result.count = 1; result.gpuMemoryGb = memoryBreakdown ? Number(memoryBreakdown[1]) * Number(memoryBreakdown[2]) : numberBefore('GB'); result.tdpWatts = numberBefore('W(?:atts?)?');
    result.pcieSlots = /\b(?:2[ -]?slot|double[ -]?wide|DW)\b/i.test(text) ? 2 : 1;
    result.gpuWidth = result.pcieSlots === 2 ? 'double' : 'single';
  }
  return result;
}
