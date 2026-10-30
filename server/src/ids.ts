import { randomBytes } from 'node:crypto';

/** Short, prefixed, sortable-enough ids (e.g. "prop_lx2k9a_3f9c1e"). */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}
