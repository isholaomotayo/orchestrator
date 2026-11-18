// Checks a payload against pipeline/contract/v1/*.schema.json, the contract the
// desktop client is built against. A tiny validator covering the subset the
// schemas use (type, enum, required, properties, items) keeps the engine
// dependency-free. Used by the tests, on both built and live server payloads.
import fs from 'node:fs';

export const loadSchema = (name) => JSON.parse(fs.readFileSync(new URL(`./contract/v1/${name}.schema.json`, import.meta.url), 'utf8'));

function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

/** Every way `value` breaks `schema`, as "$.path: problem" strings; empty when it conforms. */
export function validate(schema, value, at = '$') {
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.includes(typeOf(value))) errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    for (const [key, sub] of Object.entries(schema.properties || {})) if (key in value) errors.push(...validate(sub, value[key], `${at}.${key}`));
  }
  if (typeOf(value) === 'array' && schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${at}[${i}]`)));
  return errors;
}
