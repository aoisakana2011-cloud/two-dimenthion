(function (root) {
  'use strict';
  const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  function copy(value) {
    if (!value || typeof value !== 'object') return value;
    const result = Array.isArray(value) ? [] : Object.create(null);
    for (const key of Object.keys(value)) result[key] = copy(value[key]);
    return result;
  }
  function cloneSceneValue(value) {
    if (!value || typeof value !== 'object') return value;
    const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    for (const key of Object.keys(value)) result[key] = cloneSceneValue(value[key]);
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
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < Number(MIN) || value >= Number(MAX) + 1) throw Error('64bit 整数の範囲外です');
      value = Math.trunc(value);
    }
    if (typeof value === 'string' && !/^[+-]?\d+$/.test(value)) throw Error('int への変換に失敗しました');
    const n = BigInt(value);
    if (n < MIN || n > MAX) throw Error('64bit 整数オーバーフローが発生しました');
    return n;
  }
  function floating(value) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') throw Error('float への変換に失敗しました');
    if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw Error('float への変換に失敗しました');
    const result = Number(value);
    if (!Number.isFinite(result)) throw Error('float は有限値でなければなりません');
    return Object.is(result, -0) ? 0 : result;
  }
  function matches(value, type) {
    if (type === 'int') return typeof value === 'bigint';
    if (type === 'float') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'str') return typeof value === 'string';
    if (type === 'bool') return typeof value === 'boolean';
    if (type && type.kind === 'struct') return value && typeof value === 'object' && !Array.isArray(value);
    if (type && type.kind === 'list') return Array.isArray(value) && value.every(v => matches(v, type.value));
    return value && typeof value === 'object' && !Array.isArray(value) && typeof type === 'object' && type.kind === 'dict' && Object.values(value).every(v => matches(v, type.value));
  }
  function trimDataSpace(value) { return value.replace(/^[ \t\n\r\f\v\u00a0\u3000]+|[ \t\n\r\f\v\u00a0\u3000]+$/gu, ''); }
  function normalizeDataSpace(value) { return trimDataSpace(value.replace(/[ \t\n\r\f\v\u00a0\u3000]+/gu, ' ')); }
  function splitText(value, separator) {
    if (!separator.length) throw Error('text.split separator must not be empty');
    return value.split(separator);
  }
  function replaceText(value, search, replacement) {
    if (!search.length) throw Error('text.replace search must not be empty');
    return value.split(search).join(replacement);
  }
  const DEFAULT_SLOTS = ['far_left', 'left', 'center', 'right', 'far_right'];
  const MAX_TIME_MS = 2147483647;
  function createSceneState() {
    return {
      revision: 0,
      logicalTimeMs: 0,
      nextVisualOrder: 0,
      background: null,
      characters: Object.create(null),
      slots: Object.fromEntries(DEFAULT_SLOTS.map(slot => [slot, null])),
      images: Object.create(null),
      video: null,
      audio: { bgm: null, se: [], voices: [], volumes: { bgm: 1, se: 1, voice: 0.5 }, volumeOverrides: {} },
      ui: { dialogOpacity: 1 },
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
  function characterShowOptions(args, start = 2) {
    const offsets = { x: 0, y: 0 };
    const axes = new Set();
    let index = start;
    while (typeof args[index] === 'string') {
      const match = /^([xy])([+-])(\d+)?$/.exec(args[index]);
      if (!match) break;
      if (axes.has(match[1])) throw Error(`show の位置ずらしは ${match[1]} を一度だけ指定できます`);
      const raw = match[3] === undefined ? args[++index] : match[3];
      const amount = typeof raw === 'bigint' ? Number(raw) : Number(raw);
      if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000) throw Error('show の位置ずらしは ±1000000 px 以内で指定してください');
      axes.add(match[1]);
      offsets[match[1]] = match[2] === '+' ? amount : -amount;
      index++;
    }
    return { ...offsets, transitionIndex: index };
  }
  function moveOptions(args) {
    const targetKind = args[0];
    const target = targetKind === 'character' ? args[1] : 'bg';
    const byIndex = targetKind === 'character' ? 2 : 1;
    const start = byIndex + 1;
    if (args[byIndex] !== 'by') throw Error('move requires by before pixel offsets');
    const delta = { x: 0, y: 0 };
    const axes = new Set();
    let index = start;
    for (; index < args.length; index++) {
      const match = /^([xy])([+-])(\d+)?$/.exec(args[index] || '');
      if (!match) break;
      if (axes.has(match[1])) throw Error(`move の ${match[1]} は一度だけ指定できます`);
      const raw = match[3] === undefined ? args[++index] : match[3];
      const amount = Number(raw);
      if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000) throw Error('move の移動量は±1000000 px 以内にしてください');
      axes.add(match[1]);
      delta[match[1]] = match[2] === '+' ? amount : -amount;
    }
    if (!axes.size) throw Error('move requires at least one pixel offset');
    let durationMs = 0;
    if (index < args.length) {
      if (index + 2 !== args.length || args[index] !== 'over') throw Error('move duration must use over <ms>');
      const duration = integer(args[index + 1]);
      if (duration < 0n || duration > BigInt(MAX_TIME_MS)) throw Error('Invalid move duration');
      durationMs = Number(duration);
    }
    return { targetKind, target, delta, durationMs };
  }
  function beginTransition(state, transition, id) {
    const startedAt = state.logicalTimeMs;
    const durationMs = transition.durationMs;
    return { ...transition, ...(id ? { id } : {}), startedAt, endsAt: startedAt + durationMs, progress: durationMs ? 0 : 1, status: durationMs ? 'running' : 'complete' };
  }
  function updateTransition(transition, now) {
    if (!transition || typeof transition !== 'object' || typeof transition.durationMs !== 'number'
      || transition.status === 'complete' || transition.clock === 'audio') return;
    const duration = transition.durationMs;
    const progress = duration ? Math.max(0, Math.min(1, (now - transition.startedAt) / duration)) : 1;
    transition.progress = progress;
    transition.status = progress >= 1 ? 'complete' : 'running';
  }
  function sampleTransition(item, transition) {
    const interpolation = transition?.interpolation;
    if (!interpolation) return;
    if (interpolation.property === 'opacity') {
      item.opacity = interpolation.from + (interpolation.to - interpolation.from) * transition.progress;
    } else if (interpolation.property === 'offset') {
      item.offsetX = interpolation.from.x + (interpolation.to.x - interpolation.from.x) * transition.progress;
      item.offsetY = interpolation.from.y + (interpolation.to.y - interpolation.from.y) * transition.progress;
    } else if (interpolation.property === 'gain') {
      item.gain = interpolation.from + (interpolation.to - interpolation.from) * transition.progress;
    }
  }
  function transitionOwners(state, id) {
    const owners = [];
    const visit = item => {
      if (!item || typeof item !== 'object') return;
      if (Array.isArray(item)) return item.forEach(visit);
      if (item.transition?.id === id) owners.push(item);
      for (const [key, child] of Object.entries(item)) if (key !== 'transition') visit(child);
    };
    [state.background, state.characters, state.images, state.audio, state.effects].forEach(visit);
    return owners;
  }
  function startBgmState(state, asset, transition, actionId, targetGain = 1) {
    const duration = transition.durationMs;
    const crossfading = transition.type === 'crossfade' && duration > 0;
    const current = state.audio.bgm;
    const previousLayers = current?.layers || (current ? [{ asset: current.asset, actionId: current.actionId, gain: current.gain ?? 1, role: 'active' }] : []);
    const bgmTransition = beginTransition(state, transition, actionId);
    // BGM automation is measured by the audio playback clock (WebAudio/SDL mixer),
    // not by deterministic script time. A suspended audio device must not
    // make the canonical scene state claim that its audible fade advanced.
    bgmTransition.clock = 'audio';
    const layers = crossfading ? previousLayers.map(layer => ({
      asset: layer.asset, actionId: layer.actionId, gain: layer.gain ?? 1, role: 'outgoing',
      transition: { ...bgmTransition, interpolation: { property: 'gain', from: layer.gain ?? 1, to: 0 } },
    })) : [];
    const incoming = {
      asset, actionId, gain: crossfading ? 0 : targetGain, role: crossfading ? 'incoming' : 'active',
      transition: { ...bgmTransition, interpolation: { property: 'gain', from: crossfading ? 0 : targetGain, to: targetGain } },
    };
    layers.push(incoming);
    bgmTransition.interpolation = { property: 'gain', from: incoming.gain, to: targetGain };
    state.audio.bgm = { asset, gain: incoming.gain, transition: bgmTransition, actionId, layers };
  }
  function pruneBgmLayers(state, id) {
    const bgm = state.audio.bgm;
    if (!bgm || bgm.transition?.id !== id || bgm.transition.status !== 'complete' || !Array.isArray(bgm.layers)) return;
    bgm.layers = bgm.layers.filter(layer => layer.role === 'incoming');
    for (const layer of bgm.layers) { layer.gain = 1; layer.role = 'active'; }
  }
  function removeBgmLayer(state, actionId) {
    const bgm = state.audio.bgm;
    if (!bgm || !Array.isArray(bgm.layers)) return false;
    const remaining = bgm.layers.filter(layer => layer.actionId !== actionId);
    if (remaining.length === bgm.layers.length) return false;
    bgm.layers = remaining;
    return true;
  }
  function advanceSceneTime(state, elapsedMs) {
    const elapsed = Number(elapsedMs);
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > MAX_TIME_MS) throw Error('Invalid scene time advance');
    state.logicalTimeMs += elapsed;
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(visit);
      updateTransition(value.transition, state.logicalTimeMs);
      sampleTransition(value, value.transition);
      if (value.transition?.id && state.actions[value.transition.id])
        state.actions[value.transition.id].progress = value.transition.progress;
      Object.values(value).forEach(child => { if (child && typeof child === 'object' && child !== value.transition) visit(child); });
    };
    visit(state.background); visit(state.characters); visit(state.images); visit(state.audio); visit(state.effects);
    const bgmTransitionId = state.audio.bgm?.transition?.id;
    if (bgmTransitionId) pruneBgmLayers(state, bgmTransitionId);
    return state;
  }
  function registerAction(state, action) {
    state.actions[action.id] = { ...action, status: action.status || 'running' };
    return action.id;
  }
  function retireActiveAudio(state, action) {
    if (action?.kind !== 'se' && action?.kind !== 'voice') return;
    const active = action.kind === 'se' ? state.audio.se : state.audio.voices;
    const index = active.findIndex(item => item.actionId === action.id);
    if (index >= 0) active.splice(index, 1);
  }
  function finishAction(state, id) {
    const action = id && state.actions[id];
    if (!action) return;
    action.status = 'complete';
    if (typeof action.durationMs === 'number') action.progress = 1;
    action.endedAt = state.logicalTimeMs;
    retireActiveAudio(state, action);
    if (state.video?.actionId === id) state.video = null;
  }
  function stopAction(state, id, reason = 'stopped', metadata = {}) {
    const action = id && state.actions[id];
    if (!action || action.status !== 'running') return;
    action.status = 'stopped';
    action.reason = reason;
    Object.assign(action, metadata);
    action.endedAt = state.logicalTimeMs;
    retireActiveAudio(state, action);
    if (state.video?.actionId === id) state.video = null;
  }
  function normalizeSlot(slot) {
    if (!DEFAULT_SLOTS.includes(slot)) throw Error(`未知の配置場所 '${slot}' です`);
    return slot;
  }
  function instructionsFromLine(instructions, file, line) {
    for (let index = 0; index < instructions.length; index++) {
      const instruction = instructions[index];
      if ((!file || !instruction.file || instruction.file === file) && Number(instruction.line) >= line) return instructions.slice(index);
      const bodies = instruction.op === 'if'
        ? [instruction.body, ...instruction.elseIf.map((branch) => branch.body), instruction.otherwise]
        : instruction.op === 'choice' ? instruction.options.map((option) => option.body)
          : instruction.op === 'for' || instruction.op === 'forEach' || instruction.op === 'while' ? [instruction.body] : [];
      for (const body of bodies) {
        const suffix = instructionsFromLine(body, file, line);
        if (suffix) {
          if (instruction.op === 'for' || instruction.op === 'forEach' || instruction.op === 'while') return [{ ...cloneSceneValue(instruction), debugBody: suffix }, ...instructions.slice(index + 1)];
          return [...suffix, ...instructions.slice(index + 1)];
        }
      }
    }
    return null;
  }
  function sceneStateCommand(state, name, args, program, defaults) {
    const op = { name, args: copy(args) };
    const boundedUnit = (value, label) => {
      const number = floating(value);
      if (number < 0 || number > 1) throw Error(`${label} must be between 0.0 and 1.0`);
      return number;
    };
    const playbackOptions = (kind, assetName, options) => {
      const definition = program?.assets?.find(item => item.type === kind && item.name === assetName);
      const gain = options.volume ?? state.audio.volumeOverrides[kind] ?? definition?.volume ?? state.audio.volumes[kind] ?? defaults?.audio?.[kind] ?? 1;
      return { gain: boundedUnit(gain, 'Audio volume'), mode: options.mode };
    };
    if (name === 'volume') {
      const volume = boundedUnit(args[1], 'Audio volume');
      state.audio.volumeOverrides[args[0]] = volume;
      op.volume = volume;
    } else if (name === 'dialog') {
      const opacity = boundedUnit(args[1], 'Dialog opacity');
      state.ui.dialogOpacity = opacity;
      op.dialogOpacity = opacity;
    } else if (name === 'say' && args.length === 4) {
      op.dialogOpacity = boundedUnit(args[3], 'Dialog opacity');
      op.dialogOpacityTemporary = true;
    }
    if (name === 'move') {
      const move = moveOptions(args);
      const current = move.targetKind === 'bg' ? state.background : state.characters[move.target];
      if (!current || (move.targetKind === 'character' && !current.visible)) throw Error(`move target '${move.target}' is not currently visible`);
      const fromX = current.offsetX || 0;
      const fromY = current.offsetY || 0;
      const toX = fromX + move.delta.x;
      const toY = fromY + move.delta.y;
      if (Math.abs(toX) > 1_000_000 || Math.abs(toY) > 1_000_000) throw Error('move target position exceeds ±1000000 px');
      const actionId = move.durationMs ? `move:${++state.revision}` : undefined;
      const transition = beginTransition(state, {
        type: 'move', durationMs: move.durationMs,
        ...(move.durationMs ? { interpolation: { property: 'offset', from: { x: fromX, y: fromY }, to: { x: toX, y: toY } } } : {}),
      }, actionId);
      Object.assign(current, { offsetX: move.durationMs ? fromX : toX, offsetY: move.durationMs ? fromY : toY, transition });
      sampleTransition(current, transition);
      op.move = { ...move, fromX, fromY, toX, toY };
      if (move.durationMs) {
        op.actionId = actionId;
        op.blocking = true;
        registerAction(state, { id: actionId, kind: 'move', targetKind: move.targetKind, target: move.target, durationMs: move.durationMs, startedAt: state.logicalTimeMs, blocking: true });
      }
    } else if (name === 'bg') {
      const replacedAsset = state.background?.asset;
      if (replacedAsset) op.replacedAsset = replacedAsset;
      state.background = { asset: args[0], transition: beginTransition(state, { type: 'instant', durationMs: 0 }) };
    }
    else if (name === 'bgm') {
      const actionId = `bgm:${++state.revision}`;
      const replacedActionId = state.audio.bgm?.actionId;
      const transition = transitionFrom(args, 1);
      stopAction(state, replacedActionId, 'replaced', { replacedBy: actionId });
      op.actionId = actionId;
      op.transitionId = actionId;
      op.transition = transition;
      if (replacedActionId) op.replacedActionId = replacedActionId;
      const { gain } = playbackOptions('bgm', args[0], {});
      op.gain = gain;
      startBgmState(state, args[0], transition, actionId, gain);
      registerAction(state, { id: actionId, kind: 'bgm', asset: args[0], gain, startedAt: state.logicalTimeMs, blocking: false });
    } else if (name === 'play' && args[0] === 'bgm') {
      const actionId = `bgm:${++state.revision}`;
      const replacedActionId = state.audio.bgm?.actionId;
      const options = {};
      for (let index = 2; index < args.length;) {
        const option = args[index++];
        if (option === 'volume') options.volume = args[index++];
        else if (option === 'crossfade') options.transition = transitionWith('crossfade', args[index++]);
        else throw Error(`Unknown BGM option '${option}'`);
      }
      const transition = options.transition || transitionWith('instant', 0);
      const { gain } = playbackOptions('bgm', args[1], options);
      stopAction(state, replacedActionId, 'replaced', { replacedBy: actionId });
      op.actionId = actionId;
      op.transitionId = actionId;
      op.transition = transition;
      op.gain = gain;
      if (replacedActionId) op.replacedActionId = replacedActionId;
      startBgmState(state, args[1], transition, actionId, gain);
      registerAction(state, { id: actionId, kind: 'bgm', asset: args[1], gain, startedAt: state.logicalTimeMs, blocking: false });
    } else if (name === 'play' && args[0] === 'se') {
      const options = {};
      for (let index = 2; index < args.length;) { const option = args[index++]; if (option === 'volume') options.volume = args[index++]; else throw Error(`Unknown SE option '${option}'`); }
      const { gain } = playbackOptions('se', args[1], options);
      const actionId = `se:${++state.revision}`;
      op.actionId = actionId;
      op.gain = gain;
      state.audio.se.push({ actionId, asset: args[1], gain, startedAt: state.logicalTimeMs, transition: beginTransition(state, { type: 'instant', durationMs: 0 }) });
      registerAction(state, { id: actionId, kind: 'se', asset: args[1], gain, startedAt: state.logicalTimeMs, blocking: false });
    } else if (name === 'play' && args[0] === 'voice') {
      const options = {};
      for (let index = 2; index < args.length;) { const option = args[index++]; if (option === 'volume') options.volume = args[index++]; else if (option === 'blocking' || option === 'async') options.mode = option; else throw Error(`Unknown voice option '${option}'`); }
      const { gain, mode } = playbackOptions('voice', args[1], options);
      const actionId = `voice:${++state.revision}`;
      const blocking = mode === 'blocking';
      op.actionId = actionId;
      op.blocking = blocking;
      op.mode = mode || 'async';
      op.gain = gain;
      state.audio.voices.push({ actionId, asset: args[1], gain, startedAt: state.logicalTimeMs, transition: beginTransition(state, { type: 'instant', durationMs: 0 }) });
      registerAction(state, { id: actionId, kind: 'voice', asset: args[1], gain, startedAt: state.logicalTimeMs, blocking });
    } else if (name === 'play' && args[0] === 'video') {
      const actionId = `video:${++state.revision}`;
      const mode = args[2] === 'blocking' || args[2] === 'async' ? args[2] : args[4] === 'blocking' || args[4] === 'async' ? args[4] : 'async';
      const blocking = mode === 'blocking';
      op.mode = mode;
      if (state.video?.actionId) op.replacedActionId = state.video.actionId;
      op.actionId = actionId;
      op.blocking = blocking;
      state.video = { asset: args[1], actionId, startedAt: state.logicalTimeMs, blocking, status: 'running' };
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
        state.images[args[1]] = {
          asset: args[1], slot: normalizeSlot(args[2]), visualOrder: ++state.nextVisualOrder,
          transition: beginTransition(state, transitionFrom(args, 3)),
        };
      } else {
        const match = /^([^\.]+)\.([^\.]+)$/.exec(args[0] || '');
        if (match) {
          const showOptions = characterShowOptions(args);
          op.transitionIndex = showOptions.transitionIndex;
          const slot = normalizeSlot(args[1]);
          const previous = state.slots[slot];
          if (previous && previous !== match[1]) {
            state.characters[previous].visible = false;
            state.diagnostics.push({ level: 'info', code: 'slot-replaced', slot, previous, next: match[1] });
          }
          const old = state.characters[match[1]];
          if (old && old.slot !== slot && state.slots[old.slot] === match[1]) state.slots[old.slot] = null;
          state.slots[slot] = match[1];
          const transition = transitionFrom(args, showOptions.transitionIndex);
          const actionId = transition.type === 'instant' ? undefined : `show:${++state.revision}`;
          if (actionId) {
            op.actionId = actionId;
            op.blocking = true;
            registerAction(state, { id: actionId, kind: 'show', target: match[1], slot, durationMs: transition.durationMs, startedAt: state.logicalTimeMs, blocking: true });
          }
          const visualTransition = beginTransition(state, {
            ...transition,
            ...(transition.type === 'fade' ? { interpolation: { property: 'opacity', from: 0, to: 1 } } : {}),
          }, actionId);
          state.characters[match[1]] = {
            id: match[1], pose: match[2], slot, offsetX: showOptions.x, offsetY: showOptions.y,
            visible: true, opacity: transition.type === 'fade' ? 0 : 1, zIndex: 0,
            visualOrder: old?.visible ? old.visualOrder : ++state.nextVisualOrder,
            transition: visualTransition, ...(actionId ? { actionId } : {}),
          };
          sampleTransition(state.characters[match[1]], visualTransition);
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
          current.transition = beginTransition(state, {
            ...transition,
            interpolation: { property: 'opacity', from: current.opacity, to: 0 },
          }, actionId);
          sampleTransition(current, current.transition);
          current.pendingVisibility = false;
          registerAction(state, { id: actionId, kind: 'hide', target: args[0], slot: current.slot, durationMs: transition.durationMs, startedAt: state.logicalTimeMs, blocking: true });
        }
      }
    } else if (name === 'effect' && args[0] === 'fade') {
      const actionId = `effect:${++state.revision}`;
      const transition = { ...transitionWith('fade', args[2]), interpolation: { property: 'opacity', from: 1, to: 0 } };
      op.actionId = actionId;
      op.blocking = true;
      const effect = { id: actionId, actionId, type: 'fade', color: args[1], opacity: 1, transition: beginTransition(state, transition, actionId) };
      sampleTransition(effect, effect.transition);
      state.effects.push(effect);
      registerAction(state, { id: actionId, kind: 'effect', color: args[1], durationMs: transition.durationMs, startedAt: state.logicalTimeMs, blocking: true });
    }
    state.revision++;
    return op;
  }
  class Runtime {
    constructor(host = {}) { this.host = host; this.globals = Object.create(null); this.frames = [this.globals]; this.loopFrames = new WeakSet(); this.readonlyFrames = new WeakMap(); this.functions = new Map(); this.program = null; this.currentSceneName = ''; this.presentationDefaults = { audio: { bgm: 1, se: 1, voice: 0.5 }, dialog: { opacity: 1 } }; this.sceneState = createSceneState(); this.pendingSceneActionEvents = null; this.transitionProgressNotifications = new WeakMap(); }
    configurePresentationDefaults(theme = {}) {
      this.presentationDefaults = {
        audio: { bgm: 1, se: 1, voice: 0.5, ...(theme.audio || {}) },
        dialog: { opacity: 1, ...(theme.dialog || {}) },
      };
      for (const kind of ['bgm', 'se', 'voice']) {
        const value = Number(this.presentationDefaults.audio[kind]);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw Error(`Invalid ${kind} volume default`);
        this.presentationDefaults.audio[kind] = value;
      }
      const opacity = Number(this.presentationDefaults.dialog.opacity);
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw Error('Invalid dialog opacity default');
      this.presentationDefaults.dialog.opacity = opacity;
    }
    notifySceneState(event) {
      Promise.resolve(this.host.sceneState?.(this.sceneState, event, this)).catch(() => {});
    }
    applySceneActionEvent(event) {
      const action = event.id && this.sceneState.actions[event.id];
      const failedBgm = event.type === 'stop' && event.reason === 'failed' && action?.kind === 'bgm';
      if (!action || (action.status !== 'running' && !failedBgm)) return;
      const actionWasRunning = action.status === 'running';
      if (event.type === 'complete') finishAction(this.sceneState, event.id);
      else if (actionWasRunning) {
        stopAction(this.sceneState, event.id, event.reason);
      }
      const removedBgmLayer = failedBgm && removeBgmLayer(this.sceneState, event.id);
      if (failedBgm && this.sceneState.audio.bgm?.actionId === event.id) this.sceneState.audio.bgm = null;
      if (!actionWasRunning && !removedBgmLayer) return;
      this.sceneState.revision++;
      this.notifySceneState({
        name: !actionWasRunning ? 'audio:layer-end' : event.type === 'complete' ? 'action:end' : 'action:stop',
        args: [], actionId: event.id, ...(event.type === 'stop' ? { reason: event.reason } : {}),
      });
    }
    applySceneTransitionEvent(id) {
      const owners = transitionOwners(this.sceneState, id);
      const transition = owners[0]?.transition;
      if (!transition) return;
      const action = this.sceneState.actions[id];
      if (action) action.progress = 1;
      if (transition.status !== 'running') return;
      for (const owner of owners) {
        owner.transition.progress = 1;
        owner.transition.status = 'complete';
        sampleTransition(owner, owner.transition);
      }
      pruneBgmLayers(this.sceneState, id);
      this.sceneState.revision++;
      this.notifySceneState({ name: 'transition:end', args: [], transitionId: id });
    }
    reportTransitionProgress(id, progress) {
      const action = id && this.sceneState.actions[id];
      const value = Number(progress);
      if (!action || action.status !== 'running' || !Number.isFinite(value)) return false;
      const bounded = Math.max(0, Math.min(1, value));
      if (this.pendingSceneActionEvents) {
        // Progress is a latest-value signal, not a history stream. Keep only
        // the newest sample for this action while preserving its position
        // relative to completion/stop events in the transaction journal.
        let previous = null;
        for (let index = this.pendingSceneActionEvents.length - 1; index >= 0; index--) {
          const event = this.pendingSceneActionEvents[index];
          if (event.type === 'progress' && event.id === id) { previous = event; break; }
        }
        if (previous) previous.progress = bounded;
        else this.pendingSceneActionEvents.push({ type: 'progress', id, progress: bounded });
      }
      return this.applySceneTransitionProgress(id, bounded);
    }
    applySceneTransitionProgress(id, progress) {
      const action = id && this.sceneState.actions[id];
      if (!action || action.status !== 'running') return false;
      const owners = transitionOwners(this.sceneState, id);
      const transition = owners[0]?.transition;
      if (!transition || transition.status !== 'running') return false;
      const bounded = Math.max(0, Math.min(1, progress));
      action.progress = bounded;
      for (const owner of owners) {
        owner.transition.progress = bounded;
        sampleTransition(owner, owner.transition);
      }
      const lastReported = this.transitionProgressNotifications.get(action);
      if (bounded - (lastReported ?? -1) >= 0.01 || bounded === 1) {
        this.transitionProgressNotifications.set(action, bounded);
        this.sceneState.revision++;
        this.notifySceneState({ name: 'transition:progress', args: [], actionId: id, transitionId: id, progress: bounded });
      }
      return true;
    }
    flushSceneActionEvents(events) {
      for (const event of events) {
        if (event.type === 'transition') this.applySceneTransitionEvent(event.id);
        else if (event.type === 'progress') this.applySceneTransitionProgress(event.id, event.progress);
        else this.applySceneActionEvent(event);
      }
    }
    completeAction(id) {
      if (!id) return;
      if (this.pendingSceneActionEvents) {
        this.pendingSceneActionEvents.push({ type: 'complete', id });
      }
      this.applySceneActionEvent({ type: 'complete', id });
    }
    stopAction(id, reason = 'stopped') {
      if (!id) return;
      if (this.pendingSceneActionEvents) {
        this.pendingSceneActionEvents.push({ type: 'stop', id, reason });
      }
      this.applySceneActionEvent({ type: 'stop', id, reason });
    }
    completeTransition(id) {
      if (!id) return;
      if (this.pendingSceneActionEvents) {
        this.pendingSceneActionEvents.push({ type: 'transition', id });
      }
      this.applySceneTransitionEvent(id);
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
      const matches = [...source.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\(\)\}/g)];
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
      if (x.kind === 'float') return floating(x.value);
      if (x.kind === 'literal') return typeof x.value === 'string' || typeof x.value === 'boolean' ? x.value : integer(x.value);
      if (x.kind === 'load') return copy(this.get(x.name));
      if (x.kind === 'dict') {
        const d = Object.create(null);
        for (const e of x.entries) d[e.key] = await this.value(e.value);
        return d;
      }
      if (x.kind === 'list') {
        const values = [];
        for (const item of x.items) values.push(await this.value(item));
        return values;
      }
      if (x.kind === 'index') {
        const target = await this.value(x.target), key = await this.value(x.key);
        if (Array.isArray(target)) {
          if (typeof key !== 'bigint' || key < 0n || key >= BigInt(target.length)) throw Error(`List index out of range: ${key}`);
          return target[Number(key)];
        }
        if (!target || typeof target !== 'object' || !own(target, key)) throw Error(`存在しない辞書キー '${key}' です`);
        return target[key];
      }
      if (x.kind === 'unary') {
        // The magnitude of INT64_MIN is allowed only as the operand of unary minus.
        if (x.operator === '-' && x.value.kind === 'integer') return integer(-BigInt(x.value.value));
        const v = await this.value(x.value);
        return x.operator === 'not' ? !v : typeof v === 'number' ? floating(x.operator === '-' ? -v : v) : integer(x.operator === '-' ? -v : v);
      }
      if (x.kind === 'binary') {
        const a = await this.value(x.left);
        if (x.operator === 'and') return a && await this.value(x.right);
        if (x.operator === 'or') return a || await this.value(x.right);
        const b = await this.value(x.right);
        if (typeof a === 'number' && typeof b === 'number') {
          if ((x.operator === '/' || x.operator === '%') && b === 0) throw Error('0 で除算することはできません');
          switch (x.operator) {
            case '+': return floating(a + b);
            case '-': return floating(a - b);
            case '*': return floating(a * b);
            case '/': return floating(a / b);
            case '==': return a === b;
            case '!=': return a !== b;
            case '>': return a > b;
            case '>=': return a >= b;
            case '<': return a < b;
            case '<=': return a <= b;
          }
        }
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
        if (x.name === 'float') return floating(args[0]);
        if (x.name === 'list.length') return BigInt(args[0].length);
        if (x.name === 'list.append') return [...args[0], args[1]];
        if (x.name === 'list.contains') return args[0].some(value => equal(value, args[1]));
        if (x.name === 'text.trim') return trimDataSpace(args[0]);
        if (x.name === 'text.normalize_space') return normalizeDataSpace(args[0]);
        if (x.name === 'text.split') return splitText(args[0], args[1]);
        if (x.name === 'text.replace') return replaceText(args[0], args[1], args[2]);
        return this.call(x.name, args);
      }
      throw Error(`未知の式 '${x.kind}' です`);
    }
    async call(name, args) {
      if (name === 'runtime.state.characters.exists') {
        if (args.length !== 1 || typeof args[0] !== 'string') throw Error('runtime.state.characters.exists expects one str argument');
        return Object.values(this.sceneState.slots).includes(args[0]);
      }
      if (name === 'runtime.state.characters.list') {
        if (args.length !== 0) throw Error('runtime.state.characters.list expects no arguments');
        return [...new Set(Object.values(this.sceneState.slots).filter(value => typeof value === 'string'))].sort();
      }
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
        await this.host.beforeInstruction?.(c, this);
        if (c.op === 'declare') {
          const frame = this.frames.findLast(f => !this.loopFrames.has(f));
          if (preserveGlobals && frame === this.globals && own(frame, c.name)) {
            if (!matches(frame[c.name], c.type)) throw Error(`ファイル間で変数 '${c.name}' の型が一致しません`);
          } else frame[c.name] = c.initial ? await this.value(c.initial) : c.type === 'int' ? 0n : c.type === 'float' ? 0 : c.type === 'str' ? '' : c.type === 'bool' ? false : c.type?.kind === 'list' ? [] : Object.create(null);
          if (c.constant) { const names = this.readonlyFrames.get(frame) || new Set(); names.add(c.name); this.readonlyFrames.set(frame, names); }
        } else if (c.op === 'set') {
          const val = await this.value(c.value);
          this.assertMutable(c.target);
          if (c.target.kind === 'load') this.set(c.target.name, val);
          else {
            const key = await this.value(c.target.key), d = copy(this.get(c.target.target.name));
            if (Array.isArray(d)) {
              if (typeof key !== 'bigint' || key < 0n || key >= BigInt(d.length)) throw Error(`List index out of range: ${key}`);
              d[Number(key)] = val;
            } else d[key] = val;
            this.set(c.target.target.name, d);
          }
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
          // Say and wait do not mutate SceneState until after their host
          // callback, so asynchronous media events should remain observable
          // while either command is waiting. Stateful presentation commands
          // retain the transaction journal for rollback safety.
          const transactional = c.name !== 'say' && c.name !== 'wait';
          const priorState = transactional ? cloneSceneValue(this.sceneState) : null;
          if (transactional) this.pendingSceneActionEvents = [];
          let operation;
          try {
            operation = sceneStateCommand(this.sceneState, c.name, args, this.program, this.presentationDefaults);
            await this.host.command(c.name, args, this, operation);
            // Commit replacement of the old video only after the adapter
            // confirms that the candidate playback started successfully.
            if (operation.replacedActionId) this.stopAction(operation.replacedActionId, 'replaced', { replacedBy: operation.actionId });
          } catch (error) {
            if (!transactional) throw error;
            const deferredEvents = this.pendingSceneActionEvents;
            const failedAction = operation?.actionId && this.sceneState.actions[operation.actionId]
              ? cloneSceneValue(this.sceneState.actions[operation.actionId]) : null;
            for (const key of Object.keys(this.sceneState)) delete this.sceneState[key];
            Object.assign(this.sceneState, priorState);
            if (failedAction && !this.sceneState.actions[operation.actionId]) {
              failedAction.status = 'stopped';
              failedAction.reason = 'failed';
              failedAction.endedAt = this.sceneState.logicalTimeMs;
              this.sceneState.actions[operation.actionId] = failedAction;
              this.sceneState.revision++;
            }
            this.pendingSceneActionEvents = null;
            this.flushSceneActionEvents(deferredEvents);
            if (failedAction) this.notifySceneState({ name: 'action:stop', args: [], actionId: operation.actionId, reason: 'failed' });
            throw error;
          }
          if (transactional) {
            const deferredEvents = this.pendingSceneActionEvents;
            this.pendingSceneActionEvents = null;
            this.flushSceneActionEvents(deferredEvents);
          }
          if (c.name === 'wait') advanceSceneTime(this.sceneState, args[0]);
          else if (c.name === 'effect') advanceSceneTime(this.sceneState, operation.args[2] === undefined ? 500 : operation.args[2]);
          else if (c.name === 'show' && operation.args[0] !== 'image' && operation.args[operation.transitionIndex] === 'fade') advanceSceneTime(this.sceneState, operation.args[operation.transitionIndex + 1]);
          else if (c.name === 'hide' && operation.args[1] === 'fade') advanceSceneTime(this.sceneState, operation.args[2]);
          else if (c.name === 'move' && operation.blocking) advanceSceneTime(this.sceneState, operation.move.durationMs);
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
              const result = await this.exec(count === 1 && c.debugBody ? c.debugBody : c.body); if (result) return result;
            }
          } finally { this.frames.pop(); }
        } else if (c.op === 'forEach') {
          const values = await this.value(c.iterable);
          if (!Array.isArray(values)) throw Error('for-in requires a list');
          const loopFrame = Object.create(null); this.loopFrames.add(loopFrame); this.frames.push(loopFrame);
          try {
            let count = 0;
            for (const item of values) {
              if (++count > 100000) throw Error('Loop limit exceeded');
              loopFrame[c.name] = item;
              const result = await this.exec(count === 1 && c.debugBody ? c.debugBody : c.body); if (result) return result;
            }
          } finally { this.frames.pop(); }
        } else if (c.op === 'while') {
          let count = 0;
          while (await this.value(c.condition)) {
            if (++count > 100000) throw Error('ループの最大反復回数を超過しました');
            const result = await this.exec(count === 1 && c.debugBody ? c.debugBody : c.body); if (result) return result;
          }
        } else throw Error(`未知の命令 '${c.op}' です`);
      }
      return null;
    }
    async run(p, debug = null) {
      if (debug?.line !== undefined && debug.line !== null
        && (!Number.isSafeInteger(debug.line) || debug.line < 0))
        throw Error('Debug line must be a non-negative safe integer.');
      if (debug?.file !== undefined && debug.file !== null && typeof debug.file !== 'string')
        throw Error('Debug source file must be a string.');
      let transferred = false;
      // SceneState contains arrays (effects, choices, transfers, audio events).
      // The lexical-frame copier intentionally produces plain objects, so use
      // the structure-preserving clone for persisted scene snapshots.
      this.sceneState = debug?.sceneState ? cloneSceneValue(debug.sceneState) : createSceneState();
      this.sceneState.audio.volumes = { ...this.presentationDefaults.audio };
      this.sceneState.ui.dialogOpacity = this.presentationDefaults.dialog.opacity;
      let restored = false;
      const recordTransfer = async (target, external) => {
        const transfer = { target, external, at: this.sceneState.logicalTimeMs };
        this.sceneState.transfers.push(transfer);
        this.sceneState.revision++;
        await this.host.sceneState?.(this.sceneState, { name: 'goto', ...transfer }, this);
      };
      for (;;) {
        if (p.version !== 2) throw Error('未対応のプログラムバージョンです');
        this.program = p;
        this.frames = [this.globals];
        this.loopFrames = new WeakSet();
        this.functions = new Map(p.functions.map(f => [f.name, f]));
        await this.host.program?.(p, this.sceneState);
        let result = await this.exec(p.globals, transferred);
        const scenes = new Map(p.scenes.map(s => [s.name, s.instructions]));
        if (!transferred && debug?.variables) {
          for (const [name, value] of Object.entries(debug.variables)) this.globals[name] = value;
        }
        if (!transferred && Array.isArray(debug?.locals)) {
          const readonly = Array.isArray(debug.readonlyLocals) ? debug.readonlyLocals : [];
          for (let index = 0; index < debug.locals.length; index++) {
            const frame = cloneSceneValue(debug.locals[index]);
            this.frames.push(frame);
            this.readonlyFrames.set(frame, new Set(readonly[index] || []));
          }
        }
        const selectedScene = !transferred && debug?.scene ? p.scenes.find((scene) => scene.name === debug.scene) : null;
        if (!transferred && debug?.scene && !selectedScene) throw Error(`Unknown debug scene '${debug.scene}'.`);
        const firstScene = selectedScene || p.scenes[0];
        this.currentSceneName = firstScene?.name || '';
        if (!restored && debug?.sceneState) {
          await this.host.sceneState?.(this.sceneState, { name: 'restore' }, this);
          restored = true;
        }
        const firstInstructions = !transferred && debug?.line && firstScene
          ? instructionsFromLine(firstScene.instructions,
            debug.file == null ? firstScene.file : debug.file.replace(/\\/g, '/'), debug.line) : null;
        if (!transferred && debug?.line && !firstInstructions) throw Error(`Line ${debug.line} has no executable instruction in scene '${firstScene?.name || ''}'.`);
        if (!result && firstScene) result = await this.exec(firstInstructions || firstScene.instructions);
        while (result?.kind === 'goto' && scenes.has(result.scene)) {
          await recordTransfer(result.scene, false);
          this.currentSceneName = result.scene;
          result = await this.exec(scenes.get(result.scene));
        }
        if (!result) return;
        if (result.kind !== 'goto' || !this.host.load) throw Error('不正なシーン遷移です');
        await recordTransfer(result.scene, true);
        p = await this.host.load(result.scene);
        transferred = true;
        this.currentSceneName = p.scenes?.[0]?.name || '';
      }
    }
  }
  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b, k) && equal(a[k], b[k]));
  }
  if (typeof module !== 'undefined') module.exports = { Runtime, integer, floating, createSceneState, sceneStateCommand, advanceSceneTime };
  else root.NovelRuntime = { Runtime, integer, floating, createSceneState, sceneStateCommand, advanceSceneTime };
})(globalThis);
