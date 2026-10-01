/** Pure intrinsics implemented with identical value semantics by both runtimes. */
export const PURE_BUILTIN_NAMES = new Set([
  'str', 'int', 'float',
  'list.length', 'list.append', 'list.contains',
  'text.trim', 'text.normalize_space', 'text.split', 'text.replace',
]);

/** Runtime-state queries are executable host intrinsics, not compile-time constants. */
export const RUNTIME_STATE_APIS = new Map([
  ['runtime.state.characters.exists', { parameters: ['str'] as const, returns: 'bool' as const, effect: 'read:characters' as const }],
  ['runtime.state.characters.list', { parameters: [] as const, returns: { kind: 'list' as const, value: 'str' as const }, effect: 'read:characters' as const }],
]);

export function isRuntimeStateApi(name: string): boolean {
  return RUNTIME_STATE_APIS.has(name);
}

/** Any built-in call name which an imported module must not namespace again. */
export function isBuiltinFunction(name: string): boolean {
  return isPureBuiltin(name) || isRuntimeStateApi(name);
}

/** Built-ins which cannot write scenario variables; runtime reads stay dynamic. */
export function isNonMutatingBuiltin(name: string): boolean {
  return isBuiltinFunction(name);
}

export function isPureBuiltin(name: string): boolean {
  return PURE_BUILTIN_NAMES.has(name);
}
