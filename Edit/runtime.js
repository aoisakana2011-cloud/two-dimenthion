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
  class Runtime {
    constructor(host = {}) { this.host = host; this.globals = Object.create(null); this.frames = [this.globals]; this.loopFrames = new WeakSet(); this.readonlyFrames = new WeakMap(); this.functions = new Map(); this.program = null; }
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
          await this.host.command(c.name, args, this);
        } else if (c.op === 'sayBlock') {
          const speaker = await this.value(c.speaker);
          if (!this.host.command) throw Error('命令の実行先がありません');
          for (const line of c.lines) await this.host.command('say', [speaker, await this.value(line)], this);
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
          const labels = []; for (const o of c.options) labels.push(this.text(await this.value(o.label)));
          const index = await this.host.choice(c.prompt ? this.text(await this.value(c.prompt)) : '', labels);
          if (!Number.isInteger(index) || !c.options[index]) throw Error('不正な選択肢です');
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
      for (;;) {
        if (p.version !== 2) throw Error('未対応のプログラムバージョンです');
        this.program = p;
        this.functions = new Map(p.functions.map(f => [f.name, f]));
        await this.host.program?.(p);
        let result = await this.exec(p.globals, transferred);
        const scenes = new Map(p.scenes.map(s => [s.name, s.instructions]));
        if (!result && p.scenes.length) result = await this.exec(p.scenes[0].instructions);
        while (result?.kind === 'goto' && scenes.has(result.scene)) result = await this.exec(scenes.get(result.scene));
        if (!result) return;
        if (result.kind !== 'goto' || !this.host.load) throw Error('不正なシーン遷移です');
        p = await this.host.load(result.scene);
        transferred = true;
      }
    }
  }
  function equal(a, b) {
    if (a === b) return true;
    return a && b && typeof a === 'object' && typeof b === 'object' && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b, k) && equal(a[k], b[k]));
  }
  if (typeof module !== 'undefined') module.exports = { Runtime, integer };
  else root.NovelRuntime = { Runtime, integer };
})(globalThis);
