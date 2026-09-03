import { readFile } from 'node:fs/promises';
import { inferRackServerProfile, platformCapabilities } from '../packages/shared/dist/index.js';
import { catalogAttributes, catalogCategory } from '../packages/extension/dist-types/catalog-normalization.js';
import { ccwOptionState } from '../packages/extension/dist-types/ccw-option-state.js';
import { buildProductContext } from '../packages/extension/dist-types/product-context.js';
import { isFrontDriveCategory, isMlomCategory, isPhysicalPcieCategory, isRearDriveCategory, rackClassificationText, rackOwnerCategory } from '../packages/extension/dist-types/rack-category.js';

const rawPath = process.argv[2];
if (!rawPath) throw new Error('Usage: node benchmark/normalize-live-ccw-catalog.mjs <live-raw.json>');

const raw = JSON.parse(await readFile(rawPath, 'utf8'));
if (!Array.isArray(raw.rows) || !raw.rows.length) throw new Error('Live CCW scan contains no option rows.');

const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = (value) => normalize(value).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'default';
const leadTimeDays = (value) => {
  const text = normalize(value);
  const match = text.match(/(\d+)\s*days?/i);
  return match ? Number(match[1]) : /^0$/.test(text) ? 0 : -1;
};

const riserSlotNames = [...new Set(raw.rows.map((row) => normalize(row.categoryName)).filter(isPhysicalPcieCategory))];
const platformProfile = inferRackServerProfile(raw.model ?? 'unknown', riserSlotNames);
const capability = platformCapabilities(platformProfile);

const options = raw.rows.flatMap((row) => {
  const sku = normalize(row.sku);
  if (!sku) return [];
  const { description, productText } = buildProductContext(sku, `${sku} ${normalize(row.description)}`, row.rowText);
  const classificationText = rackClassificationText(row.categoryName, row.groupName, productText);
  const foundCategory = rackOwnerCategory(row.categoryName) ?? catalogCategory(classificationText);
  const state = ccwOptionState(row.priceText, Boolean(row.controlEnabled), Boolean(row.quantityDisabled), row.quantityValue, Boolean(row.checked));
  const normalizedAttributes = catalogAttributes(productText, foundCategory, capability.kind);
  const storageLocation = isFrontDriveCategory(row.categoryName) ? 'front' : isRearDriveCategory(row.categoryName) ? 'rear' : foundCategory === 'storage' ? 'other' : undefined;
  const maxQuantity = foundCategory === 'cpu' ? capability.maxSockets
    : foundCategory === 'memory' ? capability.dimmsPerCpu * capability.maxSockets
      : foundCategory === 'bootDrive' ? 2
        : foundCategory === 'storage' ? storageLocation === 'rear' ? 4 : capability.frontDriveCapacity
          : foundCategory === 'raid' || foundCategory === 'boot' ? Number(normalizedAttributes.maxQuantity ?? 1)
            : isPhysicalPcieCategory(row.categoryName) || isMlomCategory(row.categoryName) ? 1 : 999;
  const categoryKdfid = `live-${key(row.categoryName)}`;
  const groupKdfid = `live-${key(row.groupName)}`;
  return [{
    id: `${categoryKdfid}:${groupKdfid}:${sku}`,
    sku,
    name: description.slice(0, 240),
    category: foundCategory,
    unitListPrice: state.unitListPrice,
    currency: 'USD',
    available: state.available,
    attributes: {
      ...normalizedAttributes,
      ...(state.fixedQuantity === undefined ? {} : { fixedQuantity: state.fixedQuantity }),
      categoryName: normalize(row.categoryName),
      subgroupName: normalize(row.groupName),
      leadTimeDays: leadTimeDays(row.leadTimeText),
      maxQuantity,
      ...(storageLocation ? { storageLocation } : {}),
      ...(storageLocation === 'front' ? { frontDriveCapacity: capability.frontDriveCapacity } : {})
    }
  }];
});

const recommendationCategories = new Set(['cpu', 'memory', 'raid', 'storage', 'riser', 'nic', 'hba', 'gpu', 'boot', 'bootDrive', 'accessory']);
const recommendationOptions = options.filter((option) => option.available && recommendationCategories.has(option.category));
const snapshot = {
  source: rawPath,
  capturedAt: raw.capturedAt,
  parentSku: raw.model,
  adapterVersion: 'ccw-live-checkpoint-v1',
  platformProfile,
  scan: {
    configurationUnchanged: raw.configurationUnchanged === true,
    configurationFingerprintLength: raw.configurationFingerprintLength,
    categoryCount: raw.categories?.length ?? 0,
    rawRowCount: raw.rows.length,
    normalizedOptionCount: options.length,
    recommendationOptionCount: recommendationOptions.length
  },
  options: recommendationOptions
};
console.log(JSON.stringify(snapshot, null, process.argv.includes('--compact') ? 0 : 2));
