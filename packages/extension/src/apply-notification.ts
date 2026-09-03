import type { CatalogOption } from '@ccw/shared';
import type { ApprovalBatchItem } from './approval-batch.js';

export type ApplyNotification = {
  status: 'success' | 'error';
  title: string;
  component: string;
  detail: string;
  fix?: string;
};

const componentLabel = (option: CatalogOption, quantity: number) =>
  `${quantity} × ${option.sku}${option.name && option.name !== option.sku ? ` — ${option.name}` : ''}`;

const componentList = (items: ApprovalBatchItem[]) => items.map((item) => componentLabel(item.option, item.quantity)).join(' · ');

export function appliedNotification(option: CatalogOption, quantity: number): ApplyNotification {
  return {
    status: 'success',
    title: 'Applied successfully',
    component: componentLabel(option, quantity),
    detail: 'CCW confirmed the component and quantity. The saved catalog was preserved.'
  };
}

function failureGuidance(message: string): { why: string; fix: string } {
  const normalized = message.toLowerCase();
  if (normalized.includes('no active cisco tab')) return {
    why: 'The matching Cisco CCW draft is not open in the active tab.',
    fix: 'Open the matching CCW draft, then approve this component again.'
  };
  if (normalized.includes('page access was not granted')) return {
    why: 'CCW Copilot does not have permission to update this CCW page.',
    fix: 'Grant page access when prompted, then approve this component again.'
  };
  if (normalized.includes('could not connect to the ccw page')) return {
    why: 'CCW Copilot could not connect to the open CCW page.',
    fix: 'Reload the CCW page and the extension, then try again.'
  };
  if (normalized.includes('page changed after review')) return {
    why: 'The CCW configuration changed after this recommendation was reviewed.',
    fix: 'Run Scan and recommend again, review the refreshed result, then approve it.'
  };
  if (normalized.includes('scan ccw again') || normalized.includes('no longer present') || normalized.includes('no longer selectable')) return {
    why: 'The reviewed component no longer matches the current CCW page.',
    fix: 'Run Scan and recommend again, then approve the refreshed component.'
  };
  if (normalized.includes('no unit list price') || normalized.includes('is not available')) return {
    why: message,
    fix: 'Choose another available component, or rescan after CCW pricing becomes available.'
  };
  if (normalized.includes('ccw-fixed quantity')) return {
    why: message,
    fix: 'Use the quantity fixed by CCW, or revise the requirement and refresh recommendations.'
  };
  if (normalized.includes('did not confirm')) return {
    why: message.replace(/\s*No further changes were attempted\.?$/i, ''),
    fix: 'Check the current CCW selection and quantity, then run Scan and recommend before retrying.'
  };
  return {
    why: message || 'CCW did not complete the requested change.',
    fix: 'Review the CCW page, run Scan and recommend again, then retry.'
  };
}

export function applyFailedNotification(option: CatalogOption, quantity: number, error: unknown): ApplyNotification {
  const message = error instanceof Error ? error.message : String(error);
  const { why, fix } = failureGuidance(message);
  return {
    status: 'error',
    title: 'Could not apply component',
    component: componentLabel(option, quantity),
    detail: `Why: ${why}`,
    fix: `Fix: ${fix}`
  };
}

export function allAppliedNotification(items: ApprovalBatchItem[]): ApplyNotification {
  return {
    status: 'success',
    title: 'All recommended components applied',
    component: `${items.length} of ${items.length} component${items.length === 1 ? '' : 's'} applied successfully`,
    detail: `Applied: ${componentList(items)}. The saved catalog was preserved.`
  };
}

export function batchApplyFailedNotification(applied: ApprovalBatchItem[], failed: ApprovalBatchItem, total: number, error: unknown): ApplyNotification {
  const failure = applyFailedNotification(failed.option, failed.quantity, error);
  const appliedSummary = applied.length ? `Applied before stopping: ${componentList(applied)}. ` : 'No components were applied. ';
  return {
    status: 'error',
    title: 'Approve all stopped',
    component: `${applied.length} of ${total} components applied · Failed: ${componentLabel(failed.option, failed.quantity)}`,
    detail: `${appliedSummary}${failure.detail}`,
    fix: failure.fix ?? 'Fix: Review the CCW page, run Scan and recommend again, then retry.'
  };
}
