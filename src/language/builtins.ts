/** Pure intrinsics implemented with identical value semantics by both runtimes. */
export const PURE_BUILTIN_NAMES = new Set([
  'str', 'int', 'float',
  'list.length', 'list.append', 'list.contains',
  'text.trim', 'text.normalize_space', 'text.split', 'text.replace',
]);

/**
 * Runtime-state APIs are executable host intrinsics. The `compile` metadata
 * describes facts a sound static analyzer may infer from the result; it does
 * not make the runtime read a compile-time constant or expose a TDS compile.*
 * function.
 */
export interface RuntimeStateApiDefinition {
  parameters: readonly string[];
  returns: 'bool' | 'str' | 'int' | 'float' | { kind: 'list'; value: 'str' };
  effects: { reads: readonly string[]; writes: readonly string[] };
  compile?: {
    predicate?:
      | { kind: 'membership'; domain: 'characters'; argument: number; positiveMeans: 'present' }
      | { kind: 'state'; domain: 'background' | 'audio.bgm'; positiveMeans: 'present' }
      | { kind: 'binding'; domain: 'variables'; argument: number; positiveMeans: 'exists' };
  };
}

export const RUNTIME_STATE_APIS: ReadonlyMap<string, RuntimeStateApiDefinition> = new Map([
  ['runtime.state.characters.exists', {
    parameters: ['str'], returns: 'bool',
    effects: { reads: ['characters'], writes: [] },
    compile: { predicate: { kind: 'membership', domain: 'characters', argument: 0, positiveMeans: 'present' } },
  }],
  ['runtime.state.characters.list', {
    parameters: [], returns: { kind: 'list', value: 'str' },
    effects: { reads: ['characters'], writes: [] },
  }],
  ['runtime.state.characters.position', {
    parameters: ['str'], returns: 'str',
    effects: { reads: ['characters'], writes: [] },
  }],
  ['runtime.state.background.exists', {
    parameters: [], returns: 'bool',
    effects: { reads: ['background'], writes: [] },
    compile: { predicate: { kind: 'state', domain: 'background', positiveMeans: 'present' } },
  }],
  ['runtime.state.background.current', {
    parameters: [], returns: 'str',
    effects: { reads: ['background'], writes: [] },
  }],
  ['runtime.state.audio.bgm_exists', {
    parameters: [], returns: 'bool',
    effects: { reads: ['audio.bgm'], writes: [] },
    compile: { predicate: { kind: 'state', domain: 'audio.bgm', positiveMeans: 'present' } },
  }],
  ['runtime.state.audio.current_bgm', {
    parameters: [], returns: 'str',
    effects: { reads: ['audio.bgm'], writes: [] },
  }],
  ['runtime.state.execution.current_scene', {
    parameters: [], returns: 'str', effects: { reads: ['execution'], writes: [] },
  }],
  ['runtime.state.execution.current_file', {
    parameters: [], returns: 'str', effects: { reads: ['execution'], writes: [] },
  }],
  ['runtime.state.execution.current_line', {
    parameters: [], returns: 'int', effects: { reads: ['execution'], writes: [] },
  }],
  ['runtime.state.audio.volume', {
    parameters: ['str'], returns: 'float', effects: { reads: ['audio.mix'], writes: [] },
  }],
  ['runtime.state.ui.dialog_opacity', {
    parameters: [], returns: 'float', effects: { reads: ['ui.dialog'], writes: [] },
  }],
  ['runtime.state.variables.exists', {
    parameters: ['str'], returns: 'bool', effects: { reads: ['variables'], writes: [] },
    compile: { predicate: { kind: 'binding', domain: 'variables', argument: 0, positiveMeans: 'exists' } },
  }],
  ['runtime.state.variables.names', {
    parameters: [], returns: { kind: 'list', value: 'str' }, effects: { reads: ['variables'], writes: [] },
  }],
]);

/** IDE-facing rules consume analysis facts; they are diagnostics, not TDS APIs. */
export const IDE_ANALYSIS_RULES = {
  runtimeStateBranchUnreachable: {
    code: 'unreachable-runtime-state-branch',
    severity: 'info' as const,
    message: 'This branch cannot run because the queried runtime state is already known here',
  },
  characterMoveRequiresPresence: {
    code: 'move-unshown-character',
    severity: 'warning' as const,
    domain: 'characters' as const,
    requiredFact: 'present' as const,
    guardApi: 'runtime.state.characters.exists',
    dynamicMessage: "dynamic character '{target}' is moved without proof that it is currently visible; guard it with {guard}(...)",
    missingMessage: "character '{target}' is moved before it is statically shown",
  },
  characterPresenceCallRequiresProof: {
    code: 'unproven-character-presence-at-call',
    severity: 'warning' as const,
    guardApi: 'runtime.state.characters.exists',
    message: "function '{function}' may move character '{target}', but its presence is not proven here; guard the call with {guard}(...) or show the character first",
  },
};

export function runtimeStateApi(name: string): RuntimeStateApiDefinition | undefined {
  return RUNTIME_STATE_APIS.get(name);
}

export function isRuntimeStateApi(name: string): boolean {
  return runtimeStateApi(name) !== undefined;
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
