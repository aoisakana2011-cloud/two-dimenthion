/** Pure intrinsics implemented with identical value semantics by both runtimes. */
export const PURE_BUILTIN_NAMES = new Set([
  'str', 'int', 'float',
  '__intrinsic_sin', '__intrinsic_cos',
  'list.length', 'list.append', 'list.contains', 'list.remove_all',
  'text.trim', 'text.normalize_space', 'text.split', 'text.replace', 'text.join',
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
    message: '参照した runtime state はこの場所ですでに確定しているため、この分岐には到達しません',
  },
  characterMoveRequiresPresence: {
    code: 'move-unshown-character',
    severity: 'warning' as const,
    domain: 'characters' as const,
    requiredFact: 'present' as const,
    guardApi: 'runtime.state.characters.exists',
    dynamicMessage: "character '{target}' が現在表示されていると確認できないため、移動できません。{guard}(...) で条件分岐してください",
    missingMessage: "character '{target}' は表示される前に移動されます",
  },
  characterPresenceCallRequiresProof: {
    code: 'unproven-character-presence-at-call',
    severity: 'warning' as const,
    guardApi: 'runtime.state.characters.exists',
    message: "関数 '{function}' は character '{target}' を移動する可能性がありますが、ここでは表示済みと確認できません。{guard}(...) で呼び出しを条件分岐するか、先に character を表示してください",
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
  return name === 'start' || isPureBuiltin(name) || isRuntimeStateApi(name);
}

/** Built-ins which cannot write scenario variables; runtime reads stay dynamic. */
export function isNonMutatingBuiltin(name: string): boolean {
  return name !== 'start' && isBuiltinFunction(name);
}

export function isPureBuiltin(name: string): boolean {
  return PURE_BUILTIN_NAMES.has(name);
}
