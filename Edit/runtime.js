(function (root) {
  'use strict';
  const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  function copy(value) {
    if (!value || typeof value !== 'object') return value;
    const result = Object.create(null);
    for (const key of Object.keys(value)) result[key] = copy(value[key]);
    return result;
  }
  function serialized(value) {
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === null) return 'null';
    if (value && typeof value === 'object') return `{${Object.keys(value).map(key => `${JSON.stringify(key)}:${serialized(value[key])}`).join(',')}}`;
    return String(value);
  }
  function integer(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('不正確な整数です');
    if (typeof value === 'string' && !/^[+-]?\d+$/.test(value)) throw Error('int への変換に失敗しました');
    const n = BigInt(value);
    if (n < MIN || n > MAX) throw Error('64bit 整数オーバーフローが発生しました');
    return n;
  }
  function matches(value, type) {
    if (type === 'int') return typeof value === 'bigint';
    if (type === 'str') return typeof value === 'string';
    if (type && type.kind === 'struct') return value && typeof value === 'object';
    return value && typeof value === 'object' && typeof type === 'object' && Object.values(value).every(v => matches(v, type.value));
  }
  const DEFAULT_SLOTS = ['far_left', 'left', 'center', 'right', 'far_right'];
  const MAX_TIME_MS = 2147483647;
  function createSceneState() {
    return {
      revision: 0,
      logicalTimeMs: 0,
      background: null,
      characters: Object.create(null),
      slots: Object.fromEntries(DEFAULT_SLOTS.map(slot => [slot, null])),
      images: Object.create(null),
      audio: { bgm: null, se: [], voices: [] },
      effects: [],
      choices: [],
      transfers: [],
      actions: Object.create(null),
      diagnostics: []
    };
  }
  function transitionWith(type, rawDuration) {
    const duration = rawDuration === undefined ? 500n : integer(rawDuration);
    if (duration < 0n || duration > BigInt(MAX_TIME_MS)) throw Error('Invalid transition duration');
    return { type, durationMs: Number(duration) };
  }
  function transitionFrom(args, offset = 0) {
    if (args[offset] === 'fade' || args[offset] === 'crossfade') {
      const duration = args[offset + 1] === undefined ? 500n : integer(args[offset + 1]);
      if (duration < 0n) throw Error('演出時間は0以上でなければなりません');
      return transitionWith(args[offset], duration);
    }
    if (args[offset] === undefined) return { type: 'instant', durationMs: 0 };
    throw Error(`Unknown transition '${args[offset]}'`);
  }
  function beginTransition(state, transition) {
    const startedAt = state.logicalTimeMs;
    const durationMs = transition.durationMs;
    return { ...transition, startedAt, endsAt: startedAt + durationMs, progress: durationMs ? 0 : 1, status: durationMs ? 'running' : 'complete' };
  }
  function updateTransition(transition, now) {
    if (!transition || typeof transition !== 'object' || typeof transition.durationMs !== 'number') return;
    const duration = transition.durationMs;
    const progress = duration ? Math.max(0, Math.min(1, (now - transition.startedAt) / duration)) : 1;
    transition.progress = progress;
    transition.status = progress >= 1 ? 'complete' : 'running';
  }
  function advanceSceneTime(state, elapsedMs) {
    const elapsed = Number(elapsedMs);
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > MAX_TIME_MS) throw Error('Invalid scene time advance');
    state.logicalTimeMs += elapsed;
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(visit);
      updateTransition(value.transition, state.logicalTimeMs);
      Object.values(value).forEach(child => { if (child && typeof child === 'object' && child !== value.transition) visit(child); });
    };
    visit(state.background); visit(state.characters); visit(state.images); visit(state.audio); visit(state.effects);
    return state;
  }
  function registerAction(state, action) {
    state.actions[action.id] = { ...action, status: action.status || 'running' };
    return action.id;
  }
  function finishAction(state, id) {
    const action = id && state.actions[id];
    if (!action) return;
    action.status = 'complete';
    action.endedAt = state.logicalTimeMs;
  }
  function stopAction(state, id, reason = 'stopped', metadata = {}) {
    const action = id && state.actions[id];
    if (!action || action.status !== 'running') return;
    action.status = 'stopped';
    action.reason = reason;
    Object.assign(action, metadata);
    action.endedAt = state.logicalTimeMs;
  }
  function normalizeSlot(slot) {
    if (!DEFAULT_SLOTS.includes(slot)) throw Error(`未知の配置場所 '${slot}' です`);
    return slot;
  }
  function sceneStateCommand(state, name, args) {
    const op = { name, args: copy(args) };
    if (name === 'bg') {
      const replacedAsset = state.background?.asset;
      if (replacedAsset) op.replacedAsset = replacedAsset;
      state.background = { asset: args[0], transition: beginTransition(state, { type: 'instant', durationMs: 0 }) };
    }
    else if (name === 'bgm') {
      const actionId = `bgm:${++state.revision}`;
      const replacedActionId = state.audio.bgm?.actionId;
      stopAction(state, replacedActionId, 'replaced', { replacedBy: actionId });
      op.actionId = actionId;
      if (replacedActionId) op.replacedActionId = replacedActionId;
      state.audio.bgm = { asset: args[0], transition: beginTransition(state, transitionFrom(args, 1)), actionId };
      registerAction(state, { id: actionId, kind: 'bgm', asset: args[0], startedAt: state.logicalTimeMs, blocking: false });
    } else if (name === 'play' && args[0] === 'bgm') {
      const actionId = `bgm:${++state.revision}`;
      const replacedActionId = state.audio.bgm?.actionId;
      stopAction(state, replacedActionId, 'replaced', { replacedBy: actionId });
      op.actionId = actionId;
      if (replacedActionId) op.replacedActionId = replacedActionId;
      state.audio.bgm = { asset: args[1], transition: beginTransition(state, transitionFrom(args, 2)), actionId };
      registerAction(state, { id: actionId, kind: 'bgm', asset: args[1], startedAt: state.logicalTimeMs, blocking: false });
    } else if (name === 'play' && args[0] === 'se') {
      const actionId = `se:${++state.revision}`;
      op.actionId = actionId;
      state.audio.se.push({ actionId, asset: args[1], startedAt: state.logicalTimeMs, transition: beginTransition(state, { type: 'instant', durationMs: 0 }) });
      registerAction(state, { id: actionId, kind: 'se', asset: args[1], startedAt: state.logicalTimeMs, blocking: false });
    } else if (name === 'play' && args[0] === 'voice') {
      const actionId = `voice:${++state.revision}`;
      const blocking = args[2] === 'blocking';
      op.actionId = actionId;
      op.blocking = blocking;
      state.audio.voices.push({ actionId, asset: args[1], startedAt: state.logicalTimeMs, transition: beginTransition(state, { type: 'instant', durationMs: 0 }) });
      registerAction(state, { id: actionId, kind: 'voice', asset: args[1], startedAt: state.logicalTimeMs, blocking });
    } else if (name === 'play' && args[0] === 'video') {
      const actionId = `video:${++state.revision}`;
      const blocking = args[2] === 'blocking';
      op.actionId = actionId;
      op.blocking = blocking;
      registerAction(state, { id: actionId, kind: 'video', asset: args[1], startedAt: state.logicalTimeMs, blocking });
    }
    else if (name === 'clear' && args[0] === 'bg') {
      if (state.background?.asset) op.clearedAsset = state.background.asset;
      state.background = null;
    }
    else if (name === 'clear' && args[0] === 'bgm') {
      const clearedActionId = state.audio.bgm?.actionId;
      if (clearedActionId) op.actionId = clearedActionId;
      stopAction(state, clearedActionId, 'cleared');
      state.audio.bgm = null;
    }
    else if (name === 'clear' && args[0] === 'image') delete state.images[args[1]];
    else if (name === 'show') {
      if (args[0] === 'image') {
        state.images[args[1]] = { asset: args[1], slot: normalizeSlot(args[2]), transition: beginTransition(state, transitionFrom(args, 3)) };
      } else {
        const match = /^([^\.]+)\.([^\.]+)$/.exec(args[0] || '');
        if (match) {
          const slot = normalizeSlot(args[1]);
          const previous = state.slots[slot];
          if (previous && previous !== match[1]) {
            state.characters[previous].visible = false;
            state.diagnostics.push({ level: 'info', code: 'slot-replaced', slot, previous, next: match[1] });
          }
          const old = state.characters[match[1]];
          if (old && old.slot !== slot && state.slots[old.slot] === match[1]) state.slots[old.slot] = null;
          state.slots[slot] = match[1];
          const transition = transitionFrom(args, 2);
          const actionId = transition.type === 'instant' ? undefined : `show:${++state.revision}`;
          if (actionId) {
            op.actionId = actionId;
            op.blocking = true;
            registerAction(state, { id: actionId, kind: 'show', target: match[1], slot, durationMs: transition.durationMs, startedAt: state.logicalTimeMs, blocking: true });
          }
          state.characters[match[1]] = { id: match[1], pose: match[2], slot, visible: true, opacity: 1, zIndex: 0, transition: beginTransition(state, transition), ...(actionId ? { actionId } : {}) };
        }
      }
    } else if (name === 'hide') {
      const current = state.characters[args[0]];
      if (current) {
        const transition = transitionFrom(args, 1);
        if (transition.type === 'instant') {
          current.visible = false;
          if (state.slots[current.slot] === args[0]) state.slots[current.slot] = null;
        } else {
          const actionId = `hide:${++state.revision}`;
          op.actionId = actionId;
          op.blocking = true;
          current.actionId = actionId;
          current.transition = beginTransition(state, transition);
          current.pendingVisibility = false;
          registerAction(state, { id: actionId, kind: 'hide', target: args[0], slot: current.slot, durationMs: transition.durationMs, startedAt: state.logicalTimeMs, blocking: true });
        }
      }
    } else if (name === 'effect' && args[0] === 'fade') {
      const actionId = `effect:${++state.revision}`;
      const transition = transitionWith('fade', args[2]);
      op.actionId = actionId;
      op.blocking = true;
      state.effects.push({ id: actionId, actionId, type: 'fade', color: args[1], transition: beginTransition(state, transition) });
      registerAction(state, { id: actionId, kind: 'effect', color: args[1], durationMs: transition.durationMs, startedAt: state.logicalTimeMs, blocking: true });
    }
    state.revision++;
    return op;
  }
  class Runtime {
    constructor(host = {}) { this.host = host; this.globals = Object.create(null); this.frames = [this.globals]; this.loopFrames = new WeakSet(); this.readonlyFrames = new WeakMap(); this.functions = new Map(); this.program = null; this.sceneState = createSceneState(); }
    completeAction(id) {
      if (!id || !this.sceneState.actions[id] || this.sceneState.actions[id].status !== 'running') return;
      finishAction(this.sceneState, id);
      this.sceneState.revision++;
      const event = { name: 'action:end', args: [], actionId: id };
      Promise.resolve(this.host.sceneState?.(this.sceneState, event, this)).catch(() => {});
    }
    stopAction(id, reason = 'stopped') {
      if (!id || !this.sceneState.actions[id] || this.sceneState.actions[id].status !== 'running') return;
      stopAction(this.sceneState, id, reason);
      this.sceneState.revision++;
      const event = { name: 'action:stop', args: [], actionId: id, reason };
      Promise.resolve(this.host.sceneState?.(this.sceneState, event, this)).catch(() => {});
    }
    get(name) {
      for (let i = this.frames.length - 1; i >= 0; --i) if (own(this.frames[i], name)) return this.frames[i][name];
      throw Error(`未定義の変数 '${name}' です`);
    }
    set(name, value) {
      for (let i = this.frames.length - 1; i >= 0; --i) if (own(this.frames[i], name)) { if (this.readonlyFrames.get(this.frames[i])?.has(name)) throw Error(`const 変数 '${name}' は変更できません`); this.frames[i][name] = value; return; }
      throw Error(`未定義の変数 '${name}' です`);
    }
    assertMutable(target) {
      const name = target?.kind === 'load' ? target.name : target?.kind === 'index' && target.target?.kind === 'load' ? target.target.name : null;
      if (!name) return;
      for (let i = this.frames.length - 1; i >= 0; --i) if (own(this.frames[i], name)) {
        if (this.readonlyFrames.get(this.frames[i])?.has(name)) throw Error(`const 変数 '${name}' は変更できません`);
        return;
      }
    }
    text(value) {
      const source = value === null || value === undefined ? '' : typeof value === 'object' ? serialized(value) : String(value);
      return source.replace(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g, (_, path) => {
        const [name, ...fields] = path.split('.');
        let replacement = this.get(name);
        for (const field of fields) {
          if (!replacement || typeof replacement !== 'object' || !own(replacement, field)) throw Error(`存在しないフィールド '${path}' です`);
          replacement = replacement[field];
        }
        return replacement && typeof replacement === 'object' ? serialized(replacement) : String(replacement ?? '');
      });
    }
    async textAsync(value) {
      const source = this.text(value);
      const matches = [...source.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\(\)\}/g)];
      if (!matches.length) return source;
      let result = '', cursor = 0;
      for (const match of matches) {
        result += source.slice(cursor, match.index);
        result += String((await this.call(match[1], [])) ?? '');
        cursor = match.index + match[0].length;
      }
      return result + source.slice(cursor);
    }
    async value(x) {
      if (!x) return null;
      if (x.kind === 'integer') return integer(x.value);
      if (x.kind === 'literal') return typeof x.value === 'string' ? x.value : integer(x.value);
      if (x.kind === 'load') return copy(this.get(x.name));
      if (x.kind === 'dict') {
        const d = Object.create(null);
        for (const e of x.entries) d[e.key] = await this.value(e.value);
        return d;
      }
      if (x.kind === 'index') {
        const target = await this.value(x.target), key = await this.value(x.key);
        if (!target || typeof target !== 'object' || !own(target, key)) throw Error(`存在しない辞書キー '${key}' です`);
        return target[key];
      }
      if (x.kind === 'unary') {
        // The magnitude of INT64_MIN is allowed only as the operand of unary minus.
        if (x.operator === '-' && x.value.kind === 'integer') return integer(-BigInt(x.value.value));
        const v = await this.value(x.value);
        return x.operator === 'not' ? !v : integer(x.operator === '-' ? -v : v);
      }
      if (x.kind === 'binary') {
        const a = await this.value(x.left);
        if (x.operator === 'and') return a && await this.value(x.right);
        if (x.operator === 'or') return a || await this.value(x.right);
        const b = await this.value(x.right);
        switch (x.operator) {
          case '+': return typeof a === 'string' && typeof b === 'string' ? a + b : integer(a + b);
          case '-': return integer(a - b);
          case '*': return integer(a * b);
          case '/': if (b === 0n) throw Error('0 で除算することはできません'); return integer(a / b);
          case '%': if (b === 0n) throw Error('0 による剰余算はできません'); return integer(a % b);
          case '==': return equal(a, b);
          case '!=': return !equal(a, b);
          case '>': return a > b;
          case '>=': return a >= b;
          case '<': return a < b;
          case '<=': return a <= b;
        }
      }
      if (x.kind === 'call') {
        const args = []; for (const a of x.args) args.push(await this.value(a));
        if (x.name === 'str') return String(args[0]);
        if (x.name === 'int') return integer(args[0]);
        return this.call(x.name, args);
      }
      throw Error(`未知の式 '${x.kind}' です`);
    }
    async call(name, args) {
      const fn = this.functions.get(name);
      if (!fn) throw Error(`未定義の関数 '${name}' です`);
      const saved = this.frames, local = Object.create(null);
      fn.params.forEach((p, i) => { local[p.name] = args[i]; });
      this.frames = [this.globals, local];
      try {
        const result = await this.exec(fn.body);
        if (fn.returnType !== 'none' && (!result || result.kind !== 'return' || result.value === null)) throw Error(`関数 '${name}' が値を返しませんでした`);
        return result?.value ?? null;
      } finally { this.frames = saved; }
    }
    async exec(list, preserveGlobals = false) {
      for (const c of list) {
        if (c.op === 'declare') {
          const frame = this.frames.findLast(f => !this.loopFrames.has(f));
          if (preserveGlobals && frame === this.globals && own(frame, c.name)) {
            if (!matches(frame[c.name], c.type)) throw Error(`ファイル間で変数 '${c.name}' の型が一致しません`);
          } else frame[c.name] = c.initial ? await this.value(c.initial) : c.type === 'int' ? 0n : c.type === 'str' ? '' : Object.create(null);
          if (c.constant) { const names = this.readonlyFrames.get(frame) || new Set(); names.add(c.name); this.readonlyFrames.set(frame, names); }
        } else if (c.op === 'set') {
          const val = await this.value(c.value);
          this.assertMutable(c.target);
          if (c.target.kind === 'load') this.set(c.target.name, val);
          else { const key = await this.value(c.target.key); const d = copy(this.get(c.target.target.name)); d[key] = val; this.set(c.target.target.name, d); }
        } else if (c.op === 'unset') {
          if (c.target.kind === 'load') throw Error('unset は辞書要素を指定してください');
          this.assertMutable(c.target);
          const k = await this.value(c.target.key), d = copy(this.get(c.target.target.name));
          if (!own(d, k)) throw Error(`存在しない辞書キー '${k}' です`);
          delete d[k];
          this.set(c.target.target.name, d);
        } else if (c.op === 'command') {
          const args = []; for (const a of c.args) args.push(await this.value(a));
          if (!this.host.command) throw Error(`命令 '${c.name}' の実行先がありません`);
          const operation = sceneStateCommand(this.sceneState, c.name, args);
          await this.host.command(c.name, args, this, operation);
          if (c.name === 'wait') advanceSceneTime(this.sceneState, args[0]);
          else if (c.name === 'effect') advanceSceneTime(this.sceneState, operation.args[2] === undefined ? 500 : operation.args[2]);
          else if (c.name === 'show' && operation.args[0] !== 'image' && operation.args[2] === 'fade') advanceSceneTime(this.sceneState, operation.args[3]);
          else if (c.name === 'hide' && operation.args[1] === 'fade') advanceSceneTime(this.sceneState, operation.args[2]);
          if (operation.blocking) {
            finishAction(this.sceneState, operation.actionId);
            if (c.name === 'hide' && args[1] === 'fade') {
              const character = this.sceneState.characters[args[0]];
              if (character) {
                character.visible = false;
                if (this.sceneState.slots[character.slot] === args[0]) this.sceneState.slots[character.slot] = null;
                delete character.pendingVisibility;
              }
            }
          }
          await this.host.sceneState?.(this.sceneState, operation, this);
        } else if (c.op === 'call') {
          await this.value({ kind: 'call', name: c.name, args: c.args });
        } else if (c.op === 'return') return { kind: 'return', value: c.value ? await this.value(c.value) : null };
        else if (c.op === 'goto') return { kind: 'goto', scene: c.scene };
        else if (c.op === 'if') {
          let body = c.otherwise;
          if (await this.value(c.condition)) body = c.body;
          else for (const b of c.elseIf) if (await this.value(b.condition)) { body = b.body; break; }
          const result = await this.exec(body); if (result) return result;
        } else if (c.op === 'choice') {
          if (!c.options.length) throw Error('選択肢がありません');
          const labels = []; for (const o of c.options) labels.push(await this.textAsync(await this.value(o.label)));
          const prompt = c.prompt ? await this.textAsync(await this.value(c.prompt)) : '';
          const index = await this.host.choice(prompt, labels);
          if (!Number.isInteger(index) || !c.options[index]) throw Error('不正な選択肢です');
          const choice = { prompt, labels: labels.slice(), selectedIndex: index, selectedLabel: labels[index], at: this.sceneState.logicalTimeMs };
          this.sceneState.choices.push(choice);
          this.sceneState.revision++;
          await this.host.sceneState?.(this.sceneState, { name: 'choice', ...choice }, this);
          this.frames.push(Object.create(null));
          try { const result = await this.exec(c.options[index].body); if (result) return result; }
          finally { this.frames.pop(); }
        } else if (c.op === 'for') {
          const start = await this.value(c.start), stop = await this.value(c.stop), step = await this.value(c.step);
          if (step === 0n || (start < stop && step < 0n) || (start > stop && step > 0n)) throw Error('for ループの step が不正です');
          const loopFrame = Object.create(null); this.loopFrames.add(loopFrame); this.frames.push(loopFrame);
          try {
            let count = 0;
            for (let i = start; step > 0n ? i <= stop : i >= stop; i += step) {
              if (++count > 100000) throw Error('ループの最大反復回数を超過しました');
              this.frames[this.frames.length - 1][c.name] = integer(i);
              const result = await this.exec(c.body); if (result) return result;
            }
          } finally { this.frames.pop(); }
        } else if (c.op === 'while') {
          let count = 0;
          while (await this.value(c.condition)) {
            if (++count > 100000) throw Error('ループの最大反復回数を超過しました');
            const result = await this.exec(c.body); if (result) return result;
          }
        } else throw Error(`未知の命令 '${c.op}' です`);
      }
      return null;
    }
    async run(p) {
      let transferred = false;
      this.sceneState = createSceneState();
      const recordTransfer = async (target, external) => {
        const transfer = { target, external, at: this.sceneState.logicalTimeMs };
        this.sceneState.transfers.push(transfer);
        this.sceneState.revision++;
        await this.host.sceneState?.(this.sceneState, { name: 'goto', ...transfer }, this);
      };
      for (;;) {
        if (p.version !== 2) throw Error('未対応のプログラムバージョンです');
        this.program = p;
        this.functions = new Map(p.functions.map(f => [f.name, f]));
        await this.host.program?.(p, this.sceneState);
        let result = await this.exec(p.globals, transferred);
        const scenes = new Map(p.scenes.map(s => [s.name, s.instructions]));
        if (!result && p.scenes.length) result = await this.exec(p.scenes[0].instructions);
        while (result?.kind === 'goto' && scenes.has(result.scene)) {
          await recordTransfer(result.scene, false);
          result = await this.exec(scenes.get(result.scene));
        }
        if (!result) return;
        if (result.kind !== 'goto' || !this.host.load) throw Error('不正なシーン遷移です');
        await recordTransfer(result.scene, true);
        p = await this.host.load(result.scene);
        transferred = true;
      }
    }
  }
  function equal(a, b) {
    if (a === b) return true;
    return a && b && typeof a === 'object' && typeof b === 'object' && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b, k) && equal(a[k], b[k]));
  }
  if (typeof module !== 'undefined') module.exports = { Runtime, integer, createSceneState, sceneStateCommand, advanceSceneTime };
  else root.NovelRuntime = { Runtime, integer, createSceneState, sceneStateCommand, advanceSceneTime };
})(globalThis);
