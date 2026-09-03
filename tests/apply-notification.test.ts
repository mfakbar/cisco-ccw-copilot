import { describe, expect, it } from 'vitest';
import { allAppliedNotification, appliedNotification, applyFailedNotification, batchApplyFailedNotification } from '../packages/extension/src/apply-notification.js';
import type { CatalogOption } from '../packages/shared/src/index.js';

const option: CatalogOption = {
  id: 'link_FrontFacingDriveOption:catDrpDwn_PCIe/U.3NVMe2.5-inSFF:UCS-NVB3T8M2V',
  sku: 'UCS-NVB3T8M2V',
  name: '3.8 TB NVMe U.3 drive',
  category: 'storage',
  unitListPrice: 1000,
  currency: 'USD',
  available: true,
  attributes: {}
};

describe('component apply notifications', () => {
  it('reports the readable SKU and description instead of the internal option ID', () => {
    expect(appliedNotification(option, 4)).toEqual({
      status: 'success',
      title: 'Applied successfully',
      component: '4 × UCS-NVB3T8M2V — 3.8 TB NVMe U.3 drive',
      detail: 'CCW confirmed the component and quantity. The saved catalog was preserved.'
    });
  });

  it('explains why a stale recommendation failed and how to fix it', () => {
    expect(applyFailedNotification(option, 4, new Error('CCW page changed after review. Refresh recommendations before applying.'))).toEqual({
      status: 'error',
      title: 'Could not apply component',
      component: '4 × UCS-NVB3T8M2V — 3.8 TB NVMe U.3 drive',
      detail: 'Why: The CCW configuration changed after this recommendation was reviewed.',
      fix: 'Fix: Run Scan and recommend again, review the refreshed result, then approve it.'
    });
  });

  it('keeps an unexpected failure reason and supplies a safe recovery step', () => {
    const result = applyFailedNotification(option, 1, new Error('Unexpected CCW response'));
    expect(result.detail).toBe('Why: Unexpected CCW response');
    expect(result.fix).toBe('Fix: Review the CCW page, run Scan and recommend again, then retry.');
  });

  it('summarizes completed and partially failed batch approvals', () => {
    const item = { option, quantity: 4 };
    expect(allAppliedNotification([item])).toMatchObject({
      status: 'success',
      title: 'All recommended components applied',
      component: '1 of 1 component applied successfully'
    });
    expect(batchApplyFailedNotification([], item, 3, new Error('CCW page changed after review.'))).toMatchObject({
      status: 'error',
      title: 'Approve all stopped',
      component: '0 of 3 components applied · Failed: 4 × UCS-NVB3T8M2V — 3.8 TB NVMe U.3 drive',
      detail: 'No components were applied. Why: The CCW configuration changed after this recommendation was reviewed.'
    });
  });
});
