export type RequirementStatus = 'explicit' | 'derived' | 'unresolved';
export type ProductFamily = 'C_SERIES' | 'X_SERIES';
export type RequirementComparison = 'atLeast' | 'atMost' | 'exact';
export type CpuVendor = 'intel' | 'amd' | 'unknown';
export type ComponentCategory =
  | 'server' | 'cpu' | 'memory' | 'storage' | 'boot' | 'bootDrive' | 'gpu' | 'nic'
  | 'raid' | 'riser' | 'hba' | 'management' | 'chassis' | 'fabric'
  | 'license' | 'power' | 'security' | 'accessory' | 'operatingSystem' | 'other';

export interface SourceEvidence {
  documentName: string;
  kind: 'pdf-page' | 'docx-heading' | 'xlsx-range' | 'pasted-text';
  locator: string;
  excerpt: string;
}

export interface Requirement<T = number | string | boolean> {
  id: string;
  label: string;
  value?: T;
  unit?: string;
  status: RequirementStatus;
  required: boolean;
  comparison?: RequirementComparison;
  evidence: SourceEvidence[];
  note?: string;
}

export interface RackServerProfile {
  model: string;
  generation: string;
  series: 'C21X' | 'C22X' | 'C24X' | 'X21X' | 'UNKNOWN';
  rackUnits?: 1 | 2;
  cpuVendor: CpuVendor;
  riserSlotNames: string[];
}

export interface SystemRole {
  id: string;
  name: string;
  quantity: number;
  family: ProductFamily;
  requirements: Requirement[];
}

export interface RequirementSet {
  id: string;
  projectName: string;
  roles: SystemRole[];
  createdAt: string;
  updatedAt: string;
}

export interface CatalogOption {
  id: string;
  sku: string;
  name: string;
  category: ComponentCategory;
  unitListPrice: number;
  currency: string;
  available: boolean;
  attributes: Record<string, string | number | boolean>;
  requires?: string[];
  excludes?: string[];
  ccwLocator?: string;
}

export interface Selection { optionId: string; quantity: number }

export interface CalculationTrace {
  requirementId: string;
  expression: string;
  actual: number | string | boolean;
  required: number | string | boolean;
  passed: boolean;
}

export interface ConfigurationCandidate {
  id: string;
  family: ProductFamily;
  selections: Selection[];
  calculations: CalculationTrace[];
  violations: string[];
  warnings: string[];
  totalListPrice: number;
  excessScore: number;
}

export interface ComponentRecommendation {
  component: 'cpu' | 'memory' | 'raid' | 'storage' | 'riser' | 'mlom' | 'riserNic' | 'gpu' | 'bootController' | 'bootDrive';
  label: string;
  selections: Selection[];
  totalListPrice: number;
  maxLeadTimeDays: number;
  reason: string;
}

export interface RackRecommendation {
  components: ComponentRecommendation[];
  calculations: CalculationTrace[];
  violations: string[];
  notices: string[];
  totalListPrice: number;
  maxLeadTimeDays: number;
}

export interface ApprovedAction {
  actionId: string;
  optionId: string;
  quantity: number;
  expectedPriorState: string;
  approvedAt: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  adapterVersion: string;
  configurationId?: string;
  platformProfile?: RackServerProfile;
  options: CatalogOption[];
  validationMessages: string[];
  pageFingerprint: string;
}
