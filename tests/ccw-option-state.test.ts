import { describe, expect, it } from 'vitest';
import { ccwOptionState } from '../packages/extension/src/ccw-option-state.js';

describe('CCW option state', () => {
  it('marks an empty unit list price as unavailable', () => {
    expect(ccwOptionState('', true, false)).toEqual({ unitListPrice: 0, hasUnitListPrice: false, available: false, quantityFixed: false });
  });

  it('preserves a zero-dollar priced option as available', () => {
    expect(ccwOptionState('0.00', true, false)).toMatchObject({ unitListPrice: 0, hasUnitListPrice: true, available: true });
  });

  it('records a disabled quantity as an immutable CCW quantity', () => {
    expect(ccwOptionState('6,423.10', true, true, '1', true)).toMatchObject({ unitListPrice: 6423.1, available: true, quantityFixed: true, fixedQuantity: 1 });
  });

  it('does not treat an unselected disabled quantity input as fixed at one', () => {
    expect(ccwOptionState('6,423.10', true, true, '1', false)).toMatchObject({ unitListPrice: 6423.1, available: true, quantityFixed: false });
  });
});
