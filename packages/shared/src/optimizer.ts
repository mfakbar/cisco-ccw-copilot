import { capacityInGb, evaluateRequirements, raidUsableCapacity } from './calculations.js';
import { supportsQuantity } from './candidate-ranking.js';
import { unresolvedBlockers } from './clarifications.js';
import { MAX_DIMM_SLOTS, nicPlacementRank, pcieRiserVariant, physicalNicSlotKey } from './rules.js';
import { canonicalNicMedia, compatiblePlatformRiserVariants, frontDriveLimit, platformCapabilities, raidDriveCountError, riserNumber, riserVariant, supportsRequestedNicSpeed } from './platform-capabilities.js';
import type { CatalogOption, ComponentRecommendation, RackRecommendation, RackServerProfile, Requirement, Selection } from './types.js';

export { clarificationQuestions, unresolvedBlockers, type ClarificationQuestion } from './clarifications.js';
export { rankCandidates, recommendCheapest, scoreCandidate, validateSelection } from './candidate-ranking.js';

type NumericRequirement = Requirement<number> & { value: number };
const numericRequirement = (requirements: Requirement[], ...ids: string[]): NumericRequirement | undefined =>
  requirements.find((requirement): requirement is NumericRequirement => ids.includes(requirement.id) && typeof requirement.value === 'number');

const attributeNumber = (option: CatalogOption, key: string): number => typeof option.attributes[key] === 'number' ? Number(option.attributes[key]) : 0;
const withinDeadline = (option: CatalogOption, deadline?: number): boolean => deadline === undefined || (attributeNumber(option, 'leadTimeDays') >= 0 && attributeNumber(option, 'leadTimeDays') <= deadline);
const optionCost = (option: CatalogOption, quantity: number) => option.unitListPrice * quantity;
const normalizedRaidLevel = (value: unknown): string => String(value ?? '').replace(/^raid\s*/i, '').trim();
const positiveComponentValueId = (id: string): boolean => /^(?:cpu(?:Cores|TotalCores|Sockets|CoresPerSocket|ClockGhz)|memory(?:Gb|ModuleCount|ModuleSizeGb)|localStorageCapacity|localDrive(?:Count|Capacity|TransferSpeedGbps)|boot(?:Capacity|CapacityGb|DriveCount)|maxLocalDriveCount|nic(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort)|nicGroup\d+(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort)|gpu(?:Count|MemoryGb)|storageGroup\d+(?:Capacity|DriveCount|DriveCapacity|TransferSpeedGbps))$/.test(id);
const supportsRaidLevel = (option: CatalogOption, level: string): boolean => {
  if (!level) return true;
  if (option.attributes.controllerType === 'standard' && option.attributes.exactRaidLevels !== true && option.attributes.raidCapable !== false) return true;
  const supported = String(option.attributes.supportedRaidLevels ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return supported.length ? supported.includes(level) : option.attributes.raidCapable === true;
};

export function recommendRackComponents(requirements: Requirement[], catalog: CatalogOption[], profile?: RackServerProfile): RackRecommendation {
  requirements = requirements.filter((requirement) => !(positiveComponentValueId(requirement.id) && typeof requirement.value === 'number' && requirement.value <= 0));
  const blockers = unresolvedBlockers(requirements);
  const blockerScope = (id: string): string => id.match(/^(?:storage|nic)Group\d+/)?.[0]
    ?? (/^cpu/.test(id) ? 'cpu' : /^memory/.test(id) ? 'memory' : /^boot/.test(id) ? 'boot' : /^(?:localStorage|localDrive|raidLevel|maxLocalDrive)/.test(id) ? 'localStorage' : /^nic/.test(id) ? 'nic' : /^gpu/.test(id) ? 'gpu' : id);
  const blockedScopes = new Set(blockers.map((item) => blockerScope(item.id)));
  const scopeForRequirement = (id: string) => blockerScope(id);
  requirements = requirements.filter((requirement) => !blockedScopes.has(scopeForRequirement(requirement.id)));
  const notices = blockers.map((item) => `Skipped ${item.label} until clarified.`);
  const capability = platformCapabilities(profile);
  const deadline = numericRequirement(requirements, 'maxLeadTimeDays')?.value;
  const availableWithoutDeadline = catalog.filter((option) => option.available);
  const available = catalog.filter((option) => option.available && withinDeadline(option, deadline));
  const components: ComponentRecommendation[] = [];
  const violations: string[] = [];
  const requiredRiserVariants = new Set<string>();
  const requiredRiserNumbers = new Set<number>();
  const occupiedPcieSlots = new Set<string>();
  const selectedQuantity = (option: CatalogOption) => Math.max(1, attributeNumber(option, 'selectedQuantity') || attributeNumber(option, 'fixedQuantity') || 1);
  const currentSelections = catalog.filter((option) => option.attributes.selected === true);
  const currentCpu = currentSelections.find((option) => option.category === 'cpu');
  const currentMemory = currentSelections.find((option) => option.category === 'memory');
  const isFrontMezzanine = (option: CatalogOption) => option.attributes.frontMezzanine === true
    || ['raid', 'accessory'].includes(option.category) && /front\s+mezz(?:anine)?/i.test(String(option.attributes.categoryName ?? ''))
    || /\bUCSX-(?:X10C-(?:PT4F|RAIDF|PTE3|GPUFM)-D|RAID-M1L6)\b/i.test(option.sku);
  const isRequiredXSeriesMlom = (option: CatalogOption) => /^UCSX-ML(?:V|-)/i.test(option.sku)
    && /\bmLOM\b/i.test(`${option.name} ${option.attributes.categoryName ?? ''}`);
  const isOptionalXSeriesRearVIC = (option: CatalogOption) => /^UCSX-ME-/i.test(option.sku)
    && /\b(?:Mezz|Rear\s+MEZZ)/i.test(`${option.name} ${option.attributes.categoryName ?? ''}`);
  const currentFrontMezzanine = currentSelections.find(isFrontMezzanine);
  const currentGpuFrontMezzanine = currentFrontMezzanine && /GPUFM|GPU\s+Front\s+Mezz/i.test(`${currentFrontMezzanine.sku} ${currentFrontMezzanine.name}`) ? currentFrontMezzanine : undefined;
  let selectedCpuCount: number | undefined = currentCpu ? selectedQuantity(currentCpu) : undefined;
  let selectedCpu: CatalogOption | undefined = currentCpu;
  let selectedMemory: { option: CatalogOption; quantity: number } | undefined = currentMemory ? { option: currentMemory, quantity: selectedQuantity(currentMemory) } : undefined;
  let selectedStorageController: CatalogOption | undefined = currentSelections.find((option) => option.category === 'raid');
  let selectedStorageControllerQuantity = selectedStorageController ? selectedQuantity(selectedStorageController) : 0;

  const add = (component: ComponentRecommendation['component'], label: string, selections: Selection[], reason: string) => {
    const selectedOptions = selections.flatMap((selection) => { const option = catalog.find((item) => item.id === selection.optionId); return option ? [{ option, quantity: selection.quantity }] : []; });
    components.push({ component, label, selections, reason, totalListPrice: selectedOptions.reduce((sum, item) => sum + optionCost(item.option, item.quantity), 0), maxLeadTimeDays: Math.max(0, ...selectedOptions.map((item) => attributeNumber(item.option, 'leadTimeDays'))) });
  };

  const sockets = numericRequirement(requirements, 'cpuSockets')?.value;
  const totalCores = numericRequirement(requirements, 'cpuTotalCores', 'cpuCores')?.value;
  const coresPerSocket = numericRequirement(requirements, 'cpuCoresPerSocket')?.value ?? (sockets && totalCores ? Math.ceil(totalCores / sockets) : undefined);
  const clockGhz = numericRequirement(requirements, 'cpuClockGhz')?.value;
  const cpuVendor = requirements.find((requirement) => requirement.id === 'cpuVendor' && typeof requirement.value === 'string')?.value;
  if (sockets || totalCores || coresPerSocket || clockGhz || cpuVendor) {
    const cpuPlans = available.filter((option) => option.category === 'cpu').flatMap((option) => {
      const maximum = Math.min(capability.maxSockets, Math.max(1, attributeNumber(option, 'maxQuantity')), Math.max(1, attributeNumber(option, 'maxSocketCount') || capability.maxSockets));
      const quantities = sockets === undefined ? Array.from({ length: maximum }, (_, index) => index + 1) : [sockets];
      return quantities.flatMap((quantity) =>
        (coresPerSocket === undefined || attributeNumber(option, 'cores') >= coresPerSocket)
          && (totalCores === undefined || attributeNumber(option, 'cores') * quantity >= totalCores)
          && (clockGhz === undefined || attributeNumber(option, 'clockGhz') >= clockGhz)
          && (cpuVendor === undefined || String(option.attributes.cpuVendor).toLowerCase() === String(cpuVendor).toLowerCase())
          && quantity <= maximum && quantity <= attributeNumber(option, 'maxQuantity') && supportsQuantity(option, quantity)
          ? [{ option, quantity }] : []
      );
    }).sort((a, b) => optionCost(a.option, a.quantity) - optionCost(b.option, b.quantity) || a.quantity - b.quantity || attributeNumber(a.option, 'cores') - attributeNumber(b.option, 'cores'));
    if (cpuPlans[0]) {
      selectedCpuCount = cpuPlans[0].quantity; selectedCpu = cpuPlans[0].option;
      add('cpu', 'CPU', [{ optionId: cpuPlans[0].option.id, quantity: cpuPlans[0].quantity }], `${cpuPlans[0].quantity} identical CPU(s), ${attributeNumber(cpuPlans[0].option, 'cores')} cores/socket, ${attributeNumber(cpuPlans[0].option, 'clockGhz')} GHz`);
    }
    else violations.push('No CPU option meets socket, core, clock-speed, and lead-time requirements.');
  }

  const memoryGb = numericRequirement(requirements, 'memoryGb')?.value;
  const requestedGpuCount = numericRequirement(requirements, 'gpuCount')?.value;
  const hasGpuDetails = requirements.some((requirement) => ['gpuModel', 'gpuMemoryGb', 'gpuDeploymentType'].includes(requirement.id) && requirement.value !== undefined);
  const gpuCount = requestedGpuCount ?? (hasGpuDetails ? 1 : undefined);
  const gpuModel = requirements.find((requirement) => requirement.id === 'gpuModel' && typeof requirement.value === 'string')?.value;
  const gpuMemoryGb = numericRequirement(requirements, 'gpuMemoryGb')?.value;
  const gpuDeploymentType = requirements.find((requirement) => requirement.id === 'gpuDeploymentType' && typeof requirement.value === 'string')?.value;
  const xFrontMezzGpuRequired = ['X210C_M8', 'X215C_M8'].includes(capability.kind) && Boolean(gpuCount) && !/PCIe\s*Node/i.test(String(gpuDeploymentType ?? ''));
  const xFrontMezzGpuActive = Boolean(currentGpuFrontMezzanine) || xFrontMezzGpuRequired;
  const requestedModuleCount = numericRequirement(requirements, 'memoryModuleCount')?.value;
  const requestedModuleSize = numericRequirement(requirements, 'memoryModuleSizeGb')?.value;
  if (memoryGb || requestedModuleCount || requestedModuleSize) {
    const cpuCount = selectedCpuCount ?? sockets ?? 1;
    const dimmLimit = capability.kind === 'UNKNOWN' ? MAX_DIMM_SLOTS : capability.dimmsPerCpu * Math.min(cpuCount, capability.maxSockets);
    const expectedDimmSpeed = selectedCpu && String(selectedCpu.attributes.cpuVendor).toLowerCase() === 'amd'
      ? attributeNumber(selectedCpu, 'cpuGeneration') >= 5 ? 6400 : attributeNumber(selectedCpu, 'cpuGeneration') === 4 ? 5600 : undefined
      : selectedCpu && attributeNumber(selectedCpu, 'cpuGeneration') >= 6 ? 6400 : undefined;
    if (requestedModuleCount !== undefined && (!Number.isInteger(requestedModuleCount) || requestedModuleCount < 1 || requestedModuleCount > dimmLimit)) violations.push(capability.kind === 'UNKNOWN' ? `Memory module count must be between 1 and ${dimmLimit} DIMMs.` : `Memory module count must be between 1 and ${dimmLimit} DIMMs for ${profile?.model ?? 'this CPU topology'}.`);
    else if (requestedModuleCount !== undefined && cpuCount === 2 && capability.balancedMemoryAcrossCpus && requestedModuleCount % 2 !== 0) violations.push('Two-socket systems require an identical DIMM count on each CPU; the total DIMM count must be even.');
    else {
      const memory = available.filter((option) => option.category === 'memory').flatMap((option) => {
        const perDimm = attributeNumber(option, 'capacityGb');
        if (requestedModuleSize !== undefined && perDimm !== requestedModuleSize) return [];
        const quantity = requestedModuleCount ?? (perDimm && memoryGb ? Math.ceil(memoryGb / perDimm) : 1);
        if (memoryGb && perDimm * quantity < memoryGb) return [];
        if (cpuCount === 2 && capability.balancedMemoryAcrossCpus && quantity % 2 !== 0) return [];
        if (expectedDimmSpeed && attributeNumber(option, 'ratedMemorySpeedMtps') && attributeNumber(option, 'ratedMemorySpeedMtps') !== expectedDimmSpeed) return [];
        return quantity > 0 && quantity <= dimmLimit && quantity <= attributeNumber(option, 'maxQuantity') && supportsQuantity(option, quantity) ? [{ option, quantity }] : [];
      }).sort((a, b) => {
        const channelPopulation = capability.memoryChannelsPerCpu * cpuCount;
        return Number(b.quantity % channelPopulation === 0) - Number(a.quantity % channelPopulation === 0) || optionCost(a.option, a.quantity) - optionCost(b.option, b.quantity);
      });
      if (memory[0]) {
        selectedMemory = memory[0];
        add('memory', 'Memory', [{ optionId: memory[0].option.id, quantity: memory[0].quantity }], `${memory[0].quantity} identical ${attributeNumber(memory[0].option, 'capacityGb')} GB DIMMs = ${memory[0].quantity * attributeNumber(memory[0].option, 'capacityGb')} GB${cpuCount === 2 ? ` · ${memory[0].quantity / 2} DIMMs per CPU` : ''}`);
      }
      else violations.push('No memory option meets capacity, DIMM-count, and lead-time requirements.');
    }
  }

  const storageReq = numericRequirement(requirements, 'localStorageCapacity', 'rawStorageTb', 'usableStorageTb');
  const storageGroupNumbers = [...new Set(requirements.flatMap((requirement) => {
    const match = requirement.id.match(/^storageGroup(\d+)/); return match ? [Number(match[1])] : [];
  }))].sort((a, b) => a - b);
  const storageGroups = storageGroupNumbers.flatMap((number) => {
    const capacity = numericRequirement(requirements, `storageGroup${number}Capacity`);
    const driveCount = numericRequirement(requirements, `storageGroup${number}DriveCount`)?.value;
    const driveCapacity = numericRequirement(requirements, `storageGroup${number}DriveCapacity`);
    if (!capacity && !(driveCount && driveCapacity)) return [];
    return [{
      number, capacity,
      capacityType: requirements.find((item) => item.id === `storageGroup${number}CapacityType`)?.value ?? 'raw',
      driveCount,
      driveCapacity,
      driveType: requirements.find((item) => item.id === `storageGroup${number}DriveType`)?.value,
      driveInterface: requirements.find((item) => item.id === `storageGroup${number}DriveInterface`)?.value,
      transferSpeedGbps: numericRequirement(requirements, `storageGroup${number}TransferSpeedGbps`)?.value,
      raidLevel: requirements.find((item) => item.id === `storageGroup${number}RaidLevel`)?.value
    }];
  });
  const bootCapacity = numericRequirement(requirements, 'bootCapacity') ?? numericRequirement(requirements, 'bootCapacityGb');
  const maximumLocalDriveCountRequirement = numericRequirement(requirements, 'maxLocalDriveCount');
  const maximumLocalDriveCount = maximumLocalDriveCountRequirement && Number.isInteger(maximumLocalDriveCountRequirement.value) && maximumLocalDriveCountRequirement.value > 0 ? maximumLocalDriveCountRequirement.value : undefined;
  if (maximumLocalDriveCountRequirement && maximumLocalDriveCount === undefined) violations.push('Maximum local capacity drive count must be a positive whole number.');
  const requestedBootDriveCount = numericRequirement(requirements, 'bootDriveCount')?.value;
  const bootDriveCountValid = requestedBootDriveCount === undefined || (Number.isInteger(requestedBootDriveCount) && requestedBootDriveCount >= 1 && requestedBootDriveCount <= 2);
  if (!bootDriveCountValid) violations.push('Boot drive count must be 1 or 2 drives per server.');
  const explicitBootDriveType = requirements.find((requirement) => requirement.id === 'bootDriveType' && typeof requirement.value === 'string')?.value;
  const bootDriveType = explicitBootDriveType ?? (bootCapacity ? available.some((option) => option.category === 'bootDrive') ? 'M.2' : 'SSD' : undefined);
  const m2Boot = /^M\.?2/i.test(String(bootDriveType ?? '').replace(/\s/g, ''));
  const bootDriveCount = Number(requestedBootDriveCount ?? (bootCapacity ? 1 : 0));
  const localDriveType = requirements.find((requirement) => requirement.id === 'localDriveType' && typeof requirement.value === 'string')?.value;
  const raidLevel = requirements.find((requirement) => requirement.id === 'raidLevel' && requirement.value !== undefined)?.value;
  const level = normalizedRaidLevel(raidLevel);
  const storageRaidLevels = [...new Set([level, ...storageGroups.map((group) => normalizedRaidLevel(group.raidLevel))].filter((item) => item && !['JBOD', 'NONE'].includes(item.toUpperCase())))];
  const explicitNoRaid = [level, ...storageGroups.map((group) => normalizedRaidLevel(group.raidLevel))].some((item) => item.toUpperCase() === 'NONE');
  const requestedDriveTypes = [localDriveType, ...storageGroups.map((group) => group.driveType)].filter((value): value is string => typeof value === 'string');
  const u2Requested = requestedDriveTypes.some((value) => /^U\.2\s*NVMe$/i.test(value));
  const u2RaidRequested = u2Requested && storageRaidLevels.length > 0;
  const u2PassThrough = u2Requested && !storageRaidLevels.length;
  const directAttachWithoutController = u2PassThrough && ['C220_M8', 'C240_M8_SFF'].includes(capability.kind);
  const requestedControllerMedia = [...new Set(requestedDriveTypes.map((value) => /U\.2/i.test(value) ? 'U.2 NVMe' : /U\.3/i.test(value) ? 'U.3 NVMe' : /E3\.S/i.test(value) ? 'E3.S NVMe' : /M\.?\s*2/i.test(value) ? 'M.2' : /HDD/i.test(value) ? 'HDD' : /SSD/i.test(value) ? 'SSD' : /NVMe/i.test(value) ? 'NVMe' : '').filter(Boolean))];
  const controllerSupportsMedia = (option: CatalogOption, mediaSet = requestedControllerMedia) => {
    const supported = String(option.attributes.supportedDriveTypes ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    if (supported.length) return mediaSet.every((media) => supported.includes(media)
      || (media === 'HDD' || media === 'SSD') && (supported.includes('SAS') || supported.includes('SATA'))
      || (media.endsWith('NVMe') && supported.includes('NVMe')));
    if (option.attributes.controllerType === 'standard') {
      const triMode = option.attributes.triMode === true || /\btri[ -]?mode\b/i.test(`${option.sku} ${option.name}`);
      return mediaSet.every((media) => media === 'HDD' || media === 'SSD' || media === 'U.3 NVMe' && triMode);
    }
    return true;
  };
  const controllerPlacementMatches = (option: CatalogOption) => !['X210C_M8', 'X215C_M8'].includes(capability.kind)
    || isFrontMezzanine(option);
  const exactRequestedDriveCount = (numericRequirement(requirements, 'localDriveCount')?.value ?? 0) + storageGroups.reduce((sum, group) => sum + (group.driveCount ?? 0), 0);
  const controllerQuantityFor = (option: CatalogOption) => Math.max(1, attributeNumber(option, 'maxDrives') && exactRequestedDriveCount ? Math.ceil(exactRequestedDriveCount / attributeNumber(option, 'maxDrives')) : 1);
  const controllerPlanFits = (option: CatalogOption) => {
    const quantity = controllerQuantityFor(option);
    return quantity <= Math.max(1, attributeNumber(option, 'maxQuantity') || 1) && supportsQuantity(option, quantity);
  };
  const e3sRequested = requestedControllerMedia.includes('E3.S NVMe');
  const hbaPassThrough = !directAttachWithoutController && (u2PassThrough || explicitNoRaid || e3sRequested && storageRaidLevels.length === 0);
  if (u2RaidRequested && !capability.raidNvmeDriveTypes.includes('U.2 NVMe')) violations.push(capability.kind === 'UNKNOWN' ? 'U.2 NVMe does not support RAID; specify raw/pass-through storage instead.' : `${profile?.model ?? 'This platform'} does not support hardware RAID for U.2 NVMe drives; use U.3 NVMe or no-RAID pass-through.`);
  const effectiveCpuCount = selectedCpuCount ?? sockets ?? capability.maxSockets;
  const directNvmeCount = directAttachWithoutController ? exactRequestedDriveCount : 0;
  const directAttachLimit = capability.directAttachNvmeMaxByCpuCount[Math.min(2, effectiveCpuCount) as 1 | 2];
  if (directNvmeCount > directAttachLimit) violations.push(`${profile?.model ?? 'This platform'} supports at most ${directAttachLimit} direct-attach NVMe drive(s) with ${effectiveCpuCount} CPU(s).`);
  for (const group of storageGroups) {
    const raid = normalizedRaidLevel(group.raidLevel);
    if (group.driveCount && group.driveType) {
      const limit = frontDriveLimit(capability, group.driveType);
      if (group.driveCount > limit) violations.push(`${profile?.model ?? 'This platform'} supports at most ${limit} front-facing ${group.driveType} capacity drives.`);
    }
    if (raid && !['NONE', 'JBOD'].includes(raid.toUpperCase()) && group.driveCount) {
      const error = raidDriveCountError(raid, group.driveCount);
      if (error) violations.push(`Drive group ${group.number}: ${error}.`);
    }
  }
  const needsStandardStorageController = Boolean(storageReq || storageGroups.length || (bootCapacity && !m2Boot && bootDriveCountValid));
  let storageControllerSatisfied = !needsStandardStorageController;
  if (needsStandardStorageController) {
    if (directAttachWithoutController) {
      storageControllerSatisfied = directNvmeCount > 0 && directNvmeCount <= directAttachLimit;
    } else if (xFrontMezzGpuActive && ['X210C_M8', 'X215C_M8'].includes(capability.kind)) {
      if (storageRaidLevels.length) violations.push(`${profile?.model ?? 'This X-Series compute node'} cannot use hardware RAID while the GPU front-mezzanine adapter occupies the only front-mezzanine connector.`);
      if (currentFrontMezzanine && !currentGpuFrontMezzanine) violations.push(`${currentFrontMezzanine.sku} already occupies the only front-mezzanine connector required by the GPU front-mezzanine adapter.`);
      storageControllerSatisfied = storageRaidLevels.length === 0 && (!currentFrontMezzanine || Boolean(currentGpuFrontMezzanine));
    } else if (selectedStorageController) {
      const violationCount = violations.length;
      if (!controllerPlacementMatches(selectedStorageController)) violations.push(`${selectedStorageController.sku} is not installed in the required front-mezzanine controller category.`);
      if (!controllerSupportsMedia(selectedStorageController)) violations.push(`${selectedStorageController.sku} does not support the requested local-storage media.`);
      if (hbaPassThrough && selectedStorageController.attributes.controllerType !== 'passthrough') violations.push(`${selectedStorageController.sku} is a RAID controller, but the requested storage requires pass-through.`);
      if (!hbaPassThrough && selectedStorageController.attributes.controllerType !== 'standard') violations.push(`${selectedStorageController.sku} is a pass-through controller, but the requested storage requires hardware RAID.`);
      if (!storageRaidLevels.every((raid) => supportsRaidLevel(selectedStorageController!, raid))) violations.push(`${selectedStorageController.sku} does not support every requested RAID level.`);
      const selectedControllerCapacity = attributeNumber(selectedStorageController, 'maxDrives') * selectedStorageControllerQuantity;
      if (selectedControllerCapacity && exactRequestedDriveCount > selectedControllerCapacity) violations.push(`${selectedStorageController.sku} controls ${attributeNumber(selectedStorageController, 'maxDrives')} drives per controller; ${selectedStorageControllerQuantity} selected controller(s) cannot support ${exactRequestedDriveCount} drives.`);
      storageControllerSatisfied = violations.length === violationCount;
    } else if (hbaPassThrough) {
      if (u2PassThrough && storageRaidLevels.length) violations.push('U.2 NVMe does not support RAID; specify raw/pass-through storage instead.');
      else if (explicitNoRaid && storageRaidLevels.length) violations.push('RAID and no-RAID drive groups require incompatible controller modes; split them across supported controllers or revise the groups.');
      const compatibleHbas = availableWithoutDeadline.filter((option) => option.category === 'raid' && option.attributes.controllerType === 'passthrough').filter(controllerPlacementMatches).filter((option) => controllerSupportsMedia(option)).filter(controllerPlanFits);
      const hbas = compatibleHbas.filter((option) => withinDeadline(option, deadline)).sort((a, b) => optionCost(a, controllerQuantityFor(a)) - optionCost(b, controllerQuantityFor(b)));
      if (hbas[0]) {
        selectedStorageController = hbas[0];
        selectedStorageControllerQuantity = controllerQuantityFor(hbas[0]);
        storageControllerSatisfied = true;
        add('raid', 'Pass-through HBA', [{ optionId: hbas[0].id, quantity: selectedStorageControllerQuantity }], `${selectedStorageControllerQuantity} pass-through HBA controller(s) for ${exactRequestedDriveCount || 'the requested'} local drives`);
      }
      else if (deadline !== undefined && compatibleHbas.length) {
        const nearest = compatibleHbas.sort((a, b) => attributeNumber(a, 'leadTimeDays') - attributeNumber(b, 'leadTimeDays') || a.unitListPrice - b.unitListPrice)[0]!;
        const leadTime = attributeNumber(nearest, 'leadTimeDays');
        violations.push(leadTime >= 0 ? `${nearest.sku} is a compatible pass-through HBA, but its ${leadTime}-day lead time exceeds the ${deadline}-day target.` : `${nearest.sku} is a compatible pass-through HBA, but its lead time is unknown and cannot be verified against the ${deadline}-day target.`);
      }
      else violations.push('No pass-through HBA supports the requested no-RAID storage media and drive count.');
    } else {
      const compatibleRaidOptions = availableWithoutDeadline.filter((option) => option.category === 'raid' && option.attributes.controllerType === 'standard' && option.attributes.raidCapable !== false).filter(controllerPlacementMatches).filter((option) => controllerSupportsMedia(option)).filter((option) => storageRaidLevels.every((raid) => supportsRaidLevel(option, raid))).filter(controllerPlanFits);
      const raidOptions = compatibleRaidOptions.filter((option) => withinDeadline(option, deadline)).sort((a, b) => optionCost(a, controllerQuantityFor(a)) - optionCost(b, controllerQuantityFor(b)));
      if (raidOptions[0]) {
        selectedStorageController = raidOptions[0];
        selectedStorageControllerQuantity = controllerQuantityFor(raidOptions[0]);
        storageControllerSatisfied = true;
        add('raid', 'RAID Controller', [{ optionId: raidOptions[0].id, quantity: selectedStorageControllerQuantity }], storageRaidLevels.length ? `${selectedStorageControllerQuantity} standard controller(s) supporting RAID ${storageRaidLevels.join(' and ')}` : `${selectedStorageControllerQuantity} standard controller(s) for non-M.2 local drives`);
      }
      else if (deadline !== undefined && compatibleRaidOptions.length) {
        const nearest = compatibleRaidOptions.sort((a, b) => attributeNumber(a, 'leadTimeDays') - attributeNumber(b, 'leadTimeDays') || a.unitListPrice - b.unitListPrice)[0]!;
        const leadTime = attributeNumber(nearest, 'leadTimeDays');
        const capabilityText = storageRaidLevels.length ? `RAID ${storageRaidLevels.join(' and ')}` : 'the requested local storage';
        violations.push(leadTime >= 0 ? `${nearest.sku} supports ${capabilityText}, but its ${leadTime}-day lead time exceeds the ${deadline}-day target.` : `${nearest.sku} supports ${capabilityText}, but its lead time is unknown and cannot be verified against the ${deadline}-day target.`);
      }
      else violations.push(`No standard RAID/storage controller supports ${storageRaidLevels.length ? `RAID ${storageRaidLevels.join(' and ')}` : 'the requested local storage'} media and drive-count requirements.`);
    }
  }
  if ((storageReq || storageGroups.length) && storageControllerSatisfied) {
    const requestedDriveCount = numericRequirement(requirements, 'localDriveCount')?.value;
    const requestedDriveCapacity = numericRequirement(requirements, 'localDriveCapacity');
    const specs = storageGroups.length ? storageGroups.map((group) => ({
      label: `Group ${group.number}${group.driveType ? ` (${group.driveType})` : ''}`,
      requiredGb: group.capacity ? capacityInGb(group.capacity.value, group.capacity.unit) : group.driveCount! * capacityInGb(group.driveCapacity!.value, group.driveCapacity!.unit),
      capacityType: group.capacityType, driveCount: group.driveCount, driveCapacity: group.driveCapacity, driveType: group.driveType, driveInterface: group.driveInterface, transferSpeedGbps: group.transferSpeedGbps, raidLevel: normalizedRaidLevel(group.raidLevel)
    })) : [{
      label: 'Local storage', requiredGb: storageReq!.id === 'rawStorageTb' || storageReq!.id === 'usableStorageTb' ? Number(storageReq!.value) * 1000 : capacityInGb(storageReq!.value, storageReq!.unit),
      capacityType: requirements.find((requirement) => requirement.id === 'localStorageCapacityType')?.value ?? (storageReq!.id === 'usableStorageTb' ? 'usable' : 'raw'), driveCount: requestedDriveCount, driveCapacity: requestedDriveCapacity, driveType: localDriveType,
      driveInterface: requirements.find((requirement) => requirement.id === 'localDriveInterface')?.value,
      transferSpeedGbps: numericRequirement(requirements, 'localDriveTransferSpeedGbps')?.value, raidLevel: level
    }];
    const driveQuantity = (requiredGb: number, capacityType: unknown, raid: string, capacityGb: number) => {
      const dataDrives = Math.ceil(requiredGb / capacityGb);
      if (String(capacityType).toLowerCase() !== 'usable') {
        if (raid === '0' || raid === '00') return Math.max(2, dataDrives);
      if (raid === '1') return 2;
        if (raid === '5') return Math.max(3, dataDrives);
        if (raid === '6') return Math.max(4, dataDrives);
        if (raid === '10') return Math.max(4, dataDrives + (dataDrives % 2));
        if (raid === '50') return Math.max(6, dataDrives + (dataDrives % 2));
        if (raid === '60') return Math.max(8, dataDrives + (dataDrives % 2));
        return dataDrives;
      }
      if (raid === '0' || raid === '00') return Math.max(2, dataDrives);
      if (raid === '1') return 2;
      if (raid === '5') return Math.max(3, dataDrives + 1);
      if (raid === '6') return Math.max(4, dataDrives + 2);
      if (raid === '10') return Math.max(4, dataDrives * 2);
      if (raid === '50') { const count = Math.max(6, dataDrives + 2); return count + (count % 2); }
      if (raid === '60') { const count = Math.max(8, dataDrives + 4); return count + (count % 2); }
      return dataDrives;
    };
    const storageLocation = (option: CatalogOption) => String(option.attributes.storageLocation ?? 'other').toLowerCase();
    const driveTypeMatches = (requested: unknown, actual: unknown) => {
      const expected = String(requested ?? '').toUpperCase(); const availableType = String(actual ?? '').toUpperCase();
      if (!expected) return availableType !== 'U.2 NVME';
      if (expected === 'SSD' || expected === 'HDD') return availableType.endsWith(expected);
      return availableType === expected;
    };
    const choicesBySpec = specs.map((spec) => {
      const matching = available.filter((option) => option.category === 'storage' && storageLocation(option) === 'front')
        .filter((option) => capability.kind !== 'X210C_M8' || !xFrontMezzGpuActive || String(option.attributes.driveType).toUpperCase() === 'U.3 NVME')
        .filter((option) => driveTypeMatches(spec.driveType, option.attributes.driveType))
        .filter((option) => spec.driveInterface === undefined || String(option.attributes.driveInterface).toUpperCase() === String(spec.driveInterface).toUpperCase())
        .filter((option) => spec.transferSpeedGbps === undefined || attributeNumber(option, 'transferSpeedGbps') >= spec.transferSpeedGbps)
        .filter((option) => !spec.driveCapacity || attributeNumber(option, 'capacityGb') === capacityInGb(spec.driveCapacity.value, spec.driveCapacity.unit));
      const requiredQuantity = (option: CatalogOption) => spec.driveCount ?? driveQuantity(spec.requiredGb, spec.capacityType, spec.raidLevel, attributeNumber(option, 'capacityGb'));
      const meetsCapacity = (option: CatalogOption, quantity: number) => String(spec.capacityType).toLowerCase() === 'usable'
        ? raidUsableCapacity(attributeNumber(option, 'capacityGb') / 1000, quantity, spec.raidLevel || '0') * 1000 >= spec.requiredGb
        : attributeNumber(option, 'capacityGb') * quantity >= spec.requiredGb;
      return matching.flatMap((option) => {
        const quantity = requiredQuantity(option);
        const raidError = spec.raidLevel && !['NONE', 'JBOD'].includes(spec.raidLevel.toUpperCase()) ? raidDriveCountError(spec.raidLevel, quantity) : undefined;
        return quantity > 0 && !raidError && meetsCapacity(option, quantity) && supportsQuantity(option, quantity) ? [{ option, quantity, spec, parts: [{ option, quantity }] }] : [];
      }).sort((a, b) => a.parts.reduce((sum, part) => sum + optionCost(part.option, part.quantity), 0) - b.parts.reduce((sum, part) => sum + optionCost(part.option, part.quantity), 0)).slice(0, 30);
    });
    let plans: Array<Array<(typeof choicesBySpec)[number][number]>> = [[]];
    for (const choices of choicesBySpec) plans = plans.flatMap((plan) => choices.map((choice) => [...plan, choice])).slice(0, 1000);
    const validPlans = plans.flatMap((plan) => {
      if (maximumLocalDriveCount !== undefined && plan.reduce((sum, choice) => sum + choice.quantity, 0) > maximumLocalDriveCount) return [];
      const parts = plan.flatMap((choice) => choice.parts);
      const frontParts = parts.filter((part) => storageLocation(part.option) === 'front');
      const scannedFrontCapacity = Math.min(...frontParts.map((part) => attributeNumber(part.option, 'frontDriveCapacity')).filter((value) => value > 0), Number.POSITIVE_INFINITY);
      const typeLimits = plan.map((choice) => frontDriveLimit(capability, choice.spec.driveType ?? choice.option.attributes.driveType));
      const frontDriveCapacity = Math.min(scannedFrontCapacity, ...typeLimits);
      if (frontParts.reduce((sum, part) => sum + part.quantity, 0) > frontDriveCapacity) return [];
      const quantities = new Map<string, number>();
      for (const part of parts) quantities.set(part.option.id, (quantities.get(part.option.id) ?? 0) + part.quantity);
      if ([...quantities].some(([id, quantity]) => quantity > attributeNumber(catalog.find((option) => option.id === id)!, 'maxQuantity'))) return [];
      return [{ plan, selections: [...quantities].map(([optionId, quantity]) => ({ optionId, quantity })), cost: parts.reduce((sum, part) => sum + optionCost(part.option, part.quantity), 0) }];
    }).sort((a, b) => a.cost - b.cost);
    if (validPlans[0]) {
      const selectedPlan = validPlans[0];
      const selectedDriveCount = selectedPlan.plan.reduce((sum, choice) => sum + choice.quantity, 0);
      const selectedDriveMedia = [...new Set(selectedPlan.plan.map((choice) => {
        const value = String(choice.spec.driveType ?? choice.option.attributes.driveType ?? '');
        return /U\.2/i.test(value) ? 'U.2 NVMe' : /U\.3/i.test(value) ? 'U.3 NVMe' : /E3\.S/i.test(value) ? 'E3.S NVMe' : /HDD/i.test(value) ? 'HDD' : /SSD/i.test(value) ? 'SSD' : /NVMe/i.test(value) ? 'NVMe' : '';
      }).filter(Boolean))];
      let selectedPlanValid = true;
      if (capability.kind === 'X210C_M8' && xFrontMezzGpuActive) {
        if (selectedDriveCount > 2) { violations.push('The X210c GPU front-mezzanine adapter supports at most 2 front U.3 NVMe drives.'); selectedPlanValid = false; }
        if (selectedDriveMedia.some((media) => media !== 'U.3 NVMe')) { violations.push('The X210c GPU front-mezzanine adapter supports only front U.3 NVMe capacity drives.'); selectedPlanValid = false; }
      } else if (selectedStorageController) {
        const controllerLimit = attributeNumber(selectedStorageController, 'maxDrives');
        const controllerCapacity = controllerLimit * Math.max(1, selectedStorageControllerQuantity);
        if (controllerCapacity && selectedDriveCount > controllerCapacity) {
          const currentController = selectedStorageController.attributes.selected === true;
          const replacements = currentController ? [] : available.filter((option) => option.category === 'raid')
            .filter(controllerPlacementMatches)
            .filter((option) => hbaPassThrough ? option.attributes.controllerType === 'passthrough' : option.attributes.controllerType === 'standard' && option.attributes.raidCapable !== false)
            .filter((option) => controllerSupportsMedia(option, selectedDriveMedia))
            .filter((option) => storageRaidLevels.every((raid) => supportsRaidLevel(option, raid)))
            .flatMap((option) => {
              const maxDrives = attributeNumber(option, 'maxDrives');
              const quantity = maxDrives ? Math.ceil(selectedDriveCount / maxDrives) : 1;
              return quantity <= Math.max(1, attributeNumber(option, 'maxQuantity') || 1) && supportsQuantity(option, quantity) ? [{ option, quantity }] : [];
            })
            .sort((a, b) => optionCost(a.option, a.quantity) - optionCost(b.option, b.quantity));
          const replacement = replacements[0];
          const controllerComponent = components.find((component) => component.component === 'raid');
          if (replacement && controllerComponent) {
            selectedStorageController = replacement.option;
            selectedStorageControllerQuantity = replacement.quantity;
            controllerComponent.selections = [{ optionId: replacement.option.id, quantity: replacement.quantity }];
            controllerComponent.reason = hbaPassThrough
              ? `${replacement.quantity} pass-through HBA controller(s) for ${selectedDriveCount} local drives`
              : `${replacement.quantity} standard controller(s) supporting ${storageRaidLevels.length ? `RAID ${storageRaidLevels.join(' and ')}` : `${selectedDriveCount} local drives`}`;
            controllerComponent.totalListPrice = optionCost(replacement.option, replacement.quantity);
            controllerComponent.maxLeadTimeDays = attributeNumber(replacement.option, 'leadTimeDays');
          } else {
            violations.push(`${selectedStorageController.sku} supports ${controllerLimit} drives per controller; ${Math.max(1, selectedStorageControllerQuantity)} controller(s) support ${controllerCapacity}, but the calculated front-drive plan requires ${selectedDriveCount}.`);
            selectedPlanValid = false;
          }
        }
        if (!controllerSupportsMedia(selectedStorageController, selectedDriveMedia)) { violations.push(`${selectedStorageController.sku} is incompatible with the media in the calculated front-drive plan.`); selectedPlanValid = false; }
      }
      const format = (gb: number) => gb >= 1000 ? `${Number((gb / 1000).toFixed(2))} TB` : `${Number(gb.toFixed(2))} GB`;
      const formulas = selectedPlan.plan.map((choice) => {
        const driveGb = attributeNumber(choice.option, 'capacityGb'); const rawGb = choice.quantity * driveGb; const raid = choice.spec.raidLevel || '0'; const usableGb = raidUsableCapacity(driveGb / 1000, choice.quantity, raid) * 1000;
        const prefix = storageGroups.length ? `${choice.spec.label}: ` : '';
        const location = ' · front-facing bays only';
        return !choice.spec.raidLevel ? `${prefix}${choice.quantity} × ${format(driveGb)} = ${format(rawGb)} raw${location}` : raid.toUpperCase() === 'JBOD' ? `${prefix}${choice.quantity} × ${format(driveGb)} = ${format(rawGb)} raw JBOD${location}` : `${prefix}${choice.quantity} × ${format(driveGb)} = ${format(rawGb)} raw → RAID ${raid} = ${format(usableGb)} usable${location}`;
      });
      if (selectedPlanValid) add('storage', 'Local Storage', selectedPlan.selections, formulas.join('\n'));
    }
    else violations.push(maximumLocalDriveCount !== undefined ? `No front-facing local-storage plan meets capacity, the ${maximumLocalDriveCount}-drive server limit, and lead-time requirements.` : 'No front-facing local-storage option meets capacity, platform bay limits, and lead-time requirements.');
  }

  const pcieSlotKey = (option: CatalogOption) => {
    const categoryName = String(option.attributes.categoryName ?? option.id);
    if (option.attributes.bootLocation === 'MLOM') return 'PCIe MLOM/OCP';
    if (['X210C_M8', 'X215C_M8'].includes(capability.kind) && isOptionalXSeriesRearVIC(option)) return 'Rear Mezzanine';
    return physicalNicSlotKey(categoryName) ?? categoryName;
  };
  const placementRank = (option: CatalogOption) => nicPlacementRank(String(option.attributes.categoryName ?? option.id));
  const cpuCountForSlots = Math.min(2, selectedCpuCount ?? sockets ?? capability.maxSockets) as 1 | 2;
  const allowedRisers = new Set(capability.allowedRisersByCpuCount[cpuCountForSlots]);
  const optionUsesAllowedRiser = (option: CatalogOption, allowed = allowedRisers) => {
    const number = riserNumber(String(option.attributes.categoryName ?? ''));
    return number === undefined || capability.kind === 'UNKNOWN' || allowed.has(number);
  };
  const reserveOptionSlot = (option: CatalogOption) => {
    const slot = pcieSlotKey(option); occupiedPcieSlots.add(slot);
    const variant = riserVariant(String(option.attributes.categoryName ?? '')); if (variant) requiredRiserVariants.add(variant);
    const number = riserNumber(String(option.attributes.categoryName ?? '')); if (number) requiredRiserNumbers.add(number);
    if (attributeNumber(option, 'pcieSlots') >= 2) {
      const physical = Number(slot.match(/PCIe Slot (\d+)/i)?.[1] ?? 0); if (physical) occupiedPcieSlots.add(`PCIe Slot ${physical + 1}`);
    }
  };
  for (const option of currentSelections.filter((item) => ['gpu', 'nic', 'hba'].includes(item.category) || item.category === 'boot' && item.attributes.bootLocation === 'MLOM')) reserveOptionSlot(option);
  if (capability.kind === 'C240_M8_LFF' && selectedStorageController) {
    requiredRiserVariants.add('R1B');
    requiredRiserNumbers.add(1);
  }
  const compatibleRiserVariants = (items: Array<{ option: CatalogOption }>) => {
    const variants = new Map<string, string>();
    for (const variant of requiredRiserVariants) variants.set(variant.slice(0, -1), variant.slice(-1));
    for (const item of items) {
      const variant = pcieRiserVariant(String(item.option.attributes.categoryName ?? ''));
      if (!variant) continue;
      const bank = variant.slice(0, -1); const letter = variant.slice(-1);
      if (variants.has(bank) && variants.get(bank) !== letter) return false;
      variants.set(bank, letter);
    }
    return compatiblePlatformRiserVariants(capability.kind, [...variants].map(([bank, letter]) => `${bank}${letter}`));
  };
  const comparePlacement = (a: Array<{ option: CatalogOption }>, b: Array<{ option: CatalogOption }>) => {
    const left = a.map((item) => placementRank(item.option)).sort((x, y) => x - y); const right = b.map((item) => placementRank(item.option)).sort((x, y) => x - y);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
    return left.length - right.length;
  };

  if (gpuCount) {
    const candidates = available.filter((option) => option.category === 'gpu' && optionUsesAllowedRiser(option))
      .filter((option) => !occupiedPcieSlots.has(pcieSlotKey(option)))
      .filter((option) => supportsQuantity(option, 1))
      .filter((option) => !gpuModel || `${option.sku} ${option.name}`.toUpperCase().includes(String(gpuModel).toUpperCase()))
      .filter((option) => gpuMemoryGb === undefined || attributeNumber(option, 'gpuMemoryGb') >= gpuMemoryGb)
      .filter((option) => capability.gpuRequiresTwoCpusAtOrAboveWatts === undefined || attributeNumber(option, 'tdpWatts') < capability.gpuRequiresTwoCpusAtOrAboveWatts || cpuCountForSlots >= 2);
    const bySku = new Map<string, CatalogOption[]>();
    for (const option of candidates) bySku.set(option.sku, [...(bySku.get(option.sku) ?? []), option]);
    const plans: CatalogOption[][] = [];
    for (const options of bySku.values()) {
      const bySlot = new Map<string, CatalogOption[]>(); for (const option of options) { const slot = pcieSlotKey(option); bySlot.set(slot, [...(bySlot.get(slot) ?? []), option]); }
      let combinations: CatalogOption[][] = [[]];
      for (const slotOptions of bySlot.values()) combinations = combinations.flatMap((current) => [current, ...slotOptions.map((option) => [...current, option])]).slice(0, 5000);
      plans.push(...combinations.filter((items) => items.length === gpuCount && compatibleRiserVariants(items.map((option) => ({ option }))) && items.every((option) => {
        if (attributeNumber(option, 'pcieSlots') < 2) return true;
        const slot = Number(pcieSlotKey(option).match(/PCIe Slot (\d+)/i)?.[1] ?? 0);
        return !slot || !items.some((other) => other !== option && pcieSlotKey(other) === `PCIe Slot ${slot + 1}`);
      })));
    }
    const plan = plans.sort((a, b) => a.reduce((sum, option) => sum + option.unitListPrice, 0) - b.reduce((sum, option) => sum + option.unitListPrice, 0) || comparePlacement(a.map((option) => ({ option })), b.map((option) => ({ option }))))[0];
    if (!plan) violations.push(`No set of ${gpuCount} identical GPU(s) fits the available platform slots and requested GPU requirements.`);
    else {
      const maxTdp = Math.max(...plan.map((option) => attributeNumber(option, 'tdpWatts')), 0);
      const perGpuMemory = Math.max(...plan.map((option) => attributeNumber(option, 'gpuMemoryGb')), 0);
      const currentGpuSkus = new Set(currentSelections.filter((option) => option.category === 'gpu').map((option) => option.sku));
      if (currentGpuSkus.size && plan.some((option) => !currentGpuSkus.has(option.sku))) violations.push('Cisco UCS GPUs cannot be mixed; the recommended GPU must match the GPU already selected in CCW.');
      if (capability.gpuRequiresTwoCpusAtOrAboveWatts !== undefined && maxTdp >= capability.gpuRequiresTwoCpusAtOrAboveWatts && cpuCountForSlots < 2) violations.push(`${profile?.model ?? 'This platform'} requires two CPUs for GPUs at or above ${capability.gpuRequiresTwoCpusAtOrAboveWatts} W.`);
      if (capability.gpuRequiresAllRisersAtOrAboveWatts !== undefined && maxTdp >= capability.gpuRequiresAllRisersAtOrAboveWatts) for (const number of [1, 2, 3]) requiredRiserNumbers.add(number);
      if (capability.gpuDisallows256GbDimmsAboveWatts !== undefined && maxTdp > capability.gpuDisallows256GbDimmsAboveWatts && selectedMemory && attributeNumber(selectedMemory.option, 'capacityGb') >= 256) violations.push(`${profile?.model ?? 'This platform'} does not support 256 GB DIMMs with the selected GPU power class.`);
      if (capability.cpuPowerCapWithGpuWatts && selectedCpu && maxTdp > 75 && attributeNumber(selectedCpu, 'tdpWatts') > capability.cpuPowerCapWithGpuWatts) violations.push(`The selected GPU limits CPU TDP to ${capability.cpuPowerCapWithGpuWatts} W on ${profile?.model ?? 'this platform'}.`);
      if (/PCIe\s*Node/i.test(String(gpuDeploymentType ?? '')) && cpuCountForSlots < 2) violations.push('X-Series PCIe-node GPU configurations require two CPUs in the compute node.');
      if (capability.gpuMemoryMultiplierForPcieNode && /X580P|580P/i.test(String(gpuDeploymentType ?? '')) && memoryGb && memoryGb < perGpuMemory * gpuCount * capability.gpuMemoryMultiplierForPcieNode) violations.push(`X580P GPU configurations require server memory of at least ${capability.gpuMemoryMultiplierForPcieNode}× total GPU memory.`);
      for (const option of plan) reserveOptionSlot(option);
      const airductRequired = plan.some((option) => attributeNumber(option, 'pcieSlots') >= 2 || String(option.attributes.gpuWidth).toLowerCase() === 'double')
        && plan.every((option) => !/\bL4\b/i.test(`${option.sku} ${option.name}`));
      const gpuAirduct = airductRequired ? available.filter((option) => option.category === 'accessory' && /^GPU Airduct$/i.test(String(option.attributes.categoryName ?? '')))
        .filter((option) => supportsQuantity(option, 1)).sort((a, b) => a.unitListPrice - b.unitListPrice)[0] : undefined;
      if (airductRequired && !gpuAirduct) violations.push('The selected double-wide GPU requires a GPU air duct, but no compatible air-duct option is available.');
      const frontMezzanineConflict = xFrontMezzGpuRequired && currentFrontMezzanine && !currentGpuFrontMezzanine;
      if (frontMezzanineConflict) violations.push(`${currentFrontMezzanine.sku} already occupies the only front-mezzanine connector; remove or replace it before selecting a compute-node GPU front mezzanine.`);
      const xFrontMezz = xFrontMezzGpuRequired && !currentGpuFrontMezzanine && !frontMezzanineConflict ? available.filter((option) => option.category === 'accessory' && isFrontMezzanine(option) && /GPU/i.test(`${option.sku} ${option.name}`))
        .filter((option) => supportsQuantity(option, 1)).sort((a, b) => a.unitListPrice - b.unitListPrice)[0] : undefined;
      if (xFrontMezzGpuRequired && !currentGpuFrontMezzanine && !frontMezzanineConflict && !xFrontMezz) violations.push('X-Series compute-node GPUs require the GPU front-mezzanine adapter, but no compatible option is available.');
      const gpuSelections = [...plan.map((option) => ({ optionId: option.id, quantity: 1 })), ...(gpuAirduct ? [{ optionId: gpuAirduct.id, quantity: 1 }] : []), ...(xFrontMezz ? [{ optionId: xFrontMezz.id, quantity: 1 }] : [])];
      add('gpu', 'GPU', gpuSelections, `${gpuCount} identical ${plan[0]!.sku} GPU(s) · ${perGpuMemory || 'unknown'} GB each · ${maxTdp || 'unknown'} W maximum${gpuAirduct ? ` · includes required ${gpuAirduct.sku} air duct` : ''}${xFrontMezz ? ` · includes required ${xFrontMezz.sku} front-mezzanine adapter` : currentGpuFrontMezzanine && xFrontMezzGpuRequired ? ` · uses selected ${currentGpuFrontMezzanine.sku} front-mezzanine adapter` : ''}`);
    }
  }

  const nicGroupNumbers = [...new Set(requirements.flatMap((requirement) => { const match = requirement.id.match(/^nicGroup(\d+)/); return match ? [Number(match[1])] : []; }))].sort((a, b) => a - b);
  const groupedNicSpecs = nicGroupNumbers.flatMap((number) => {
    const cardCount = numericRequirement(requirements, `nicGroup${number}CardCount`)?.value;
    const portsPerCard = numericRequirement(requirements, `nicGroup${number}PortsPerCard`)?.value;
    const totalPorts = numericRequirement(requirements, `nicGroup${number}TotalPorts`)?.value;
    const speedPerPort = numericRequirement(requirements, `nicGroup${number}SpeedGbpsPerPort`)?.value;
    const media = requirements.find((requirement) => requirement.id === `nicGroup${number}Media` && typeof requirement.value === 'string')?.value;
    const adapterType = requirements.find((requirement) => requirement.id === `nicGroup${number}AdapterType` && typeof requirement.value === 'string')?.value;
    return cardCount || portsPerCard || totalPorts || speedPerPort || media || adapterType ? [{ number, cardCount, portsPerCard, totalPorts, speedPerPort, media, adapterType }] : [];
  });
  const legacyNicSpec = {
    number: 1,
    cardCount: numericRequirement(requirements, 'nicCardCount')?.value,
    portsPerCard: numericRequirement(requirements, 'nicPortsPerCard')?.value,
    totalPorts: numericRequirement(requirements, 'nicTotalPorts')?.value,
    speedPerPort: numericRequirement(requirements, 'nicSpeedGbpsPerPort')?.value,
    media: requirements.find((requirement) => requirement.id === 'nicMedia' && typeof requirement.value === 'string')?.value,
    adapterType: requirements.find((requirement) => requirement.id === 'nicAdapterType' && typeof requirement.value === 'string')?.value
  };
  const nicSpecs = groupedNicSpecs.length ? groupedNicSpecs : legacyNicSpec.cardCount || legacyNicSpec.portsPerCard || legacyNicSpec.totalPorts || legacyNicSpec.speedPerPort || legacyNicSpec.media || legacyNicSpec.adapterType ? [legacyNicSpec] : [];
  let xSeriesRearMezzSelected = currentSelections.some(isOptionalXSeriesRearVIC);
  if (nicSpecs.length) {
    const choicesBySpec = nicSpecs.map((spec) => {
      const isRiserSlot = (slot: string) => /^(?:PCIe Slot|Riser)\s+\d+$/i.test(slot);
      const isMlomSlot = (slot: string) => slot === 'PCIe MLOM/OCP';
      const isOptionalRearMezzSlot = (slot: string) => ['X210C_M8', 'X215C_M8'].includes(capability.kind) && slot === 'Rear Mezzanine';
      const requestedMedia = canonicalNicMedia(spec.media);
      const requestedAdapterType = String(spec.adapterType ?? '').trim().toUpperCase();
      const c240VicRequest = ['C240_M8_LFF', 'C240_M8_SFF'].includes(capability.kind) && requestedAdapterType === 'VIC';
      const explicitMlom = requestedAdapterType === 'OCP' || requestedAdapterType === 'VIC' && !c240VicRequest;
      const adapterTypeMatches = (option: CatalogOption) => {
        if (!['C240_M8_LFF', 'C240_M8_SFF'].includes(capability.kind)) return true;
        if (requestedAdapterType === 'OCP') return /\bOCP\b/i.test(`${option.sku} ${option.name}`);
        if (requestedAdapterType === 'VIC') return /\bVIC\b/i.test(`${option.sku} ${option.name}`);
        return true;
      };
      const matching = available.filter((option) => requestedMedia === 'FC'
        ? option.category === 'hba' && isRiserSlot(pcieSlotKey(option))
        : option.category === 'nic' && (explicitMlom ? isMlomSlot(pcieSlotKey(option)) : isRiserSlot(pcieSlotKey(option)) || isMlomSlot(pcieSlotKey(option)) || isOptionalRearMezzSlot(pcieSlotKey(option))))
        .filter(adapterTypeMatches)
        .filter((option) => !['X210C_M8', 'X215C_M8'].includes(capability.kind) || !isMlomSlot(pcieSlotKey(option)) || isRequiredXSeriesMlom(option))
        .filter((option) => !occupiedPcieSlots.has(pcieSlotKey(option)))
        .filter((option) => isMlomSlot(pcieSlotKey(option)) || isOptionalRearMezzSlot(pcieSlotKey(option)) || optionUsesAllowedRiser(option))
        .filter((option) => requestedMedia !== 'FC' || capability.kind === 'UNKNOWN' || capability.fcHbaRisers.includes(riserNumber(String(option.attributes.categoryName ?? '')) ?? -1))
        .filter((option) => supportsQuantity(option, 1))
        .filter((option) => spec.portsPerCard === undefined || attributeNumber(option, 'ports') >= spec.portsPerCard)
        .filter((option) => supportsRequestedNicSpeed(option.attributes.supportedSpeedsGbps, spec.speedPerPort))
        .filter((option) => spec.media === undefined || requestedMedia !== 'FC' || canonicalNicMedia(option.attributes.nicMedia) === requestedMedia)
        .sort((a, b) => Number(canonicalNicMedia(b.attributes.nicMedia) === requestedMedia) - Number(canonicalNicMedia(a.attributes.nicMedia) === requestedMedia)
          || Number(!explicitMlom && isMlomSlot(pcieSlotKey(a))) - Number(!explicitMlom && isMlomSlot(pcieSlotKey(b)))
          || placementRank(a) - placementRank(b)
          || a.unitListPrice - b.unitListPrice);
      const bySlot = new Map<string, CatalogOption[]>();
      for (const option of matching) { const slot = pcieSlotKey(option); bySlot.set(slot, [...(bySlot.get(slot) ?? []), option]); }
      let combinations: Array<Array<{ slot: string; option: CatalogOption }>> = [[]];
      for (const [slot, options] of bySlot) combinations = combinations.flatMap((current) => [current, ...options.map((option) => [...current, { slot, option }])]).slice(0, 10000);
      const minimumCardCount = spec.cardCount ?? (spec.totalPorts === undefined ? 1 : undefined);
      const mediaMismatchCount = (items: Array<{ option: CatalogOption }>) => spec.media === undefined ? 0 : items.filter((item) => canonicalNicMedia(item.option.attributes.nicMedia) !== requestedMedia).length;
      const c240VicTopologyFits = (items: Array<{ slot: string; option: CatalogOption }>) => {
        if (!c240VicRequest) return true;
        const selectedPluginVics = currentSelections.filter((option) => option.category === 'nic' && !isMlomSlot(pcieSlotKey(option)) && /\bVIC\b/i.test(`${option.sku} ${option.name}`));
        const pluginVics = items.filter((item) => !isMlomSlot(item.slot));
        const maximumPluginVics = cpuCountForSlots >= 2 ? 2 : 1;
        const risers = [...selectedPluginVics.map((option) => riserNumber(String(option.attributes.categoryName ?? ''))), ...pluginVics.map((item) => riserNumber(String(item.option.attributes.categoryName ?? '')))].filter((number): number is number => number !== undefined);
        return selectedPluginVics.length + pluginVics.length <= maximumPluginVics && new Set(risers).size === risers.length;
      };
      const choices = combinations.filter((items) => c240VicTopologyFits(items) && compatibleRiserVariants(items) && (minimumCardCount === undefined || items.length === minimumCardCount) && (spec.totalPorts === undefined || items.reduce((sum, item) => sum + attributeNumber(item.option, 'ports'), 0) >= spec.totalPorts))
        .sort((a, b) => mediaMismatchCount(a) - mediaMismatchCount(b) || Number(!explicitMlom && !capability.mandatoryMlom) * (a.filter((item) => isMlomSlot(item.slot)).length - b.filter((item) => isMlomSlot(item.slot)).length) || comparePlacement(a, b) || a.reduce((sum, item) => sum + item.option.unitListPrice, 0) - b.reduce((sum, item) => sum + item.option.unitListPrice, 0));
      if (!choices.length) violations.push(groupedNicSpecs.length
        ? spec.cardCount !== undefined ? `NIC group ${spec.number}: only ${bySlot.size} physical slot(s) meet the requirement; ${spec.cardCount} requested.` : `NIC group ${spec.number}: no combination provides ${spec.totalPorts} requested port(s).`
        : spec.cardCount !== undefined ? `Only ${bySlot.size} physical NIC slot(s) meet the requirement; ${spec.cardCount} requested.` : `No combination of physical NIC slots provides ${spec.totalPorts} requested port(s).`);
      return choices.slice(0, 100);
    });
    if (choicesBySpec.every((choices) => choices.length)) {
      let plans: Array<Array<{ specIndex: number; items: Array<{ slot: string; option: CatalogOption }> }>> = [[]];
      choicesBySpec.forEach((choices, specIndex) => {
        plans = plans.flatMap((plan) => choices.flatMap((items) => {
          const usedSlots = new Set(plan.flatMap((entry) => entry.items.map((item) => item.slot)));
          return items.some((item) => usedSlots.has(item.slot)) || !compatibleRiserVariants([...plan.flatMap((entry) => entry.items), ...items]) ? [] : [[...plan, { specIndex, items }]];
        })).slice(0, 10000);
      });
      const mlomFallbackCount = (plan: typeof plans[number]) => capability.mandatoryMlom ? 0 : plan.reduce((sum, entry) => /^(?:VIC|OCP)$/i.test(String(nicSpecs[entry.specIndex]?.adapterType ?? '')) ? sum : sum + entry.items.filter((item) => pcieSlotKey(item.option) === 'PCIe MLOM/OCP').length, 0);
      const mediaMismatchCountForPlan = (plan: typeof plans[number]) => plan.reduce((sum, entry) => {
        const requested = canonicalNicMedia(nicSpecs[entry.specIndex]?.media);
        return requested ? sum + entry.items.filter((item) => canonicalNicMedia(item.option.attributes.nicMedia) !== requested).length : sum;
      }, 0);
      const itemsForMedia = (plan: typeof plans[number], media: 'FC' | 'NON_FC') => plan.flatMap((entry) => {
        const isFc = String(nicSpecs[entry.specIndex]?.media ?? '').toUpperCase() === 'FC';
        return (media === 'FC') === isFc ? entry.items : [];
      });
      const plan = plans.sort((a, b) => mediaMismatchCountForPlan(a) - mediaMismatchCountForPlan(b)
        || comparePlacement(itemsForMedia(a, 'FC'), itemsForMedia(b, 'FC'))
        || mlomFallbackCount(a) - mlomFallbackCount(b)
        || comparePlacement(itemsForMedia(a, 'NON_FC'), itemsForMedia(b, 'NON_FC'))
        || a.flatMap((entry) => entry.items).reduce((sum, item) => sum + item.option.unitListPrice, 0) - b.flatMap((entry) => entry.items).reduce((sum, item) => sum + item.option.unitListPrice, 0))[0];
      if (!plan) violations.push('The requested NIC groups cannot be placed without reusing the same physical slot.');
      else for (const entry of plan) {
        if (entry.items.some((item) => isOptionalXSeriesRearVIC(item.option)) && cpuCountForSlots < 2) {
          xSeriesRearMezzSelected = true;
          continue;
        }
        const spec = nicSpecs[entry.specIndex]!;
        const mlomFallback = !spec.adapterType && entry.items.some((item) => pcieSlotKey(item.option) === 'PCIe MLOM/OCP');
        const reason = `${entry.items.length} card(s) × ${spec.portsPerCard ?? 'required'} ports at ${spec.speedPerPort ?? 'supported'} Gbps · ${spec.media ?? 'any media'}${spec.adapterType ? ` · ${spec.adapterType}` : ''}${mlomFallback ? ' · riser slots exhausted; PCIe MLOM fallback' : ''}`;
        const mlom = entry.items.filter((item) => pcieSlotKey(item.option) === 'PCIe MLOM/OCP');
        const riser = entry.items.filter((item) => pcieSlotKey(item.option) !== 'PCIe MLOM/OCP');
        if (entry.items.some((item) => isOptionalXSeriesRearVIC(item.option))) xSeriesRearMezzSelected = true;
        for (const item of entry.items) reserveOptionSlot(item.option);
        if (mlom.length) add('mlom', nicSpecs.length > 1 ? `NIC group ${spec.number} · PCIe MLOM` : 'PCIe MLOM', mlom.map((item) => ({ optionId: item.option.id, quantity: 1 })), reason);
        if (riser.length) add('riserNic', nicSpecs.length > 1 ? `NIC group ${spec.number} · ${String(spec.media).toUpperCase() === 'FC' ? 'Fibre Channel HBA' : 'NIC'}` : 'NIC in riser slots', riser.map((item) => ({ optionId: item.option.id, quantity: 1 })), reason);
      }
    }
  }
  if (xSeriesRearMezzSelected && cpuCountForSlots < 2) violations.push('The X210c optional rear mezzanine adapter requires two CPUs.');

  if (capability.mandatoryMlom) {
    const currentHasMlom = currentSelections.some((option) => option.category === 'nic' && pcieSlotKey(option) === 'PCIe MLOM/OCP' && isRequiredXSeriesMlom(option));
    const recommendationHasMlom = components.some((component) => component.component === 'mlom');
    if (!currentHasMlom && !recommendationHasMlom) {
      const mlom = available.filter((option) => option.category === 'nic' && pcieSlotKey(option) === 'PCIe MLOM/OCP' && isRequiredXSeriesMlom(option) && supportsQuantity(option, 1))
        .sort((a, b) => a.unitListPrice - b.unitListPrice)[0];
      if (mlom) add('mlom', 'Required rear mLOM', [{ optionId: mlom.id, quantity: 1 }], `${profile?.model ?? 'X-Series'} requires one rear mLOM adapter`);
      else violations.push(`${profile?.model ?? 'X-Series'} requires one rear mLOM adapter, but no compatible mLOM option is available.`);
    }
  }

  if (bootCapacity && bootDriveCountValid) {
    const requiredPerDriveGb = bootCapacity.id === 'bootCapacityGb' ? bootCapacity.value : capacityInGb(bootCapacity.value, bootCapacity.unit);
    if (m2Boot) {
      const requestedProtocol = /NVMe/i.test(String(bootDriveType)) ? 'NVMe' : /SATA/i.test(String(bootDriveType)) ? 'SATA' : undefined;
      const protocolOf = (option: CatalogOption) => {
        const value = `${option.attributes.m2Protocol ?? ''} ${option.attributes.driveInterface ?? ''} ${option.name}`;
        return /NVMe/i.test(value) ? 'NVMe' : /SATA/i.test(value) ? 'SATA' : 'any';
      };
      const drives = available.filter((option) => option.category === 'bootDrive')
        .filter((option) => requestedProtocol === undefined || protocolOf(option) === requestedProtocol || protocolOf(option) === 'any')
        .filter((option) => attributeNumber(option, 'capacityGb') >= requiredPerDriveGb)
        .sort((a, b) => a.unitListPrice - b.unitListPrice || attributeNumber(a, 'capacityGb') - attributeNumber(b, 'capacityGb'));
      const drive = drives[0];
      if (!drive) violations.push('No M.2 drive meets boot capacity, protocol, and lead-time requirements.');
      else {
        const protocol = requestedProtocol ?? protocolOf(drive);
        const controllerMatchesProtocol = (option: CatalogOption) => String(option.attributes.m2Protocol ?? 'any').toUpperCase() === 'ANY' || String(option.attributes.m2Protocol ?? '').toUpperCase() === protocol.toUpperCase();
        const cpuGeneration = selectedCpu ? attributeNumber(selectedCpu, 'cpuGeneration') : undefined;
        const platformSupportsRaid = capability.kind === 'UNKNOWN'
          || protocol === 'SATA' && capability.m2SataRaid
          || protocol === 'NVMe' && cpuGeneration !== undefined && capability.m2NvmeRaidCpuGenerations.includes(cpuGeneration);
        const raidController = platformSupportsRaid ? available.filter((option) => option.category === 'boot' && option.attributes.controllerType === 'M.2')
          .filter((option) => supportsQuantity(option, 1) && supportsRaidLevel(option, '1') && controllerMatchesProtocol(option))
          .filter((option) => option.attributes.bootLocation !== 'MLOM' || !occupiedPcieSlots.has('PCIe MLOM/OCP'))
          .sort((a, b) => a.unitListPrice - b.unitListPrice)[0] : undefined;
        if (raidController && requestedBootDriveCount === 1) {
          if (!supportsQuantity(drive, 1)) violations.push(`${drive.sku} does not support one M.2 boot drive.`);
          else {
            if (raidController.attributes.selected !== true) add('bootController', 'M.2 Controller', [{ optionId: raidController.id, quantity: 1 }], `${protocol} M.2 controller used with one non-mirrored boot drive`);
            add('bootDrive', `M.2 ${protocol} Boot Drive`, [{ optionId: drive.id, quantity: 1 }], `1 × ${attributeNumber(drive, 'capacityGb')} GB M.2 ${protocol} boot drive in non-mirrored/JBOD mode`);
          }
        } else if (raidController) {
          if (!supportsQuantity(drive, 2)) violations.push(`${drive.sku} cannot be selected as the required pair of identical M.2 RAID 1 drives.`);
          else {
            if (raidController.attributes.selected !== true) add('bootController', 'M.2 RAID Controller', [{ optionId: raidController.id, quantity: 1 }], protocol === 'any' ? 'M.2 boot controller with RAID 1' : `${protocol} M.2 boot media supports RAID; use the M.2 controller and RAID 1`);
            add('bootDrive', `M.2 ${protocol} Boot Drives`, [{ optionId: drive.id, quantity: 2 }], `2 identical × ${attributeNumber(drive, 'capacityGb')} GB M.2 ${protocol} boot drives in RAID 1`);
          }
        } else if (platformSupportsRaid) {
          violations.push(`No compatible ${protocol} M.2 controller is available; the rear hot-plug M.2 controller can use the mLOM slot only when that slot is empty.`);
        } else {
          const count = requestedBootDriveCount ?? 1;
          const passThrough = available.filter((option) => option.category === 'boot' && option.attributes.controllerType === 'M.2-passthrough')
            .filter((option) => supportsQuantity(option, 1) && controllerMatchesProtocol(option)).sort((a, b) => a.unitListPrice - b.unitListPrice)[0];
          if (passThrough) add('bootController', 'M.2 Pass-through Controller', [{ optionId: passThrough.id, quantity: 1 }], `${protocol} M.2 boot media does not support RAID on this platform; use pass-through`);
          if (!supportsQuantity(drive, count)) violations.push(`${drive.sku} does not support the requested M.2 boot-drive quantity.`);
          else add('bootDrive', `M.2 ${protocol} Boot Drive${count === 1 ? '' : 's'}`, [{ optionId: drive.id, quantity: count }], `${count} identical × ${attributeNumber(drive, 'capacityGb')} GB M.2 ${protocol} boot drive(s) without RAID`);
        }
      }
    } else if (bootDriveType) {
      const requestedType = String(bootDriveType).toUpperCase();
      const bootDrives = available.filter((option) => option.category === 'storage' && String(option.attributes.storageLocation).toLowerCase() === 'front')
        .filter((option) => supportsQuantity(option, bootDriveCount))
        .filter((option) => requestedType === 'SSD' ? ['SSD', 'NVME'].includes(String(option.attributes.driveType).toUpperCase()) : String(option.attributes.driveType).toUpperCase() === requestedType)
        .filter((option) => attributeNumber(option, 'capacityGb') >= requiredPerDriveGb)
        .sort((a, b) => optionCost(a, bootDriveCount) - optionCost(b, bootDriveCount));
      if (bootDrives[0]) add('bootDrive', `${bootDriveType} Boot Drives`, [{ optionId: bootDrives[0].id, quantity: bootDriveCount }], `${bootDriveCount} × ${attributeNumber(bootDrives[0], 'capacityGb')} GB ${bootDriveType} boot drive(s) using the standard controller`);
      else violations.push(`No ${bootDriveType} drive meets boot capacity and lead-time requirements.`);
    }
  }

  if (capability.kind !== 'UNKNOWN' && (requiredRiserNumbers.size || requiredRiserVariants.size)) {
    const riserSelections: Selection[] = [];
    for (const number of [...requiredRiserNumbers].sort((a, b) => a - b)) {
      const requestedVariant = [...requiredRiserVariants].find((variant) => variant.startsWith(`R${number}`));
      const choices = available.filter((option) => option.category === 'riser')
        .filter((option) => {
          const categoryName = String(option.attributes.categoryName ?? '').replace(/\s+/g, ' ').trim();
          const subgroupName = String(option.attributes.subgroupName ?? '').replace(/\s+/g, ' ').trim();
          return /^PCIe Riser(?:\s+\d+)? Option$/i.test(categoryName) && new RegExp(`^PCIe Riser ${number} Option$`, 'i').test(subgroupName);
        })
        .filter((option) => riserNumber(`${option.attributes.categoryName ?? ''} ${option.sku} ${option.name}`) === number)
        .filter((option) => !requestedVariant || riserVariant(`${option.attributes.categoryName ?? ''} ${option.sku} ${option.name}`) === requestedVariant)
        .filter((option) => supportsQuantity(option, 1)).sort((a, b) => a.unitListPrice - b.unitListPrice);
      if (choices[0]) riserSelections.push({ optionId: choices[0].id, quantity: 1 });
      else violations.push(`No compatible ${requestedVariant ?? `Riser ${number}`} kit is available for the selected PCIe components.`);
    }
    if (riserSelections.length) add('riser', 'PCIe Riser Kits', riserSelections, `Required by occupied ${[...requiredRiserVariants].sort().join(', ') || [...requiredRiserNumbers].sort().map((number) => `Riser ${number}`).join(', ')} slots`);
  }

  const selections = components.flatMap((component) => component.selections);
  const calculations = evaluateRequirements(requirements, catalog, selections);
  const failed = calculations.filter((item) => !item.passed).map((item) => `Requirement ${item.requirementId} is not met.`);
  return { components, calculations, violations: [...violations, ...failed], notices, totalListPrice: components.reduce((sum, component) => sum + component.totalListPrice, 0), maxLeadTimeDays: Math.max(0, ...components.map((component) => component.maxLeadTimeDays)) };
}
