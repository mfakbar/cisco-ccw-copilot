export interface CcwOptionState {
  unitListPrice: number;
  hasUnitListPrice: boolean;
  available: boolean;
  quantityFixed: boolean;
  fixedQuantity?: number;
}

export function ccwOptionState(priceText: string, hasSelectableControl: boolean, quantityDisabled: boolean, quantityValue?: string, selected = false): CcwOptionState {
  const normalizedPrice = priceText.replace(/,/g, '').replace(/[^0-9.-]/g, '');
  const hasUnitListPrice = /\d/.test(priceText) && normalizedPrice !== '' && Number.isFinite(Number(normalizedPrice));
  const parsedQuantity = Number(quantityValue);
  // CCW disables many quantity inputs until their option is selected. That is
  // temporary UI state, not a fixed quantity constraint.
  const quantityFixed = quantityDisabled && selected;
  const fixedQuantity = quantityFixed && Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : undefined;
  return {
    unitListPrice: hasUnitListPrice ? Number(normalizedPrice) : 0,
    hasUnitListPrice,
    available: hasSelectableControl && hasUnitListPrice,
    quantityFixed,
    ...(fixedQuantity === undefined ? {} : { fixedQuantity })
  };
}
