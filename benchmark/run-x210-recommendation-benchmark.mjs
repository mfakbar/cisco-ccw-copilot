import { readFile } from 'node:fs/promises';
import { inferRackServerProfile, recommendRackComponents } from '../packages/shared/dist/index.js';

const fixture = JSON.parse(await readFile(new URL('./x210-live-catalog.json', import.meta.url), 'utf8'));
const cases = JSON.parse(await readFile(new URL('./x210-recommendation-cases.json', import.meta.url), 'utf8'));
const profile = fixture.platformProfile ?? inferRackServerProfile(fixture.parentSku ?? 'UCSX-210C-M8-U');

const requirement = (item) => ({
  id: item.id, label: item.id, value: item.value, ...(item.unit === undefined ? {} : { unit: item.unit }),
  status: 'explicit', required: true, evidence: []
});
const isFrontMezz = (option) => option.attributes?.frontMezzanine === true || ['raid', 'accessory'].includes(option.category) && /Front MEZZ/i.test(String(option.attributes?.categoryName ?? ''));

const results = cases.map((testCase) => {
  let catalog = fixture.options.map((option) => ({ ...option, attributes: { ...option.attributes } }));
  if (testCase.excludeSkus?.length) catalog = catalog.filter((option) => !testCase.excludeSkus.includes(option.sku));
  for (const selected of testCase.selectedSkus ?? []) {
    const option = catalog.find((item) => item.sku === selected.sku);
    if (option) Object.assign(option.attributes, { selected: true, selectedQuantity: selected.quantity });
  }
  const recommendation = recommendRackComponents(testCase.requirements.map(requirement), catalog, profile);
  const status = recommendation.violations.length ? 'unsatisfied' : recommendation.notices.length ? 'partial' : recommendation.components.length ? 'complete' : 'empty';
  const selected = recommendation.components.flatMap((component) => component.selections.map((selection) => ({
    component: component.component, quantity: selection.quantity,
    option: catalog.find((option) => option.id === selection.optionId)
  })));
  const failures = [];
  if (status !== testCase.expectStatus) failures.push(`expected status ${testCase.expectStatus}, received ${status}`);
  for (const expected of testCase.expectedSelections ?? []) {
    if (!selected.some((item) => item.option?.sku === expected.sku && item.quantity === expected.quantity && (!expected.component || item.component === expected.component))) {
      failures.push(`missing ${expected.quantity}x ${expected.sku}${expected.component ? ` in ${expected.component}` : ''}`);
    }
  }
  for (const sku of testCase.forbiddenRecommendedSkus ?? []) if (selected.some((item) => item.option?.sku === sku)) failures.push(`forbidden recommendation ${sku}`);
  for (const component of testCase.forbiddenComponents ?? []) if (selected.some((item) => item.component === component)) failures.push(`forbidden component ${component}`);
  for (const fragment of testCase.violationIncludes ?? []) if (!recommendation.violations.some((message) => message.includes(fragment))) failures.push(`missing violation containing: ${fragment}`);
  if (testCase.expectStatus === 'complete' && recommendation.violations.length) failures.push(`unexpected violations: ${recommendation.violations.join(' | ')}`);
  if (testCase.expectFrontStorageOnly) {
    const invalid = selected.filter((item) => item.component === 'storage' && item.option?.attributes?.storageLocation !== 'front');
    if (invalid.length) failures.push(`capacity drive not front-facing: ${invalid.map((item) => item.option?.sku).join(', ')}`);
  }
  if (testCase.expectRaid1Two) {
    const raid1Reasons = recommendation.components.filter((component) => component.component === 'storage').flatMap((component) => component.reason.split('\n')).filter((line) => /RAID 1\b/i.test(line));
    if (!raid1Reasons.length || raid1Reasons.some((line) => !/\b2\s*[×x]\s*/.test(line))) failures.push('RAID 1 was not expressed as exactly two drives');
  }
  if (testCase.maxFrontMezzSelections !== undefined) {
    const recommended = selected.map((item) => item.option).filter(Boolean);
    const current = catalog.filter((option) => option.attributes?.selected === true);
    const frontMezzCount = new Set([...recommended, ...current].filter(isFrontMezz).map((option) => option.id)).size;
    if (frontMezzCount > testCase.maxFrontMezzSelections) failures.push(`${frontMezzCount} front-mezzanine options exceed limit ${testCase.maxFrontMezzSelections}`);
  }
  return {
    id: testCase.id, status, passed: failures.length === 0, failures,
    selections: selected.map((item) => `${item.component}: ${item.quantity}x ${item.option?.sku ?? 'unknown'}`),
    violations: recommendation.violations
  };
});

const report = {
  benchmark: 'X210 M8 recommendation compatibility',
  specSheet: 'ucs-specsheet/ucs-x210c-m8-specsheet.pdf',
  catalogSource: fixture.source,
  platform: profile.model,
  catalogOptions: fixture.options.length,
  cases: results.length,
  passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length,
  results
};
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
