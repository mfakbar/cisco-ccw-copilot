import type { CatalogOption, ComponentRecommendation } from '@ccw/shared';

export type ApprovalBatchItem = { option: CatalogOption; quantity: number };

export function recommendedApprovalItems(components: ComponentRecommendation[], options: CatalogOption[]): ApprovalBatchItem[] {
  const optionsById = new Map(options.map((option) => [option.id, option]));
  const quantities = new Map<string, number>();
  for (const selection of components.flatMap((component) => component.selections)) {
    if (!optionsById.has(selection.optionId) || selection.quantity <= 0) continue;
    quantities.set(selection.optionId, (quantities.get(selection.optionId) ?? 0) + selection.quantity);
  }
  return [...quantities].flatMap(([optionId, quantity]) => {
    const option = optionsById.get(optionId);
    return option ? [{ option, quantity }] : [];
  });
}
