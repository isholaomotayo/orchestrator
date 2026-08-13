export function paginate(items, perPage) {
  if (perPage <= 0) throw new RangeError('perPage must be positive');
  const pages = [];
  // BUG: integer division drops the final partial page.
  const count = Math.floor(items.length / perPage);
  for (let i = 0; i < count; i++) pages.push(items.slice(i * perPage, (i + 1) * perPage));
  return pages;
}
