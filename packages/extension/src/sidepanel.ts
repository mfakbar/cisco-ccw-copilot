import { CIRCUIT_MODEL_OPTIONS, clarificationQuestions, recommendRackComponents, type ApprovedAction, type PageSnapshot, type Requirement } from '@ccw/shared';
import { recommendedApprovalItems, type ApprovalBatchItem } from './approval-batch.js';
import { allAppliedNotification, appliedNotification, applyFailedNotification, batchApplyFailedNotification, type ApplyNotification } from './apply-notification.js';
import { catalogId, chooseStoredCatalog, updateStoredCatalogSnapshot, upsertScannedCatalog, type StoredCatalog } from './catalog-library.js';
import { renderCatalogTables } from './catalog-table.js';
import { DEFAULT_PROVIDER, FILE_UPLOAD_BETA_STORAGE_KEY, circuitTokenHint, isFileUploadBetaEnabled, storedProvider, type SettingProvider } from './provider-settings.js';
import { createDriveGroup, createNicGroup, ensureAlternativeSizingRequirements, ensureManualCpuRequirements, ensureManualMemoryRequirements, redundantDriveInterfaceIds, redundantStandaloneCapacityTypeIds, redundantStandaloneStorageIds, removeRequirementGroupAndReindex, requirementGroupNumbers, type RequirementGroupKind } from './requirement-groups.js';
import { scanPhaseFromMessage, scanProgressView, type ScanProgress } from './scan-progress.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let snapshot: PageSnapshot | undefined;
let currentRequirements: Requirement[] = [];
let sourceRequirements: Requirement[] = [];
const SNAPSHOT_STORAGE_KEY = 'ccwCatalogSnapshot';
const CATALOG_LIBRARY_STORAGE_KEY = 'ccwCatalogLibrary';
const SELECTED_CATALOG_STORAGE_KEY = 'ccwSelectedCatalogId';
let catalogLibrary: StoredCatalog[] = [];
let selectedCatalogId: string | undefined;
let liveSnapshotFingerprint: string | undefined;
let catalogLibraryLoaded = false;
type Appearance = 'light' | 'dark';
const modelSelections: Record<SettingProvider, string> = { local: '', circuit: CIRCUIT_MODEL_OPTIONS[0].value };
let activeProvider: SettingProvider = DEFAULT_PROVIDER;
const selectedProvider = (): SettingProvider => $<HTMLSelectElement>('provider').value === 'circuit' ? 'circuit' : 'local';

const applyFileUploadBeta = (enabled: boolean) => {
  $<HTMLElement>('fileUploadField').hidden = !enabled;
  $<HTMLInputElement>('fileUploadBetaEnabled').checked = enabled;
  if (!enabled) $<HTMLInputElement>('rfpFile').value = '';
};

const applyAppearance = (appearance: Appearance) => {
  document.documentElement.dataset.theme = appearance;
  const toggle = $<HTMLButtonElement>('themeToggle');
  const next = appearance === 'dark' ? 'light' : 'dark';
  toggle.querySelector('.theme-toggle-icon')!.textContent = appearance === 'dark' ? '☀︎' : '☾';
  toggle.setAttribute('aria-label', `Switch to ${next} mode`);
  toggle.title = `Switch to ${next} mode`;
};

chrome.storage.local.get('appearance').then(({ appearance }) => {
  applyAppearance(appearance === 'dark' ? 'dark' : 'light');
});
$<HTMLButtonElement>('themeToggle').addEventListener('click', async () => {
  const next: Appearance = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyAppearance(next);
  await chrome.storage.local.set({ appearance: next });
});
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toast = (message: string | ApplyNotification) => {
  const element = $('toast');
  element.classList.remove('toast-success', 'toast-error');
  if (typeof message === 'string') {
    element.textContent = message;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
  } else {
    const title = document.createElement('strong'); title.className = 'toast-title'; title.textContent = message.title;
    const component = document.createElement('span'); component.className = 'toast-component'; component.textContent = message.component;
    const detail = document.createElement('span'); detail.className = 'toast-detail'; detail.textContent = message.detail;
    const content: HTMLElement[] = [title, component, detail];
    if (message.fix) { const fix = document.createElement('span'); fix.className = 'toast-fix'; fix.textContent = message.fix; content.push(fix); }
    element.replaceChildren(...content);
    element.classList.add(`toast-${message.status}`);
    element.setAttribute('role', message.status === 'error' ? 'alert' : 'status');
    element.setAttribute('aria-live', message.status === 'error' ? 'assertive' : 'polite');
  }
  element.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), typeof message === 'string' ? 4500 : message.status === 'error' ? 10_000 : 7000);
};
const settings = async () => {
  const provider = selectedProvider();
  return {
    provider,
    model: $<HTMLSelectElement>('model').value || undefined,
    apiKey: provider === 'circuit' ? $<HTMLInputElement>('circuitToken').value.trim() : undefined,
    token: $<HTMLInputElement>('token').value || (await chrome.storage.local.get('token')).token || ''
  };
};
const companionRequest = async (path: string, init: RequestInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:3219${path}`, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `Companion request failed (${response.status})`);
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(path === '/requirements/extract' ? 'Extraction timed out. Try again, choose a smaller local model, or use a cloud provider.' : 'CCW companion request timed out. Try again.');
    if (error instanceof TypeError) throw new Error('CCW companion is unavailable. Start it, then try again.');
    throw error;
  } finally { clearTimeout(timer); }
};
const api = async (path: string, payload: unknown) => { const config = await settings(); return companionRequest(path, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) }, 180_000); };
const apiGet = async (path: string) => { const config = await settings(); return companionRequest(path, { headers: { authorization: `Bearer ${config.token}` } }, 10_000); };
const activeCiscoTab = async () => {
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const candidates = active.length ? active : await chrome.tabs.query({ active: true });
  return candidates.find((tab) => { try { const host = new URL(tab.url ?? '').hostname; return host === 'cisco.com' || host.endsWith('.cisco.com'); } catch { return false; } });
};
const contentRequest = async (message: Record<string, unknown>) => {
  const tab = await activeCiscoTab(); if (!tab?.id || !tab.url) throw new Error('No active Cisco tab was detected. Reload the extension, return to CCW, and try again.');
  const origin = new URL(tab.url).origin + '/*'; const allowed = await chrome.permissions.request({ origins: [origin] }); if (!allowed) throw new Error('CCW page access was not granted.');
  const request = () => chrome.tabs.sendMessage(tab.id!, { source: 'ccw-copilot', ...message }) as Promise<any>;
  try { return await request(); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch((error) => { throw new Error(`Could not connect to the CCW page: ${error instanceof Error ? error.message : String(error)}`); });
    return request();
  }
};

let latestScanOptionsFound = 0;

function renderScanProgress(update: ScanProgress) {
  const container = $('scanProgress'); const bar = $<HTMLProgressElement>('scanProgressBar');
  const view = scanProgressView(update, latestScanOptionsFound);
  latestScanOptionsFound = view.found;
  container.hidden = false; container.dataset.state = update.phase;
  $('scanProgressEyebrow').textContent = view.eyebrow;
  $('scanProgressTitle').textContent = update.label;
  $('scanProgressText').textContent = view.text;
  $('scanProgressCount').textContent = view.count;
  $('scanProgressPosition').textContent = view.position;
  if (view.indeterminate) bar.removeAttribute('value');
  else { bar.max = view.total || 1; bar.value = update.phase === 'complete' ? bar.max : Math.min(view.current, bar.max); }
  document.querySelectorAll<HTMLElement>('[data-scan-step]').forEach((step, index) => {
    step.classList.toggle('is-complete', update.phase === 'complete' || (view.activeStep >= 0 && index < view.activeStep));
    step.classList.toggle('is-active', update.phase !== 'complete' && update.phase !== 'error' && index === view.activeStep);
  });
  $('scanProgressAssurance').textContent = view.assurance;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.source !== 'ccw-copilot-content' || message.type !== 'SCAN_PROGRESS') return;
  const phase = scanPhaseFromMessage(message);
  renderScanProgress({ phase, label: String(message.label ?? 'Scanning CCW'), current: message.current, total: message.total, optionsFound: message.optionsFound });
  if (phase === 'scanning') $('status').textContent = message.total ? `Scanning ${Math.min(Number(message.current) || 0, Number(message.total))}/${Number(message.total)}` : 'Scanning CCW';
});

const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('nav [role="tab"]')];
const viewScrollPositions = new Map<string, number>();
const activateView = (button: HTMLButtonElement) => {
  const currentTab = tabButtons.find((tab) => tab.classList.contains('active'));
  if (currentTab?.dataset.view) viewScrollPositions.set(currentTab.dataset.view, window.scrollY);
  for (const tab of tabButtons) {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === button.dataset.view));
  requestAnimationFrame(() => window.scrollTo({ top: viewScrollPositions.get(button.dataset.view ?? '') ?? 0, behavior: 'auto' }));
};
tabButtons.forEach((button, index) => {
  button.addEventListener('click', () => activateView(button));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabButtons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length;
    const next = tabButtons[nextIndex]!;
    activateView(next);
    next.focus();
  });
});

const updateCircuitTokenHint = () => {
  const token = $<HTMLInputElement>('circuitToken').value.trim();
  $('circuitTokenHint').textContent = circuitTokenHint(token);
};

$('saveSettings').addEventListener('click', async () => {
  const provider = selectedProvider();
  const fileUploadBetaEnabled = $<HTMLInputElement>('fileUploadBetaEnabled').checked;
  modelSelections[provider] = $<HTMLSelectElement>('model').value;
  await chrome.storage.local.set({ token: $<HTMLInputElement>('token').value, provider, localModel: modelSelections.local, circuitModel: modelSelections.circuit, [FILE_UPLOAD_BETA_STORAGE_KEY]: fileUploadBetaEnabled });
  applyFileUploadBeta(fileUploadBetaEnabled);
  toast(provider === 'circuit' ? 'Settings saved. The CircuIT token remains only in this side panel.' : 'Settings saved on this browser profile.');
});
chrome.storage.local.get(['token','provider','model','localModel','circuitModel', FILE_UPLOAD_BETA_STORAGE_KEY]).then((value) => {
  $<HTMLInputElement>('token').value = value.token ?? '';
  activeProvider = storedProvider(value.provider);
  $<HTMLSelectElement>('provider').value = activeProvider;
  modelSelections.local = value.localModel ?? (activeProvider === 'local' ? value.model : '') ?? '';
  modelSelections.circuit = value.circuitModel ?? (activeProvider === 'circuit' ? value.model : CIRCUIT_MODEL_OPTIONS[0].value) ?? CIRCUIT_MODEL_OPTIONS[0].value;
  applyFileUploadBeta(isFileUploadBetaEnabled(value[FILE_UPLOAD_BETA_STORAGE_KEY]));
  refreshProviderModels(false);
});

async function refreshProviderModels(showErrors = true) {
  const button = $<HTMLButtonElement>('refreshModels');
  const hint = $('modelHint');
  const modelSelect = $<HTMLSelectElement>('model');
  const provider = selectedProvider();
  $<HTMLElement>('circuitCredentials').hidden = provider !== 'circuit';
  if (provider === 'circuit') {
    button.hidden = true; modelSelect.disabled = false;
    modelSelect.replaceChildren(...CIRCUIT_MODEL_OPTIONS.map(({ value, label }) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
    modelSelect.value = CIRCUIT_MODEL_OPTIONS.some(({ value }) => value === modelSelections.circuit) ? modelSelections.circuit : CIRCUIT_MODEL_OPTIONS[0].value;
    hint.textContent = 'Two Cisco-approved CircuIT deployments are available.';
    updateCircuitTokenHint();
    return;
  }
  button.hidden = false; modelSelect.disabled = false; button.disabled = true; button.textContent = 'Loading local models…';
  try {
    const data = await apiGet('/ollama/models') as { models?: string[] };
    const models = data.models ?? []; const desired = modelSelections.local; const values = desired && !models.includes(desired) ? [desired, ...models] : models;
    const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'Use recommended default';
    modelSelect.replaceChildren(defaultOption, ...values.map((model) => { const option = document.createElement('option'); option.value = model; option.textContent = model; return option; })); modelSelect.value = desired && values.includes(desired) ? desired : '';
    hint.textContent = models.length ? `${models.length} local Ollama model${models.length === 1 ? '' : 's'} available. Choose one from the list.` : 'No local Ollama models are installed.';
  } catch (error) { hint.textContent = 'Could not load local Ollama models. Confirm the companion token and that Ollama is available.'; if (showErrors) toast(error instanceof Error ? error.message : String(error)); }
  finally { button.disabled = false; button.textContent = 'Refresh local models'; }
}
$('refreshModels').addEventListener('click', () => refreshProviderModels());
$<HTMLSelectElement>('provider').addEventListener('change', () => {
  modelSelections[activeProvider] = $<HTMLSelectElement>('model').value;
  activeProvider = selectedProvider();
  refreshProviderModels(false);
});
$<HTMLInputElement>('token').addEventListener('change', () => { if (selectedProvider() === 'local') refreshProviderModels(false); });
$<HTMLInputElement>('circuitToken').addEventListener('input', updateCircuitTokenHint);

const formatCatalogTimestamp = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

function renderCatalogLibrary() {
  const container = $('catalogLibrary');
  if (!catalogLibrary.length) {
    const empty = document.createElement('p'); empty.className = 'meta catalog-empty'; empty.textContent = 'No CCW catalogs saved yet. Run Scan and recommend from a UCS server draft.';
    container.replaceChildren(empty); return;
  }
  const cards = catalogLibrary.map((catalog) => {
    const card = document.createElement('article'); card.className = 'catalog-card'; card.classList.toggle('selected', catalog.id === selectedCatalogId);
    const details = document.createElement('details'); details.className = 'catalog-details';
    const summary = document.createElement('summary');
    const identity = document.createElement('span'); identity.className = 'catalog-identity'; identity.textContent = catalog.parentSku;
    const updated = document.createElement('span'); updated.className = 'catalog-updated'; updated.textContent = `Updated ${formatCatalogTimestamp(catalog.updatedAt)}`;
    summary.append(identity, updated);
    const actions = document.createElement('div'); actions.className = 'catalog-actions';
    const use = document.createElement('button'); use.type = 'button'; use.className = catalog.id === selectedCatalogId ? 'primary' : 'secondary'; use.textContent = catalog.id === selectedCatalogId ? 'Using this catalog' : 'Use for recommendations'; use.disabled = catalog.id === selectedCatalogId;
    use.addEventListener('click', async () => {
      selectedCatalogId = catalog.id; snapshot = catalog.snapshot;
      await chrome.storage.local.set({ [SELECTED_CATALOG_STORAGE_KEY]: selectedCatalogId, [SNAPSHOT_STORAGE_KEY]: snapshot });
      renderCatalogLibrary(); renderStoredScanStatus(snapshot); renderSnapshot(snapshot); $('status').textContent = 'Catalog selected'; toast(`${catalog.parentSku} selected as the recommendation basis.`);
    });
    const count = document.createElement('span'); count.className = 'meta'; count.textContent = `${catalog.snapshot.options.length} scanned components`;
    actions.append(use, count);
    const components = document.createElement('div'); components.className = 'catalog-components'; components.append(renderCatalogTables(catalog.snapshot.options, false));
    details.append(summary, actions, components); card.append(details); return card;
  });
  container.replaceChildren(...cards);
}

async function loadCatalogLibrary() {
  if (catalogLibraryLoaded) return;
  const stored = await chrome.storage.local.get([CATALOG_LIBRARY_STORAGE_KEY, SELECTED_CATALOG_STORAGE_KEY, SNAPSHOT_STORAGE_KEY]);
  catalogLibrary = Array.isArray(stored[CATALOG_LIBRARY_STORAGE_KEY]) ? stored[CATALOG_LIBRARY_STORAGE_KEY] as StoredCatalog[] : [];
  const legacy = stored[SNAPSHOT_STORAGE_KEY] as PageSnapshot | undefined;
  if (!catalogLibrary.length && legacy?.options?.length) catalogLibrary = upsertScannedCatalog([], legacy);
  selectedCatalogId = typeof stored[SELECTED_CATALOG_STORAGE_KEY] === 'string' ? stored[SELECTED_CATALOG_STORAGE_KEY] : undefined;
  const selected = chooseStoredCatalog(catalogLibrary, selectedCatalogId);
  if (selected) { selectedCatalogId = selected.id; snapshot = selected.snapshot; }
  catalogLibraryLoaded = true;
  await chrome.storage.local.set({ [CATALOG_LIBRARY_STORAGE_KEY]: catalogLibrary, ...(selectedCatalogId ? { [SELECTED_CATALOG_STORAGE_KEY]: selectedCatalogId } : {}) });
  renderCatalogLibrary(); renderStoredScanStatus(snapshot);
}

function leadTimeRequirement(): Requirement | undefined {
  const input = $<HTMLInputElement>('targetLeadTime');
  if (!input.value.trim()) return undefined;
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 0 || value > 182) return undefined;
  return { id: 'maxLeadTimeDays', label: 'Maximum component lead time', value, unit: 'days', comparison: 'atMost', status: 'explicit', required: true, evidence: [], note: 'User-entered delivery constraint' };
}

interface UserConstraintSpec {
  inputId: string;
  storageKey: string;
  requirementId: string;
  label: string;
  unit?: string;
  comparison: 'exact' | 'atMost';
  min: number;
  max?: number;
  integer: boolean;
  validationMessage: string;
}

const userConstraintSpecs: UserConstraintSpec[] = [
  { inputId: 'preferredCpuSockets', storageKey: 'preferredCpuSockets', requirementId: 'cpuSockets', label: 'CPU sockets', comparison: 'exact', min: 1, max: 2, integer: true, validationMessage: 'Enter 1 or 2 CPU sockets.' },
  { inputId: 'preferredMemoryModules', storageKey: 'preferredMemoryModules', requirementId: 'memoryModuleCount', label: 'DIMM count', comparison: 'exact', min: 1, max: 32, integer: true, validationMessage: 'Enter a whole number from 1 to 32 DIMMs.' },
  { inputId: 'maxLocalDriveCount', storageKey: 'maxLocalDriveCount', requirementId: 'maxLocalDriveCount', label: 'Maximum local capacity drive count', unit: 'drives', comparison: 'atMost', min: 1, max: 28, integer: true, validationMessage: 'Enter a whole number from 1 to 28 local drives.' }
];

function renderConstraintPreview() {
  const labels: Record<string, string> = { preferredCpuSockets: 'CPU sockets', preferredMemoryModules: 'Memory modules', maxLocalDriveCount: 'Maximum local drives' };
  const applied = userConstraintSpecs.flatMap((spec) => {
    const value = $<HTMLInputElement>(spec.inputId).value.trim();
    return value ? [`${labels[spec.inputId]}: ${value}`] : [];
  });
  const preview = $('appliedConstraintsPreview');
  preview.hidden = applied.length === 0;
  preview.textContent = applied.length ? `Applied · ${applied.join(' · ')}` : '';
}

function userConstraintRequirement(spec: UserConstraintSpec): Requirement | undefined {
  const input = $<HTMLInputElement>(spec.inputId);
  if (!input.value.trim()) return undefined;
  const value = Number(input.value);
  const inRange = Number.isFinite(value) && value >= spec.min && (spec.max === undefined || value <= spec.max) && (!spec.integer || Number.isInteger(value));
  if (!inRange) return undefined;
  return { id: spec.requirementId, label: spec.label, value, ...(spec.unit ? { unit: spec.unit } : {}), comparison: spec.comparison, status: 'explicit', required: true, evidence: [], note: 'User-entered hard constraint; overrides conflicting RFP wording.' };
}

function mergeUserConstraints(requirements: Requirement[]): Requirement[] {
  const extracted = requirements.find((requirement) => requirement.id === 'maxLeadTimeDays' && typeof requirement.value === 'number');
  const input = $<HTMLInputElement>('targetLeadTime');
  if (!input.value && extracted && typeof extracted.value === 'number' && extracted.value >= 0 && extracted.value <= 182) input.value = String(extracted.value);
  const overrides = [leadTimeRequirement(), ...userConstraintSpecs.map(userConstraintRequirement)].filter((requirement): requirement is Requirement => requirement !== undefined);
  const overriddenIds = new Set(overrides.map((requirement) => requirement.id));
  return [...requirements.filter((requirement) => !overriddenIds.has(requirement.id)), ...overrides];
}

$<HTMLInputElement>('targetLeadTime').addEventListener('change', async () => {
  const input = $<HTMLInputElement>('targetLeadTime');
  const value = Number(input.value);
  const valid = !input.value || (Number.isInteger(value) && value >= 0 && value <= 182);
  input.setCustomValidity(valid ? '' : 'Enter a whole number from 0 to 182 days.');
  if (!valid) { input.reportValidity(); return; }
  renderRequirements(sourceRequirements.length ? sourceRequirements : currentRequirements);
  await chrome.storage.local.set({ targetLeadTime: input.value });
});
chrome.storage.local.get('targetLeadTime').then((value) => { $<HTMLInputElement>('targetLeadTime').value = value.targetLeadTime ?? ''; currentRequirements = mergeUserConstraints(currentRequirements); });

for (const spec of userConstraintSpecs) {
  const input = $<HTMLInputElement>(spec.inputId);
  input.addEventListener('change', async () => {
    const value = Number(input.value);
    const valid = !input.value || (Number.isFinite(value) && value >= spec.min && (spec.max === undefined || value <= spec.max) && (!spec.integer || Number.isInteger(value)));
    input.setCustomValidity(valid ? '' : spec.validationMessage);
    if (!valid) { input.reportValidity(); return; }
    renderRequirements(sourceRequirements.length ? sourceRequirements : currentRequirements);
    renderConstraintPreview();
    await chrome.storage.local.set({ [spec.storageKey]: input.value });
  });
}
chrome.storage.local.get(userConstraintSpecs.map((spec) => spec.storageKey)).then((values) => {
  for (const spec of userConstraintSpecs) $<HTMLInputElement>(spec.inputId).value = values[spec.storageKey] ?? '';
  renderConstraintPreview(); renderRequirements(sourceRequirements);
});

const commitManualRequirements = (requirements: Requirement[]) => { sourceRequirements = requirements; renderRequirements(sourceRequirements); };
const addCpuRequirements = () => commitManualRequirements(ensureManualCpuRequirements(sourceRequirements));
const addMemoryRequirements = () => commitManualRequirements(ensureManualMemoryRequirements(sourceRequirements));
const addDriveGroup = () => {
  const nextNumber = (requirementGroupNumbers(sourceRequirements, 'storage').at(-1) ?? 0) + 1;
  commitManualRequirements([...sourceRequirements, ...createDriveGroup(nextNumber)]);
};
const addNicGroup = () => {
  const nextNumber = (requirementGroupNumbers(sourceRequirements, 'nic').at(-1) ?? 0) + 1;
  commitManualRequirements([...sourceRequirements, ...createNicGroup(nextNumber)]);
};

$('extract').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('extract');
  try {
    for (const inputId of ['targetLeadTime', ...userConstraintSpecs.map((spec) => spec.inputId)]) {
      const input = $<HTMLInputElement>(inputId);
      if (!input.checkValidity()) { input.reportValidity(); $('status').textContent = 'Stopped'; return; }
    }
    button.disabled = true; button.textContent = 'Extracting…'; $('requirements').setAttribute('aria-busy', 'true');
    $('status').textContent = 'Extracting…'; let text = $<HTMLTextAreaElement>('rfpText').value; let evidence: any[] = [];
    const fileUploadBetaEnabled = $<HTMLInputElement>('fileUploadBetaEnabled').checked;
    const file = fileUploadBetaEnabled ? $<HTMLInputElement>('rfpFile').files?.[0] : undefined;
    if (file) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; bytes.forEach((b) => binary += String.fromCharCode(b)); const doc = await api('/documents/extract', { name: file.name, mimeType: file.type, base64: btoa(binary) }); text = `${text}\n\n${doc.text}`; evidence = doc.evidence; }
    if (!text.trim()) throw new Error(fileUploadBetaEnabled ? 'Paste RFP text or choose a file first.' : 'Paste RFP text first.');
    const config = await settings(); const requirements = await api('/requirements/extract', { config: { provider: config.provider, model: config.model, apiKey: config.apiKey }, text }) as Requirement[];
    requirements.forEach((r) => { if (!r.evidence.length) r.evidence = evidence; }); sourceRequirements = ensureAlternativeSizingRequirements(requirements); renderRequirements(sourceRequirements); document.body.classList.add('has-extracted-requirements');
    const questionCount = clarificationQuestions(currentRequirements).length; $('status').textContent = questionCount ? `${questionCount} clarification${questionCount === 1 ? '' : 's'} available` : 'Ready for CCW review';
  } catch (error) { $('status').textContent = 'Extraction failed'; toast(error instanceof Error ? error.message : String(error)); }
  finally { button.disabled = false; button.textContent = 'Extract requirements'; $('requirements').removeAttribute('aria-busy'); }
});

function renderRequirements(requirements: Requirement[]) {
  currentRequirements = mergeUserConstraints(requirements);
  const orderedIds = [
    'cpuSockets', 'cpuCoresPerSocket', 'cpuTotalCores', 'cpuClockGhz', 'cpuVendor',
    'memoryGb', 'memoryModuleCount', 'memoryModuleSizeGb',
    'localStorageCapacity', 'localStorageCapacityType', 'raidLevel', 'localDriveCount', 'localDriveCapacity', 'localDriveType', 'maxLocalDriveCount',
    'storageGroup1Capacity', 'storageGroup1CapacityType', 'storageGroup1DriveCount', 'storageGroup1DriveCapacity', 'storageGroup1DriveType', 'storageGroup1DriveInterface', 'storageGroup1TransferSpeedGbps', 'storageGroup1RaidLevel',
    'storageGroup2Capacity', 'storageGroup2CapacityType', 'storageGroup2DriveCount', 'storageGroup2DriveCapacity', 'storageGroup2DriveType', 'storageGroup2DriveInterface', 'storageGroup2TransferSpeedGbps', 'storageGroup2RaidLevel',
    'storageGroup3Capacity', 'storageGroup3CapacityType', 'storageGroup3DriveCount', 'storageGroup3DriveCapacity', 'storageGroup3DriveType', 'storageGroup3DriveInterface', 'storageGroup3TransferSpeedGbps', 'storageGroup3RaidLevel',
    'bootCapacity', 'bootDriveCount', 'bootDriveType',
    'gpuCount', 'gpuModel', 'gpuMemoryGb', 'gpuDeploymentType',
    'nicCardCount', 'nicPortsPerCard', 'nicTotalPorts', 'nicSpeedGbpsPerPort', 'nicMedia', 'nicAdapterType',
    'nicGroup1CardCount', 'nicGroup1PortsPerCard', 'nicGroup1TotalPorts', 'nicGroup1SpeedGbpsPerPort', 'nicGroup1Media', 'nicGroup1AdapterType',
    'nicGroup2CardCount', 'nicGroup2PortsPerCard', 'nicGroup2TotalPorts', 'nicGroup2SpeedGbpsPerPort', 'nicGroup2Media', 'nicGroup2AdapterType'
  ];
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  const redundantInterfaces = redundantDriveInterfaceIds(currentRequirements);
  const redundantCapacityTypes = redundantStandaloneCapacityTypeIds(currentRequirements);
  const redundantStandaloneStorage = redundantStandaloneStorageIds(currentRequirements);
  const presented = currentRequirements.filter((r) => r.id !== 'maxLeadTimeDays' && !redundantInterfaces.has(r.id) && !redundantCapacityTypes.has(r.id) && !redundantStandaloneStorage.has(r.id)).map((requirement, index) => ({ requirement, index })).sort((a, b) => (rank.get(a.requirement.id) ?? orderedIds.length) - (rank.get(b.requirement.id) ?? orderedIds.length) || a.index - b.index).map(({ requirement }) => requirement);
  const categoryFor = (id: string) => id.startsWith('cpu') ? 'cpu' : id.startsWith('memory') ? 'memory' : /^(?:local|storage|raid|boot|maxLocalDrive)/.test(id) ? 'storage' : id.startsWith('nic') ? 'nic' : id.startsWith('gpu') ? 'gpu' : 'other';
  const categorySymbolPaths: Record<string, string[]> = {
    cpu: ['M7 7h10v10H7z', 'M10 10h4v4h-4z', 'M9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4'],
    memory: ['M5 7h14v10H5z', 'M8 10h8v4H8z', 'M8 4v3m4-3v3m4-3v3M8 17v3m4-3v3m4-3v3'],
    storage: ['M5 6c0-1.1 3.1-2 7-2s7 .9 7 2-3.1 2-7 2-7-.9-7-2Z', 'M5 6v12c0 1.1 3.1 2 7 2s7-.9 7-2V6', 'M5 12c0 1.1 3.1 2 7 2s7-.9 7-2'],
    nic: ['M4 7h16v10H4z', 'M7 10v4m3-4v4m4-4h3v4h-3z', 'M7 17v3m10-3v3'],
    gpu: ['M4 5h16v14H4z', 'M8 9h8v6H8z', 'M2 9h2m16 0h2M2 15h2m16 0h2'],
    other: ['M6 12h.01M12 12h.01M18 12h.01']
  };
  const createCategorySymbol = (id: string) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('focusable', 'false'); svg.setAttribute('aria-hidden', 'true');
    for (const d of categorySymbolPaths[id] ?? categorySymbolPaths.other!) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.7'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
    }
    return svg;
  };
  const categories = [
    { id: 'cpu', label: 'CPU', actionLabel: 'Add/edit CPU', action: addCpuRequirements },
    { id: 'memory', label: 'Memory', actionLabel: 'Add/edit RAM', action: addMemoryRequirements },
    { id: 'storage', label: 'Storage', actionLabel: '+ Drive group', action: addDriveGroup },
    { id: 'nic', label: 'NIC & connectivity', actionLabel: '+ NIC group', action: addNicGroup },
    { id: 'gpu', label: 'GPU' },
    { id: 'other', label: 'Other requirements' }
  ];
  const createRequirementCard = (r: Requirement) => {
    const card = document.createElement('article'); card.className = `card requirement-card ${r.required && r.status === 'unresolved' ? 'warning' : ''}`;
    const groupedLabel = r.id.match(/^(?:storage|nic)Group\d+(CapacityType|Capacity|DriveCount|DriveCapacity|DriveType|DriveInterface|TransferSpeedGbps|RaidLevel|CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort|Media|AdapterType)$/)?.[1];
    const groupedLabels: Record<string, string> = { Capacity: 'Capacity', CapacityType: 'Capacity type', DriveCount: 'Drive count', DriveCapacity: 'Capacity per drive', DriveType: 'Drive type', DriveInterface: 'Drive interface', TransferSpeedGbps: 'Transfer speed', RaidLevel: 'RAID level', CardCount: 'Card count', PortsPerCard: 'Ports per card', TotalPorts: 'Total ports', SpeedGbpsPerPort: 'Speed per port', Media: 'Port type', AdapterType: 'Adapter type' };
    const displayLabels: Record<string, string> = {
      cpuTotalCores: 'Total CPU cores', cpuSockets: 'CPU sockets', cpuCoresPerSocket: 'Cores per socket',
      memoryGb: 'Capacity', memoryModuleCount: 'DIMM count', memoryModuleSizeGb: 'DIMM size'
    };
    const title = document.createElement('h3'); title.textContent = groupedLabel ? groupedLabels[groupedLabel]! : (displayLabels[r.id] ?? r.label.replace(/\s+per server$/i, ''));
    const isMemoryCapacity = r.id === 'memoryGb';
    let displayUnit = isMemoryCapacity && typeof r.value === 'number' && r.value >= 1024 ? 'TB' : r.unit;
    const selectOptions = r.id === 'cpuVendor' ? ['', 'intel', 'amd']
      : /CapacityType$/.test(r.id) ? ['', 'raw', 'usable']
        : /DriveInterface$/.test(r.id) ? ['', 'SAS', 'SATA', 'NVMe']
          : /RaidLevel$/.test(r.id) || r.id === 'raidLevel' ? ['', 'NONE', '0', '00', '1', '5', '6', '10', '50', '60', 'JBOD']
            : /Media$/.test(r.id) || r.id === 'nicMedia' ? ['', 'SFP', 'QSFP', 'BASE-T', 'FC']
              : /AdapterType$/.test(r.id) || r.id === 'nicAdapterType' ? ['', 'VIC', 'OCP']
                : /DriveType$/.test(r.id) ? ['', 'SSD', 'SAS SSD', 'SATA SSD', 'HDD', 'SAS HDD', 'SATA HDD', 'NVMe', 'U.2 NVMe', 'U.3 NVMe', 'M.2', 'M.2 SATA', 'M.2 NVMe'] : undefined;
    let control: HTMLInputElement | HTMLSelectElement;
    if (selectOptions) {
      const select = document.createElement('select');
      const currentValue = r.value === undefined ? '' : String(r.value);
      const values = selectOptions.includes(currentValue) ? selectOptions : [...selectOptions, currentValue];
      for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = value === 'NONE' ? 'No RAID (HBA pass-through)' : value || 'Select…'; select.append(option); }
      select.value = currentValue; control = select;
    } else {
      const input = document.createElement('input'); input.value = r.value === undefined ? '' : String(isMemoryCapacity && displayUnit === 'TB' && typeof r.value === 'number' ? r.value / 1024 : r.value);
      if (/^(?:cpuSockets|cpuCoresPerSocket|cpuTotalCores|cpuClockGhz|memoryGb|memoryModuleCount|memoryModuleSizeGb|localDriveCount|localDriveCapacity|storageGroup\d+(?:Capacity|DriveCount|DriveCapacity|TransferSpeedGbps)|nicGroup\d+(?:CardCount|PortsPerCard|TotalPorts|SpeedGbpsPerPort)|gpuCount|gpuMemoryGb)$/.test(r.id)) { input.type = 'number'; input.min = '0.01'; input.step = 'any'; }
      control = input;
    }
    control.dataset.requirementId = r.id;
    control.setAttribute('aria-label', title.textContent ?? r.label);
    const meta = document.createElement('div'); meta.className = 'meta';
    const updateMeta = () => {
      const status = r.status === 'derived' ? 'Inferred' : r.status === 'unresolved' ? r.required ? 'Needs input' : 'Optional' : 'Explicit';
      const locator = r.evidence[0]?.locator;
      const source = locator && !/^aggregate inference\b/i.test(locator) && locator !== 'full text' ? ` · ${locator}` : '';
      meta.textContent = `${status}${source}${displayUnit ? ` · ${displayUnit}` : ''}`;
    };
    updateMeta();
    control.addEventListener('change', () => {
      const numeric = Number(control.value); const emptyOptionalNumber = control instanceof HTMLInputElement && (!control.value.trim() || !Number.isFinite(numeric) || numeric <= 0);
      if (emptyOptionalNumber) { control.value = ''; delete r.value; r.required = false; r.status = 'unresolved'; }
      else { r.value = control instanceof HTMLInputElement ? numeric * (isMemoryCapacity && displayUnit === 'TB' ? 1024 : 1) : control.value; if (!control.value.trim()) delete r.value; r.status = control.value.trim() ? 'explicit' : 'unresolved'; }
      if (isMemoryCapacity) r.unit = 'GB'; card.classList.toggle('warning', r.required && r.status === 'unresolved'); updateMeta(); renderClarifications(currentRequirements);
    });
    const valueRow = document.createElement('div'); valueRow.className = 'requirement-value-row'; valueRow.append(control);
    if (isMemoryCapacity || /^(?:storageGroup\d+(?:Capacity|DriveCapacity)|localStorageCapacity|localDriveCapacity|bootCapacity)$/.test(r.id)) {
      const unit = document.createElement('select'); unit.className = 'requirement-unit'; unit.setAttribute('aria-label', `${title.textContent ?? r.label} unit`);
      for (const value of ['GB', 'TB']) { const option = document.createElement('option'); option.value = value; option.textContent = value; unit.append(option); }
      unit.value = displayUnit?.toUpperCase() === 'TB' ? 'TB' : 'GB'; displayUnit = unit.value;
      if (isMemoryCapacity) r.unit = 'GB'; else r.unit = unit.value;
      unit.addEventListener('change', () => {
        if (isMemoryCapacity) {
          const canonicalGb = typeof r.value === 'number' ? r.value : undefined;
          displayUnit = unit.value;
          if (canonicalGb !== undefined && control instanceof HTMLInputElement) control.value = String(displayUnit === 'TB' ? canonicalGb / 1024 : canonicalGb);
          r.unit = 'GB';
        } else { displayUnit = unit.value; r.unit = unit.value; }
        updateMeta();
      }); valueRow.append(unit);
    }
    card.append(title, valueRow, meta); return card;
  };
  const sections = categories.flatMap((category) => {
    const items = presented.filter((requirement) => categoryFor(requirement.id) === category.id);
    if (!items.length && category.id === 'other') return [];
    const section = document.createElement('section'); section.className = `requirement-group requirement-group-${category.id}`; section.classList.toggle('is-empty', items.length === 0);
    const header = document.createElement('div'); header.className = 'requirement-group-header';
    const icon = document.createElement('span'); icon.className = 'requirement-group-icon'; icon.setAttribute('aria-hidden', 'true'); icon.append(createCategorySymbol(category.id));
    const heading = document.createElement('h2'); heading.textContent = category.label;
    const count = document.createElement('span'); count.className = 'requirement-count'; count.textContent = String(items.length); count.setAttribute('aria-label', `${items.length} fields`);
    header.append(icon, heading);
    if (category.actionLabel && category.action) { const action = document.createElement('button'); action.type = 'button'; action.className = 'secondary requirement-category-action'; action.textContent = category.actionLabel; action.addEventListener('click', category.action); header.append(action); }
    header.append(count);
    const groupPattern = category.id === 'storage' ? /^storageGroup(\d+)/ : category.id === 'nic' ? /^nicGroup(\d+)/ : undefined;
    const standalone = groupPattern ? items.filter((item) => !groupPattern.test(item.id)) : items;
    const body = document.createElement('div'); body.className = 'requirement-group-body';
    if (!items.length) { const empty = document.createElement('p'); empty.className = 'meta requirement-empty'; empty.textContent = 'No requirements added yet.'; body.append(empty); }
    if (standalone.length) { const grid = document.createElement('div'); grid.className = 'requirement-grid'; grid.append(...standalone.map(createRequirementCard)); body.append(grid); }
    if (groupPattern) {
      const subgroupGrid = document.createElement('div'); subgroupGrid.className = 'requirement-subgroups';
      const groupNumbers = [...new Set(items.flatMap((item) => item.id.match(groupPattern)?.[1] ?? []))].sort((a, b) => Number(a) - Number(b));
      for (const number of groupNumbers) {
        const subgroupItems = items.filter((item) => item.id.match(groupPattern)?.[1] === number);
        const subgroup = document.createElement('section'); subgroup.className = 'requirement-subgroup';
        const subgroupHeader = document.createElement('div'); subgroupHeader.className = 'requirement-subgroup-header';
        const subgroupTitle = document.createElement('h3'); subgroupTitle.textContent = `${category.id === 'storage' ? 'Drive' : 'NIC'} group ${number}`;
        const subgroupActions = document.createElement('div'); subgroupActions.className = 'requirement-subgroup-actions';
        const subgroupCount = document.createElement('span'); subgroupCount.textContent = `${subgroupItems.length} fields`;
        const removeGroup = document.createElement('button'); removeGroup.className = 'group-delete'; removeGroup.textContent = 'Delete'; removeGroup.type = 'button'; removeGroup.setAttribute('aria-label', `Delete ${category.id === 'storage' ? 'drive' : 'NIC'} group ${number}`);
        removeGroup.addEventListener('click', () => { const kind: RequirementGroupKind = category.id === 'storage' ? 'storage' : 'nic'; commitManualRequirements(removeRequirementGroupAndReindex(sourceRequirements, kind, Number(number))); });
        subgroupActions.append(subgroupCount, removeGroup); subgroupHeader.append(subgroupTitle, subgroupActions);
        const grid = document.createElement('div'); grid.className = 'requirement-grid'; grid.append(...subgroupItems.map(createRequirementCard));
        subgroup.append(subgroupHeader, grid); subgroupGrid.append(subgroup);
      }
      body.append(subgroupGrid);
    }
    section.append(header, body); return [section];
  });
  $('requirementsList').replaceChildren(...sections);
  renderClarifications(currentRequirements);
}

function renderClarifications(requirements: Requirement[]) {
  const panel = $('clarificationPanel'); const list = $('clarificationList');
  const questions = clarificationQuestions(requirements);
  panel.hidden = questions.length === 0; list.replaceChildren();
  for (const item of questions) {
    const row = document.createElement('li'); const question = document.createElement('span'); question.textContent = item.question;
    const review = document.createElement('button'); review.type = 'button'; review.textContent = item.requirementId === 'nicTopology' ? 'Add topology' : 'Answer';
    review.addEventListener('click', () => {
      if (item.requirementId === 'nicTopology') { addNicGroup(); requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-requirement-id^="nicGroup"]')?.focus()); return; }
      const fallbackId = item.requirementId === 'cpuSizing' ? 'cpuTotalCores' : item.requirementId === 'memorySizing' ? 'memoryGb' : item.requirementId.replace(/Sizing$/, 'Capacity');
      const control = document.querySelector<HTMLElement>(`[data-requirement-id="${CSS.escape(item.requirementId)}"]`) ?? document.querySelector<HTMLElement>(`[data-requirement-id="${CSS.escape(fallbackId)}"]`);
      control?.scrollIntoView({ behavior: 'smooth', block: 'center' }); control?.focus();
    });
    row.append(question, review); list.append(row);
  }
  if (requirements.length) $('status').textContent = questions.length ? `${questions.length} clarification${questions.length === 1 ? '' : 's'} available` : 'Ready for CCW review';
}

function renderStoredScanStatus(value?: PageSnapshot) {
  const status = $('storedScanStatus');
  status.parentElement!.dataset.state = value ? 'available' : 'empty';
  if (!value) { status.textContent = 'No stored CCW scan yet.'; return; }
  const captured = new Date(value.capturedAt);
  const when = Number.isNaN(captured.valueOf()) ? value.capturedAt : captured.toLocaleString();
  status.textContent = `Recommendation catalog · ${value.platformProfile?.model ?? value.title} · ${value.options.length} options · ${when}`;
}

async function persistScannedSnapshot(value: PageSnapshot) {
  catalogLibrary = upsertScannedCatalog(catalogLibrary, value); selectedCatalogId = catalogId(value); snapshot = value; liveSnapshotFingerprint = value.pageFingerprint;
  await chrome.storage.local.set({ [SNAPSHOT_STORAGE_KEY]: value, [CATALOG_LIBRARY_STORAGE_KEY]: catalogLibrary, [SELECTED_CATALOG_STORAGE_KEY]: selectedCatalogId });
  renderStoredScanStatus(value); renderCatalogLibrary();
}

async function persistApprovedSnapshot(value: PageSnapshot) {
  catalogLibrary = updateStoredCatalogSnapshot(catalogLibrary, value); snapshot = value; liveSnapshotFingerprint = value.pageFingerprint;
  await chrome.storage.local.set({ [SNAPSHOT_STORAGE_KEY]: value, [CATALOG_LIBRARY_STORAGE_KEY]: catalogLibrary });
  renderStoredScanStatus(value); renderCatalogLibrary();
}

$('scan').addEventListener('click', async () => {
  const scanButton = $<HTMLButtonElement>('scan');
  try {
    await loadCatalogLibrary(); scanButton.textContent = 'Scanning CCW…'; scanButton.classList.add('is-scanning'); $('ccw').setAttribute('aria-busy', 'true'); $('status').textContent = 'Connecting…'; scanButton.disabled = true; $<HTMLButtonElement>('recommendOnly').disabled = true;
    renderScanProgress({ phase: 'connecting', label: 'Connecting to the current draft', detail: 'Confirming page access and preparing the catalog scan.' });
    const response = await contentRequest({ type: 'DISCOVER' }); if (!response.ok) throw new Error(response.error);
    snapshot = response.data; await persistScannedSnapshot(snapshot!); renderSnapshot(snapshot!); const available = snapshot!.options.filter((option) => option.available).length;
    $('status').textContent = `${available} available`;
    renderScanProgress({ phase: 'complete', label: 'Your recommendation is ready', detail: `${available} available of ${snapshot!.options.length} scanned components.`, current: 1, total: 1, optionsFound: snapshot!.options.length });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error); $('status').textContent = 'Scan needs attention';
    renderScanProgress({ phase: 'error', label: 'The scan could not finish', detail: message }); toast(message);
  }
  finally { scanButton.textContent = 'Scan and recommend'; scanButton.classList.remove('is-scanning'); scanButton.disabled = false; $<HTMLButtonElement>('recommendOnly').disabled = false; $('ccw').removeAttribute('aria-busy'); }
});

$('recommendOnly').addEventListener('click', async () => {
  try {
    await loadCatalogLibrary();
    if (!snapshot) snapshot = (await chrome.storage.local.get(SNAPSHOT_STORAGE_KEY))[SNAPSHOT_STORAGE_KEY] as PageSnapshot | undefined;
    if (!snapshot?.options?.length) throw new Error('No stored CCW scan is available. Run Scan and recommend once first.');
    renderSnapshot(snapshot); renderStoredScanStatus(snapshot); $('status').textContent = 'Stored scan reused'; toast('Recommendation refreshed from the locally stored CCW scan.');
  } catch (error) { $('status').textContent = 'Stopped'; toast(error instanceof Error ? error.message : String(error)); }
});

void loadCatalogLibrary();

function renderSnapshot(value: PageSnapshot) {
  const intro = document.createElement('p'); intro.className = 'meta'; const profile = value.platformProfile; const availableCount = value.options.filter((option) => option.available).length; intro.textContent = `${value.adapterVersion} · ${profile ? `${profile.model} · ${profile.rackUnits ?? '?'}RU · ${profile.cpuVendor.toUpperCase()} · ` : ''}${availableCount} available of ${value.options.length} scanned · ${value.validationMessages.length} messages`;
  const recommendation = recommendRackComponents(currentRequirements, value.options, value.platformProfile);
  const hasRecommendations = recommendation.components.length > 0;
  const complete = hasRecommendations && recommendation.violations.length === 0;
  const heading = document.createElement('h2'); heading.textContent = hasRecommendations ? `${complete && !recommendation.notices.length ? 'Component recommendation' : 'Recommended available categories'} · ${value.options[0]?.currency ?? 'USD'} ${recommendation.totalListPrice.toLocaleString()} · ${recommendation.maxLeadTimeDays} days` : recommendation.violations.length ? 'No valid component recommendation' : 'No component recommendation yet';
  const validationBoundary = document.createElement('p'); validationBoundary.className = 'meta'; validationBoundary.textContent = 'Not a complete orderable BOM. Final CCW validation must confirm power, cables, cooling, firmware/HCL, licenses, and chassis or fabric dependencies.';
  const issues: HTMLElement[] = [];
  const canApplyToLiveDraft = liveSnapshotFingerprint === value.pageFingerprint;
  if (!canApplyToLiveDraft) { const notice = document.createElement('article'); notice.className = 'card warning'; notice.textContent = 'Recommendation is based on a stored catalog. Open the matching CCW draft and run Scan and recommend before approving components.'; issues.push(notice); }
  if (recommendation.notices.length) { const notice = document.createElement('article'); notice.className = 'card warning'; const title = document.createElement('h2'); title.textContent = 'Some inputs still need clarification'; const list = document.createElement('ul'); for (const message of recommendation.notices) { const item = document.createElement('li'); item.textContent = message; list.append(item); } notice.append(title, list); issues.push(notice); }
  if (recommendation.violations.length) { const warning = document.createElement('article'); warning.className = 'card warning'; const title = document.createElement('h2'); title.textContent = 'Cannot satisfy all requirements'; const list = document.createElement('ul'); for (const issue of recommendation.violations) { const item = document.createElement('li'); item.textContent = issue; list.append(item); } warning.append(title, list); issues.push(warning); }
  if (!currentRequirements.length) { const hint = document.createElement('article'); hint.className = 'card warning'; hint.textContent = 'Extract or enter requirements before requesting a recommendation.'; issues.push(hint); }
  const approvalItems = recommendedApprovalItems(recommendation.components, value.options);
  const batchActions = document.createElement('div'); batchActions.className = 'recommendation-batch'; batchActions.hidden = !approvalItems.length;
  const approveAll = document.createElement('button'); approveAll.type = 'button'; approveAll.className = 'primary'; approveAll.textContent = 'Approve all recommended components';
  const batchReady = canApplyToLiveDraft && complete && recommendation.notices.length === 0;
  approveAll.disabled = !batchReady;
  if (!canApplyToLiveDraft) approveAll.title = 'Scan the matching live CCW draft before approval.';
  else if (!complete || recommendation.notices.length) approveAll.title = 'Resolve all recommendation issues before approving every component.';
  const batchHint = document.createElement('p'); batchHint.className = 'meta'; batchHint.textContent = batchReady
    ? `Applies and verifies ${approvalItems.length} component${approvalItems.length === 1 ? '' : 's'} in CCW. Stops if any component fails.`
    : !canApplyToLiveDraft ? 'Open the matching CCW draft and run Scan and recommend first.' : 'Resolve all clarification and validation issues to enable batch approval.';
  approveAll.addEventListener('click', () => approveAllOptions(approvalItems, approveAll)); batchActions.append(approveAll, batchHint);
  const cards = (hasRecommendations ? recommendation.components : []).map((component) => {
    const section = document.createElement('article'); section.className = 'card'; const title = document.createElement('h2'); title.textContent = component.label;
    const reason = document.createElement('div'); reason.className = 'meta recommendation-reason'; reason.textContent = `${component.reason} · ${component.maxLeadTimeDays} days · ${value.options[0]?.currency ?? 'USD'} ${component.totalListPrice.toLocaleString()}`; section.append(title, reason);
    for (const selection of component.selections) { const option = value.options.find((item) => item.id === selection.optionId); if (!option) continue; const row = document.createElement('div'); row.className = 'recommendation-row'; const detail = document.createElement('div'); detail.textContent = `${selection.quantity} × ${option.sku} — ${option.name}`; const location = document.createElement('div'); location.className = 'meta'; location.textContent = `${option.attributes.categoryName || option.category} > ${option.attributes.subgroupName || option.category}`; const approve = document.createElement('button'); approve.className = 'primary'; approve.textContent = 'Approve this component'; approve.disabled = !canApplyToLiveDraft; if (!canApplyToLiveDraft) approve.title = 'Scan the matching live CCW draft before approval.'; approve.addEventListener('click', () => approveOption(option.id, selection.quantity, approve)); row.append(detail, location, approve); section.append(row); }
    return section;
  });
  $('snapshot').replaceChildren(intro, heading, validationBoundary, ...issues, batchActions, ...cards);
}

async function applyApprovedOption(optionId: string, quantity: number) {
  if (!snapshot) throw new Error('Scan CCW again before approving a component.');
  const action: ApprovedAction = { actionId: crypto.randomUUID(), optionId, quantity, expectedPriorState: snapshot.pageFingerprint, approvedAt: new Date().toISOString() };
  const response = await contentRequest({ type: 'APPLY_APPROVED', action });
  if (!response.ok) throw new Error(response.error);
  snapshot = response.data;
  await persistApprovedSnapshot(snapshot!);
}

async function approveOption(optionId: string, quantity: number, button: HTMLButtonElement) {
  if (!snapshot) return;
  const option = snapshot.options.find((item) => item.id === optionId);
  if (!option) return;
  button.disabled = true;
  try { await applyApprovedOption(optionId, quantity); renderSnapshot(snapshot!); toast(appliedNotification(option, quantity)); }
  catch (error) { toast(applyFailedNotification(option, quantity, error)); }
  finally { button.disabled = false; }
}

async function approveAllOptions(items: ApprovalBatchItem[], button: HTMLButtonElement) {
  if (!snapshot || !items.length) return;
  const container = $('snapshot'); const applied: ApprovalBatchItem[] = [];
  button.disabled = true; button.classList.add('is-scanning'); container.setAttribute('aria-busy', 'true');
  container.querySelectorAll<HTMLButtonElement>('.recommendation-row button').forEach((item) => { item.disabled = true; });
  for (const [index, item] of items.entries()) {
    button.textContent = `Applying ${index + 1} of ${items.length}…`; $('status').textContent = button.textContent;
    try { await applyApprovedOption(item.option.id, item.quantity); applied.push(item); }
    catch (error) {
      renderSnapshot(snapshot!); $('status').textContent = `Stopped after ${applied.length} of ${items.length} components`; toast(batchApplyFailedNotification(applied, item, items.length, error)); container.removeAttribute('aria-busy'); return;
    }
  }
  renderSnapshot(snapshot!); $('status').textContent = `${applied.length} components applied`; toast(allAppliedNotification(applied)); container.removeAttribute('aria-busy');
}

renderConstraintPreview();
renderRequirements([]);
