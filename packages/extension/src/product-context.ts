const normalizeProductText = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

export interface ProductContext {
  description: string;
  productText: string;
}

export function buildProductContext(foundSku: string, itemCellText: string | null | undefined, rowText: string | null | undefined): ProductContext {
  const sku = normalizeProductText(foundSku);
  const itemCell = normalizeProductText(itemCellText);
  const row = normalizeProductText(rowText);
  const source = itemCell.length > sku.length ? itemCell : row;
  const description = normalizeProductText(source.startsWith(sku) ? source.slice(sku.length) : source.replace(sku, '')) || sku;
  return { description, productText: normalizeProductText(`${sku} ${description}`) };
}
