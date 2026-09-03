import type { Requirement } from './types.js';

export function unresolvedBlockers(requirements: Requirement[]): Requirement[] {
  const hasNumber = (id: string) => requirements.some((item) => item.id === id && typeof item.value === 'number' && item.value > 0);
  const cpuSizingComplete = hasNumber('cpuTotalCores') || hasNumber('cpuCores') || (hasNumber('cpuSockets') && hasNumber('cpuCoresPerSocket'));
  const memorySizingComplete = hasNumber('memoryGb') || (hasNumber('memoryModuleCount') && hasNumber('memoryModuleSizeGb'));
  const optionalComponentParameter = (id: string) => /^(?:cpu(?:Cores|TotalCores|Sockets|CoresPerSocket|ClockGhz|Vendor)|memory(?:Gb|ModuleCount|ModuleSizeGb)|localDrive(?:Count|Capacity|Type|Interface|TransferSpeedGbps)|raidLevel|boot(?:Capacity|CapacityGb|DriveCount|DriveType)|maxLocalDriveCount|nic(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort|Media|AdapterType)|nicGroup\d+(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort|Media|AdapterType)|gpu(?:Count|Model|MemoryGb|DeploymentType)|storageGroup\d+(?:Capacity|DriveCount|DriveCapacity|DriveType|DriveInterface|TransferSpeedGbps|RaidLevel))$/.test(id);
  const alternativeIsComplete = (id: string) => {
    if (['cpuTotalCores', 'cpuCores', 'cpuSockets', 'cpuCoresPerSocket'].includes(id)) return cpuSizingComplete;
    if (['memoryGb', 'memoryModuleCount', 'memoryModuleSizeGb'].includes(id)) return memorySizingComplete;
    const storage = id.match(/^storageGroup(\d+)(Capacity|DriveCount|DriveCapacity)$/);
    return storage ? hasNumber(`storageGroup${storage[1]}Capacity`) || (hasNumber(`storageGroup${storage[1]}DriveCount`) && hasNumber(`storageGroup${storage[1]}DriveCapacity`)) : false;
  };
  const blockers = requirements.filter((requirement) => requirement.required && (requirement.status === 'unresolved' || requirement.value === undefined) && !optionalComponentParameter(requirement.id) && !alternativeIsComplete(requirement.id));
  const placeholder = (id: string, label: string, note?: string): Requirement => ({ id, label, status: 'unresolved', required: true, evidence: [], ...(note ? { note } : {}) });

  const storageGroupNumbers = [...new Set(requirements.flatMap((requirement) => {
    const match = requirement.id.match(/^storageGroup(\d+)/); return match ? [Number(match[1])] : [];
  }))];
  for (const number of storageGroupNumbers) {
    const prefix = `storageGroup${number}`;
    const capacityType = requirements.find((item) => item.id === `${prefix}CapacityType`)?.value;
    const raidLevel = requirements.find((item) => item.id === `${prefix}RaidLevel`)?.value;
    if (String(capacityType).toLowerCase() === 'usable' && (raidLevel === undefined || raidLevel === '') && !blockers.some((item) => item.id === `${prefix}RaidLevel`)) {
      blockers.push(placeholder(`${prefix}RaidLevel`, `drive group ${number} RAID level`, `Which RAID level should drive group ${number} use to provide usable capacity?`));
    }
  }
  const localCapacityType = requirements.find((item) => item.id === 'localStorageCapacityType')?.value;
  const localRaidLevel = requirements.find((item) => item.id === 'raidLevel')?.value;
  if (String(localCapacityType).toLowerCase() === 'usable' && (localRaidLevel === undefined || localRaidLevel === '') && !blockers.some((item) => item.id === 'raidLevel')) {
    blockers.push(placeholder('raidLevel', 'local-storage RAID level', 'Which RAID level should be used to provide the requested usable local-storage capacity?'));
  }
  return blockers;
}

export interface ClarificationQuestion {
  requirementId: string;
  question: string;
}

export function clarificationQuestions(requirements: Requirement[]): ClarificationQuestion[] {
  const blockers = unresolvedBlockers(requirements);
  const advisory = requirements.filter((requirement) => requirement.status === 'unresolved' && requirement.note?.includes('?') && !blockers.some((blocker) => blocker.id === requirement.id));
  const questions = [...blockers, ...advisory].map((requirement) => {
    const note = requirement.note?.trim();
    if (note?.includes('?')) return { requirementId: requirement.id, question: note };
    if (requirement.id === 'nicTopology') return { requirementId: requirement.id, question: 'How many NIC cards are required, and how many ports should each card provide?' };
    if (/CapacityType$/.test(requirement.id)) return { requirementId: requirement.id, question: `Is ${requirement.label.toLowerCase()} raw or usable?` };
    if (/RaidLevel$/.test(requirement.id) || requirement.id === 'raidLevel') return { requirementId: requirement.id, question: 'Should this drive group use RAID? Choose a RAID level or No RAID (HBA pass-through).' };
    if (/DriveType$/.test(requirement.id)) return { requirementId: requirement.id, question: `What ${requirement.label.toLowerCase()} should be used: HDD, SSD, or NVMe?` };
    return { requirementId: requirement.id, question: `What value should be used for ${requirement.label.toLowerCase()}?` };
  });
  return questions.filter((item, index) => questions.findIndex((candidate) => candidate.question === item.question) === index);
}
