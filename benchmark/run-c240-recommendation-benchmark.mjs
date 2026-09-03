import { readFile } from 'node:fs/promises';
import { inferRackServerProfile, recommendRackComponents, riserNumber } from '../packages/shared/dist/index.js';

const fixture = JSON.parse(await readFile(new URL('./c240-live-catalog.json', import.meta.url), 'utf8'));
const cases = JSON.parse(await readFile(new URL('./c240-spec-recommendation-cases.json', import.meta.url), 'utf8'));
const profile = fixture.platformProfile ?? inferRackServerProfile('UCSC-C240-M8SX');
const requirement = (item) => ({ id: item.id, label: item.id, value: item.value, ...(item.unit === undefined ? {} : { unit: item.unit }), status: 'explicit', required: true, evidence: [] });
const isMlom = (option) => /MLOM|OCP/i.test(String(option?.attributes?.categoryName ?? ''));
const isVic = (option) => /\bVIC\b/i.test(`${option?.sku ?? ''} ${option?.name ?? ''}`);

const results = cases.map((testCase) => {
  let catalog = fixture.options.map((option) => ({ ...option, attributes: { ...option.attributes } }));
  if (testCase.excludeSkus?.length) catalog = catalog.filter((option) => !testCase.excludeSkus.includes(option.sku));
  for (const selectedOption of testCase.selectedOptions ?? []) {
    const option = catalog.find((item) => item.sku === selectedOption.sku && (!selectedOption.categoryNameIncludes || String(item.attributes.categoryName).includes(selectedOption.categoryNameIncludes)));
    if (option) Object.assign(option.attributes, { selected: true, selectedQuantity: selectedOption.quantity });
  }
  const recommendation = recommendRackComponents(testCase.requirements.map(requirement), catalog, profile);
  const status = recommendation.violations.length ? 'unsatisfied' : recommendation.notices.length ? 'partial' : recommendation.components.length ? 'complete' : 'empty';
  const selected = recommendation.components.flatMap((component) => component.selections.map((selection) => ({ component: component.component, quantity: selection.quantity, option: catalog.find((option) => option.id === selection.optionId) })));
  const failures = [];
  if (status !== testCase.expectStatus) failures.push(`expected status ${testCase.expectStatus}, received ${status}`);
  for (const expected of testCase.expectedSelections ?? []) {
    if (!selected.some((item) => item.option?.sku === expected.sku && item.quantity === expected.quantity && (!expected.component || item.component === expected.component) && (!expected.categoryNameIncludes || String(item.option?.attributes.categoryName).includes(expected.categoryNameIncludes)))) failures.push(`missing ${expected.quantity}x ${expected.sku}${expected.categoryNameIncludes ? ` at ${expected.categoryNameIncludes}` : ''}`);
  }
  for (const component of testCase.expectedComponents ?? []) if (!selected.some((item) => item.component === component)) failures.push(`missing component ${component}`);
  for (const component of testCase.forbiddenComponents ?? []) if (selected.some((item) => item.component === component)) failures.push(`forbidden component ${component}`);
  for (const fragment of testCase.violationIncludes ?? []) if (!recommendation.violations.some((message) => message.includes(fragment))) failures.push(`missing violation containing: ${fragment}`);
  if (testCase.expectFrontStorageOnly && selected.some((item) => item.component === 'storage' && item.option?.attributes.storageLocation !== 'front')) failures.push('capacity drive is not front-facing');
  if (testCase.expectRaid1Two) {
    const lines = recommendation.components.filter((component) => component.component === 'storage').flatMap((component) => component.reason.split('\n')).filter((line) => /RAID 1\b/i.test(line));
    if (!lines.length || lines.some((line) => !/\b2\s*[×x]/.test(line))) failures.push('RAID 1 is not exactly two drives');
  }
  const controllerSelections = selected.filter((item) => item.component === 'raid');
  const capacityDriveCount = selected.filter((item) => item.component === 'storage').reduce((sum, item) => sum + item.quantity, 0);
  if (capacityDriveCount > 24) failures.push(`${capacityDriveCount} capacity drives exceed twenty-four front bays`);
  if (controllerSelections.length && capacityDriveCount) {
    const capacity = controllerSelections.reduce((sum, item) => sum + Number(item.option?.attributes.maxDrives ?? 0) * item.quantity, 0);
    if (capacity && capacityDriveCount > capacity) failures.push(`${capacityDriveCount} drives exceed selected controller capacity ${capacity}`);
  }
  if (testCase.expectC240VicTopology) {
    const recommendedVics = selected.filter((item) => isVic(item.option));
    const selectedVics = catalog.filter((option) => option.attributes.selected === true && isVic(option));
    const pluginVics = [...recommendedVics.map((item) => item.option), ...selectedVics].filter((option) => !isMlom(option));
    const cpuCount = Number(testCase.requirements.find((item) => item.id === 'cpuSockets')?.value ?? 2);
    const risers = pluginVics.map((option) => riserNumber(String(option?.attributes.categoryName ?? ''))).filter(Boolean);
    if (pluginVics.length > (cpuCount === 1 ? 1 : 2)) failures.push(`too many plug-in VICs for ${cpuCount} CPU(s)`);
    if (new Set(risers).size !== risers.length) failures.push('more than one plug-in VIC uses the same riser');
  }
  return {
    id: testCase.id,
    status,
    passed: failures.length === 0,
    failures,
    selections: selected.map((item) => `${item.component}: ${item.quantity}x ${item.option?.sku ?? 'unknown'} @ ${item.option?.attributes.categoryName ?? ''}`),
    violations: recommendation.violations
  };
});

const report = { benchmark: 'C240 M8 SFF recommendation compatibility', specSheet: 'ucs-specsheet/ucs-c240-m8-sff-rack-server.pdf', catalogSource: fixture.source, platform: profile.model, catalogOptions: fixture.options.length, cases: results.length, passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, results };
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
