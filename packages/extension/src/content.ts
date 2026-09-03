import { extractUcsParentSku, inferRackServerProfile, platformCapabilities, type ApprovedAction, type CatalogOption, type PageSnapshot } from '@ccw/shared';
import { catalogAttributes, catalogCategory } from './catalog-normalization.js';
import { ccwOptionState } from './ccw-option-state.js';
import { buildProductContext } from './product-context.js';
import { includedPlatformOptions } from './current-platform-options.js';
import { frontDriveCapacityForSeries, isFrontDriveCategory, isMlomCategory, isPhysicalPcieCategory, isRackCategoryBreadcrumb, isRackScanCategory, isRearDriveCategory, rackClassificationText, rackOwnerCategoryForProduct } from './rack-category.js';

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map((x) => x.toString(16).padStart(2, '0')).join('');
const price = (text: string): number | undefined => {
  const match = text.replace(/,/g, '').match(/(?:USD|US\$|\$)\s*([0-9]+(?:\.\d{1,2})?)/i);
  return match ? Number(match[1]) : undefined;
};
const sku = (text: string): string | undefined => text.match(/\b[A-Z][A-Z0-9]{1,9}(?:-[A-Z0-9]{2,}){1,5}\b/)?.[0];

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const selectedConfigurationState = (): string => [...document.querySelectorAll('.productsummery')].map((element) => normalize(element.textContent)).filter(Boolean).sort().join('|');

async function waitForSelection(selector: string, kind: 'category' | 'group', expectedLabel?: string, timeoutMs = 6000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const element = document.querySelector(selector);
    const selected = kind === 'category'
      ? Boolean(element?.classList.contains('Select') || element?.closest('h6')?.classList.contains('Select'))
      : Boolean(element?.classList.contains('selectedCtegory'));
    const contentReady = kind !== 'category' || !expectedLabel || isRackCategoryBreadcrumb(normalize(document.querySelector('#breadCrumb')?.textContent), expectedLabel);
    if (selected && contentReady) {
      await sleep(250);
      return;
    }
    await sleep(100);
  }
  throw new Error(`CCW did not finish opening ${selector}`);
}

async function openNavigation(kdfid: string, kind: 'category' | 'group', expectedLabel?: string): Promise<void> {
  const selector = `[kdfid="${CSS.escape(kdfid)}"]`;
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`CCW navigation target is no longer available: ${kdfid}`);
  const selected = kind === 'category' ? element.classList.contains('Select') || element.closest('h6')?.classList.contains('Select') : element.classList.contains('selectedCtegory');
  if (!selected) element.click();
  await waitForSelection(selector, kind, expectedLabel);
}

function currencyFromPage(): string {
  const text = normalize(document.body.textContent);
  return text.match(/Price List[^()]{0,100}\(([A-Z]{3})\)/i)?.[1] ?? text.match(/Unit List Price\s*\(([A-Z]{3})\)/i)?.[1] ?? 'USD';
}

function modelFromPage(): string {
  const text = normalize(document.body.textContent);
  return extractUcsParentSku(text) ?? 'unknown';
}

function leadTimeDays(text: string): number {
  const normalized = normalize(text);
  const match = normalized.match(/(\d+)\s*days?/i);
  return match ? Number(match[1]) : /^0$/.test(normalized) ? 0 : -1;
}

function ccwProductOptions(context?: { categoryName: string; subgroupName: string; categoryKdfid: string; groupKdfid?: string }): CatalogOption[] {
  const currency = currencyFromPage();
  return [...document.querySelectorAll<HTMLTableRowElement>('tr.majorProductList')].flatMap((row, index) => {
    const foundSku = normalize(row.querySelector('.skutitle')?.textContent) || sku(normalize(row.textContent));
    const priceText = normalize(row.querySelector('.unitListPriceCls')?.textContent);
    if (!foundSku) return [];
    const itemCell = row.querySelector('.itemNameTd') ?? row.querySelector('.skutitle')?.closest('td') ?? row.querySelector('td:nth-child(2)');
    const { description, productText } = buildProductContext(foundSku, itemCell?.textContent, row.textContent);
    const leadTime = leadTimeDays(normalize(row.querySelector('.leadTimeTd')?.textContent));
    const control = row.querySelector<HTMLInputElement>('input.selectionCheckBox');
    const quantityInput = row.querySelector<HTMLInputElement>('input.configqty');
    const optionState = ccwOptionState(priceText, Boolean(control) && !control!.disabled, Boolean(quantityInput?.disabled), quantityInput?.value || quantityInput?.getAttribute('userqty') || quantityInput?.getAttribute('prevqty') || undefined, Boolean(control?.checked));
    const selectedQuantity = Number(quantityInput?.value || quantityInput?.getAttribute('userqty') || quantityInput?.getAttribute('prevqty') || optionState.fixedQuantity || 1);
    const kdfid = control?.getAttribute('kdfid');
    row.setAttribute('data-ccw-copilot-index', String(index));
    const classificationText = context ? rackClassificationText(context.categoryName, context.subgroupName, productText) : productText;
    const ownerCategory = context ? rackOwnerCategoryForProduct(context.categoryName, productText) : undefined;
    const foundCategory = ownerCategory ?? catalogCategory(classificationText);
    const profile = inferRackServerProfile(modelFromPage());
    const capability = platformCapabilities(profile);
    const normalizedAttributes = catalogAttributes(productText, foundCategory, capability.kind);
    const frontDriveCapacity = capability.kind === 'UNKNOWN' ? frontDriveCapacityForSeries(profile.series) : capability.frontDriveCapacity;
    const storageLocation = context && isFrontDriveCategory(context.categoryName) ? 'front' : context && isRearDriveCategory(context.categoryName) ? 'rear' : foundCategory === 'storage' ? 'other' : undefined;
    const maxQuantity = foundCategory === 'cpu' ? capability.maxSockets : foundCategory === 'memory' ? capability.dimmsPerCpu * capability.maxSockets : foundCategory === 'bootDrive' ? 2 : foundCategory === 'storage' ? storageLocation === 'front' ? frontDriveCapacity : storageLocation === 'rear' ? 4 : frontDriveCapacity : foundCategory === 'raid' || foundCategory === 'boot' ? Number(normalizedAttributes.maxQuantity ?? 1) : context && (isPhysicalPcieCategory(context.categoryName) || isMlomCategory(context.categoryName)) ? 1 : 999;
    const optionId = context ? `${context.categoryKdfid}:${context.groupKdfid ?? 'default'}:${foundSku}` : foundSku;
    return [{
      id: optionId, sku: foundSku, name: description.slice(0, 240), category: foundCategory,
      unitListPrice: optionState.unitListPrice, currency, available: optionState.available,
      attributes: {
        ...normalizedAttributes, selected: Boolean(control?.checked),
        ...(control?.checked && Number.isFinite(selectedQuantity) && selectedQuantity > 0 ? { selectedQuantity } : {}),
        hasUnitListPrice: optionState.hasUnitListPrice, quantityFixed: optionState.quantityFixed,
        ...(optionState.fixedQuantity === undefined ? {} : { fixedQuantity: optionState.fixedQuantity }),
        categoryName: context?.categoryName ?? '', subgroupName: context?.subgroupName ?? '',
        categoryKdfid: context?.categoryKdfid ?? '', groupKdfid: context?.groupKdfid ?? '',
        controlKdfid: kdfid ?? '', inputType: control?.type ?? '', configPath: control?.getAttribute('configpath') ?? '',
        quantityKdfid: quantityInput?.getAttribute('kdfid') ?? '',
        leadTimeDays: leadTime,
        maxQuantity,
        ...(storageLocation ? { storageLocation } : {}),
        ...(storageLocation === 'front' ? { frontDriveCapacity } : {})
      },
      ccwLocator: kdfid ? `[kdfid="${CSS.escape(kdfid)}"]` : locatorFor(row, index)
    }];
  });
}

async function scanRackConfiguration(): Promise<CatalogOption[]> {
  const categoryLinks = [...document.querySelectorAll<HTMLAnchorElement>('h6 a.renderNewClass[kdfid][configpath]')]
    .map((link) => ({ name: normalize(link.textContent), kdfid: link.getAttribute('kdfid') ?? '' }))
    .filter((item) => item.kdfid && isRackScanCategory(item.name));
  if (!categoryLinks.length) return [];
  const originalCategoryLink = document.querySelector<HTMLAnchorElement>('h6.Select a.renderNewClass[kdfid]');
  const originalCategory = { kdfid: originalCategoryLink?.getAttribute('kdfid') ?? categoryLinks[0]!.kdfid, name: normalize(originalCategoryLink?.textContent) || categoryLinks[0]!.name };
  const originalGroup = document.querySelector<HTMLAnchorElement>('#categoryDropDown a.selectedCtegory[kdfid]')?.getAttribute('kdfid') ?? undefined;
  const expectedConfiguration = selectedConfigurationState();
  const assertConfigurationUnchanged = () => { if (selectedConfigurationState() !== expectedConfiguration) throw new Error('CCW configuration changed during read-only discovery. Scanning stopped before any further navigation; do not approve recommendations from this scan.'); };
  const results: CatalogOption[] = [];
  try {
    for (const [categoryIndex, currentCategory] of categoryLinks.entries()) {
      void chrome.runtime.sendMessage({ source: 'ccw-copilot-content', type: 'SCAN_PROGRESS', phase: 'scanning', current: categoryIndex + 1, total: categoryLinks.length, label: currentCategory.name, optionsFound: results.length }).catch(() => undefined);
      await openNavigation(currentCategory.kdfid, 'category', currentCategory.name);
      assertConfigurationUnchanged();
      const groups = [...document.querySelectorAll<HTMLAnchorElement>('#categoryDropDown a.categoryChange[kdfid]')]
        .map((link) => ({ name: normalize(link.textContent), kdfid: link.getAttribute('kdfid') ?? '' })).filter((item) => item.kdfid);
      if (!groups.length) results.push(...ccwProductOptions({ categoryName: currentCategory.name, subgroupName: currentCategory.name, categoryKdfid: currentCategory.kdfid }));
      for (const group of groups) {
        await openNavigation(group.kdfid, 'group');
        assertConfigurationUnchanged();
        results.push(...ccwProductOptions({ categoryName: currentCategory.name, subgroupName: group.name, categoryKdfid: currentCategory.kdfid, groupKdfid: group.kdfid }));
      }
    }
  } finally {
    void chrome.runtime.sendMessage({ source: 'ccw-copilot-content', type: 'SCAN_PROGRESS', phase: 'restoring', current: categoryLinks.length, total: categoryLinks.length, label: 'Returning to your starting view', optionsFound: results.length }).catch(() => undefined);
    await openNavigation(originalCategory.kdfid, 'category', originalCategory.name).catch(() => undefined);
    if (originalGroup) await openNavigation(originalGroup, 'group').catch(() => undefined);
  }
  return results;
}

function locatorFor(element: Element, index: number): string {
  const id = element.getAttribute('id');
  if (id && /^[A-Za-z][\w:.-]*$/.test(id)) return `#${CSS.escape(id)}`;
  const testId = element.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  return `[data-ccw-copilot-index="${index}"]`;
}

async function discover(): Promise<PageSnapshot> {
  void chrome.runtime.sendMessage({ source: 'ccw-copilot-content', type: 'SCAN_PROGRESS', phase: 'connecting', current: 0, total: 1, label: 'Reading the current configuration', optionsFound: 0 }).catch(() => undefined);
  let options = await scanRackConfiguration();
  for (const included of includedPlatformOptions(selectedConfigurationState())) {
    if (!options.some((option) => option.sku === included.sku)) options.push(included);
  }
  let adapterVersion = 'ccw-rack-config-v8';
  if (!options.length) {
    adapterVersion = 'generic-discovery-v1';
    const candidates = [...document.querySelectorAll('tr, [role="row"], [role="option"], label, .config-option')];
    options = candidates.flatMap((element, index) => {
      const text = normalize(element.textContent);
      const foundSku = sku(text); const foundPrice = price(text);
      if (!foundSku) return [];
      element.setAttribute('data-ccw-copilot-index', String(index));
      const foundCategory = catalogCategory(text);
      const hasUnitListPrice = foundPrice !== undefined;
      return [{ id: foundSku, sku: foundSku, name: text.slice(0, 240), category: foundCategory, unitListPrice: foundPrice ?? 0, currency: currencyFromPage(), available: hasUnitListPrice && !element.matches('[disabled], [aria-disabled="true"], .disabled'), attributes: { ...catalogAttributes(text, foundCategory), hasUnitListPrice, quantityFixed: false }, ccwLocator: locatorFor(element, index) }];
    });
  }
  const messages = [...document.querySelectorAll('p[class^="CE"], [role="alert"], .error, .warning, [class*="validation"]')].map((x) => normalize(x.textContent)).filter(Boolean).slice(0, 50);
  void chrome.runtime.sendMessage({ source: 'ccw-copilot-content', type: 'SCAN_PROGRESS', phase: 'preparing', current: 1, total: 1, label: 'Preparing recommendations', optionsFound: options.length }).catch(() => undefined);
  const riserSlotNames = [...new Set(options.map((option) => String(option.attributes.categoryName ?? '')).filter(isPhysicalPcieCategory))];
  const platformProfile = inferRackServerProfile(modelFromPage(), riserSlotNames);
  const fingerprintSource = `${location.host}|${document.title}|${platformProfile.model}|${options.map((o) => `${o.sku}:${o.unitListPrice}:${String(o.attributes.selected ?? false)}`).join('|')}|${messages.join('|')}`;
  const snapshot = { url: location.href, title: document.title, capturedAt: new Date().toISOString(), adapterVersion, platformProfile, options, validationMessages: messages, pageFingerprint: await hash(fingerprintSource) };
  lastSnapshot = snapshot;
  void chrome.runtime.sendMessage({ source: 'ccw-copilot-content', type: 'SCAN_PROGRESS', phase: 'complete', current: 1, total: 1, label: 'Catalog scan complete', optionsFound: options.length }).catch(() => undefined);
  return snapshot;
}

let lastSnapshot: PageSnapshot | undefined;

function setNativeValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.setAttribute('value', value); input.setAttribute('userqty', value); input.setAttribute('prevqty', value);
  for (const event of ['input', 'keyup', 'change', 'blur']) input.dispatchEvent(event === 'keyup' ? new KeyboardEvent(event, { bubbles: true, key: 'Enter' }) : new Event(event, { bubbles: true }));
}

async function verifyApplied(option: CatalogOption, quantity: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const control = document.querySelector<HTMLInputElement>(option.ccwLocator!);
    const qty = control?.closest('tr')?.querySelector<HTMLInputElement>('input.configqty');
    const actualQuantity = Number(qty?.value || qty?.getAttribute('userqty') || qty?.getAttribute('prevqty'));
    const summaryText = normalize(document.querySelector('.productsummery')?.parentElement?.textContent);
    if ((control?.checked || summaryText.includes(option.sku)) && (!qty || actualQuantity === quantity || (quantity === 1 && !Number.isFinite(actualQuantity)))) return;
    await sleep(250);
  }
  throw new Error(`CCW did not confirm ${quantity} × ${option.sku}. No further changes were attempted.`);
}

async function applyApproved(action: ApprovedAction) {
  const before = lastSnapshot;
  if (!before) throw new Error('Scan CCW again before approving a component.');
  if (before.pageFingerprint !== action.expectedPriorState) throw new Error('CCW page changed after review. Refresh recommendations before applying.');
  const option = before.options.find((o) => o.id === action.optionId);
  if (!option?.ccwLocator) throw new Error('Approved option is no longer present.');
  if (!option.available || option.attributes.hasUnitListPrice === false) throw new Error(`${option.sku} is not available because CCW has no unit list price.`);
  if (option.attributes.quantityFixed === true && Number(option.attributes.fixedQuantity) !== action.quantity) throw new Error(`${option.sku} has a CCW-fixed quantity of ${option.attributes.fixedQuantity ?? 'unknown'} and cannot be applied as quantity ${action.quantity}.`);
  const categoryKdfid = String(option.attributes.categoryKdfid ?? '');
  const groupKdfid = String(option.attributes.groupKdfid ?? '');
  if (categoryKdfid) await openNavigation(categoryKdfid, 'category', String(option.attributes.categoryName ?? ''));
  if (groupKdfid) await openNavigation(groupKdfid, 'group');
  const control = document.querySelector<HTMLInputElement>(option.ccwLocator);
  if (!control || control.disabled) throw new Error('The approved CCW option is no longer selectable. Scan again.');
  if (!control.checked) { (control.closest<HTMLElement>('label') ?? control).click(); await sleep(350); }
  const refreshedControl = document.querySelector<HTMLInputElement>(option.ccwLocator);
  const quantityInput = refreshedControl?.closest('tr')?.querySelector<HTMLInputElement>('input.configqty');
  if (quantityInput && !quantityInput.disabled) { quantityInput.focus(); quantityInput.select(); setNativeValue(quantityInput, String(action.quantity)); }
  await verifyApplied(option, action.quantity);
  const radioSelection = String(option.attributes.inputType).toLowerCase() === 'radio';
  const updatedOptions = before.options.map((item) => {
    const sameGroup = item.attributes.categoryKdfid === option.attributes.categoryKdfid && item.attributes.groupKdfid === option.attributes.groupKdfid;
    if (item.id === option.id) return { ...item, attributes: { ...item.attributes, selected: true, selectedQuantity: action.quantity } };
    return radioSelection && sameGroup ? { ...item, attributes: { ...item.attributes, selected: false } } : item;
  });
  const fingerprintSource = `${location.host}|${before.title}|${before.platformProfile?.model ?? ''}|${updatedOptions.map((item) => `${item.sku}:${item.unitListPrice}:${String(item.attributes.selected ?? false)}`).join('|')}|${before.validationMessages.join('|')}`;
  const after: PageSnapshot = { ...before, capturedAt: new Date().toISOString(), options: updatedOptions, pageFingerprint: await hash(fingerprintSource) };
  lastSnapshot = after;
  return after;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.source !== 'ccw-copilot') return;
  (message.type === 'DISCOVER' ? discover() : message.type === 'APPLY_APPROVED' ? applyApproved(message.action) : Promise.reject(new Error('Unsupported request')))
    .then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
