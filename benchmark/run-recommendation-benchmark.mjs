import { readFile } from 'node:fs/promises';
import { normalizeExtractedRequirements } from '../packages/companion/dist/providers.js';
import { inferRackServerProfile, recommendRackComponents } from '../packages/shared/dist/index.js';

const catalogPath = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
if (!catalogPath) throw new Error('Usage: node benchmark/run-recommendation-benchmark.mjs <catalog-snapshot.json> [--ground-truth] [--summary]');

const baseCases = JSON.parse(await readFile(new URL('./requirement-cases.json', import.meta.url), 'utf8'));
const extraCasesPath = process.argv.slice(2).find((argument) => argument.startsWith('--extra-cases='))?.slice('--extra-cases='.length);
const extraCases = extraCasesPath ? JSON.parse(await readFile(extraCasesPath, 'utf8')) : [];
const cases = [...baseCases, ...extraCases];
const snapshot = JSON.parse(await readFile(catalogPath, 'utf8'));
const catalog = Array.isArray(snapshot) ? snapshot : snapshot.options;
if (!Array.isArray(catalog) || !catalog.length) throw new Error('Catalog snapshot has no options.');
const profile = snapshot.platformProfile ?? inferRackServerProfile(snapshot.parentSku ?? 'unknown');

const scopeRules = {
  cpu: { ids: /^cpu/, components: new Set(['cpu']), violation: /CPU option/i },
  memory: { ids: /^memory/, components: new Set(['memory']), violation: /memory option|DIMM/i },
  storage: { ids: /^(?:localStorage|localDrive|raidLevel|storageGroup)/, components: new Set(['storage']), violation: /storage|drive group|RAID/i },
  nic: { ids: /^nic/, components: new Set(['mlom', 'riserNic']), violation: /NIC|ports?|slot/i },
  gpu: { ids: /^gpu/, components: new Set(['gpu']), violation: /GPU/i }
};
const legacyIds = new Set(['cpuCores', 'rawStorageTb', 'usableStorageTb', 'nicPorts', 'nicThroughputGbps']);
const useGroundTruth = process.argv.includes('--ground-truth');
const requirementsFromGroundTruth = (testCase) => Object.entries(testCase.expected).map(([id, expected]) => ({
  id,
  label: id,
  ...(expected.value === undefined ? {} : { value: expected.value }),
  ...(expected.unit === undefined ? {} : { unit: expected.unit }),
  status: expected.status ?? (expected.value === undefined ? 'unresolved' : 'explicit'),
  required: true,
  evidence: []
}));
const componentOptionCategories = {
  cpu: new Set(['cpu']),
  memory: new Set(['memory']),
  raid: new Set(['raid']),
  storage: new Set(['storage']),
  riser: new Set(['riser']),
  mlom: new Set(['nic']),
  riserNic: new Set(['nic', 'hba']),
  gpu: new Set(['gpu', 'accessory']),
  bootController: new Set(['boot', 'raid']),
  bootDrive: new Set(['bootDrive', 'storage'])
};
const catalogAnomalies = [];
if (catalog.some((option) => option.category === 'gpu' && /air\s*duct|license|subscription|support|opt[- ]?out/i.test(`${option.sku} ${option.name}`))) catalogAnomalies.push('A GPU accessory or license is classified as GPU hardware.');

const results = cases.map((testCase) => {
  const requirements = useGroundTruth ? requirementsFromGroundTruth(testCase) : normalizeExtractedRequirements([], testCase.input);
  const recommendation = recommendRackComponents(requirements, catalog, profile);
  const selected = recommendation.components.flatMap((component) => component.selections.map((selection) => ({ ...selection, component: component.component })));
  const anomalies = [];
  const deadline = Number(requirements.find((requirement) => requirement.id === 'maxLeadTimeDays')?.value);
  if (deadline && recommendation.components.some((component) => component.maxLeadTimeDays > deadline)) anomalies.push(`A recommended component exceeds the ${deadline}-day target.`);
  if (selected.some((selection) => !catalog.some((option) => option.id === selection.optionId))) anomalies.push('A recommendation references an option outside the scanned catalog.');
  if (selected.some((selection) => !Number.isInteger(selection.quantity) || selection.quantity < 1)) anomalies.push('A recommendation contains a non-positive or non-integer quantity.');
  for (const selection of selected) {
    const option = catalog.find((item) => item.id === selection.optionId);
    const allowed = componentOptionCategories[selection.component];
    if (option && allowed && !allowed.has(option.category)) anomalies.push(`${selection.component} selected ${option.sku}, which is classified as ${option.category}.`);
    if (option && selection.component === 'gpu' && option.category === 'accessory' && !/^GPU Airduct$/i.test(String(option.attributes.categoryName ?? ''))) anomalies.push(`GPU selected unrelated accessory ${option.sku}.`);
  }
  const calculatedTotal = recommendation.components.reduce((sum, component) => sum + component.totalListPrice, 0);
  if (Math.abs(calculatedTotal - recommendation.totalListPrice) > 0.000001) anomalies.push('Recommendation total does not equal its component totals.');
  const visibleLegacy = requirements.filter((requirement) => legacyIds.has(requirement.id)).map((requirement) => requirement.id);
  if (visibleLegacy.length) anomalies.push(`Legacy requirement IDs remain visible: ${visibleLegacy.join(', ')}.`);

  const blockedScopes = new Set(recommendation.notices.flatMap((notice) => Object.entries(scopeRules).filter(([, rule]) => rule.violation.test(notice)).map(([scope]) => scope)));
  for (const [scope, rule] of Object.entries(scopeRules)) {
    const requested = requirements.some((requirement) => requirement.value !== undefined && rule.ids.test(requirement.id));
    if (!requested || blockedScopes.has(scope)) continue;
    const hasComponent = recommendation.components.some((component) => rule.components.has(component.component));
    const hasExplanation = recommendation.violations.some((violation) => rule.violation.test(violation));
    if (!hasComponent && !hasExplanation) anomalies.push(`${scope} was requested but produced neither a component nor a category-specific violation.`);
  }

  const raid1Reasons = recommendation.components.filter((component) => component.component === 'storage').flatMap((component) => component.reason.split('\n')).filter((reason) => /RAID 1\b/i.test(reason));
  if (raid1Reasons.some((reason) => !/\b2\s*[×x]\s*/.test(reason))) anomalies.push('A RAID1 drive group was not sized to exactly two drives.');

  return {
    id: testCase.id,
    status: recommendation.violations.length ? 'unsatisfied' : recommendation.notices.length ? 'partial' : recommendation.components.length ? 'complete' : 'empty',
    components: recommendation.components.map((component) => ({
      component: component.component,
      selections: component.selections.map((selection) => ({
        sku: catalog.find((option) => option.id === selection.optionId)?.sku ?? selection.optionId,
        quantity: selection.quantity
      })),
      maxLeadTimeDays: component.maxLeadTimeDays,
      reason: component.reason
    })),
    violations: recommendation.violations,
    notices: recommendation.notices,
    anomalies
  };
});

const report = {
  source: catalogPath,
  requirementsSource: useGroundTruth ? 'structured-ground-truth' : 'deterministic-text-normalization',
  platformProfile: profile,
  caseCount: results.length,
  catalogOptionCount: catalog.length,
  complete: results.filter((result) => result.status === 'complete').length,
  partial: results.filter((result) => result.status === 'partial').length,
  unsatisfied: results.filter((result) => result.status === 'unsatisfied').length,
  empty: results.filter((result) => result.status === 'empty').length,
  catalogAnomalies,
  anomalyCount: catalogAnomalies.length + results.reduce((sum, result) => sum + result.anomalies.length, 0),
  results
};
const output = process.argv.includes('--summary') ? {
  ...report,
  results: results.map((result) => ({
    id: result.id,
    status: result.status,
    components: result.components.map((component) => `${component.component}: ${component.selections.map((selection) => `${selection.quantity}x ${selection.sku}`).join(', ')}`),
    violations: result.violations,
    notices: result.notices,
    anomalies: result.anomalies
  }))
} : report;
console.log(JSON.stringify(output, null, 2));
