/** Pure intrinsics implemented with identical value semantics by both runtimes. */
export const PURE_BUILTIN_NAMES = new Set([
  'str', 'int', 'float',
  'list.length', 'list.append', 'list.contains',
  'text.trim', 'text.normalize_space', 'text.split', 'text.replace',
]);

export function isPureBuiltin(name: string): boolean {
  return PURE_BUILTIN_NAMES.has(name);
}
