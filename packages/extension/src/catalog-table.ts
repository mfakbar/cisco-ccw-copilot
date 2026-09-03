import type { CatalogOption } from '@ccw/shared';
import { groupCatalogOptions, type CatalogFilters, type CatalogSort } from './catalog-options.js';

const numericFilter = (input: HTMLInputElement): number | undefined => input.value === '' ? undefined : Number(input.value);

export function renderCatalogTables(options: CatalogOption[], includeHeading = true): HTMLElement {
  const container = document.createElement('section'); container.className = `catalog-listing${includeHeading ? '' : ' catalog-listing-embedded'}`;
  if (includeHeading) {
    const heading = document.createElement('h2'); heading.textContent = 'Scanned CCW catalog';
    const intro = document.createElement('p'); intro.className = 'meta'; intro.textContent = 'Components discovered in the selected CCW catalog.';
    container.append(heading, intro);
  }
  const controls = document.createElement('details'); controls.className = 'catalog-sort-filter';
  const controlsSummary = document.createElement('summary'); controlsSummary.textContent = 'Sort & filter';
  const controlsBody = document.createElement('div'); controlsBody.className = 'catalog-filter-grid';
  const field = (labelText: string, control: HTMLInputElement | HTMLSelectElement) => { const label = document.createElement('label'); label.textContent = labelText; label.append(control); return label; };
  const sort = document.createElement('select'); sort.setAttribute('aria-label', 'Sort catalog components');
  const sortOptions: Array<[CatalogSort, string]> = [['price-desc', 'Price: high to low'], ['price-asc', 'Price: low to high'], ['lead-asc', 'Lead time: shortest first'], ['lead-desc', 'Lead time: longest first']];
  for (const [value, label] of sortOptions) { const option = document.createElement('option'); option.value = value; option.textContent = label; sort.append(option); }
  const maxLead = document.createElement('input'); maxLead.type = 'number'; maxLead.min = '0'; maxLead.step = '1'; maxLead.placeholder = 'Any';
  const minPrice = document.createElement('input'); minPrice.type = 'number'; minPrice.min = '0'; minPrice.step = 'any'; minPrice.placeholder = 'No minimum';
  const maxPrice = document.createElement('input'); maxPrice.type = 'number'; maxPrice.min = '0'; maxPrice.step = 'any'; maxPrice.placeholder = 'No maximum';
  controlsBody.append(field('Sort by', sort), field('Max lead time (days)', maxLead), field('Minimum list price', minPrice), field('Maximum list price', maxPrice)); controls.append(controlsSummary, controlsBody); container.append(controls);
  const groupContainer = document.createElement('div'); groupContainer.className = 'catalog-groups'; container.append(groupContainer);
  const renderGroups = () => {
    const maxLeadDays = numericFilter(maxLead);
    const minimumPrice = numericFilter(minPrice);
    const maximumPrice = numericFilter(maxPrice);
    const filters: CatalogFilters = {
      sort: sort.value as CatalogSort,
      ...(maxLeadDays !== undefined ? { maxLeadDays } : {}),
      ...(minimumPrice !== undefined ? { minPrice: minimumPrice } : {}),
      ...(maximumPrice !== undefined ? { maxPrice: maximumPrice } : {})
    };
    const sections: HTMLElement[] = groupCatalogOptions(options, filters).map((group) => {
      const section = document.createElement('details'); section.className = 'catalog-group'; section.open = true;
      const titleRow = document.createElement('summary'); titleRow.className = 'catalog-group-title';
      const title = document.createElement('h3'); title.textContent = group.label;
      const count = document.createElement('span'); count.textContent = String(group.options.length); count.setAttribute('aria-label', `${group.options.length} components`); titleRow.append(title, count);
      const scroller = document.createElement('div'); scroller.className = 'catalog-table-scroll';
      const table = document.createElement('table'); table.className = 'catalog-table';
      const head = document.createElement('thead'); const headerRow = document.createElement('tr');
      for (const label of ['Component SKU & description', 'Lead time', 'Unit price list']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; headerRow.append(cell); } head.append(headerRow);
      const body = document.createElement('tbody');
      for (const option of group.options) {
        const row = document.createElement('tr');
        const component = document.createElement('td'); const sku = document.createElement('strong'); sku.textContent = option.sku; const description = document.createElement('span'); description.textContent = option.name; component.append(sku, description);
        const leadTime = document.createElement('td'); const days = option.attributes.leadTimeDays; leadTime.textContent = typeof days === 'number' && days >= 0 ? `${days} days` : 'Unknown';
        const price = document.createElement('td'); price.className = 'catalog-price'; price.textContent = option.attributes.hasUnitListPrice === false ? 'Unavailable' : `${option.currency} ${option.unitListPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        row.classList.toggle('is-unavailable', !option.available); row.append(component, leadTime, price); body.append(row);
      }
      table.append(head, body); scroller.append(table); section.append(titleRow, scroller); return section;
    });
    if (!sections.length) { const empty = document.createElement('p'); empty.className = 'meta catalog-empty'; empty.textContent = 'No catalog components match these filters.'; sections.push(empty); }
    groupContainer.replaceChildren(...sections);
  };
  for (const control of [sort, maxLead, minPrice, maxPrice]) control.addEventListener(control === sort ? 'change' : 'input', renderGroups);
  renderGroups();
  return container;
}
