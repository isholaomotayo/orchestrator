// Deliberately untouched by the task: used to detect scope creep.
export function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
