import { describe, expect, it } from 'vitest';
import { recommendedApprovalItems } from '../packages/extension/src/approval-batch.js';
import type { CatalogOption, ComponentRecommendation } from '../packages/shared/src/index.js';

const option = (id: string): CatalogOption => ({ id, sku: id.toUpperCase(), name: `${id} component`, category: 'storage', unitListPrice: 1, currency: 'USD', available: true, attributes: {} });
const component = (label: string, selections: ComponentRecommendation['selections']): ComponentRecommendation => ({ component: 'storage', label, selections, reason: '', totalListPrice: 0, maxLeadTimeDays: 0 });

describe('recommended approval batch', () => {
  it('keeps recommendation order and resolves catalog details', () => {
    const items = recommendedApprovalItems([component('First', [{ optionId: 'cpu', quantity: 2 }]), component('Second', [{ optionId: 'memory', quantity: 8 }])], [option('cpu'), option('memory')]);
    expect(items.map((item) => [item.option.id, item.quantity])).toEqual([['cpu', 2], ['memory', 8]]);
  });

  it('combines duplicate option quantities and ignores missing or empty selections', () => {
    const items = recommendedApprovalItems([
      component('Local storage', [{ optionId: 'drive', quantity: 4 }, { optionId: 'missing', quantity: 1 }]),
      component('Boot storage', [{ optionId: 'drive', quantity: 2 }, { optionId: 'drive', quantity: 0 }])
    ], [option('drive')]);
    expect(items.map((item) => [item.option.id, item.quantity])).toEqual([['drive', 6]]);
  });
});
