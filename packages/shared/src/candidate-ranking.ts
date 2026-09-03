import { evaluateRequirements } from './calculations.js';
import { validatePlatform } from './rules.js';
import { unresolvedBlockers } from './clarifications.js';
import type { CatalogOption, ConfigurationCandidate, Requirement, Selection } from './types.js';

export const supportsQuantity = (option: CatalogOption, quantity: number): boolean => option.attributes.quantityFixed !== true || (typeof option.attributes.fixedQuantity === 'number' && option.attributes.fixedQuantity === quantity);

export function validateSelection(catalog: CatalogOption[], selections: Selection[]): string[] {
  const chosen = new Set(selections.filter((selection) => selection.quantity > 0).map((selection) => selection.optionId));
  const violations: string[] = [];
  for (const selection of selections) {
    const option = catalog.find((item) => item.id === selection.optionId);
    if (!option) { violations.push(`Unknown option: ${selection.optionId}`); continue; }
    if (!option.available) violations.push(`${option.sku} is unavailable`);
    if (option.category === 'storage' && String(option.attributes.storageLocation).toLowerCase() !== 'front') violations.push(`${option.sku} is not a front-facing drive option`);
    if (!supportsQuantity(option, selection.quantity)) violations.push(`${option.sku} has a fixed CCW quantity that does not allow ${selection.quantity}`);
    for (const required of option.requires ?? []) if (!chosen.has(required)) violations.push(`${option.sku} requires ${required}`);
    for (const excluded of option.excludes ?? []) if (chosen.has(excluded)) violations.push(`${option.sku} excludes ${excluded}`);
  }
  return [...new Set(violations)];
}

export function scoreCandidate(id: string, family: ConfigurationCandidate['family'], requirements: Requirement[], catalog: CatalogOption[], selections: Selection[]): ConfigurationCandidate {
  const calculations = evaluateRequirements(requirements, catalog, selections);
  const violations = [...validateSelection(catalog, selections), ...validatePlatform(family, catalog, selections), ...calculations.filter((calculation) => !calculation.passed).map((calculation) => `Requirement ${calculation.requirementId} is not met`)];
  const totalListPrice = selections.reduce((sum, selection) => sum + (catalog.find((option) => option.id === selection.optionId)?.unitListPrice ?? 0) * selection.quantity, 0);
  const excessScore = calculations.reduce((sum, calculation) => calculation.requirementId !== 'maxLeadTimeDays' && typeof calculation.actual === 'number' && typeof calculation.required === 'number' ? sum + Math.max(0, calculation.actual - calculation.required) : sum, 0);
  return { id, family, selections, calculations, violations, warnings: [], totalListPrice, excessScore };
}

export function rankCandidates(candidates: ConfigurationCandidate[]): ConfigurationCandidate[] {
  return candidates.filter((candidate) => candidate.violations.length === 0).sort((a, b) =>
    a.totalListPrice - b.totalListPrice || a.warnings.length - b.warnings.length || a.excessScore - b.excessScore || a.selections.length - b.selections.length
  );
}

const metricForCategory: Partial<Record<CatalogOption['category'], { requirementIds: string[]; attribute: string }>> = {
  cpu: { requirementIds: ['cpuCores'], attribute: 'cores' },
  memory: { requirementIds: ['memoryGb'], attribute: 'capacityGb' },
  storage: { requirementIds: ['rawStorageTb', 'usableStorageTb'], attribute: 'capacityTb' },
  gpu: { requirementIds: ['gpuCount'], attribute: 'count' },
  nic: { requirementIds: ['nicPorts'], attribute: 'ports' }
};

export function recommendCheapest(family: ConfigurationCandidate['family'], requirements: Requirement[], catalog: CatalogOption[]): ConfigurationCandidate[] {
  if (unresolvedBlockers(requirements).length) return [];
  const base: Selection[] = [];
  const targetLeadTime = requirements.find((requirement) => requirement.id === 'maxLeadTimeDays' && typeof requirement.value === 'number')?.value as number | undefined;
  const meetsLeadTime = (option: CatalogOption) => targetLeadTime === undefined || (typeof option.attributes.leadTimeDays === 'number' && option.attributes.leadTimeDays >= 0 && option.attributes.leadTimeDays <= targetLeadTime);
  const chooseCheapest = (category: CatalogOption['category']) => catalog.filter((option) => option.available && option.category === category && meetsLeadTime(option) && supportsQuantity(option, 1)).sort((a, b) => a.unitListPrice - b.unitListPrice)[0];
  for (const category of ['server', ...(family === 'X_SERIES' ? ['chassis', 'fabric'] : [])] as CatalogOption['category'][]) {
    const option = chooseCheapest(category); if (option) base.push({ optionId: option.id, quantity: 1 });
  }
  const categoryCandidates: Selection[][] = [];
  for (const [category, mapping] of Object.entries(metricForCategory) as Array<[CatalogOption['category'], NonNullable<typeof metricForCategory[CatalogOption['category']]>]>) {
    const requirement = requirements.find((item) => mapping.requirementIds.includes(item.id) && typeof item.value === 'number');
    if (!requirement || typeof requirement.value !== 'number') continue;
    const choices = catalog.filter((option) => option.available && option.category === category && meetsLeadTime(option))
      .filter((option) => category !== 'storage' || String(option.attributes.storageLocation).toLowerCase() === 'front').flatMap((option) => {
        const perUnit = category === 'gpu' ? 1 : Number(option.attributes[mapping.attribute] ?? 0);
        const quantity = Math.max(1, Math.ceil(requirement.value as number / perUnit));
        const maxQuantity = typeof option.attributes.maxQuantity === 'number' ? option.attributes.maxQuantity : Number.POSITIVE_INFINITY;
        return perUnit > 0 && quantity <= maxQuantity && supportsQuantity(option, quantity) ? [{ optionId: option.id, quantity }] : [];
      });
    if (!choices.length) return [];
    categoryCandidates.push(choices);
  }
  let combinations: Selection[][] = [base];
  for (const choices of categoryCandidates) combinations = combinations.flatMap((current) => choices.map((choice) => [...current, choice])).slice(0, 5000);
  return rankCandidates(combinations.map((selections, index) => scoreCandidate(`candidate-${index + 1}`, family, requirements, catalog, selections))).slice(0, 3);
}
