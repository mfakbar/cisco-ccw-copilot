import { CIRCUIT_MODELS, isCircuitModel, type Requirement } from '@ccw/shared';
import { assertCurrentCircuitToken, CircuitAuthenticationError, CircuitConfigurationError, configuredCircuitAppKey } from './circuit-auth.js';

export { CIRCUIT_MODELS } from '@ccw/shared';

export type Provider = 'local' | 'circuit';
export interface ProviderConfig { provider: Provider; model?: string; apiKey?: string; appKey?: string; baseUrl?: string }

const circuitBaseUrl = 'https://chat-ai.cisco.com/openai/deployments';

const allowedRequirementIds = [
  'serverQuantity', 'cpuSockets', 'cpuTotalCores', 'cpuCoresPerSocket', 'cpuClockGhz', 'cpuVendor',
  'memoryGb', 'memoryModuleCount', 'memoryModuleSizeGb', 'localStorageCapacity', 'localStorageCapacityType',
  'localDriveCount', 'localDriveCapacity', 'localDriveType', 'localDriveInterface', 'localDriveTransferSpeedGbps', 'raidLevel', 'storageGroup1Capacity', 'storageGroup1CapacityType',
  'storageGroup1DriveCount', 'storageGroup1DriveCapacity', 'storageGroup1DriveType', 'storageGroup1DriveInterface', 'storageGroup1TransferSpeedGbps', 'storageGroup1RaidLevel',
  'storageGroup2Capacity', 'storageGroup2CapacityType', 'storageGroup2DriveCount', 'storageGroup2DriveCapacity', 'storageGroup2DriveType', 'storageGroup2DriveInterface', 'storageGroup2TransferSpeedGbps', 'storageGroup2RaidLevel',
  'storageGroup3Capacity', 'storageGroup3CapacityType', 'storageGroup3DriveCount', 'storageGroup3DriveCapacity', 'storageGroup3DriveType', 'storageGroup3DriveInterface', 'storageGroup3TransferSpeedGbps', 'storageGroup3RaidLevel',
  'bootCapacity', 'bootDriveCount', 'bootDriveType', 'nicCardCount', 'nicPortsPerCard', 'nicTotalPorts',
  'nicSpeedGbpsPerPort', 'nicMedia', 'nicAdapterType', 'nicGroup1CardCount', 'nicGroup1PortsPerCard', 'nicGroup1TotalPorts', 'nicGroup1SpeedGbpsPerPort',
  'nicGroup1Media', 'nicGroup1AdapterType', 'nicGroup2CardCount', 'nicGroup2PortsPerCard', 'nicGroup2TotalPorts', 'nicGroup2SpeedGbpsPerPort', 'nicGroup2Media', 'nicGroup2AdapterType',
  'nicGroup3CardCount', 'nicGroup3PortsPerCard', 'nicGroup3TotalPorts', 'nicGroup3SpeedGbpsPerPort', 'nicGroup3Media', 'nicGroup3AdapterType',
  'gpuCount', 'gpuModel', 'gpuMemoryGb', 'gpuDeploymentType', 'maxLeadTimeDays', 'rackUnits'
] as const;
const allowedRequirementIdSet = new Set<string>(allowedRequirementIds);

const ollamaRequirementSchema = {
  type: 'object',
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: allowedRequirementIds },
          label: { type: 'string' },
          value: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          unit: { type: 'string' },
          required: { type: 'boolean' },
          status: { type: 'string', enum: ['explicit', 'derived', 'unresolved'] },
          comparison: { type: 'string', enum: ['atLeast', 'atMost', 'exact'] },
          note: { type: 'string' }
        },
        required: ['id', 'label', 'required', 'status'],
        additionalProperties: false
      }
    }
  },
  required: ['requirements'],
  additionalProperties: false
} as const;

const systemPrompt = `Extract Cisco rack-server requirements from the text. Return JSON only as {"requirements":[...]}. Each requirement has id, label, value, unit, required, status, comparison, and note. Status is explicit, derived, or unresolved. Never invent missing values or combine distinct requirements.

The input may be informal plain language, shorthand, bullet points, sentences, or mixed expressions. Understand equivalent phrases such as pair/dual/two, each/per/apiece, sticks/modules/DIMMs, gig/gigabit/Gbps, terabyte/TB, fibre/fiber channel, and RAID levels written as words. Preserve the stated meaning, not its surface wording. If wording is genuinely ambiguous and different interpretations would change component selection, emit the relevant requirement as unresolved with no value and put one concise direct clarification question in note. Do not choose the most likely interpretation. Missing sibling fields are optional: one CPU sizing value, one memory sizing value, one NIC constraint, or one GPU constraint can still be useful. Mark a missing clarification field required only when that category cannot be sized safely without it, such as usable storage without a RAID level.

Use these exact IDs:
- serverQuantity: number of servers
- cpuSockets: explicit number of physical CPUs/sockets per server
- cpuTotalCores: explicit total physical cores per server
- cpuCoresPerSocket: explicit cores required in each CPU, only when stated
- cpuClockGhz: minimum CPU base clock in GHz
- cpuVendor: intel or amd when explicit
- memoryGb: installed memory capacity in GB. Convert an explicitly stated TB value using 1 TB = 1024 GB
- memoryModuleCount and memoryModuleSizeGb: discrete DIMM population when explicitly stated. Preserve a standalone module-size requirement even when module count is omitted, for example "1TB using 64GB DDR5" means memoryGb 1024 and memoryModuleSizeGb 64
- localStorageCapacity: local-drive capacity; preserve the stated unit exactly as TB or GB
- localStorageCapacityType: explicit raw or usable when stated. For an aggregate capacity, RAID without raw/usable means usable; no RAID means raw. For an explicit drive count and capacity per drive, raw/usable remains explicit when stated and otherwise means raw
- raidLevel: RAID level as text
- localDriveCount, localDriveCapacity, localDriveInterface, and localDriveTransferSpeedGbps: discrete local-drive population, SAS/SATA interface, and transfer rate when explicitly stated
- localDriveType: HDD, SSD, SAS HDD, SATA HDD, SAS SSD, SATA SSD, U.2 NVMe, U.3 NVMe, or NVMe when explicit
- storageGroup1Capacity, storageGroup1CapacityType, storageGroup1DriveCount, storageGroup1DriveCapacity, storageGroup1DriveType, storageGroup1DriveInterface, storageGroup1TransferSpeedGbps, storageGroup1RaidLevel (and later group equivalents): preserve each drive group separately. Capacity may be empty when drive count plus capacity per drive is present, and those two fields may be empty when aggregate capacity is present. Apply raw/usable inference independently to each group. When usable capacity is requested without a RAID statement, leave RAID level unresolved and ask which RAID level. When count plus capacity per drive has no RAID statement, leave RAID level unresolved so the user can choose a RAID level or no RAID/HBA pass-through. RAID 1 always uses exactly two drives
- bootCapacity: boot-drive capacity per drive; preserve the stated unit exactly as TB or GB
- bootDriveCount: explicit number of boot drives
- bootDriveType: M.2, M.2 SATA, M.2 NVMe, SSD, NVMe, or HDD. Every M.2 drive is boot media even when the word boot is omitted
- nicCardCount: explicit number of NIC adapter cards
- nicPortsPerCard: ports required on each NIC card
- nicSpeedGbpsPerPort: required speed of each port in Gbps
- nicMedia: required port/connection family. Normalize SFP and Small Form-factor Pluggable to SFP; QSFP and Quad Small Form-factor Pluggable to QSFP; RJ45, RJ-45, BASE-T, BASET, and UTP to BASE-T; FC, Fibre Channel, and Fiber Channel to FC
- nicTotalPorts: total required ports only when no physical card topology is stated; never invent a card count
- nicAdapterType and nicGroup1AdapterType (and Group2/Group3 equivalents): VIC or OCP only when explicitly stated
- nicGroup1CardCount, nicGroup1PortsPerCard, nicGroup1TotalPorts, nicGroup1SpeedGbpsPerPort, nicGroup1Media (and Group2/Group3 equivalents): preserve each distinct NIC/HBA requirement separately. Use TotalPorts for compact groups such as 4x 10G SFP when no card topology is stated. In card-topology shorthand, dual and dual-port always mean 2 ports on each NIC; quad and quad-port always mean 4 ports on each NIC. A leading <count>x before dual or quad is the NIC card count, not a port count. For example, "2x quad 10G" means CardCount 2, PortsPerCard 4, and SpeedGbpsPerPort 10; "2x dual-port 32G FC" means CardCount 2, PortsPerCard 2, SpeedGbpsPerPort 32, and Media FC. Do not multiply these values into TotalPorts
- gpuCount, gpuModel, gpuMemoryGb, and gpuDeploymentType (front mezzanine or PCIe Node) when explicit. Preserve H200 and H200-NVL as explicit model names
- maxLeadTimeDays and rackUnits when explicit

Do not emit null values except for a required unresolved field that asks a material clarification. Do not emit total NIC throughput, nicPorts, or nicThroughputGbps. Preserve TB or GB for local and boot drive capacity, but memoryGb must always be GB. Use comparison atMost for maxLeadTimeDays and atLeast for minimum capacity, clock, cores, cards, ports, and speed.`;

const numberWords: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

type StructuredLabel = 'Server Quantity' | 'CPU' | 'Memory' | 'Drive' | 'Boot' | 'NIC' | 'GPU' | 'Rack Units' | 'Lead Time';

function canonicalStructuredLabel(value: string): StructuredLabel | undefined {
  const label = value.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\s+(?:raw|usable|net)$/, '');
  if (/^(?:server\s+quantity|server\s+count|quantity|number\s+of\s+servers)$/.test(label)) return 'Server Quantity';
  if (/^(?:cpu(?:\s+requirements?)?|processors?)$/.test(label)) return 'CPU';
  if (/^(?:memory(?:\s+requirements?)?|ram(?:\s+capacity)?)$/.test(label)) return 'Memory';
  if (/^(?:drives?|storage|local\s+(?:drives?|storage|capacity))$/.test(label)) return 'Drive';
  if (/^(?:boot|boot\s+(?:drives?|storage))$/.test(label)) return 'Boot';
  if (/^(?:nics?|network(?:\s+adapters?)?|connectivity)$/.test(label)) return 'NIC';
  if (/^(?:gpus?|accelerators?)$/.test(label)) return 'GPU';
  if (/^(?:rack\s+units?|rack\s+size|ru)$/.test(label)) return 'Rack Units';
  if (/^(?:lead\s+time|delivery(?:\s+time)?)$/.test(label)) return 'Lead Time';
  return undefined;
}

function nestedStructuredValue(category: StructuredLabel, key: string, value: string): string {
  const normalizedKey = key.trim().replace(/\s+/g, ' ').toLowerCase();
  if (category === 'CPU') {
    if (/^(?:socket|sockets|socket count|cpu count|processor count)$/.test(normalizedKey)) return `${value} sockets`;
    if (/^(?:cores per socket|cores per cpu|cores per processor)$/.test(normalizedKey)) return `${value} cores per socket`;
    if (/^(?:total cores|core count|cores)$/.test(normalizedKey)) return `${value} cores total`;
    if (/^(?:clock|clock speed|base clock|minimum clock)$/.test(normalizedKey)) return value;
  }
  if (category === 'Memory') {
    if (/^(?:capacity|total|installed)$/.test(normalizedKey)) return value;
    if (/^(?:dimm count|module count|modules|dimms)$/.test(normalizedKey)) return `DIMM count: ${value}`;
    if (/^(?:dimm size|module size|size per dimm)$/.test(normalizedKey)) return `DIMM size: ${value}`;
  }
  if (category === 'Drive') {
    if (/^(?:capacity|size)$/.test(normalizedKey)) return value;
    if (/^(?:type|media|drive type)$/.test(normalizedKey)) return value;
    if (/^(?:raid|raid level)$/.test(normalizedKey)) return `RAID ${value}`;
  }
  if (category === 'NIC') {
    if (/^(?:cards|card count|adapters|adapter count)$/.test(normalizedKey)) return `${value} cards`;
    if (/^(?:ports per card|ports per adapter)$/.test(normalizedKey)) return `${value} ports per card`;
    if (/^(?:speed|port speed|speed per port)$/.test(normalizedKey)) return value;
    if (/^(?:media|port type|connection)$/.test(normalizedKey)) return value;
  }
  return `${key}: ${value}`;
}

function normalizeStructuredLayout(value: string): string {
  const labelPattern = '(?:Server\\s+Quantity|Server\\s+Count|Number\\s+of\\s+Servers|CPU(?:\\s+Requirements?)?|Processors?|Memory(?:\\s+Requirements?)?|RAM(?:\\s+Capacity)?|Drives?(?:\\s+(?:raw|usable|net))?|Storage(?:\\s+(?:raw|usable|net))?|Local\\s+(?:Drives?|Storage|Capacity)(?:\\s+(?:raw|usable|net))?|Boot(?:\\s+(?:Drives?|Storage))?|NICs?|Network(?:\\s+Adapters?)?|Connectivity|GPUs?|Accelerators?|Rack\\s+Units?|Rack\\s+Size|RU|Lead\\s+Time|Delivery(?:\\s+Time)?)';
  const splitCategories = value.replace(new RegExp(`;\\s*(?=${labelPattern}\\s*(?::|=|[–—]|\\s-\\s))`, 'gi'), '\n');
  const tableExpanded = splitCategories.split(/\r?\n/).map((line) => {
    if (!/^\s*\|.*\|\s*$/.test(line)) return line;
    const cells = line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
    const label = canonicalStructuredLabel(cells[0] ?? '');
    return label && cells[1] && !/^:?-{2,}:?$/.test(cells[1]) ? `${label}: ${cells.slice(1).join(', ')}` : line;
  });
  const result: string[] = [];
  let active: { label: StructuredLabel; parts: string[] } | undefined;
  const flush = () => {
    if (!active) return;
    result.push(`${active.label}: ${active.parts.join(', ')}`.trimEnd());
    active = undefined;
  };
  for (const originalLine of tableExpanded) {
    const line = originalLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!line) { flush(); continue; }
    const topLevel = line.match(new RegExp(`^(${labelPattern})\\s*(?::|=|[–—]|\\s-\\s)\\s*(.*)$`, 'i'));
    const label = topLevel ? canonicalStructuredLabel(topLevel[1]!) : undefined;
    if (label) {
      flush();
      const capacityType = topLevel![1]!.match(/\b(raw|usable|net)\s*$/i)?.[1];
      const rawInitial = topLevel![2]!.trim();
      const initial = label === 'Drive' && capacityType ? `${capacityType} ${rawInitial}` : rawInitial;
      if (['Server Quantity', 'Rack Units', 'Lead Time'].includes(label)) result.push(`${label}: ${initial}`);
      else active = { label, parts: initial ? [initial] : [] };
      continue;
    }
    const nested = active ? line.match(/^([^:=]{1,40})\s*[:=]\s*(.+)$/) : undefined;
    if (active && nested) {
      active.parts.push(nestedStructuredValue(active.label, nested[1]!, nested[2]!));
      continue;
    }
    flush();
    result.push(line);
  }
  flush();
  return result.join('\n');
}

function normalizeFlexibleInput(value: string): string {
  const numberPattern = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](one|two|three|four|five|six|seven|eight|nine))?\b/gi;
  return normalizeStructuredLayout(value)
    .replace(/[×✕]/g, 'x')
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
    .replace(/\b(?:a\s+)?pair\s+of\b/gi, '2')
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine)\s+point\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi, (_, whole: string, decimal: string) => `${numberWords[whole.toLowerCase()]}.${numberWords[decimal.toLowerCase()]}`)
    .replace(numberPattern, (_, tens: string, ones?: string) => String((numberWords[tens.toLowerCase()] ?? 0) + (ones ? numberWords[ones.toLowerCase()] ?? 0 : 0)))
    .replace(/\bterabytes?\b/gi, 'TB')
    .replace(/\bgigabytes?\b/gi, 'GB')
    .replace(/\b(\d+(?:\.\d+)?)\s*TiB\b/gi, '$1TB')
    .replace(/\b(\d+(?:\.\d+)?)\s*GiB\b/gi, '$1GB')
    .replace(/\bgigabits?\s*(?:per\s*second|\/\s*s)\b/gi, 'Gbps')
    .replace(/\b(\d+(?:\.\d+)?)\s*gigs?\b/gi, '$1G')
    .replace(/\bmegatransfers?\s*(?:per\s*second|\/\s*s)\b/gi, 'MT/s')
    .replace(/\b(\d+(?:\.\d+)?)\s*MHz\b/gi, (_, mhz: string) => `${Number(mhz) / 1000}GHz`)
    .replace(/\bRAID\s*(?:1\s*\+\s*0|0\s*\+\s*1)\b/gi, 'RAID 10')
    .replace(/\bRAID\s+(zero|one|five|six|ten|fifty|sixty)\b/gi, (_, word: string) => `RAID ${numberWords[word.toLowerCase()]}`)
    .replace(/\b(\d+)\s+(?=\d+(?:\.\d+)?\s*(?:TB|GB)\b(?:(?:U\.[23])|[^.;\n]){0,40}\b(?:drives?|SSDs?|HDDs?|NVMe)\b)/gi, '$1x ');
}

export function parseRequirements(text: string): Requirement[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  let value: unknown;
  try { value = JSON.parse(candidate); }
  catch {
    const start = Math.min(...[candidate.indexOf('['), candidate.indexOf('{')].filter((index) => index >= 0));
    const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
    if (!Number.isFinite(start) || end <= start) throw new Error('Provider returned invalid JSON. Try again or choose another model.');
    try { value = JSON.parse(candidate.slice(start, end + 1)); }
    catch { throw new Error('Provider returned invalid JSON. Try again or choose another model.'); }
  }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const requirements = Array.isArray(value) ? value : record && Array.isArray(record.requirements) ? record.requirements : record && Array.isArray(record.items) ? record.items : undefined;
  if (!requirements) throw new Error('Provider JSON did not contain a requirements array. Try again or choose another model.');
  return requirements.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Requirement ${index + 1} is not an object.`);
    const item = raw as Partial<Requirement>;
    return { ...item, id: String(item.id || `requirement-${index + 1}`), label: String(item.label || item.id || `Requirement ${index + 1}`), required: item.required ?? true, status: item.status ?? (item.value === undefined ? 'unresolved' : 'explicit'), evidence: Array.isArray(item.evidence) ? item.evidence : [] } as Requirement;
  });
}

export function normalizeExtractedRequirements(requirements: Requirement[], sourceText: string): Requirement[] {
  sourceText = normalizeFlexibleInput(sourceText);
  const exactIds = new Set(['cpuSockets', 'bootDriveCount', 'bootDriveType', 'nicCardCount', 'nicMedia', 'nicAdapterType', 'nicGroup1CardCount', 'nicGroup1Media', 'nicGroup1AdapterType', 'nicGroup2CardCount', 'nicGroup2Media', 'nicGroup2AdapterType', 'nicGroup3CardCount', 'nicGroup3Media', 'nicGroup3AdapterType', 'serverQuantity', 'cpuVendor', 'gpuModel', 'gpuDeploymentType', 'localStorageCapacityType', 'raidLevel', 'memoryModuleCount', 'memoryModuleSizeGb', 'localDriveCount', 'localDriveCapacity', 'localDriveType', 'localDriveInterface', 'storageGroup1CapacityType', 'storageGroup1DriveCount', 'storageGroup1DriveCapacity', 'storageGroup1DriveType', 'storageGroup1DriveInterface', 'storageGroup1RaidLevel', 'storageGroup2CapacityType', 'storageGroup2DriveCount', 'storageGroup2DriveCapacity', 'storageGroup2DriveType', 'storageGroup2DriveInterface', 'storageGroup2RaidLevel', 'storageGroup3CapacityType', 'storageGroup3DriveCount', 'storageGroup3DriveCapacity', 'storageGroup3DriveType', 'storageGroup3DriveInterface', 'storageGroup3RaidLevel']);
  const minimumIds = new Set(['cpuTotalCores', 'cpuCoresPerSocket', 'cpuClockGhz', 'memoryGb', 'localStorageCapacity', 'bootCapacity', 'nicPortsPerCard', 'nicTotalPorts', 'nicSpeedGbpsPerPort', 'nicGroup1PortsPerCard', 'nicGroup1TotalPorts', 'nicGroup1SpeedGbpsPerPort', 'nicGroup2PortsPerCard', 'nicGroup2TotalPorts', 'nicGroup2SpeedGbpsPerPort', 'nicGroup3PortsPerCard', 'nicGroup3TotalPorts', 'nicGroup3SpeedGbpsPerPort', 'gpuCount', 'gpuMemoryGb', 'localDriveTransferSpeedGbps', 'storageGroup1Capacity', 'storageGroup1TransferSpeedGbps', 'storageGroup2Capacity', 'storageGroup2TransferSpeedGbps', 'storageGroup3Capacity', 'storageGroup3TransferSpeedGbps']);
  const disallowed = new Set(['nicPorts', 'nicThroughputGbps']);
  const units: Record<string, string> = { cpuClockGhz: 'GHz', memoryGb: 'GB', memoryModuleSizeGb: 'GB', gpuMemoryGb: 'GB', nicSpeedGbpsPerPort: 'Gbps', nicGroup1SpeedGbpsPerPort: 'Gbps', nicGroup2SpeedGbpsPerPort: 'Gbps', nicGroup3SpeedGbpsPerPort: 'Gbps', localDriveTransferSpeedGbps: 'Gbps', storageGroup1TransferSpeedGbps: 'Gbps', storageGroup2TransferSpeedGbps: 'Gbps', storageGroup3TransferSpeedGbps: 'Gbps', maxLeadTimeDays: 'days' };
  const normalized = requirements.filter((requirement) => allowedRequirementIdSet.has(requirement.id) && !disallowed.has(requirement.id) && requirement.value !== null && requirement.value !== undefined && requirement.value !== '').map((requirement) => {
    const result = { ...requirement };
    const originalUnit = String(result.unit ?? '').toUpperCase();
    if (result.id === 'cpuCores') result.id = 'cpuTotalCores';
    if (result.id === 'memoryTb') { result.id = 'memoryGb'; if (typeof result.value === 'number') result.value *= 1024; result.unit = 'GB'; }
    else if (result.id === 'memoryGb' && originalUnit === 'TB' && typeof result.value === 'number') { result.value *= 1024; result.unit = 'GB'; }
    if (result.id === 'bootCapacityGb') { result.id = 'bootCapacity'; result.unit = 'GB'; }
    if (result.id === 'rawStorageTb' || result.id === 'usableStorageTb') { result.id = 'localStorageCapacity'; result.unit = 'TB'; }
    if (result.comparison && !['atLeast', 'atMost', 'exact'].includes(result.comparison)) delete result.comparison;
    if (exactIds.has(result.id)) result.comparison = 'exact';
    if (minimumIds.has(result.id)) result.comparison = 'atLeast';
    if (result.id === 'maxLeadTimeDays') result.comparison = 'atMost';
    const normalizedUnit = units[result.id]; if (normalizedUnit) result.unit = normalizedUnit;
    if (result.id === 'localStorageCapacity' || result.id === 'bootCapacity') {
      const statedUnit = String(result.unit ?? '').toUpperCase();
      if (statedUnit === 'TB' || statedUnit === 'GB') result.unit = statedUnit;
    }
    if (result.value !== undefined && result.value !== '') { result.status = 'explicit'; result.required = true; }
    return result;
  });
  const remove = (...ids: string[]) => { for (const id of ids) { const index = normalized.findIndex((item) => item.id === id); if (index >= 0) normalized.splice(index, 1); } };
  const removeMatching = (pattern: RegExp) => { for (let index = normalized.length - 1; index >= 0; index -= 1) if (pattern.test(normalized[index]!.id)) normalized.splice(index, 1); };
  const replace = (id: string, label: string, value: number | string | undefined, options: { unit?: string; comparison?: Requirement['comparison']; status?: Requirement['status']; note?: string; required?: boolean } = {}) => {
    const existing = normalized.find((requirement) => requirement.id === id);
    const next: Requirement = { id, label, ...(value === undefined ? {} : { value }), ...(options.unit ? { unit: options.unit } : {}), comparison: options.comparison ?? (exactIds.has(id) ? 'exact' : 'atLeast'), status: options.status ?? (value === undefined ? 'unresolved' : 'explicit'), required: options.required ?? true, evidence: existing?.evidence ?? [], ...(options.note ? { note: options.note } : {}) };
    if (existing) { Object.assign(existing, next); if (value === undefined) delete existing.value; } else normalized.push(next);
  };
  const socketMatch = sourceText.match(/^\s*CPU\s*(?:[:=]|is)?\s*(\d+)\s*x\s*\d+\s*[- ]?cores?\b/im)
    ?? sourceText.match(/\b(\d+)\s*(?:x|-)\s*(?:\d+\s*[- ]?core\s+)?(?:(?:intel|amd)\s+)?(?:CPUs?|processors?|sockets?)\b/i)
    ?? sourceText.match(/\b(\d+)\s*(?:x\s*)?(?:(?:intel|amd)\s+)?\d+\s*[- ]?core\s+(?:(?:intel|amd)\s+)?(?:CPUs?|processors?)\b/i)
    ?? sourceText.match(/\b(\d+)\s+(?:physical\s+)?(?:CPUs?(?!\s+cores?)|processors?|sockets?)\b/i)
    ?? sourceText.match(/\b(?:number\s+of\s+)?(?:physical\s+)?(?:CPUs?\s*\/\s*sockets?|processors?|sockets?)(?:\s+per\s+server)?\s*(?:count|quantity)?\s*[:=]\s*(\d+)\b/i)
    ?? sourceText.match(/\b(?:CPU|processor)\s+(?:count|quantity)(?:\s+per\s+server)?\s*[:=]\s*(\d+)\b/i);
  const socketWordMatch = sourceText.match(/\b(one|two|three|four)\s+(?:physical\s+)?(?:CPUs?|processors?|sockets?)\b/i);
  const socketCount = socketMatch ? Number(socketMatch[1]) : socketWordMatch ? ({ one: 1, two: 2, three: 3, four: 4 } as const)[socketWordMatch[1]!.toLowerCase() as 'one' | 'two' | 'three' | 'four'] : /\bdual[- ]socket\b/i.test(sourceText) ? 2 : /\bsingle[- ]socket\b/i.test(sourceText) ? 1 : undefined;
  if (socketCount) replace('cpuSockets', 'CPU sockets', socketCount);
  else remove('cpuSockets');
  const coresEachMatch = sourceText.match(/\b\d+\s*[- ]sockets?\s*[,;:]?\s*(\d+)\s*[- ]?cores?\b/i)
    ?? sourceText.match(/\b\d+\s*x\s*(\d+)\s*[- ]?core\b/i)
    ?? sourceText.match(/\b\d+\s*x\s*(?:(?:intel|amd)\s+)?(\d+)\s*[- ]?core\b/i)
    ?? sourceText.match(/\b\d+\s+(?:(?:intel|amd)\s+)?(\d+)\s*[- ]?core\s+(?:(?:intel|amd)\s+)?(?:CPUs?|processors?)\b/i)
    ?? sourceText.match(/\b(\d+)\s+cores?\s+(?:each|apiece|per\s+(?:CPU|processor|socket))\b/i)
    ?? sourceText.match(/\b(?:each|every)\s+(?:CPU|processor|socket)[^.;\n\d]{0,20}(\d+)\s*[- ]?cores?\b/i);
  const totalCoresMatch = sourceText.match(/\b(\d+)\s+(?:physical\s+)?(?:CPU\s+)?cores?\s+total\b/i)
    ?? sourceText.match(/\btotal(?:\s+of)?\s+(\d+)\s+(?:physical\s+)?cores?\b/i)
    ?? sourceText.match(/\b(\d+)\s+(?:physical\s+)?cores?\s+(?:across|shared\s+across|split\s+(?:between|across))\s+\d+\s+(?:CPUs?|processors?|sockets?)\b/i);
  const looseCoreMatch = sourceText.match(/(?:\bCPU\b|\bprocessors?\b|\bsockets?\b)[^.;\n\d]{0,24}(\d+)\s*[- ]?cores?\b/i)
    ?? sourceText.match(/\b(\d+)\s*[- ]?cores?\b[^.;\n]{0,24}(?:\bCPU\b|\bprocessors?\b|\bsockets?\b)/i);
  const ambiguousCoreCount = socketCount && looseCoreMatch && !coresEachMatch && !totalCoresMatch ? Number(looseCoreMatch[1]) : undefined;
  const coresEach = coresEachMatch ? Number(coresEachMatch[1]) : socketCount && totalCoresMatch ? Number(totalCoresMatch[1]) / socketCount : undefined;
  const totalCores = totalCoresMatch ? Number(totalCoresMatch[1]) : socketCount && coresEach ? socketCount * coresEach : !socketCount && looseCoreMatch ? Number(looseCoreMatch[1]) : undefined;
  if (coresEach && Number.isInteger(coresEach)) replace('cpuCoresPerSocket', 'Physical cores per CPU/socket', coresEach, { status: coresEachMatch ? 'explicit' : 'derived' });
  else if (ambiguousCoreCount) replace('cpuCoresPerSocket', 'Physical cores per CPU/socket', undefined, { status: 'unresolved', required: false, note: `Does ${ambiguousCoreCount} cores mean total cores per server or cores per CPU? Complete either total cores or cores per CPU.` });
  else remove('cpuCoresPerSocket');
  if (totalCores) replace('cpuTotalCores', 'Total CPU cores', totalCores, { status: totalCoresMatch || !socketCount ? 'explicit' : 'derived' });
  else if (ambiguousCoreCount) replace('cpuTotalCores', 'Total CPU cores', undefined, { status: 'unresolved', required: false, note: `Does ${ambiguousCoreCount} cores mean total cores per server or cores per CPU? Complete either total cores or cores per CPU.` });
  else remove('cpuTotalCores');
  const clockMatch = sourceText.match(/\b(\d+(?:\.\d+)?)\s*GHz\b/i);
  if (clockMatch) replace('cpuClockGhz', 'Minimum CPU base clock', Number(clockMatch[1]), { unit: 'GHz' }); else remove('cpuClockGhz');

  const dimmMatch = sourceText.match(/\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*GB(?:\s+DDR\d+)?\s+DIMMs?\b/i)
    ?? sourceText.match(/\b(?:memory|RAM)\s*:\s*(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*GB\b/i)
    ?? sourceText.match(/\binstall\s+(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*GB(?:\s+DDR\d+)?\b/i)
    ?? sourceText.match(/\b(\d+)\s+(?:memory\s+)?(?:DIMMs?|sticks?|modules?)\s+(?:of|at|each\s+with)\s+(\d+(?:\.\d+)?)\s*GB\b/i)
    ?? sourceText.match(/\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*GB\s+(?:memory\s+)?(?:sticks?|modules?)\b/i);
  const aggregateMemoryMatch = sourceText.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\s+(?:of\s+)?(?:RAM|memory)\b/i)
    ?? sourceText.match(/\b(?:RAM|memory)[^\S\r\n]*(?:[:=]|is)?[^\S\r\n]*(?:minimum|min(?:imum)?\.?\s*)?(\d+(?:\.\d+)?)[^\S\r\n]*(TB|GB)\b/i);
  const partialModuleCount = sourceText.match(/\b(?:DIMM|memory\s+module)\s*(?:count|quantity)\s*[:=]\s*(\d+)\b/i)?.[1]
    ?? sourceText.match(/\b(\d+)\s+(?:DIMMs?|memory\s+modules?)\b/i)?.[1];
  const partialModuleSize = sourceText.match(/\b(?:DIMM|memory\s+module)\s*size\s*[:=]\s*(\d+(?:\.\d+)?)\s*GB\b/i)?.[1]
    ?? sourceText.match(/\b(?:using|with|use|prefer(?:red)?|preference\s*(?:is|:)?)[^\S\r\n]*(\d+(?:\.\d+)?)\s*GB(?:\s+DDR\d+)?(?:\s+(?:DIMMs?|memory\s+modules?|modules?))?\b/i)?.[1]
    ?? sourceText.match(/^\s*(?:Memory|RAM)[^\n]*?\b(\d+(?:\.\d+)?)\s*GB\s+(?:DDR\d+|DIMMs?|memory\s+modules?|modules?)\b/im)?.[1];
  if (dimmMatch) {
    const count = Number(dimmMatch[1]); const size = Number(dimmMatch[2]);
    replace('memoryModuleCount', 'DIMM count', count, { comparison: 'exact' });
    replace('memoryModuleSizeGb', 'DIMM size', size, { unit: 'GB', comparison: 'exact' });
    replace('memoryGb', 'Capacity', count * size, { unit: 'GB', status: 'derived' });
  } else if (aggregateMemoryMatch) {
    replace('memoryGb', 'Capacity', Number(aggregateMemoryMatch[1]) * (aggregateMemoryMatch[2]!.toUpperCase() === 'TB' ? 1024 : 1), { unit: 'GB' });
    remove('memoryModuleCount', 'memoryModuleSizeGb');
    if (partialModuleCount) replace('memoryModuleCount', 'DIMM count', Number(partialModuleCount), { comparison: 'exact' });
    if (partialModuleSize) replace('memoryModuleSizeGb', 'DIMM size', Number(partialModuleSize), { unit: 'GB', comparison: 'exact' });
  } else {
    remove('memoryGb', 'memoryModuleCount', 'memoryModuleSizeGb');
    if (partialModuleCount) replace('memoryModuleCount', 'DIMM count', Number(partialModuleCount), { comparison: 'exact' });
    if (partialModuleSize) replace('memoryModuleSizeGb', 'DIMM size', Number(partialModuleSize), { unit: 'GB', comparison: 'exact' });
  }

  const bootClause = sourceText.split(/\n|;|\.(?=\s|$)/).find((part) => /\b(?:boot|OS|operating\s+system|M\.?\s*2)\b/i.test(part));
  const m2Clause = bootClause && /\bM\.?\s*2\b/i.test(bootClause) ? bootClause : undefined;
  const bootContext = Boolean(bootClause);
  const explicitBootType = bootClause ? m2Clause ? /\bNVMe\b/i.test(m2Clause) ? 'M.2 NVMe' : /\bSATA\b/i.test(m2Clause) ? 'M.2 SATA' : 'M.2' : /\bNVMe\b/i.test(bootClause) ? 'NVMe' : /\bSSD\b/i.test(bootClause) ? 'SSD' : /\bHDD\b/i.test(bootClause) ? 'HDD' : undefined : undefined;
  const bootCapacityMatch = bootClause?.match(/(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
  const bootCountMatch = bootClause?.match(/\b(\d+)\s*x\s*\d+(?:\.\d+)?\s*(?:TB|GB)\b/i);
  if (bootCapacityMatch) replace('bootCapacity', 'Boot drive capacity', Number(bootCapacityMatch[1]), { unit: bootCapacityMatch[2]!.toUpperCase() });
  if (bootCountMatch) replace('bootDriveCount', 'Boot drive count', Number(bootCountMatch[1]), { comparison: 'exact' });
  else remove('bootDriveCount');
  if (explicitBootType && bootContext) replace('bootDriveType', 'Boot drive type', explicitBootType, { comparison: 'exact' });
  if (!bootContext) remove('bootCapacity', 'bootDriveCount', 'bootDriveType');

  const storageText = sourceText.split(/\n|;|\.(?=\s|$)/).filter((part) => !/\b(?:boot|OS|operating\s+system|M\.?\s*2)\b/i.test(part)).join('\n');
  const raidPattern = '(?:00|60|50|10|[0156])';
  const storageGroupPattern = new RegExp(`(\\d+(?:\\.\\d+)?)[^\\S\\r\\n]*(TB|GB)[^\\S\\r\\n]*(raw|usable|net)?(?:(?:U\\.[23])|[^.;\\n]){0,30}?RAID[^\\S\\r\\n]*(${raidPattern})\\b`, 'gi');
  const raidStorageGroups = [...storageText.matchAll(storageGroupPattern)];
  const keyedStorageMatch = storageText.match(/^\s*(?:drives?|storage|local\s+(?:drives?|storage|capacity))\s*(raw|usable|net)?\s*(?:[:=]|is)?\s*(raw|usable|net)?\s*(\d+(?:\.\d+)?)\s*(TB|GB)\b[^\n]*/im);
  const sharedStorageType = (keyedStorageMatch?.[1] ?? keyedStorageMatch?.[2])?.toLowerCase();
  const driveMatchCandidate = storageText.match(/\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(TB|GB)\b(?=[^.;\n]{0,80}\b(?:(?:U\.[23]\s*)?NVMe|SSDs?|HDDs?|drives?)\b)/i);
  const driveMatchContext = driveMatchCandidate?.index === undefined ? '' : storageText.slice(Math.max(0, driveMatchCandidate.index - 20), driveMatchCandidate.index + driveMatchCandidate[0].length + 80);
  const driveMatch = driveMatchCandidate && !/\bM\.?\s*2\b/i.test(driveMatchContext) ? driveMatchCandidate : null;
  const driveInterfaceFromText = (text: string) => /\bSAS\b/i.test(text) ? 'SAS' : /\bSATA\b/i.test(text) ? 'SATA' : /\bNVMe\b/i.test(text) ? 'NVMe' : undefined;
  const transferSpeedFromText = (text: string) => Number(text.match(/\b(?:SAS|SATA)\b[^\n;]{0,40}?\b(\d+(?:\.\d+)?)\s*G(?:bps|b\/s)?\b/i)?.[1] ?? text.match(/\b(\d+(?:\.\d+)?)\s*G(?:bps|b\/s)?\b[^\n;]{0,40}?\b(?:SAS|SATA)\b/i)?.[1] ?? 0) || undefined;
  const driveTypeFromText = (text: string) => /\bU\.2\s*NVMe\b|\bNVMe\s*U\.2\b/i.test(text) ? 'U.2 NVMe' : /\bU\.3\s*NVMe\b|\bNVMe\s*U\.3\b/i.test(text) ? 'U.3 NVMe' : /\bNVMe\b/i.test(text) ? 'NVMe' : /\bSSDs?\b/i.test(text) ? /\bSAS\b/i.test(text) ? 'SAS SSD' : /\bSATA\b/i.test(text) ? 'SATA SSD' : 'SSD' : /\bHDDs?\b/i.test(text) ? /\bSAS\b/i.test(text) ? 'SAS HDD' : /\bSATA\b/i.test(text) ? 'SATA HDD' : 'HDD' : undefined;
  const localDriveType = driveTypeFromText(storageText);
  const allDrivesClause = storageText.match(/\ball\s+(?:the\s+)?drives?\b[^.;\n]{0,40}/i)?.[0];
  const sharedAllDriveType = allDrivesClause ? driveTypeFromText(allDrivesClause) : undefined;
  const ambiguousCapacityType = /\b(?:raw\s+or\s+usable|whether[^.\n]{0,30}\braw\b[^.\n]{0,30}\busable\b|does\s+not\s+say[^.\n]{0,40}\braw\b[^.\n]{0,30}\busable\b)/i.test(storageText);
  const storageContexts = storageText.split(/\n|;\s*|\.(?=\s|$)\s*/).filter((part) => /\b\d+(?:\.\d+)?\s*(?:TB|GB)\b/i.test(part) && /\b(?:drives?|storage|capacity|JBOD|SSD|HDD|NVMe)\b|\bRAID\s*\d/i.test(part));
  const contextualStorageGroups = storageContexts.flatMap((context) => {
    const capacities = [...context.matchAll(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\b/gi)];
    const parsed = capacities.flatMap((capacity, index) => {
      const segment = context.slice(capacity.index, capacities[index + 1]?.index ?? context.length);
      const prefix = context.slice(0, capacity.index);
      const isStorageCapacity = /\b(?:drives?|storage|capacity|JBOD|SSD|HDD|NVMe)\b|\bRAID\s*\d/i.test(segment) || (index === 0 && /\b(?:drives?|storage|capacity)\b/i.test(prefix));
      if (!isStorageCapacity || /\b(?:RAM|memory|DIMMs?)\b/i.test(segment) && !/\b(?:drives?|storage|RAID|JBOD)\b/i.test(segment)) return [];
      const driveCount = Number(prefix.match(/(\d+)\s*x\s*$/i)?.[1] ?? 0) || undefined;
      const driveCapacity = Number(capacity[1]);
      const explicitType = segment.match(/\b(raw|usable|net)\b/i)?.[1]?.toLowerCase() ?? sharedStorageType;
      const raidLevel = segment.match(new RegExp(`\\bRAID\\s*(${raidPattern})\\b`, 'i'))?.[1];
      const inferredType = ambiguousCapacityType ? undefined : explicitType === 'net' ? 'usable' : explicitType ?? (driveCount ? 'raw' : raidLevel ? 'usable' : 'raw');
      return [{ capacity: driveCount ? undefined : driveCapacity, unit: capacity[2]!.toUpperCase(), capacityType: inferredType, capacityTypeExplicit: Boolean(explicitType), driveCount, driveCapacity: driveCount ? driveCapacity : undefined, driveType: driveTypeFromText(segment) ?? sharedAllDriveType, driveInterface: driveInterfaceFromText(segment), transferSpeedGbps: transferSpeedFromText(segment), raidLevel, sourceIndex: index }];
    });
    const absorbed = new Set<number>();
    for (const [parsedIndex, group] of parsed.entries()) {
      if (!group.driveCount || !group.driveCapacity) continue;
      const aggregateIndex = parsed.findIndex((candidate, candidateIndex) => candidateIndex > parsedIndex && candidate.capacity !== undefined && candidate.capacityTypeExplicit);
      if (aggregateIndex < 0) continue;
      const aggregate = parsed[aggregateIndex]!;
      const firstCapacity = capacities[group.sourceIndex]!;
      const aggregateCapacity = capacities[aggregate.sourceIndex]!;
      const bridge = context.slice((firstCapacity.index ?? 0) + firstCapacity[0].length, aggregateCapacity.index ?? context.length);
      if (!/\b(?:provid(?:e|es|ing)|yield(?:s|ed|ing)|result(?:s|ed|ing)(?:\s+in)?)\b/i.test(bridge)) continue;
      group.capacity = aggregate.capacity;
      group.capacityType = aggregate.capacityType;
      group.capacityTypeExplicit = aggregate.capacityTypeExplicit;
      absorbed.add(aggregateIndex);
    }
    return parsed.filter((_group, index) => !absorbed.has(index)).map(({ sourceIndex, ...group }) => {
      void sourceIndex;
      return group;
    });
  });
  const storageGroups = contextualStorageGroups.length > 1 ? contextualStorageGroups : raidStorageGroups.map((group) => {
    const explicitType = group[3]?.toLowerCase() ?? sharedStorageType;
    return { capacity: Number(group[1]), unit: group[2]!.toUpperCase(), capacityType: ambiguousCapacityType ? undefined : explicitType === 'net' ? 'usable' : explicitType ?? 'usable', capacityTypeExplicit: Boolean(explicitType), driveCount: undefined, driveCapacity: undefined, driveType: driveTypeFromText(group[0]) ?? sharedAllDriveType, driveInterface: driveInterfaceFromText(group[0]), transferSpeedGbps: transferSpeedFromText(group[0]), raidLevel: group[4] };
  });
  removeMatching(/^storageGroup\d+/);
  if (storageGroups.length > 1) {
    remove('localStorageCapacity', 'localStorageCapacityType', 'raidLevel', 'localDriveCount', 'localDriveCapacity');
    storageGroups.forEach((group, index) => {
      const prefix = `storageGroup${index + 1}`;
      if (group.capacity !== undefined) replace(`${prefix}Capacity`, 'Capacity', group.capacity, { unit: group.unit, comparison: 'atLeast' });
      replace(`${prefix}CapacityType`, 'Capacity type', group.capacityType, { comparison: 'exact', status: group.capacityType === undefined ? 'unresolved' : group.capacityTypeExplicit ? 'explicit' : 'derived', ...(group.capacityType === undefined ? { note: `Is drive group ${index + 1} capacity raw or usable?` } : {}) });
      if (group.driveCount) replace(`${prefix}DriveCount`, 'Drive count', group.driveCount, { comparison: 'exact' });
      if (group.driveCapacity) replace(`${prefix}DriveCapacity`, 'Capacity per drive', group.driveCapacity, { unit: group.unit, comparison: 'exact' });
      if (group.driveType) replace(`${prefix}DriveType`, 'Drive type', group.driveType, { comparison: 'exact' });
      else replace(`${prefix}DriveType`, 'Drive type', undefined, { comparison: 'exact', status: 'unresolved', required: false, note: `What drive type should drive group ${index + 1} use: HDD, SSD, or NVMe?` });
      if (group.driveInterface) replace(`${prefix}DriveInterface`, 'Drive interface', group.driveInterface, { comparison: 'exact' });
      if (group.transferSpeedGbps) replace(`${prefix}TransferSpeedGbps`, 'Transfer speed', group.transferSpeedGbps, { unit: 'Gbps', comparison: 'atLeast' });
      if (group.raidLevel) replace(`${prefix}RaidLevel`, 'RAID level or no RAID', group.raidLevel, { comparison: 'exact' });
      else if (group.capacityType === 'usable') replace(`${prefix}RaidLevel`, 'RAID level or no RAID', undefined, { comparison: 'exact', status: 'unresolved', note: `Which RAID level should drive group ${index + 1} use to provide usable capacity?` });
      else if (group.driveCount) replace(`${prefix}RaidLevel`, 'RAID level or no RAID', undefined, { comparison: 'exact', status: 'unresolved', note: `Should drive group ${index + 1} use RAID? Choose a RAID level or No RAID (HBA pass-through).` });
    });
  } else {
    let capacityValue: number | undefined; let capacityUnit: string | undefined;
    if (driveMatch) { capacityValue = Number(driveMatch[1]) * Number(driveMatch[2]); capacityUnit = driveMatch[3]!.toUpperCase(); replace('localDriveCount', 'Local drive count', Number(driveMatch[1]), { comparison: 'exact' }); replace('localDriveCapacity', 'Local drive capacity', Number(driveMatch[2]), { unit: capacityUnit, comparison: 'exact' }); }
    else {
      remove('localDriveCount', 'localDriveCapacity');
      if (keyedStorageMatch) { capacityValue = Number(keyedStorageMatch[3]); capacityUnit = keyedStorageMatch[4]!.toUpperCase(); }
      else if (contextualStorageGroups[0]?.capacity !== undefined) {
        capacityValue = contextualStorageGroups[0].capacity; capacityUnit = contextualStorageGroups[0].unit;
      } else {
        const capacityMatch = raidStorageGroups[0] ?? storageText.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\s*(?:raw|usable|net)?\s*(?:local\s+(?:storage|capacity)|storage|on\s+RAID|RAID|JBOD)\b/i)
          ?? storageText.match(/\b(?:local\s+(?:storage|capacity)|raw\s+JBOD(?:\s+capacity)?(?:\s+is)?)[^.;\n\d]{0,30}(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
        if (capacityMatch) { capacityValue = Number(capacityMatch[1]); capacityUnit = capacityMatch[2]!.toUpperCase(); }
      }
    }
    if (capacityValue !== undefined && capacityUnit) {
      replace('localStorageCapacity', 'Local storage capacity', capacityValue, { unit: capacityUnit, status: driveMatch ? 'derived' : 'explicit' });
      const keyedCapacityType = (keyedStorageMatch?.[1] ?? keyedStorageMatch?.[2])?.toLowerCase();
      const explicitCapacityType = keyedCapacityType === 'usable' || keyedCapacityType === 'net' ? 'usable' : keyedCapacityType === 'raw' ? 'raw' : /\b(?:usable|net)\b/i.test(storageText) ? 'usable' : /\braw\b/i.test(storageText) || /\bJBOD\b/i.test(storageText) ? 'raw' : undefined;
      const raidMatch = storageText.match(new RegExp(`\\bRAID\\s*(${raidPattern})\\b`, 'i'));
      const capacityType = ambiguousCapacityType ? undefined : explicitCapacityType ?? (driveMatch ? 'raw' : raidMatch ? 'usable' : 'raw');
      replace('localStorageCapacityType', 'Local storage capacity type', capacityType, { comparison: 'exact', status: capacityType === undefined ? 'unresolved' : explicitCapacityType ? 'explicit' : 'derived', ...(capacityType === undefined ? { note: 'Is the requested local-storage capacity raw or usable?' } : {}) });
      if (raidMatch || /\bJBOD\b/i.test(storageText)) replace('raidLevel', 'RAID level or no RAID', raidMatch?.[1] ?? 'JBOD', { comparison: 'exact', status: 'explicit' });
      else if (capacityType === 'usable') replace('raidLevel', 'RAID level or no RAID', undefined, { comparison: 'exact', status: 'unresolved', note: 'Which RAID level should be used to provide the requested usable local-storage capacity?' });
      else if (driveMatch) replace('raidLevel', 'RAID level or no RAID', undefined, { comparison: 'exact', status: 'unresolved', note: 'Should this drive group use RAID? Choose a RAID level or No RAID (HBA pass-through).' });
      else remove('raidLevel');
    } else remove('localStorageCapacity', 'localStorageCapacityType', 'raidLevel', 'localDriveCount', 'localDriveCapacity');
  }
  const hasSingleStorageRequirement = storageGroups.length <= 1 && (storageGroups.length || contextualStorageGroups.length || driveMatch || keyedStorageMatch || normalized.some((item) => item.id === 'localStorageCapacity'));
  if (localDriveType && hasSingleStorageRequirement) replace('localDriveType', 'Local drive type', localDriveType, { comparison: 'exact' });
  else if (hasSingleStorageRequirement) replace('localDriveType', 'Local drive type', undefined, { comparison: 'exact', status: 'unresolved', required: false, note: 'What local drive type should be used: HDD, SSD, or NVMe?' });
  else remove('localDriveType');
  const localDriveInterface = /\bNVMe\b/i.test(String(localDriveType ?? '')) ? 'NVMe'
    : /\bSAS\b/i.test(String(localDriveType ?? '')) ? 'SAS'
      : /\bSATA\b/i.test(String(localDriveType ?? '')) ? 'SATA'
        : driveInterfaceFromText(storageText);
  const localTransferSpeed = transferSpeedFromText(storageText);
  if (localDriveInterface && storageGroups.length <= 1 && (driveMatch || keyedStorageMatch)) replace('localDriveInterface', 'Local drive interface', localDriveInterface, { comparison: 'exact' }); else remove('localDriveInterface');
  if (localTransferSpeed && storageGroups.length <= 1 && (driveMatch || keyedStorageMatch)) replace('localDriveTransferSpeedGbps', 'Local drive transfer speed', localTransferSpeed, { unit: 'Gbps', comparison: 'atLeast' }); else remove('localDriveTransferSpeedGbps');

  const bootCapacity = normalized.find((requirement) => requirement.id === 'bootCapacity');
  if (bootCapacity && !normalized.some((requirement) => requirement.id === 'bootDriveType')) normalized.push({ id: 'bootDriveType', label: 'Boot drive type', status: 'unresolved', required: false, evidence: [], note: 'Optional: choose M.2, SSD, NVMe, or HDD. M.2 will be recommended when available.' });
  const leadTime = sourceText.match(/(?:within|up\s+to|no\s+more\s+than|maximum(?:\s+acceptable)?|max(?:imum)?|lead\s*time\s*(?:<=|is|:)?|target(?:\s+is)?|deliver(?:y|ed|able)?|arrive(?:\s+within|\s+in)?)[^\d\n]{0,40}(\d{1,3})\s*(?:calendar\s*)?days?/i)?.[1];
  if (leadTime) replace('maxLeadTimeDays', 'Maximum component lead time', Number(leadTime), { unit: 'days', comparison: 'atMost' }); else remove('maxLeadTimeDays');
  const vendor = /\bintel\b/i.test(sourceText) ? 'intel' : /\bamd\b/i.test(sourceText) ? 'amd' : undefined;
  if (vendor) replace('cpuVendor', 'CPU vendor', vendor, { comparison: 'exact' }); else remove('cpuVendor');
  remove('gpuCount', 'gpuModel', 'gpuMemoryGb', 'gpuDeploymentType');
  const gpuClause = sourceText.split(/\n|;|\.(?=\s|$)/).find((part) => /\b(?:GPU|NVIDIA|AMD\s+Instinct|L4|L40S?|A16|H200(?:[- ]NVL)?|MI210|RTX\s+PRO)\b/i.test(part));
  if (gpuClause) {
    const gpuCount = Number(gpuClause.match(/\b(\d+)\s*x\s*(?:(?:NVIDIA|AMD)\s+)?(?:GPU|L4|L40S?|A16|H200(?:[- ]NVL)?|MI210|RTX\s+PRO)/i)?.[1]
      ?? gpuClause.match(/\b(\d+)\s+(?:identical\s+)?GPUs?\b/i)?.[1] ?? 0) || undefined;
    const gpuModel = gpuClause.match(/\b(H200(?:[- ]NVL)?|L40S|L40|L4|A16|MI210|RTX\s+PRO\s+(?:6000|4500)(?:\s+Blackwell)?(?:\s+Server\s+Edition)?)\b/i)?.[1];
    const gpuMemory = Number(gpuClause.match(/\b(?:GPU|H200(?:[- ]NVL)?|L40S?|L4|A16|MI210|RTX\s+PRO)[^.;\n]{0,40}?\b(\d+(?:\.\d+)?)\s*GB\b/i)?.[1] ?? 0) || undefined;
    const deployment = /\bPCIe\s*Node\b/i.test(gpuClause) ? 'PCIe Node' : /\bfront\s+mezzanine\b/i.test(gpuClause) ? 'front mezzanine' : undefined;
    if (gpuCount) replace('gpuCount', 'GPU count', gpuCount, { comparison: 'atLeast' });
    else if (gpuModel || gpuMemory || deployment) replace('gpuCount', 'GPU count', undefined, { comparison: 'atLeast', status: 'unresolved', required: false, note: 'How many GPUs are required per server? One GPU will be recommended until clarified.' });
    if (gpuModel) replace('gpuModel', 'GPU model', gpuModel.replace(/\s+/g, ' '), { comparison: 'exact' });
    if (gpuMemory) replace('gpuMemoryGb', 'GPU memory per GPU', gpuMemory, { unit: 'GB', comparison: 'atLeast' });
    if (deployment) replace('gpuDeploymentType', 'GPU deployment type', deployment, { comparison: 'exact' });
  }
  const serverQuantityMatch = sourceText.match(/^\s*Server Quantity\s*:\s*(\d+)\b/im) ?? sourceText.match(/\b(\d+)\s+(?:C-Series\s+)?servers?\b/i) ?? sourceText.match(/\b(one|two|three)\s+(?:C-Series\s+)?servers?\b/i);
  if (serverQuantityMatch) replace('serverQuantity', 'Number of servers', /^one$/i.test(serverQuantityMatch[1]!) ? 1 : /^two$/i.test(serverQuantityMatch[1]!) ? 2 : /^three$/i.test(serverQuantityMatch[1]!) ? 3 : Number(serverQuantityMatch[1]), { comparison: 'exact' }); else remove('serverQuantity');
  const rackUnitsMatch = sourceText.match(/^\s*Rack Units\s*:\s*(\d+)\s*U?\b/im) ?? sourceText.match(/\b(1|2)\s*U\s+(?:rack|server|chassis)\b/i);
  if (rackUnitsMatch) replace('rackUnits', 'Rack units', Number(rackUnitsMatch[1]), { comparison: 'exact' }); else remove('rackUnits');
  const canonicalPortType = (value: string): string => /\b(?:RJ-?45|BASE-?T|UTP)\b/i.test(value) ? 'BASE-T' : /\b(?:QSFP\d*|Quad\s+Small\s+Form[- ]factor\s+Pluggable)\b/i.test(value) ? 'QSFP' : /\b(?:SFP(?:\+|\d+)?|Small\s+Form[- ]factor\s+Pluggable)\b/i.test(value) ? 'SFP' : /(?:\bFC\b|\d+\s*GFC\b|\bFib(?:re|er)\s+Channel\b)/i.test(value) ? 'FC' : value.trim().toUpperCase();
  const nicSentence = sourceText.split(/(?<=[.;\n])/).find((part) => /(?:\b(?:NIC|network|networking|SFP|QSFP|BASE-?T|RJ-?45|Fibre\s+Channel|Fiber\s+Channel|card)\b|\d\s*GbE\b)/i.test(part));
  const nicCardStarts = nicSentence ? [...nicSentence.matchAll(/(\d+)[^\S\r\n]*(?:x|-)?[^\S\r\n]*(?:NIC[^\S\r\n]*)?cards?\b/gi)] : [];
  const adapterTypeFromText = (text: string) => /\bVIC\b/i.test(text) ? 'VIC' : /\bOCP\b/i.test(text) ? 'OCP' : undefined;
  const portTopologyNicGroups = nicSentence ? [...nicSentence.matchAll(/\b(\d+)\s*x\s*(dual|quad|\d+)(?:[ -]?ports?)?\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*G(?:bps|bE|b)?(?:\s*(SFP(?:\+|\d+)?|QSFP(?:\+|\d+)?|RJ-?45|BASE-?T|BASET|UTP|FC|Fib(?:re|er)\s+Channel))?/gi)].map((match) => ({
    cardCount: Number(match[1]),
    portsPerCard: /^dual$/i.test(match[2]!) ? 2 : /^quad$/i.test(match[2]!) ? 4 : Number(match[2]),
    totalPorts: undefined,
    speedPerPort: Number(match[3]),
    media: match[4] ? canonicalPortType(match[4]) : undefined,
    adapterType: adapterTypeFromText(match[0])
  })) : [];
  const compactNicGroups = nicCardStarts.flatMap((start, index) => {
    const clause = nicSentence!.slice(start.index, nicCardStarts[index + 1]?.index ?? nicSentence!.length);
    const portsAndSpeed = clause.match(/(\d+)[^\S\r\n]*x[^\S\r\n]*(\d+(?:\.\d+)?)[^\S\r\n]*G(?:bps|bE|b)?/i);
    if (!portsAndSpeed) return [];
    const hasMedia = /\b(?:RJ-?45|BASE-?T|UTP|QSFP\d*|SFP(?:\+|\d+)?|FC|Fib(?:re|er)\s+Channel)\b|\d+\s*GFC\b/i.test(clause);
    return [{ cardCount: Number(start[1]), portsPerCard: Number(portsAndSpeed[1]), totalPorts: undefined, speedPerPort: Number(portsAndSpeed[2]), media: hasMedia ? canonicalPortType(clause) : undefined, adapterType: adapterTypeFromText(clause) }];
  });
  const plainNicGroups = nicSentence ? [...nicSentence.matchAll(/\b(\d+)\s+(?:(\d+)|(dual|quad))[ -]?ports?\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*(?:Gbps|GbE|G\b)[^,;.\n]{0,50}?(?:cards?|adapters?|HBAs?|NICs?)\b/gi)].map((match) => {
    const hasMedia = /\b(?:RJ-?45|BASE-?T|UTP|QSFP\d*|SFP(?:\+|\d+)?|FC|Fib(?:re|er)\s+Channel)\b|\d+\s*GFC\b/i.test(match[0]);
    return { cardCount: Number(match[1]), portsPerCard: match[2] ? Number(match[2]) : /^quad$/i.test(match[3] ?? '') ? 4 : 2, totalPorts: undefined, speedPerPort: Number(match[4]), media: hasMedia ? canonicalPortType(match[0]) : undefined, adapterType: adapterTypeFromText(match[0]) };
  }) : [];
  const abstractNicGroups = nicSentence ? [...nicSentence.matchAll(/\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*G(?:bps|bE|b)?\s*(SFP(?:\+|\d+)?|QSFP(?:\+|\d+)?|RJ-?45|BASE-?T|BASET|UTP|FC|Fib(?:re|er)\s+Channel)\b/gi)].map((match) => ({
    cardCount: undefined, portsPerCard: undefined, totalPorts: Number(match[1]), speedPerPort: Number(match[2]), media: canonicalPortType(match[3]!), adapterType: adapterTypeFromText(match[0])
  })) : [];
  const nicGroups = portTopologyNicGroups.length ? portTopologyNicGroups : compactNicGroups.length ? compactNicGroups : plainNicGroups.length ? plainNicGroups : abstractNicGroups;
  remove('nicCardCount', 'nicPortsPerCard', 'nicTotalPorts', 'nicSpeedGbpsPerPort', 'nicMedia', 'nicAdapterType');
  removeMatching(/^nicGroup\d+/);
  if (nicGroups.length > 1) {
    nicGroups.forEach((group, index) => {
      const prefix = `nicGroup${index + 1}`;
      if (group.cardCount) replace(`${prefix}CardCount`, 'Card count', group.cardCount, { comparison: 'exact' });
      if (group.portsPerCard) replace(`${prefix}PortsPerCard`, 'Ports per card', group.portsPerCard);
      if (group.totalPorts) replace(`${prefix}TotalPorts`, 'Total ports', group.totalPorts);
      replace(`${prefix}SpeedGbpsPerPort`, 'Speed per port', group.speedPerPort, { unit: 'Gbps' });
      if (group.media) replace(`${prefix}Media`, 'Port type', group.media, { comparison: 'exact' });
      if (group.adapterType) replace(`${prefix}AdapterType`, 'Adapter type', group.adapterType, { comparison: 'exact' });
    });
  } else if (nicSentence) {
    const cardsMatch = nicSentence.match(/\b(\d+)[^\S\r\n]*(?:x|-)?[^\S\r\n]*(?:NIC[^\S\r\n]*)?cards?\b/i) ?? nicSentence.match(/\b(one|two|three)\s+[^.;\n]{0,50}?(?:cards?|NIC)\b/i) ?? nicSentence.match(/\b(1)x\s*(?:dual|quad)[ -]port[^.\n]*?NIC\b/i);
    const cardCount = cardsMatch ? (/^one$/i.test(cardsMatch[1]!) ? 1 : /^two$/i.test(cardsMatch[1]!) ? 2 : /^three$/i.test(cardsMatch[1]!) ? 3 : Number(cardsMatch[1])) : nicGroups[0]?.cardCount;
    const portsMatch = nicSentence.match(/\beach(?:\s+with)?\s+(\d+)[ -]?ports?\b/i) ?? nicSentence.match(/\b(\d+)\s*ports?\s+(?:each|per\s+(?:card|adapter|NIC|HBA))\b/i) ?? nicSentence.match(/\b(\d+)\s*x\s*\d+(?:\.\d+)?\s*G(?:b(?:ps|E)?)?\s*ports?\s+per\s+card\b/i);
    const namedPorts = /\bquad[ -]port\b/i.test(nicSentence) ? 4 : /\bdual[ -]port\b/i.test(nicSentence) ? 2 : undefined;
    const compactPorts = nicSentence.match(/\bNIC\s*(?:[:=]|is)?\s*(\d+)\s*x\s*\d+(?:\.\d+)?\s*G/i)?.[1];
    const portsPerCard = nicGroups[0]?.portsPerCard ?? (portsMatch ? Number(portsMatch[1]) : namedPorts ?? (cardCount && compactPorts ? Number(compactPorts) : undefined));
    const speedMatch = nicSentence.match(/(\d+(?:\.\d+)?)\s*(?:Gbps|GbE|G\b)/i);
    if (cardCount) {
      replace('nicCardCount', 'NIC card count', cardCount, { comparison: 'exact' });
      if (portsPerCard) replace('nicPortsPerCard', 'Ports per NIC card', portsPerCard);
    } else {
      const abstractPorts = nicSentence.match(/\b(\d+)\s*(?:x\s*)?\d+(?:\.\d+)?\s*G(?:bps|bE|\b)/i)?.[1] ?? (/\bdual\s+\d+(?:\.\d+)?\s*G(?:bps|bE|\b)/i.test(nicSentence) ? '2' : undefined);
      if (abstractPorts) replace('nicTotalPorts', 'Total NIC ports', Number(abstractPorts));
    }
    if (speedMatch) replace('nicSpeedGbpsPerPort', 'NIC speed per port', Number(speedMatch[1]), { unit: 'Gbps' });
    const detectedMedia = /\b(?:RJ-?45|BASE-?T|UTP|QSFP\d*|SFP(?:\+|\d+)?|Small\s+Form[- ]factor\s+Pluggable|Quad\s+Small\s+Form[- ]factor\s+Pluggable|FC|Fib(?:re|er)\s+Channel)\b|\d+\s*GFC\b/i.test(nicSentence) ? canonicalPortType(nicSentence) : undefined;
    if (detectedMedia) replace('nicMedia', 'NIC port type', detectedMedia, { comparison: 'exact' });
    const adapterType = adapterTypeFromText(nicSentence);
    if (adapterType) replace('nicAdapterType', 'NIC adapter type', adapterType, { comparison: 'exact' });
  }
  const portType = normalized.find((requirement) => requirement.id === 'nicMedia');
  if (portType && typeof portType.value === 'string') { portType.value = canonicalPortType(portType.value); portType.label = 'NIC port type'; portType.comparison = 'exact'; }
  const hasLegacyNic = normalized.some((requirement) => /^nic(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort|Media|AdapterType)$/.test(requirement.id));
  if (hasLegacyNic && normalized.some((requirement) => requirement.id === 'nicCardCount') && !normalized.some((requirement) => requirement.id === 'nicPortsPerCard')) {
    replace('nicPortsPerCard', 'Ports per NIC card', undefined, { status: 'unresolved', required: false, note: 'How many ports are required on each NIC card?' });
  }
  if (hasLegacyNic && !normalized.some((requirement) => requirement.id === 'nicSpeedGbpsPerPort')) {
    replace('nicSpeedGbpsPerPort', 'NIC speed per port', undefined, { unit: 'Gbps', status: 'unresolved', required: false, note: 'What speed is required for each NIC port?' });
  }

  const cpuLines = sourceText.split('\n').filter((line) => /^\s*CPU\s*:/i.test(line));
  const cpuProfiles = cpuLines.flatMap((line) => {
    const sockets = line.match(/\b(\d+)\s*(?:x|-)?\s*(?:sockets?|(?=\d+\s*[- ]?cores?))/i)?.[1];
    const cores = line.match(/\b(\d+)\s*[- ]?cores?\s*(?:each|per\s+(?:CPU|processor|socket))/i)?.[1]
      ?? line.match(/\b\d+\s*(?:x|-)\s*(\d+)\s*[- ]?cores?\b/i)?.[1];
    return sockets || cores ? [`${sockets ?? '?'}:${cores ?? '?'}`] : [];
  });
  const memoryProfiles = sourceText.split('\n').filter((line) => /^\s*Memory\s*:/i.test(line)).flatMap((line) => {
    const match = line.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
    return match ? [Number(match[1]) * (match[2]!.toUpperCase() === 'TB' ? 1024 : 1)] : [];
  });
  if (new Set(cpuProfiles).size > 1 || new Set(memoryProfiles).size > 1 && !/\bminimum\b[^\n]*\bpreferred\b/i.test(sourceText)) {
    remove('cpuSockets', 'cpuCoresPerSocket', 'cpuTotalCores', 'memoryGb', 'memoryModuleCount', 'memoryModuleSizeGb');
    replace('structuredRfpConflict', 'Conflicting structured requirements', undefined, { comparison: 'exact', status: 'unresolved', required: true, note: 'The RFP contains conflicting CPU or memory values. Which value applies to this server profile?' });
  } else remove('structuredRfpConflict');

  const roleNames = [...sourceText.matchAll(/\b(database|application|web|analytics|management|compute)\s+servers?\b/gi)].map((match) => match[1]!.toLowerCase());
  if (new Set(roleNames).size > 1) {
    replace('serverRoleScope', 'Multiple server roles', undefined, { comparison: 'exact', status: 'unresolved', required: true, note: 'Which server role should be extracted first? Submit one role at a time so quantities and requirements remain separate.' });
  } else remove('serverRoleScope');

  const preferredCpu = sourceText.match(/\bminimum\s+(\d+)\s+(?:physical\s+)?cores?[^\n]{0,60}\bpreferred\s+(\d+)\s+(?:physical\s+)?cores?/i);
  if (preferredCpu) replace('cpuTotalCores', 'Total CPU cores', Number(preferredCpu[1]), { status: 'explicit', note: `Hard minimum is ${preferredCpu[1]} cores; preferred target is ${preferredCpu[2]} cores.` });
  const preferredMemory = sourceText.match(/\bminimum\s+(\d+(?:\.\d+)?)\s*(TB|GB)[^\n]{0,60}\bpreferred\s+(\d+(?:\.\d+)?)\s*(TB|GB)/i);
  if (preferredMemory) {
    const minimumGb = Number(preferredMemory[1]) * (preferredMemory[2]!.toUpperCase() === 'TB' ? 1024 : 1);
    const preferredGb = Number(preferredMemory[3]) * (preferredMemory[4]!.toUpperCase() === 'TB' ? 1024 : 1);
    replace('memoryGb', 'Capacity', minimumGb, { unit: 'GB', status: 'explicit', note: `Hard minimum is ${minimumGb} GB; preferred target is ${preferredGb} GB.` });
  }
  const positiveComponentValueId = (id: string) => /^(?:cpu(?:Cores|TotalCores|Sockets|CoresPerSocket|ClockGhz)|memory(?:Gb|ModuleCount|ModuleSizeGb)|localStorageCapacity|localDrive(?:Count|Capacity|TransferSpeedGbps)|boot(?:Capacity|CapacityGb|DriveCount)|maxLocalDriveCount|nic(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort)|nicGroup\d+(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort)|gpu(?:Count|MemoryGb)|storageGroup\d+(?:Capacity|DriveCount|DriveCapacity|TransferSpeedGbps))$/.test(id);
  return normalized.filter((requirement) => !(positiveComponentValueId(requirement.id) && typeof requirement.value === 'number' && requirement.value <= 0));
}

export async function extractRequirements(config: ProviderConfig, text: string): Promise<Requirement[]> {
  const deterministic = normalizeExtractedRequirements([], text);
  const finish = (content: string) => normalizeExtractedRequirements(parseRequirements(content), text);
  try {
    if (config.provider === 'local') {
      const response = await fetch(`${config.baseUrl ?? 'http://127.0.0.1:11434'}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model: config.model ?? 'qwen3.5:4b-q4_K_M', stream: false, think: false, format: ollamaRequirementSchema, options: { temperature: 0 }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }] })
      });
      if (!response.ok) throw new Error(`Local provider failed: ${response.status}`);
      const data = await response.json() as { done_reason?: string; message?: { content?: string } };
      if (data.done_reason && data.done_reason !== 'stop') throw new Error(`Local provider stopped before completing JSON (${data.done_reason}).`);
      return finish(data.message?.content ?? '[]');
    }
    if (config.provider !== 'circuit') throw new Error('Unsupported extraction provider. Choose Local Ollama or CircuIT.');
    const token = config.apiKey ?? '';
    assertCurrentCircuitToken(token);
    const model = config.model ?? CIRCUIT_MODELS[0];
    if (!isCircuitModel(model)) throw new Error('Unsupported CircuIT model. Choose Gemini 3.1 Flash Lite or GPT-5 Nano.');
    const appKey = configuredCircuitAppKey(config.appKey);
    const response = await fetch(`${config.baseUrl ?? circuitBaseUrl}/${encodeURIComponent(model)}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': token, accept: 'application/json', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
        user: JSON.stringify({ appkey: appKey }),
        stop: ['<|im_end|>']
      })
    });
    if (response.status === 401 || response.status === 403) throw new CircuitAuthenticationError('CircuIT access token was rejected or expired. Generate a new token and paste it in Settings.');
    if (!response.ok) throw new Error(`CircuIT request failed (${response.status}). Try again or use Local Ollama.`);
    const data = await response.json() as { message?: { content?: string }; choices?: Array<{ message?: { content?: string } }> };
    const content = data.message?.content ?? data.choices?.map((choice) => choice.message?.content ?? '').join('') ?? '';
    return finish(content);
  } catch (error) {
    if (error instanceof CircuitAuthenticationError || error instanceof CircuitConfigurationError) throw error;
    if (deterministic.length) return deterministic;
    throw error;
  }
}
