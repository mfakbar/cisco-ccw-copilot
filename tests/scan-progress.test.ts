import { describe, expect, it } from 'vitest';
import { scanPhaseFromMessage, scanProgressView } from '../packages/extension/src/scan-progress.js';

describe('scan progress presentation', () => {
  it('normalizes legacy progress messages', () => {
    expect(scanPhaseFromMessage({ label: 'Complete' })).toBe('complete');
    expect(scanPhaseFromMessage({ current: 2 })).toBe('scanning');
    expect(scanPhaseFromMessage({ phase: 'restoring' })).toBe('restoring');
    expect(scanPhaseFromMessage({ phase: 'unexpected' })).toBe('connecting');
  });

  it('retains discovered component counts and clamps category progress', () => {
    const view = scanProgressView({ phase: 'scanning', label: 'Reading', current: 12, total: 10 }, 7);
    expect(view).toMatchObject({ current: 12, total: 10, found: 7, count: '7 components found', position: 'Category 10 of 10', activeStep: 1, indeterminate: false });
  });

  it('resets counts when a new scan connects and preserves safety messaging on error', () => {
    expect(scanProgressView({ phase: 'connecting', label: 'Connecting' }, 9).found).toBe(0);
    expect(scanProgressView({ phase: 'error', label: 'Stopped' }, 9)).toMatchObject({ found: 9, position: 'Not completed', activeStep: -1, assurance: 'Nothing was applied to the CCW draft. Resolve the issue and scan again.' });
  });
});
