'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NovelScreenDocument = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const DEFAULT_CANVAS = Object.freeze({ width: 1280, height: 720 });
  const TAGS = new Set(['main', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'small', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'label', 'button', 'input', 'img', 'br', 'save-slots']);
  const ACTIONS = new Set(['start', 'continue', 'resume', 'next', 'auto', 'skip', 'hold', 'save', 'load', 'quick-save', 'quick-load', 'slot-page', 'slot-select', 'slot-commit', 'slot-copy', 'slot-move', 'slot-delete', 'slot-lock', 'open-screen', 'setting-value', 'shortcut-cycle', 'reset-settings', 'reset-window-size', 'back', 'quit']);
  const SLOT_FIELDS = new Set(['number', 'status', 'scene', 'speaker', 'text', 'saved-at', 'thumbnail']);
  const PROPERTIES = new Set([
    'position', 'display', 'flex-direction', 'flex', 'flex-grow', 'justify-content', 'align-items', 'gap', 'row-gap', 'column-gap',
    'grid-template-columns', 'grid-auto-rows', 'left', 'right', 'top', 'bottom', 'width', 'height',
    'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
    'background', 'background-color', 'background-image', 'background-size', 'color', 'font-size',
    'text-align', 'border', 'border-width', 'border-color', 'border-radius', 'opacity', 'object-fit', 'z-index', 'accent-color',
    'overflow', 'overflow-x', 'overflow-y', 'white-space', 'line-height', 'font-family', 'font-weight', 'font-style', 'letter-spacing',
    'box-shadow', 'text-shadow', 'transform', 'transform-origin', 'transition', 'cursor', 'pointer-events',
    'box-sizing', 'outline', 'outline-offset', 'border-top', 'border-bottom', 'border-left', 'border-right',
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
    'user-select', 'appearance', 'list-style', 'vertical-align', 'visibility',
    'background-position', 'background-repeat', 'background-blend-mode', 'filter', 'backdrop-filter',
    'min-width', 'min-height', 'max-width', 'max-height', 'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
    'grid-template-rows', 'grid-column', 'grid-row', 'align-self', 'justify-self', 'flex-wrap', 'flex-shrink',
  ]);
  const NON_PORTABLE_PROPERTIES = new Set([
    'border-radius', 'box-shadow', 'text-shadow', 'transform', 'transform-origin', 'transition', 'cursor', 'pointer-events',
    'box-sizing', 'outline', 'outline-offset', 'border-top', 'border-bottom', 'border-left', 'border-right',
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
    'user-select', 'appearance', 'list-style', 'vertical-align', 'visibility', 'overflow', 'overflow-x', 'overflow-y',
    'white-space', 'font-family', 'font-weight', 'font-style', 'letter-spacing',
    'background-position', 'background-repeat', 'background-blend-mode', 'filter', 'backdrop-filter',
    'min-width', 'min-height', 'max-width', 'max-height', 'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
    'grid-template-rows', 'grid-column', 'grid-row', 'align-self', 'justify-self', 'flex-wrap', 'flex-shrink',
  ]);
  const VIEWPORT_LENGTH_PROPERTIES = new Set([
    'left', 'right', 'top', 'bottom', 'width', 'height', 'gap', 'row-gap', 'column-gap',
    'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
    'font-size', 'border-width', 'grid-auto-rows',
  ]);
  const NON_NEGATIVE_LENGTH_PROPERTIES = new Set([
    'width', 'height', 'gap', 'row-gap', 'column-gap', 'font-size', 'border-width', 'grid-auto-rows',
  ]);
  const INHERITED = new Set(['color', 'font-size', 'line-height', 'text-align']);
  const CONTROL_TYPES = new Set(['range', 'checkbox']);
  const SHORTCUT_ACTIONS = ['none', 'system', 'save', 'load', 'replay-voice', 'auto', 'clear-text', 'fullscreen', 'skip', 'quick-save', 'history', 'quick-load'];
  const SHORTCUT_ACTION_LABELS = { none: 'Disabled', system: 'System', save: 'Save', load: 'Load', 'replay-voice': 'Replay Last Voice', auto: 'Auto Play', 'clear-text': 'Clear Text', fullscreen: 'Toggle Fullscreen', skip: 'Skip', 'quick-save': 'Quick Save', history: 'Text History', 'quick-load': 'Quick Load' };
  const ENUM_CONTROL_VALUES = { 'ui.fontFamily': ['default', 'gothic', 'mincho'] };
  const CONTROL_KEYS = new Set(['audio.master', 'audio.bgm', 'audio.se', 'audio.voice', 'audio.bgmMuted', 'audio.seMuted', 'audio.voiceMuted', 'ui.dialogOpacity', 'ui.skipUnseen', 'ui.autoAfterChoice', 'ui.skipAfterChoice', 'ui.autoSpeed', 'ui.textSpeed', 'ui.fullscreen', 'ui.effects', 'ui.cursorHideDelay']);
  const BOOLEAN_CONTROL_KEYS = new Set(['audio.bgmMuted', 'audio.seMuted', 'audio.voiceMuted', 'ui.skipUnseen', 'ui.autoAfterChoice', 'ui.skipAfterChoice', 'ui.fullscreen', 'ui.effects']);
  const isShortcutSettingKey = key => /^ui\.shortcut\.F(?:[1-9]|1[0-2])$/.test(key || '');
  const isControlSettingKey = key => CONTROL_KEYS.has(key) || isShortcutSettingKey(key) || Object.hasOwn(ENUM_CONTROL_VALUES, key) || /^audio\.voice\.[A-Za-z_][A-Za-z0-9_]*(?:\.muted)?$/.test(key || '');
  const isBooleanControlSettingKey = key => BOOLEAN_CONTROL_KEYS.has(key) || /^audio\.voice\.[A-Za-z_][A-Za-z0-9_]*\.muted$/.test(key || '');
  function controlSettingRule(key, value) {
    if (isBooleanControlSettingKey(key)) return { type: 'boolean' };
    if (isShortcutSettingKey(key)) return { type: 'enum', values: [...SHORTCUT_ACTIONS] };
    if (Object.hasOwn(ENUM_CONTROL_VALUES, key)) return { type: 'enum', values: [...ENUM_CONTROL_VALUES[key]] };
    if (isControlSettingKey(key) && typeof value === 'number') return { type: 'number', minimum: 0, maximum: 1 };
    throw Error(`未対応の画面コントロール設定です: ${key}`);
  }
  function compileControlSchema(settings) {
    return {
      settings: Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, controlSettingRule(key, value)])),
      shortcutActions: [...SHORTCUT_ACTIONS],
      shortcutActionLabels: { ...SHORTCUT_ACTION_LABELS },
    };
  }

  function validateControlSkins(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw Error('controlSkinsは64個以内のオブジェクトで指定してください。');
    const assetPath = (image, label) => {
      if (typeof image !== 'string' || image.length > 240) throw Error(`${label}の画像パスが不正です。`);
      const normalized = image.replaceAll('\\', '/').replace(/^asset\//i, '');
      if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..') || !/\.(?:png|jpe?g|webp)$/i.test(normalized)) throw Error(`${label}はasset内のPNG/JPEG/WebP相対パスで指定してください。`);
      return normalized;
    };
    const number = (skin, key, fallback, minimum, maximum, id) => {
      const result = skin[key] === undefined ? fallback : skin[key];
      if (!Number.isFinite(result) || result < minimum || result > maximum) throw Error(`controlSkins.${id}.${key}は${minimum}〜${maximum}で指定してください。`);
      return result;
    };
    const result = {};
    for (const [id, raw] of Object.entries(value)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`controlSkinsのIDまたは定義が不正です: ${id}`);
      if (raw.type === 'range') {
        const skin = {
          type: 'range',
          orientation: raw.orientation === undefined ? 'horizontal' : raw.orientation,
          track: assetPath(raw.track, `controlSkins.${id}.track`),
          fill: assetPath(raw.fill, `controlSkins.${id}.fill`),
          thumb: assetPath(raw.thumb, `controlSkins.${id}.thumb`),
          trackHeight: number(raw, 'trackHeight', 8, 2, 96, id),
          thumbWidth: number(raw, 'thumbWidth', 28, 8, 128, id),
          thumbHeight: number(raw, 'thumbHeight', 28, 8, 128, id),
          inset: number(raw, 'inset', (raw.thumbWidth ?? 28) / 2, 0, 256, id),
        };
        if (!['horizontal', 'vertical'].includes(skin.orientation)) throw Error(`controlSkins.${id}.orientationはhorizontalまたはverticalで指定してください。`);
        if (raw.thumbHover !== undefined) skin.thumbHover = assetPath(raw.thumbHover, `controlSkins.${id}.thumbHover`);
        if (skin.inset * 2 >= 4096) throw Error(`controlSkins.${id}.insetが大きすぎます。`);
        result[id] = skin;
      } else if (raw.type === 'checkbox') {
        const skin = {
          type: 'checkbox',
          off: assetPath(raw.off, `controlSkins.${id}.off`),
          on: assetPath(raw.on, `controlSkins.${id}.on`),
        };
        if (raw.offHover !== undefined) skin.offHover = assetPath(raw.offHover, `controlSkins.${id}.offHover`);
        if (raw.onHover !== undefined) skin.onHover = assetPath(raw.onHover, `controlSkins.${id}.onHover`);
        result[id] = skin;
      } else throw Error(`controlSkins.${id}.typeはrangeまたはcheckboxです。`);
    }
    return result;
  }

  function parseControlSettings(source) {
    if (typeof source !== 'string' || source.length > 20_000) throw Error('画面コントロール設定は20KB以内で指定してください。');
    const settings = {};
    for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^([A-Za-z][\w.]*)\s*=\s*(.+)$/.exec(line);
      if (!match || !isControlSettingKey(match[1]) || Object.hasOwn(settings, match[1])) throw Error(`画面コントロール設定の${index + 1}行目が不正、未対応、または重複しています。`);
      const key = match[1], sourceValue = match[2].trim();
      if (isBooleanControlSettingKey(key)) {
        if (!['true', 'false'].includes(sourceValue)) throw Error(`${key}はtrueまたはfalseで指定してください。`);
        settings[key] = sourceValue === 'true';
      } else if (isShortcutSettingKey(key)) {
        if (!SHORTCUT_ACTIONS.includes(sourceValue)) throw Error(`${key}のショートカット動作が正しくありません`);
        settings[key] = sourceValue;
      } else if (Object.hasOwn(ENUM_CONTROL_VALUES, key)) {
        if (!ENUM_CONTROL_VALUES[key].includes(sourceValue)) throw Error(`${key}は許可された選択肢から指定してください。`);
        settings[key] = sourceValue;
      } else {
        const value = Number(sourceValue);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw Error(`${key}は0〜1の数値で指定してください。`);
        settings[key] = value;
      }
    }
    return settings;
  }

  function canvasTransform(viewWidth, viewHeight, canvas, mode = 'contain') {
    const width = Number(canvas?.width), height = Number(canvas?.height);
    if (![viewWidth, viewHeight, width, height].every(Number.isFinite) || viewWidth <= 0 || viewHeight <= 0 || width <= 0 || height <= 0) {
      throw Error('画面サイズと基準キャンバスは正の有限値で指定してください');
    }
    if (!['contain', 'cover', 'stretch'].includes(mode)) throw Error(`未対応の画面スケール方式です: ${mode}`);
    const scale = mode === 'cover'
      ? Math.max(viewWidth / width, viewHeight / height)
      : Math.min(viewWidth / width, viewHeight / height);
    const scaleX = mode === 'stretch' ? viewWidth / width : scale;
    const scaleY = mode === 'stretch' ? viewHeight / height : scale;
    return { scaleX, scaleY, offsetX: (viewWidth - width * scaleX) / 2, offsetY: (viewHeight - height * scaleY) / 2 };
  }

  function decodeEntities(value) {
    return String(value).replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
      const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const hex = /^&#x([\da-f]+);$/i.exec(entity), decimal = /^&#(\d+);$/.exec(entity);
      const code = hex ? parseInt(hex[1], 16) : decimal ? Number(decimal[1]) : NaN;
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
  }

  function parseMarkup(markup) {
    if (typeof markup !== 'string' || markup.length > 120_000) throw Error('画面HTMLは120KB以内で指定してください。');
    const root = { tag: 'screen-root', attrs: {}, text: '', children: [] };
    const stack = [root];
    let nodeCount = 0;
    const tokens = markup.replace(/<!--[\s\S]*?-->/g, '').match(/<[^>]*>|[^<]+/g) || [];
    for (const token of tokens) {
      if (!token.startsWith('<')) {
        const text = decodeEntities(token).replace(/\s+/g, ' ').trim();
        if (text) {
          const parent = stack.at(-1);
          parent.text += (parent.text && !parent.text.endsWith('\n') ? ' ' : '') + text;
        }
        continue;
      }
      if (/^<!|^<\?/.test(token)) continue;
      const closing = /^<\s*\//.test(token);
      const name = /^<\s*\/?\s*([A-Za-z][\w-]*)/.exec(token)?.[1]?.toLowerCase();
      if (!name || !TAGS.has(name)) throw Error(`画面HTMLに未対応の要素があります: ${name || token.slice(0, 24)}`);
      if (closing) {
        if (stack.length === 1 || stack.at(-1).tag !== name) throw Error(`画面HTMLの閉じタグが一致しません: ${name}`);
        const closed = stack.pop();
        if (closed.text && closed.children.length) throw Error(`画面HTMLの混在コンテンツには対応していません: ${name}要素はテキストのみ、または子要素のみで記述してください。`);
        continue;
      }
      const rawAttrs = token.slice(name.length + token.indexOf(name) + 1, token.length - 1).replace(/\/\s*$/, '');
      const attrs = {};
      const attrPattern = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
      let match;
      let consumedAttributes = 0;
      while ((match = attrPattern.exec(rawAttrs))) {
        if (rawAttrs.slice(consumedAttributes,match.index).trim()) throw Error('HTML属性は引用符付きの値で指定してください。');
        consumedAttributes = attrPattern.lastIndex;
        const key = match[1].toLowerCase(), value = decodeEntities(match[2] ?? match[3] ?? '');
        if (key.startsWith('on') || !['id', 'class', 'src', 'alt', 'title', 'for', 'type', 'min', 'max', 'step', 'value', 'checked', 'aria-label', 'aria-hidden', 'tabindex', 'data-action', 'data-target', 'data-value', 'data-role', 'data-count', 'data-setting', 'data-skin', 'data-slot-field'].includes(key)) throw Error(`画面HTMLに未対応の属性があります: ${key}`);
        if (Object.hasOwn(attrs, key)) throw Error(`画面HTMLの属性が重複しています: ${key}`);
        attrs[key] = value;
      }
      if (rawAttrs.slice(consumedAttributes).trim()) throw Error('HTML属性は引用符付きの値で指定してください。');
      if (attrs.tabindex !== undefined && (!/^[+-]?\d+$/.test(attrs.tabindex) || !Number.isSafeInteger(Number(attrs.tabindex)) || Number(attrs.tabindex) < -2147483648 || Number(attrs.tabindex) > 2147483647)) throw Error('tabindexには32-bit signed integerを指定してください。');
      if (name === 'img' && !attrs.src && attrs['data-slot-field'] !== 'thumbnail') throw Error('img要素にはsrcかサムネイルの指定が必要です。');
      if (name === 'img' && !Object.hasOwn(attrs, 'alt')) throw Error('img要素にはalt属性を指定してください。装飾画像にはalt=""を指定してください。');
      if (name === 'input') {
        if (!CONTROL_TYPES.has(attrs.type) || !attrs['data-setting'] || !isControlSettingKey(attrs['data-setting'])) throw Error('inputには対応するtypeとdata-settingが必要です。');
        if (attrs.type === 'range') {
          const min = Number(attrs.min ?? 0), max = Number(attrs.max ?? 1), step = Number(attrs.step ?? 0.01);
          if (![min, max, step].every(Number.isFinite) || min < 0 || max > 1 || max <= min || step < Number.EPSILON || step > max - min) throw Error('rangeのmin/max/stepは0〜1の有効範囲で指定してください。stepはNumber.EPSILON以上にしてください。');
          if (isBooleanControlSettingKey(attrs['data-setting'])) throw Error('boolean設定はcheckboxを使ってください。');
        } else if (!isBooleanControlSettingKey(attrs['data-setting'])) throw Error('checkboxにはboolean設定を指定してください。');
        if (attrs['data-skin'] && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(attrs['data-skin'])) throw Error('data-skinは有効なスキンIDで指定してください。');
      } else if (attrs['data-setting'] || attrs['data-skin']) throw Error('data-settingとdata-skinはinputでのみ使用できます。');
      if (attrs['data-action'] && !ACTIONS.has(attrs['data-action'])) throw Error(`未対応の画面動作です: ${attrs['data-action']}`);
      if (attrs['data-action'] === 'open-screen' && !attrs['data-target']) throw Error('open-screenにはdata-targetが必要です。');
      if (attrs['data-action'] === 'shortcut-cycle' && !/^F(?:[1-9]|1[0-2])$/.test(attrs['data-target'] || '')) throw Error('shortcut-cycleのdata-targetにはF1〜F12を指定してください');
      if (attrs['data-action'] === 'setting-value' && !((BOOLEAN_CONTROL_KEYS.has(attrs['data-target']) && ['true', 'false'].includes(attrs['data-value'])) || (Object.hasOwn(ENUM_CONTROL_VALUES, attrs['data-target']) && ENUM_CONTROL_VALUES[attrs['data-target']].includes(attrs['data-value'])))) throw Error('setting-valueには許可された設定値が必要です。');
      if (attrs['data-value'] && attrs['data-action'] !== 'setting-value') throw Error('data-valueはsetting-value動作でのみ使用できます。');
      if (attrs['data-action'] === 'slot-page' && !/^[0-9]$/.test(attrs['data-target'] || '')) throw Error('slot-pageには0〜9のページ番号が必要です。');
      if (attrs['data-action'] === 'slot-page' && !attrs['data-target']) throw Error('slot-pageにはdata-targetが必要です。');
      if (attrs['data-role'] && !['save-slots', 'load-slots', 'dialogue-history', 'selected-slot-summary'].includes(attrs['data-role'])) throw Error(`未対応の画面roleです: ${attrs['data-role']}`);
      if (attrs['data-count'] && (!/^\d+$/.test(attrs['data-count']) || Number(attrs['data-count']) < 1 || Number(attrs['data-count']) > 100)) throw Error('data-countは1〜100の整数です。');
      if (attrs['data-slot-field'] && !SLOT_FIELDS.has(attrs['data-slot-field'])) throw Error(`未対応のセーブ枠フィールドです: ${attrs['data-slot-field']}`);
      if (name === 'br') {
        if (Object.keys(attrs).some(key => !['id', 'class', 'title', 'aria-label', 'aria-hidden'].includes(key))) throw Error('brには表示用属性だけ指定できます。');
        if (++nodeCount > 2000) throw Error('画面HTMLの要素数は2000個以内にしてください。');
        stack.at(-1).text += '\n';
        continue;
      }
      const node = { tag: name, attrs, text: '', children: [] };
      stack.at(-1).children.push(node);
      if (++nodeCount > 2000) throw Error('画面HTMLの要素数は2000個以内にしてください。');
      if (!['img', 'br', 'input'].includes(name) && !/\/\s*>$/.test(token)) {
        if (stack.length >= 64) throw Error('画面HTMLの入れ子は64階層以内にしてください。');
        stack.push(node);
      }
    }
    if (stack.length !== 1) throw Error(`画面HTMLの閉じタグがありません: ${stack.at(-1).tag}`);
    return root.children;
  }

  function parseDeclarations(source, baseOffset, sourcePosition) {
    const style = {};
    const sharedColor = value => value === 'transparent' || /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)
      || /^rgb\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\)$/i.test(value)
      || /^rgba\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*(?:0(?:\.\d+)?|\.\d+|1(?:\.0+)?)\s*\)$/i.test(value);
    let offset = 0;
    for (const declaration of source.split(';')) {
      const declarationOffset = offset;
      offset += declaration.length + 1;
      if (!declaration.trim()) continue;
      const leadingWhitespace = declaration.search(/\S/);
      const position = sourcePosition(baseOffset + declarationOffset + Math.max(leadingWhitespace, 0));
      const colon = declaration.indexOf(':');
      if (colon < 1) {
        const error = Error('CSSの宣言は「property: value;」形式で指定してください。');
        error.cssPosition = position;
        throw error;
      }
      const key = declaration.slice(0, colon).trim().toLowerCase(), value = declaration.slice(colon + 1).trim();
      try {
        if (/^--/.test(key)) throw Error(`CSSカスタムプロパティには対応していません: ${key}`);
        if (!PROPERTIES.has(key)) throw Error(`未対応の画面CSSプロパティです: ${key}`);
        if (!value || value.length > 1000 || /[{}<>;]/.test(value) || /expression\s*\(|javascript:|data:|@import/i.test(value)) throw Error(`CSS値が不正です: ${key}`);
        if (NON_PORTABLE_PROPERTIES.has(key)) throw Error(`Browser／Native共通画面では未対応のCSSです: ${key}`);
        if ((key === 'background' || key === 'background-image') && /(?:linear|radial)-gradient\s*\(/i.test(value)) throw Error(`Browser／Native共通画面では未対応の背景効果です: ${key}`);
        if (/var\s*\(/i.test(value)) throw Error(`Browser／Native共通画面ではCSS変数を使用できません: ${key}`);
        if (key === 'flex' && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw Error('Browser／Native共通画面のflexは数値のみ指定できます');
        if ((key === 'flex' || key === 'flex-grow') && (!Number.isFinite(Number(value)) || Number(value) > 1_000_000)) throw Error(`${key}には有限範囲の0〜1000000を指定してください`);
        if (key !== 'gap' && NON_NEGATIVE_LENGTH_PROPERTIES.has(key) && length(value, 100) < 0) throw Error(`${key}に負の値は指定できません`);
        if (key === 'font-size' || key === 'border-width') length(value, 100);
        if (key === 'line-height' && (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)?$/.test(value) || !Number.isFinite(Number.parseFloat(value)) || Number.parseFloat(value) > 1_000_000)) throw Error('line-heightには0〜1000000の数値、px、または%を指定してください');
        if (key === 'flex-grow' && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw Error('flex-growには0以上の数値を指定してください');
        if (key.startsWith('padding-') && length(value, 100) < 0) throw Error('paddingに負の値は指定できません');
        for (const reference of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
          const asset = reference[1].trim().replace(/^['"]|['"]$/g, '');
          if (!/^(?:asset\/)?[A-Za-z0-9_./-]+$/.test(asset) || asset.split('/').includes('..') || asset.startsWith('/')) throw Error('CSSのurl()は作品素材だけを指定してください。');
        }
        if (key === 'display' && !['block','flex','grid','none'].includes(value)) throw Error(`displayはblock、flex、grid、noneから指定してください: ${value}`);
        if (key === 'position' && !['relative','absolute'].includes(value)) throw Error(`positionはrelativeまたはabsoluteから指定してください: ${value}`);
        if (key === 'flex-direction' && !['row','column'].includes(value)) throw Error(`flex-directionはrowまたはcolumnから指定してください: ${value}`);
        if (key === 'justify-content' && !['start','flex-start','end','flex-end','center','space-between','space-around','space-evenly'].includes(value)) throw Error(`未対応のjustify-contentです: ${value}`);
        if (key === 'align-items' && !['stretch','start','flex-start','end','flex-end','center'].includes(value)) throw Error(`未対応のalign-itemsです: ${value}`);
        if (key === 'text-align' && !['left','center','right'].includes(value)) throw Error(`text-alignはleft、center、rightから指定してください: ${value}`);
        if (key === 'opacity' && (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value))) throw Error('opacityは0〜1の数値で指定してください。');
        if (key === 'z-index' && !/^-?\d+$/.test(value)) throw Error('z-indexは整数で指定してください。');
        if (key === 'object-fit' && !['fill','contain','cover'].includes(value)) throw Error('object-fitはfill、contain、coverから指定してください。');
        if (key === 'background-size' && !['cover','contain','100% 100%'].includes(value)) throw Error('background-sizeはcover、contain、100% 100%から指定してください。');
        if ((key === 'background-image' || key === 'background') && /url\s*\(/i.test(value) && !/^url\(["']?(?:asset\/)?[A-Za-z0-9_./-]+["']?\)$/i.test(value)) throw Error('background画像は作品素材のassetパスだけ指定できます。');
        if (['color','background-color','border-color','accent-color'].includes(key) && !sharedColor(value)) throw Error(`${key}には対応している色を指定してください`);
        if (key === 'background' && !/url\s*\(/i.test(value) && !sharedColor(value) && !/^(?:linear|radial)-gradient\(.+\)$/i.test(value)) throw Error('backgroundの値が正しくありません');
        if (key === 'border') {
          const border = /^(\d+(?:\.\d+)?px)\s+solid\s+(.+)$/i.exec(value);
          if (!border || !sharedColor(border[2])) throw Error('borderにはpx単位の幅、solid、対応している色を指定してください');
          style['border-width'] = border[1];
          style['border-style'] = 'solid';
          style['border-color'] = border[2];
        }
        if (key === 'padding') {
          const values = value.split(/\s+/);
          if (values.length < 1 || values.length > 4) throw Error('paddingには1〜4個の対応している寸法を指定してください');
          for (const item of values) {
            const amount = length(item, 100);
            if (amount < 0) throw Error('paddingに負の値は指定できません');
          }
          const [top, right = top, bottom = top, left = right] = values;
          const sides = values.length === 3 ? { top, right, bottom, left: right } : { top, right, bottom, left };
          for (const [side, amount] of Object.entries(sides)) style[`padding-${side}`] = amount;
          continue;
        }
        if (key === 'gap') {
          const values = value.split(/\s+/);
          if (values.length < 1 || values.length > 2) throw Error('gapには1つまたは2つの非負長さを指定してください');
          for (const item of values) if (length(item, 100) < 0) throw Error('gapに負の値は指定できません');
          style['row-gap'] = values[0];
          style['column-gap'] = values[1] || values[0];
          continue;
        }
        style[key] = value;
      } catch (error) {
        error.cssPosition = position;
        error.cssProperty = key;
        throw error;
      }
    }
    return style;
  }

  function parseStylesheet(css) {
    if (typeof css !== 'string' || css.length > 80_000) throw Error('画面CSSは80KB以内で指定してください。');
    const source = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\r\n\u2028\u2029]/g, ' '));
    if (/@|url\s*\([^)]*(?:https?:|\\|\.\.)/i.test(source)) throw Error('画面CSSの外部参照やat-ruleは使用できません。');
    const sourcePosition = offset => {
      const prefix = source.slice(0, offset);
      const breaks = [...prefix.matchAll(/\r\n|\r|\n|\u2028|\u2029/g)];
      const last = breaks.at(-1);
      return { line: breaks.length + 1, column: last ? prefix.length - last.index - last[0].length + 1 : prefix.length + 1 };
    };
    const rules = [];
    const pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match, consumed = '';
    while ((match = pattern.exec(source))) {
      consumed += match[0];
      let selectorOffset = 0;
      for (const selector of match[1].split(',')) {
        const normalized = selector.trim();
        const leadingWhitespace = selector.search(/\S/);
        const position = sourcePosition(match.index + selectorOffset + Math.max(leadingWhitespace, 0));
        selectorOffset += selector.length + 1;
        let declarations;
        const declarationOffset = match.index + match[0].indexOf('{') + 1;
        try { declarations = parseDeclarations(match[2], declarationOffset, sourcePosition); }
        catch (error) {
          const errorPosition = error.cssPosition || position;
          const property = error.cssProperty ? `, property '${error.cssProperty}'` : '';
          throw Error(`CSS ${errorPosition.line}行${errorPosition.column}列、セレクター「${normalized}」${property}: ${error.message}`);
        }
        const stateSelector = /\[data-state=(?:"(empty|ready|corrupt|incompatible)"|'(empty|ready|corrupt|incompatible)'|(empty|ready|corrupt|incompatible))\]/.exec(normalized);
        const dataState = stateSelector ? stateSelector[1] || stateSelector[2] || stateSelector[3] : '';
        const selectorBase = stateSelector ? normalized.replace(stateSelector[0], '') : normalized;
        const matchSelector = /^([A-Za-z][\w-]*)?(?:#([A-Za-z][\w-]*))?((?:\.[A-Za-z_][\w-]*)*)(?::(hover|focus|focus-visible))?$/.exec(selectorBase);
        if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9_#.\s>+~:\[\]="'()\-*]+$/.test(normalized)) throw Error(`CSS ${position.line}行${position.column}列: 画面CSSのセレクターが不正です: ${normalized}`);
        if (!matchSelector) throw Error(`CSS ${position.line}行${position.column}列、セレクター「${normalized}」: Browser／Native共通画面では未対応です`);
        if (dataState && (!matchSelector[3] || matchSelector[2] || matchSelector[4])) throw Error(`CSS ${position.line}行${position.column}列、セレクター「${normalized}」: data-stateはクラスだけを使い、セーブ枠テンプレートのルートを指定してください`);
        rules.push({ selector: normalized, tag: matchSelector[1]?.toLowerCase() || '', id: matchSelector[2] || '', classes: matchSelector[3].split('.').filter(Boolean) || [], dataState, state: matchSelector[4] || '', webOnly: false, declarations });
      }
    }
    if (source.replace(pattern, '').trim()) throw Error('画面CSSのルール構文が不正です。');
    return rules;
  }

  function matches(node, rule) {
    return !rule.webOnly && (!rule.tag || node.tag === rule.tag) && (!rule.id || node.attrs.id === rule.id)
      && rule.classes.every(name => (node.attrs.class || '').split(/\s+/).includes(name));
  }
  function mergeStyles(node, rules, inherited, validateSlotStates = true) {
    const base = {}, specified = {}, hover = {}, focus = {}, focusVisible = {}, slotStateStyles = {};
    let lineHeightSpecified = false;
    // The browser UA stylesheet gives heading elements large default margins;
    // Native has no UA stylesheet. Normalize them into the shared tree so the
    // same authored rect starts at the same pixel in both renderers.
    if (node.tag === 'h1' || node.tag === 'h2') base.margin = '0';
    for (const key of INHERITED) if (inherited[key] !== undefined) base[key] = inherited[key];
    for (const rule of rules) if (matches(node, rule)) {
      if (rule.dataState) {
        if (node.attrs['data-slot-index'] === undefined) {
          if (validateSlotStates) throw Error('data-stateセレクターはセーブ枠テンプレートのルートにだけ指定できます');
          continue;
        }
        slotStateStyles[rule.dataState] ||= {};
        Object.assign(slotStateStyles[rule.dataState], rule.declarations);
      } else if (rule.state === 'hover') Object.assign(hover, rule.declarations);
      else if (rule.state === 'focus') {
        Object.assign(focus, rule.declarations);
        Object.assign(focusVisible, rule.declarations);
      } else if (rule.state === 'focus-visible') Object.assign(focusVisible, rule.declarations);
      else {
        Object.assign(base, rule.declarations);
        Object.assign(specified, rule.declarations);
        if (Object.hasOwn(rule.declarations, 'line-height')) lineHeightSpecified = true;
      }
    }
    Object.assign(base, node.attrs.style || {});
    Object.assign(specified, node.attrs.style || {});
    if (Object.hasOwn(node.attrs.style || {}, 'line-height')) lineHeightSpecified = true;
    const nextInherited = { ...inherited };
    for (const key of INHERITED) if (base[key] !== undefined) nextInherited[key] = base[key];
    node.style = base; node.specifiedStyle = specified; node.hoverStyle = hover; node.focusStyle = focus; node.focusVisibleStyle = focusVisible; node.slotStateStyles = slotStateStyles; node.inherited = nextInherited; node.lineHeightSpecified = lineHeightSpecified;
    node.children.forEach(child => mergeStyles(child, rules, nextInherited, validateSlotStates));
  }

  function length(value, available, fallback = 0) {
    if (value === undefined) return fallback;
    const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|%|vw|vh)?$/i.exec(String(value).trim());
    if (!match) throw Error(`寸法はpx、%、vw、vhで指定してください: ${value}`);
    const number = Number(match[1]);
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) throw Error(`寸法が範囲外です: ${value}`);
    return match[2] === '%' ? available * number / 100 : number;
  }
  function normalizeViewportUnits(nodes, rules, canvas) {
    const convert = style => {
      if (!style || typeof style !== 'object') return;
      for (const [property, value] of Object.entries(style)) {
        if (!VIEWPORT_LENGTH_PROPERTIES.has(property) || typeof value !== 'string') continue;
        // Screen documents are authored in logical canvas coordinates. Resolve
        // viewport units against that reference canvas before either renderer
        // consumes the shared tree, so letterboxing/scaling stays renderer-neutral.
        style[property] = value.replace(/(-?(?:\d+\.?\d*|\.\d+))\s*(vw|vh)\b/gi, (_, raw, unit) => {
          const viewport = unit.toLowerCase() === 'vw' ? canvas.width : canvas.height;
          return `${Number(raw) * viewport / 100}px`;
        });
      }
    };
    for (const rule of rules) convert(rule.declarations);
    const visit = node => {
      convert(node.attrs?.style);
      for (const child of node.children || []) visit(child);
    };
    for (const node of nodes) visit(node);
  }
  function edge(style, key, available) { return length(style[key], available, 0); }
  function boxEdges(style, prefix, available) {
    return {
      left: edge(style, `${prefix}-left`, available),
      right: edge(style, `${prefix}-right`, available),
      top: edge(style, `${prefix}-top`, available),
      bottom: edge(style, `${prefix}-bottom`, available),
    };
  }
  function intrinsicSize(node, availableWidth, availableHeight) {
    const style = node.style || {};
    // Intrinsic dimensions must follow the same flow participation rules as
    // layoutNodes. Hidden and absolutely positioned descendants cannot size an
    // auto-sized parent in Browser and Native.
    const children = (node.children || []).filter(child =>
      child.style?.display !== 'none' && child.style?.position !== 'absolute');
    const grid = style.display === 'grid';
    const vertical = style.display === 'flex' && (style['flex-direction'] || 'row') === 'column';
    const gap = length(vertical ? style['row-gap'] : style['column-gap'], vertical ? availableHeight : availableWidth, 0);
    const padding = boxEdges(style, 'padding', availableWidth);
    const border = length(style['border-width'], availableWidth, 0);
    const measured = children.map(child => intrinsicSize(child, availableWidth, availableHeight));
    let contentWidth = vertical ? Math.max(0, ...measured.map(size => size.width)) : measured.reduce((sum, size) => sum + size.width, 0) + gap * Math.max(0, children.length - 1);
    let contentHeight = vertical ? measured.reduce((sum, size) => sum + size.height, 0) + gap * Math.max(0, children.length - 1) : Math.max(0, ...measured.map(size => size.height));
    if (grid && children.length) {
      const expression = style['grid-template-columns'] || '1fr';
      const repeated = /^repeat\(\s*(\d+)\s*,\s*((?:\d+(?:\.\d+)?|\.\d+))?\s*(px|fr|%)\s*\)$/.exec(expression);
      const repeatedCount = repeated ? Number(repeated[1]) : null;
      if (repeated && (!Number.isSafeInteger(repeatedCount) || repeatedCount < 1 || repeatedCount > 2000)) throw Error(`grid-template-columnsのrepeat列数は1〜2000で指定してください: ${expression}`);
      const columns = Math.max(1, repeated ? repeatedCount : expression.trim().split(/\s+/).length);
      const definitions = repeated
        ? Array.from({ length: columns }, () => `${repeated[2] || '1'}${repeated[3]}`)
        : expression.trim().split(/\s+/);
      const columnGap = length(style['column-gap'], availableWidth, 0);
      const trackAvailable = Math.max(0, availableWidth - columnGap * Math.max(0, columns - 1));
      const intrinsicColumns = Array.from({ length: columns }, (_, column) =>
        Math.max(0, ...measured.filter((_, index) => index % columns === column).map(size => size.width)));
      const trackWidths = definitions.map((definition, column) => {
        const track = /^(\d+(?:\.\d+)?|\.\d+)(px|fr|%)$/.exec(definition);
        if (!track) return intrinsicColumns[column] || 0;
        if (track[2] === 'px') return Number(track[1]);
        if (track[2] === '%') return trackAvailable * Number(track[1]) / 100;
        // Fractional tracks in an intrinsically sized grid retain the
        // minimum content contribution of their column.
        return intrinsicColumns[column] || 0;
      });
      const rows = Math.ceil(children.length / columns), rowGap = length(style['row-gap'], availableHeight, 0);
      let gridHeight = 0;
      for (let row = 0; row < rows; row++) {
        const rowStart = row * columns;
        const rowHeight = length(style['grid-auto-rows'], availableHeight,
          Math.max(0, ...measured.slice(rowStart, rowStart + columns).map(size => size.height)));
        gridHeight += rowHeight;
      }
      contentHeight = gridHeight + rowGap * Math.max(0, rows - 1);
      contentWidth = trackWidths.reduce((sum, width) => sum + width, 0) + columnGap * Math.max(0, columns - 1);
    }
    const textLines = node.text ? (node.text.match(/\n/g) || []).length + 1 : 0;
    const fontSize = length(style['font-size'], availableHeight, 16);
    const authoredLineHeight = String(style['line-height'] || '').trim();
    const lineHeight = !authoredLineHeight ? fontSize * 1.5
      : authoredLineHeight.endsWith('px') ? length(authoredLineHeight, availableHeight)
        : authoredLineHeight.endsWith('%') ? fontSize * Number.parseFloat(authoredLineHeight) / 100
          : fontSize * Number(authoredLineHeight);
    const fallbackHeight = node.text ? Math.max(24, fontSize, lineHeight * textLines) : 0;
    return {
      width: length(style.width, availableWidth, contentWidth + padding.left + padding.right + border * 2),
      height: length(style.height, availableHeight, (contentHeight || fallbackHeight) + padding.top + padding.bottom + border * 2),
    };
  }

  function layoutNodes(nodes, rect, rules) {
    const laid = nodes.map(node => ({ ...node, children: node.children.map(child => ({ ...child })) }));
    const inFlowChildren = node => node.children
      .map((child, index) => ({ child, index }))
      .filter(({ child }) => child.style.display !== 'none' && child.style.position !== 'absolute');
    const mapFlowRects = (node, participants, rects, box) => {
      const result = node.children.map(() => ({ x: box.x, y: box.y, width: 0, height: 0, _availableWidth: box.width, _availableHeight: box.height }));
      participants.forEach(({ index }, participantIndex) => { result[index] = rects[participantIndex]; });
      return result;
    };
    const flexChildren = (node, box) => {
      const participants = inFlowChildren(node);
      const flowNodes = participants.map(({ child }) => child);
      const direction = node.style['flex-direction'] || 'row';
      const vertical = direction === 'column';
      const gap = length(vertical ? node.style['row-gap'] : node.style['column-gap'], vertical ? box.height : box.width, 0);
      const content = box;
      const basis = vertical ? content.height : content.width;
      const flexBasis = child => {
        const mainKey = vertical ? 'height' : 'width';
        const measured = intrinsicSize(child, content.width, content.height);
        return length(child.style[mainKey], basis, vertical ? measured.height : measured.width);
      };
      const growFactor = child => Number(child.style.flex !== undefined ? child.style.flex : child.style['flex-grow'] || 0);
      const fixed = flowNodes.reduce((sum, child) => {
        // `flex: N` uses a zero basis in this subset. `flex-grow: N` keeps
        // the authored/intrinsic basis and only distributes remaining space.
        if (child.style.flex !== undefined) return sum;
        return sum + flexBasis(child);
      }, 0);
      const grow = flowNodes.reduce((sum, child) => sum + growFactor(child), 0);
      const free = basis - fixed - gap * Math.max(0, flowNodes.length - 1);
      const growFree = Math.max(0, free);
      // Growing children consume the available main-axis space, leaving no
      // additional free space for justify-content to distribute.
      // Flexbox keeps negative free space for positional alignment: center and
      // flex-end may overflow equally or toward the start edge. Edge's flex
      // layout falls back to start for all space-* values on negative space.
      const justifyFree = grow > 0 ? 0 : free;
      let itemGap = gap, offset = 0;
      if (justifyFree > 0 && node.style['justify-content'] === 'space-between' && flowNodes.length > 1) itemGap += justifyFree / (flowNodes.length - 1);
      else if (justifyFree > 0 && node.style['justify-content'] === 'space-around' && flowNodes.length) { itemGap += justifyFree / flowNodes.length; offset = justifyFree / flowNodes.length / 2; }
      else if (justifyFree > 0 && node.style['justify-content'] === 'space-evenly' && flowNodes.length) { itemGap += justifyFree / (flowNodes.length + 1); offset = justifyFree / (flowNodes.length + 1); }
      let cursor = vertical ? content.y : content.x;
      cursor += offset;
      const justify = node.style['justify-content'];
      if (justify === 'center') cursor += justifyFree / 2;
      if (justify === 'end' || justify === 'flex-end') cursor += justifyFree;
      const placed = flowNodes.map(child => {
        const flex = growFactor(child);
        const measured = intrinsicSize(child, content.width, content.height);
        const main = child.style.flex !== undefined
          ? (grow ? growFree * flex / grow : 0)
          : flexBasis(child) + (grow ? growFree * flex / grow : 0);
        const crossAvailable = vertical ? content.width : content.height;
        const cross = length(child.style[vertical ? 'width' : 'height'], crossAvailable, node.style['align-items'] === 'stretch' || !node.style['align-items'] ? crossAvailable : vertical ? measured.width : measured.height);
        const crossAlign = node.style['align-items'] || 'stretch';
        const crossOffset = crossAlign === 'center' ? ((vertical ? content.width : content.height) - cross) / 2 : crossAlign === 'end' || crossAlign === 'flex-end' ? (vertical ? content.width : content.height) - cross : 0;
        const childRect = vertical
          ? { x: content.x + crossOffset, y: cursor, width: cross, height: main, _flowMainAxis: 'height', _availableWidth: content.width, _availableHeight: content.height }
          : { x: cursor, y: content.y + crossOffset, width: main, height: cross, _flowMainAxis: 'width', _availableWidth: content.width, _availableHeight: content.height };
        cursor += main + itemGap;
        return childRect;
      });
      return mapFlowRects(node, participants, placed, box);
    };
    const gridChildren = (node, box) => {
      const participants = inFlowChildren(node);
      const expression = node.style['grid-template-columns'] || '1fr';
      const repeated = /^repeat\(\s*(\d+)\s*,\s*((?:\d+(?:\.\d+)?|\.\d+))?\s*(px|fr|%)\s*\)$/.exec(expression);
      let definitions = ['1fr'];
      if (repeated) {
        const count = Number(repeated[1]);
        if (!Number.isSafeInteger(count) || count < 1 || count > 2000) throw Error(`grid-template-columnsのrepeat列数は1〜2000で指定してください: ${expression}`);
        definitions = Array.from({ length: count }, () => `${repeated[2] || '1'}${repeated[3]}`);
      }
      else definitions = expression.trim().split(/\s+/);
      if (definitions.length > 2000) throw Error(`grid-template-columnsの列数は2000以内で指定してください: ${expression}`);
      const tracks = definitions.map(value => /^(\d+(?:\.\d+)?|\.\d+)(px|fr|%)$/.exec(value));
      if (!definitions.length || tracks.some(track => !track || !Number.isFinite(Number(track[1])))) throw Error(`grid-template-columnsは有限な数値のpx、%、fr列幅を指定してください: ${expression}`);
      const columns = definitions.length;
      const gap = length(node.style['column-gap'], box.width, 0), rowGap = length(node.style['row-gap'], box.height, 0);
      const available = Math.max(0, box.width - gap * (columns - 1));
      const parsed = tracks;
      const fixed = parsed.reduce((sum, part) => sum + (part[2] === 'px' ? Number(part[1]) : part[2] === '%' ? available * Number(part[1]) / 100 : 0), 0);
      if (!Number.isFinite(fixed)) throw Error(`grid-template-columnsの固定幅合計が有限範囲を超えています: ${expression}`);
      const maxFraction = parsed.reduce((maximum, part) => part[2] === 'fr' ? Math.max(maximum, Number(part[1])) : maximum, 0);
      const fractionWeights = parsed.map(part => part[2] === 'fr' && maxFraction > 0 ? Number(part[1]) / maxFraction : 0);
      const fractions = fractionWeights.reduce((sum, weight) => sum + weight, 0);
      const remaining = Math.max(0, available - fixed);
      const widths = parsed.map((part, index) => part[2] === 'px' ? Number(part[1]) : part[2] === '%' ? available * Number(part[1]) / 100 : fractions ? remaining * fractionWeights[index] / fractions : 0);
      const rowCount = Math.ceil(participants.length / columns);
      const autoRows = node.style['grid-auto-rows'] === undefined;
      const rowHeights = Array.from({ length: rowCount }, (_, row) => {
        if (!autoRows) return length(node.style['grid-auto-rows'], box.height, 0);
        const start = row * columns;
        return Math.max(0, ...participants.slice(start, start + columns).map(({ child }) => intrinsicSize(child, box.width, box.height).height));
      });
      if (autoRows && rowCount) {
        const trackTotal = rowHeights.reduce((sum, height) => sum + height, 0) + rowGap * Math.max(0, rowCount - 1);
        const stretch = Math.max(0, box.height - trackTotal) / rowCount;
        for (let row = 0; row < rowCount; row++) rowHeights[row] += stretch;
      }
      const rowOffsets = [];
      let rowOffset = 0;
      for (let row = 0; row < rowCount; row++) { rowOffsets[row] = rowOffset; rowOffset += rowHeights[row] + rowGap; }
      const placed = participants.map((_, index) => {
        const col = index % columns, row = Math.floor(index / columns);
        const rowHeight = rowHeights[row];
        const x = box.x + widths.slice(0,col).reduce((sum,width) => sum + width + gap,0);
        return { x, y: box.y + rowOffsets[row], width: widths[col], height: rowHeight, _availableWidth: widths[col], _availableHeight: rowHeight || box.height };
      });
      return mapFlowRects(node, participants, placed, box);
    };
    const place = (node, box, root = false, availableWidth = box.width, availableHeight = box.height) => {
      if (node.style.display === 'none') { node.rect = { ...box, width: 0, height: 0 }; return; }
      const padding = boxEdges(node.style, 'padding', availableWidth);
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const property = `padding-${side}`;
        if (String(node.style[property] || '').trim().endsWith('%')) node.style[property] = `${padding[side]}px`;
      }
      for (const [property, basis] of [['font-size', availableHeight], ['border-width', availableWidth]]) {
        const value = String(node.style[property] || '').trim();
        if (value && (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value) || value.endsWith('%'))) node.style[property] = `${length(value, basis)}px`;
      }
      if (String(node.style['line-height'] || '').endsWith('%')) {
        const authoredFontSize = String(node.style['font-size'] || '').trim();
        const fontSize = authoredFontSize ? length(authoredFontSize, availableHeight, 16) : 16;
        if (!authoredFontSize) node.style['font-size'] = '16px';
        node.style['line-height'] = `${fontSize * Number.parseFloat(node.style['line-height']) / 100}px`;
      }
      for (const child of node.children) if (!child.lineHeightSpecified && node.style['line-height'] !== undefined) child.style['line-height'] = node.style['line-height'];
      const border = length(node.style['border-width'], availableWidth, 0);
      const content = { x: box.x + border + padding.left, y: box.y + border + padding.top,
        width: Math.max(0, box.width - border * 2 - padding.left - padding.right),
        height: Math.max(0, box.height - border * 2 - padding.top - padding.bottom) };
      node.rect = box;
      const display = node.style.display || (root ? 'block' : 'block');
      let flowRects = [];
      if (display === 'flex') flowRects = flexChildren(node, content);
      else if (display === 'grid') flowRects = gridChildren(node, content);
      else {
        let nextY = content.y;
        const participants = inFlowChildren(node);
        const placed = participants.map(({ child }) => {
          const measured = intrinsicSize(child, content.width, content.height);
          const h = length(child.style.height, content.height, measured.height);
          const r = { x: content.x, y: nextY, width: length(child.style.width, content.width, content.width), height: h, _availableWidth: content.width, _availableHeight: content.height };
          nextY += h;
          return r;
        });
        flowRects = mapFlowRects(node, participants, placed, content);
      }
      node.children.forEach((child, index) => {
        const style = child.style;
        let childRect = flowRects[index] || { x: content.x, y: content.y, width: 0, height: 0 };
        const flowMainAxis = childRect._flowMainAxis;
        const childAvailableWidth = childRect._availableWidth ?? content.width;
        const childAvailableHeight = childRect._availableHeight ?? content.height;
        childRect = { x: childRect.x, y: childRect.y, width: childRect.width, height: childRect.height };
        if (style.position === 'absolute') {
          const w = length(style.width, content.width, childRect.width || content.width);
          const measured = intrinsicSize(child, content.width, content.height);
          const h = length(style.height, content.height, childRect.height || measured.height);
          const x = style.left !== undefined ? content.x + length(style.left, content.width) : style.right !== undefined ? content.x + content.width - length(style.right, content.width) - w : childRect.x;
          const y = style.top !== undefined ? content.y + length(style.top, content.height) : style.bottom !== undefined ? content.y + content.height - length(style.bottom, content.height) - h : childRect.y;
          childRect = { x, y, width: w, height: h };
        } else {
          if (flowMainAxis !== 'width') childRect.width = length(style.width, childAvailableWidth, childRect.width);
          if (flowMainAxis !== 'height') childRect.height = length(style.height, childAvailableHeight, childRect.height);
          if (style.position === 'relative') {
            const offsetX = style.left !== undefined ? length(style.left, content.width) : style.right !== undefined ? -length(style.right, content.width) : 0;
            const offsetY = style.top !== undefined ? length(style.top, content.height) : style.bottom !== undefined ? -length(style.bottom, content.height) : 0;
            childRect.x += offsetX;
            childRect.y += offsetY;
          }
        }
        place(child, childRect, false,
          style.position === 'absolute' ? content.width : childAvailableWidth,
          style.position === 'absolute' ? content.height : childAvailableHeight);
      });
    };
    laid.forEach(node => mergeStyles(node, rules, {}));
    laid.forEach(node => place(node, rect, true, rect.width, rect.height));
    const clearLineHeightMetadata = nodes => nodes.forEach(node => { delete node.lineHeightSpecified; clearLineHeightMetadata(node.children || []); });
    clearLineHeightMetadata(laid);
    const sortByStacking = node => {
      node.children.sort((a,b) => Number(a.style?.['z-index'] || 0) - Number(b.style?.['z-index'] || 0));
      node.children.forEach(sortByStacking);
    };
    laid.forEach(sortByStacking);
    return laid;
  }

  function compileScreenDocument(markup, stylesheet, canvas = DEFAULT_CANVAS, targets = [], controlSettings = {}, controlSkins = {}) {
    const skins = validateControlSkins(controlSkins);
    const nodes = parseMarkup(markup);
    if (nodes.length !== 1) throw Error('画面HTMLは1つのルート要素（通常はmain）で囲んでください。');
    const rules = parseStylesheet(stylesheet);
    normalizeViewportUnits(nodes, rules, canvas);
    nodes.forEach(node => mergeStyles(node, rules, {}, false));
    const expandRoles = (node, insideSlot = false) => {
      if (node.attrs['data-slot-field'] && !insideSlot) throw Error('data-slot-fieldはセーブ枠テンプレート内だけで使えます。');
      if (node.attrs['data-role']) {
        const role = node.attrs['data-role'];
        if (role === 'dialogue-history' || role === 'selected-slot-summary') { node.children.forEach(child => expandRoles(child, insideSlot)); return; }
        const count = Number(node.attrs['data-count'] || 8);
        if (node.children.length > 1 || (node.children.length && (node.children[0].tag !== 'button' || node.children[0].attrs['data-action'] || node.children[0].attrs.id))) throw Error('セーブ枠テンプレートは、idとdata-actionのないbuttonを1つだけ置いてください。');
        const prototype = node.children[0];
        const validate = (child, root = false) => {
          if (child.attrs['data-role'] || child.attrs['data-count'] || (!root && (child.tag === 'button' || child.attrs['data-action'] || child.attrs.id))) throw Error('セーブ枠の内部には別のrole・ボタン・動作・idを置けません。');
          child.children.forEach(grandchild => validate(grandchild));
        };
        if (prototype) validate(prototype, true);
        node.children = Array.from({ length: count }, (_, index) => {
          const item = prototype ? JSON.parse(JSON.stringify(prototype)) : { tag: 'button', attrs: { class: `save-slot save-slot-${role}` }, text: '', children: [] };
          item.attrs = { ...item.attrs, id: `${role}-${index + 1}`, 'data-action': 'slot-select', 'data-slot-index': String(index) };
          return item;
        });
      } else node.children.forEach(child => expandRoles(child, insideSlot));
    };
    nodes.forEach(expandRoles);
    let sourceOrder = 0;
    const recordSourceOrder = node => {
      node.sourceOrder = sourceOrder++;
      node.children.forEach(recordSourceOrder);
    };
    nodes.forEach(recordSourceOrder);
    nodes.forEach(node => mergeStyles(node, rules, {}));
    const actions = [];
    const collect = node => {
      if (node.attrs['data-action'] === 'open-screen' && targets.length && !targets.includes(node.attrs['data-target'])) throw Error(`画面HTMLの遷移先がありません: ${node.attrs['data-target']}`);
      if (node.tag === 'input' && !Object.hasOwn(controlSettings, node.attrs['data-setting'])) throw Error(`data-settingが画面コントロール設定にありません: ${node.attrs['data-setting']}`);
      if (node.tag === 'input' && (node.attrs.type === 'checkbox') !== (typeof controlSettings[node.attrs['data-setting']] === 'boolean')) throw Error(`data-settingの型がinput typeと一致しません: ${node.attrs['data-setting']}`);
      if (node.attrs['data-skin']) {
        const skin = skins[node.attrs['data-skin']];
        if (!skin) throw Error(`画面コントロールのスキンがありません: ${node.attrs['data-skin']}`);
        if (skin.type !== node.attrs.type) throw Error(`スキン '${node.attrs['data-skin']}' とinput typeが一致しません。`);
        node.controlSkin = { ...skin };
      }
      if (node.attrs['data-action']) actions.push(node.attrs['data-action']);
      if (node.tag === 'img' && node.attrs.src) {
        const source = node.attrs.src.replaceAll('\\', '/').replace(/^asset\//i, '');
        if (source.startsWith('/') || /^[A-Za-z]:/.test(source) || source.split('/').some(part => !part || part === '.' || part === '..')) throw Error('img srcはasset内の相対パスにしてください。');
        node.attrs.src = source;
      }
      node.children.forEach(collect);
    };
    nodes.forEach(collect);
    const tree = layoutNodes(nodes, { x: 0, y: 0, width: canvas.width, height: canvas.height }, rules);
    return { tree, actions };
  }

  function textContent(node) { return [node.text || '', ...(node.children || []).map(textContent)].filter(Boolean).join(' ').trim(); }
  function compileGameScreens(value, documents, canvas) {
    const result = JSON.parse(JSON.stringify(value));
    result.controlSkins = validateControlSkins(result.controlSkins || {});
    const controlSettings = result.controlSettings ? parseControlSettings(documents?.[result.controlSettings]) : {};
    result.controlDefaults = controlSettings;
    if (result.controlSettings) result.controlSchema = compileControlSchema(controlSettings);
    else delete result.controlSchema;
    for (const [screenId, screen] of Object.entries(result.screens || {})) {
      if (!screen.template) continue;
      const markup = documents?.[screen.template];
      const stylesheet = result.stylesheet ? documents?.[result.stylesheet] : '';
      if (typeof markup !== 'string') throw Error(`画面HTMLがありません: ${screen.template}`);
      if (result.stylesheet && typeof stylesheet !== 'string') throw Error(`画面CSSがありません: ${result.stylesheet}`);
      let compiled;
      try {
        compiled = compileScreenDocument(markup, stylesheet || '', canvas || result.canvas || DEFAULT_CANVAS, Object.keys(result.screens), controlSettings, result.controlSkins);
      } catch (error) {
        const sources = [`HTML: ${screen.template}`];
        if (result.stylesheet) sources.push(`CSS: ${result.stylesheet}`);
        throw Error(`画面「${screenId}」（${sources.join('、')}）: ${error.message}`);
      }
      screen.uiTree = compiled.tree;
      const items = [];
      const visit = (node, path = []) => {
        node.focusKey = `${screenId}:${path.join('.')}`;
        if (node.style?.display === 'none') return;
        const action = node.attrs?.['data-action'];
        if (action) {
          if (items.length >= 100) throw Error(`画面 '${screenId}' の動作要素は100個以内にしてください。`);
          items.push({
          id: node.attrs.id || `html_${items.length + 1}`, type: 'button', action,
          ...(node.attrs['data-target'] ? { target: node.attrs['data-target'] } : {}),
          ...(node.attrs['data-value'] ? { value: Object.hasOwn(ENUM_CONTROL_VALUES, node.attrs['data-target']) ? node.attrs['data-value'] : node.attrs['data-value'] === 'true' } : {}),
          ...(node.attrs['data-slot-index'] !== undefined ? { slotIndex: Number(node.attrs['data-slot-index']) } : {}),
          label: textContent(node), x: Math.round(node.rect.x), y: Math.round(node.rect.y),
          width: Math.max(1, Math.round(node.rect.width)), height: Math.max(1, Math.round(node.rect.height)),
          });
        }
        if (node.attrs?.['data-role'] === 'save-slots' || node.attrs?.['data-role'] === 'load-slots') {
          screen.role = node.attrs['data-role'];
          const rect = node.rect;
          screen.slotLayout = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)), rowHeight: Math.max(1, Math.round(node.children[0]?.rect.height || 48)), gap: 0, count: node.children.length };
        }
        const sourceChildren = (node.children || []).slice().sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0));
        sourceChildren.forEach((child, index) => visit(child, [...path, index]));
      };
      screen.uiTree.forEach((node, index) => visit(node, [index]));
      screen.items = items;
    }
    if (!result.screens?.[result.initial]?.items?.some(item => item.action === 'start')) {
      throw Error('開始画面には「ゲーム開始」ボタンが必要です。');
    }
    return result;
  }

  function buildScreenDom(tree, documentRef, options = {}) {
    const scaleX = options.scaleX ?? 1, scaleY = options.scaleY ?? 1;
    const setStyle = (element, style = {}, rect = {}, applyCanvasOffset = false) => {
      element.style.position = 'absolute';
      // Native has no browser user-agent stylesheet. Remove defaults that
      // shift authored geometry or add list markers before applying CSS.
      element.style.margin = '0';
      if (element.tagName === 'UL' || element.tagName === 'OL') {
        element.style.padding = '0';
        element.style.listStyle = 'none';
      }
      // Shared rects describe the painted outer box, including authored
      // padding. Native draws backgrounds and borders from that rect, so the
      // Browser DOM must not add padding to the width/height a second time.
      element.style.boxSizing = 'border-box';
      // Native paints each shared node's children in local z-index order, so
      // even an unstyled parent forms a stacking boundary. Give every DOM
      // node the same default layer to prevent a high-z descendant from
      // escaping an ancestor in Browser rendering.
      element.style.zIndex = String(style['z-index'] ?? 0);
      const offsetX = applyCanvasOffset ? options.offsetX || 0 : 0;
      const offsetY = applyCanvasOffset ? options.offsetY || 0 : 0;
      element.style.left = `${rect.x * scaleX + offsetX}px`; element.style.top = `${rect.y * scaleY + offsetY}px`;
      element.style.width = `${rect.width * scaleX}px`; element.style.height = `${rect.height * scaleY}px`;
      for (const [key, value] of Object.entries(style)) {
        if (key === 'border') continue; // Shorthand is expanded by parseDeclarations for both renderers.
        const property = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        if (['position','left','right','top','bottom','width','height','flex','flex-grow','flex-direction','justify-content','align-items','gap','row-gap','column-gap','grid-template-columns','grid-template-rows','grid-auto-rows'].includes(property)) continue;
        let resolved = value;
        if (['font-size', 'line-height', 'gap', 'row-gap', 'column-gap', 'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'border-radius', 'border-width'].includes(property)) {
          const number = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(value);
          const scale = property === 'padding-left' || property === 'padding-right' ? scaleX
            : property === 'border-width' ? Math.min(scaleX, scaleY) : scaleY;
          if (number) resolved = `${Number(number[1]) * scale}px`;
        }
        if (property === 'background-image' || property === 'background') resolved = value.replace(/url\((["']?)([^"')]+)\1\)/g, (_all, _quote, path) => `url("${options.assetUrl ? options.assetUrl(path.replace(/^asset\//, '')) : path}")`);
        element.style.setProperty(property, resolved);
      }
      const backgroundImage = style['background-image'] || (String(style.background || '').startsWith('url(') ? style.background : '');
      if (backgroundImage) {
        element.style.backgroundRepeat = 'no-repeat';
        element.style.backgroundPosition = 'center';
        element.style.backgroundSize = style['background-size'] || '100% 100%';
      }
    };
    const rendererStyle = (node, style = {}, slotStateStyle = {}) => {
      const result = { ...style };
      const own = node.specifiedStyle;
      if (!own) return result;
      for (const key of INHERITED) {
        if (own[key] === undefined && node.hoverStyle?.[key] === undefined && node.focusStyle?.[key] === undefined
          && node.focusVisibleStyle?.[key] === undefined && slotStateStyle[key] === undefined) delete result[key];
      }
      return result;
    };
    const assetUrl = image => options.assetUrl ? options.assetUrl(String(image).replace(/^asset\//, '')) : image;
    const mountSkinnedInput = (node, localRect, applyCanvasOffset) => {
      const skin = node.controlSkin, attrs = node.attrs || {}, setting = attrs['data-setting'];
      const wrapper = documentRef.createElement('div');
      wrapper.className = `${attrs.class || ''} novel-skinned-control`.trim();
      wrapper.dataset.skin = attrs['data-skin'];
      setStyle(wrapper, rendererStyle(node, node.style), localRect, applyCanvasOffset);
      const input = documentRef.createElement('input');
      input.type = attrs.type;
      if (attrs.id) input.id = attrs.id;
      input.dataset.setting = setting;
      input.setAttribute('aria-hidden', 'false');
      if (attrs['aria-label']) input.setAttribute('aria-label', attrs['aria-label']);
      if (attrs.tabindex !== undefined) input.tabIndex = Number(attrs.tabindex);
      input.min = attrs.min || '0'; input.max = attrs.max || '1'; input.step = attrs.step || '0.01';
      const value = options.settings?.[setting] ?? options.controlDefaults?.[setting] ?? (attrs.type === 'checkbox' ? false : Number(attrs.value ?? 0));
      if (attrs.type === 'checkbox') input.checked = Boolean(value);
      else input.value = String(value);
      Object.assign(input.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', margin: '0', opacity: '0', pointerEvents: 'none', appearance: 'none', zIndex: '4' });
      const image = (src, className) => {
        const element = documentRef.createElement('img');
        element.className = className;
        element.alt = '';
        element.setAttribute('aria-hidden', 'true');
        element.draggable = false;
        Object.assign(element.style, { position: 'absolute', display: 'block', objectFit: 'fill', pointerEvents: 'none', userSelect: 'none' });
        element.dataset.assetSource = src;
        element.src = assetUrl(src);
        wrapper.append(element);
        return element;
      };
      const type = attrs.type;
      let track, fillClip, fill, thumb, updateVisual;
      if (type === 'range') {
        const vertical = skin.orientation === 'vertical';
        const rectWidth = localRect.width * scaleX, rectHeight = localRect.height * scaleY;
        const thumbWidth = skin.thumbWidth * scaleX, thumbHeight = skin.thumbHeight * scaleY;
        const inset = skin.inset * (vertical ? scaleY : scaleX);
        const railWidth = vertical ? skin.trackHeight * scaleX : Math.max(0, rectWidth - inset * 2);
        const railHeight = vertical ? Math.max(0, rectHeight - inset * 2) : skin.trackHeight * scaleY;
        const railLeft = vertical ? (rectWidth - railWidth) / 2 : inset;
        const railTop = vertical ? inset : (rectHeight - railHeight) / 2;
        track = image(skin.track, 'novel-skin-track');
        Object.assign(track.style, { left: `${railLeft}px`, top: `${railTop}px`, width: `${railWidth}px`, height: `${railHeight}px` });
        fillClip = documentRef.createElement('div');
        fillClip.className = 'novel-skin-fill-clip';
        Object.assign(fillClip.style, { position: 'absolute', overflow: 'hidden', pointerEvents: 'none', left: `${railLeft}px`, top: `${railTop}px`, width: `${railWidth}px`, height: `${railHeight}px` });
        fill = documentRef.createElement('img');
        fill.alt = ''; fill.setAttribute('aria-hidden', 'true'); fill.draggable = false;
        Object.assign(fill.style, { position: 'absolute', left: '0', top: '0', width: `${railWidth}px`, height: `${railHeight}px`, objectFit: 'fill', pointerEvents: 'none' });
        fill.src = assetUrl(skin.fill); fillClip.append(fill); wrapper.append(fillClip);
        thumb = image(skin.thumb, 'novel-skin-thumb');
        Object.assign(thumb.style, { width: `${thumbWidth}px`, height: `${thumbHeight}px` });
        updateVisual = () => {
          const min = Number(input.min), max = Number(input.max), ratio = Math.max(0, Math.min(1, (Number(input.value) - min) / (max - min)));
          if (vertical) {
            const fillHeight = railHeight * ratio;
            fillClip.style.left = `${railLeft}px`; fillClip.style.top = `${railTop + railHeight - fillHeight}px`;
            fillClip.style.width = `${railWidth}px`; fillClip.style.height = `${fillHeight}px`;
            fill.style.left = '0'; fill.style.top = `${-railHeight + fillHeight}px`;
            thumb.style.left = `${(rectWidth - thumbWidth) / 2}px`;
            thumb.style.top = `${railTop + railHeight * (1 - ratio) - thumbHeight / 2}px`;
          } else {
            fillClip.style.left = `${railLeft}px`; fillClip.style.top = `${railTop}px`;
            fillClip.style.width = `${railWidth * ratio}px`; fillClip.style.height = `${railHeight}px`;
            fill.style.left = '0'; fill.style.top = '0';
            thumb.style.left = `${railLeft + railWidth * ratio - thumbWidth / 2}px`;
            thumb.style.top = `${(rectHeight - thumbHeight) / 2}px`;
          }
          const active = hovered || focused;
          const selectedImage = active ? skin.thumbHover || skin.thumb : skin.thumb;
          if (thumb.dataset.assetSource !== selectedImage) { thumb.dataset.assetSource = selectedImage; thumb.src = assetUrl(selectedImage); }
        };
        const setValueFromPointer = event => {
          const bounds = wrapper.getBoundingClientRect();
          const scaledInset = (vertical ? bounds.height / Math.max(1, rectHeight) : bounds.width / Math.max(1, rectWidth)) * inset;
          const position = vertical ? bounds.bottom - scaledInset - event.clientY : event.clientX - bounds.left - scaledInset;
          const extent = (vertical ? bounds.height : bounds.width) - scaledInset * 2;
          const ratio = Math.max(0, Math.min(1, position / Math.max(1, extent)));
          const min = Number(input.min), max = Number(input.max), step = Number(input.step);
          const next = Math.max(min, Math.min(max, min + Math.round((ratio * (max - min)) / step) * step));
          input.value = String(Number(next.toFixed(8)));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        wrapper.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          event.preventDefault(); input.focus(); wrapper.setPointerCapture?.(event.pointerId); setValueFromPointer(event);
        });
        wrapper.addEventListener('pointermove', event => { if (wrapper.hasPointerCapture?.(event.pointerId)) setValueFromPointer(event); });
        const releasePointer = event => { if (wrapper.hasPointerCapture?.(event.pointerId)) wrapper.releasePointerCapture(event.pointerId); };
        wrapper.addEventListener('pointerup', releasePointer);
        wrapper.addEventListener('pointercancel', releasePointer);
      } else {
        wrapper.style.cursor = 'pointer';
        const drawCheckbox = () => {
          const checked = input.checked, active = hovered || focused;
          const imageName = checked ? (active ? skin.onHover || skin.on : skin.on) : (active ? skin.offHover || skin.off : skin.off);
          let icon = wrapper.querySelector('.novel-skin-checkbox');
          if (!icon) { icon = image(imageName, 'novel-skin-checkbox'); Object.assign(icon.style, { inset: '0', width: '100%', height: '100%' }); }
          else if (icon.dataset.assetSource !== imageName) { icon.dataset.assetSource = imageName; icon.src = assetUrl(imageName); }
        };
        updateVisual = drawCheckbox;
        wrapper.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          event.preventDefault(); input.focus(); input.checked = !input.checked;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      let hovered = false, focused = false;
      const focusVisibleStyle = node.focusVisibleStyle || {};
      const updateState = () => {
        const visible = focused && input.matches(':focus-visible');
        const stateStyle = { ...node.style, ...(hovered ? node.hoverStyle || {} : {}), ...(focused ? node.focusStyle || {} : {}), ...(visible ? focusVisibleStyle : {}) };
        setStyle(wrapper, rendererStyle(node, stateStyle), localRect, applyCanvasOffset);
        updateVisual();
      };
      input.addEventListener(type === 'checkbox' ? 'change' : 'input', event => {
        updateVisual();
        options.onSettingChange?.(setting, type === 'checkbox' ? event.currentTarget.checked : Number(event.currentTarget.value), event, node);
      });
      wrapper.addEventListener('pointerenter', () => { hovered = true; updateState(); });
      wrapper.addEventListener('pointerleave', () => { hovered = false; updateState(); });
      input.addEventListener('focus', () => { focused = true; updateState(); });
      input.addEventListener('blur', () => { focused = false; updateState(); });
      input.addEventListener('keydown', updateState);
      wrapper.append(input);
      updateVisual();
      return wrapper;
    };
    const mount = (node, parentRect = { x: 0, y: 0 }, slotContext = null, applyCanvasOffset = false) => {
      const localRect = { ...node.rect, x: node.rect.x - parentRect.x, y: node.rect.y - parentRect.y };
      const hasLocalSlot = node.attrs?.['data-slot-index'] !== undefined;
      const localSlot = hasLocalSlot ? Number(node.attrs['data-slot-index']) : slotContext;
      const currentSlot = localSlot === null ? null : localSlot + (hasLocalSlot ? options.slotIndexOffset || 0 : 0);
      if (node.attrs?.['data-role'] && node.attrs['data-role'] !== 'save-slots' && node.attrs['data-role'] !== 'load-slots' && options.roleContent) {
        const host = documentRef.createElement('div');
        host.dataset.role = node.attrs['data-role'];
        if (node.attrs.id) host.id = node.attrs.id;
        if (node.attrs.class) host.className = node.attrs.class;
        if (node.attrs['aria-label']) host.setAttribute('aria-label', node.attrs['aria-label']);
        if (node.attrs['data-count']) host.dataset.count = node.attrs['data-count'];
        setStyle(host, rendererStyle(node, node.style), localRect, applyCanvasOffset);
        options.roleContent(host, node);
        return host;
      }
      if (node.tag === 'input' && node.controlSkin) return mountSkinnedInput(node, localRect, applyCanvasOffset);
      const element = documentRef.createElement(node.tag === 'screen-root' ? 'div' : node.tag);
      let actionDisabled = false;
      if (node.attrs?.id) element.id = node.attrs.id;
      if (node.attrs?.class) element.className = node.attrs.class;
      if (node.tag === 'label' && node.attrs?.for) element.htmlFor = node.attrs.for;
      if (node.attrs?.tabindex !== undefined) element.setAttribute('tabindex', node.attrs.tabindex);
      if (node.attrs?.['data-slot-index'] !== undefined) element.dataset.slotIndex = String(currentSlot);
      const slotState = hasLocalSlot ? options.slotState?.(currentSlot) || 'empty' : '';
      if (hasLocalSlot) element.dataset.state = slotState;
      const slotStateStyle = slotState ? node.slotStateStyles?.[slotState] || {} : {};
      if (node.attrs?.['data-slot-field']) element.dataset.slotField = node.attrs['data-slot-field'];
      if (node.tag === 'button') element.type = 'button';
      // An empty alt is meaningful: it marks a decorative image. Preserve the
      // attribute itself instead of dropping it through a truthiness check.
      if (Object.hasOwn(node.attrs || {}, 'alt')) element.setAttribute('alt', node.attrs.alt);
      if (node.attrs?.['aria-label']) element.setAttribute('aria-label', node.attrs['aria-label']);
      if (node.tag === 'input') {
        const setting = node.attrs['data-setting'];
        element.type = node.attrs.type;
        element.dataset.setting = setting;
        element.min = node.attrs.min || '0'; element.max = node.attrs.max || '1'; element.step = node.attrs.step || '0.01';
        const value = options.settings?.[setting] ?? options.controlDefaults?.[setting] ?? (node.attrs.type === 'checkbox' ? false : Number(node.attrs.value ?? 0));
        if (node.attrs.type === 'checkbox') element.checked = Boolean(value);
        else element.value = String(value);
        element.addEventListener(node.attrs.type === 'checkbox' ? 'change' : 'input', event => options.onSettingChange?.(setting, node.attrs.type === 'checkbox' ? event.currentTarget.checked : Number(event.currentTarget.value), event, node));
      }
      const applyElementStyle = style => {
        setStyle(element, rendererStyle(node, style, slotStateStyle), localRect, applyCanvasOffset);
        // Native dims unavailable screen actions as a whole; mirror that on
        // the Browser DOM while leaving disabled save-slot information cards
        // legible (their state styling owns their appearance).
        if (actionDisabled && node.attrs?.['data-action'] && !hasLocalSlot) {
          const authoredOpacity = Number(style.opacity ?? 1);
          element.style.opacity = String((Number.isFinite(authoredOpacity) ? authoredOpacity : 1) * 0.45);
        }
      };
      if (node.attrs?.['data-slot-field'] && currentSlot !== null) {
        const value = String(options.slotField?.(currentSlot, node.attrs['data-slot-field']) ?? '');
        if (node.tag === 'img') {
          if (value) element.src = value;
          else { element.removeAttribute('src'); element.style.display = 'none'; }
        }
        else element.textContent = value;
      }
      else if (node.text) element.textContent = node.text;
      if (node.text?.includes('\n')) element.style.whiteSpace = 'pre-line';
      if (node.tag === 'img' && node.attrs.src && !node.attrs['data-slot-field']) element.src = options.assetUrl ? options.assetUrl(node.attrs.src) : node.attrs.src;
      if (node.attrs?.['data-action']) {
        element.dataset.action = node.attrs['data-action'];
        if (node.attrs['data-target']) element.dataset.target = node.attrs['data-target'];
        if (node.attrs['data-value']) element.dataset.value = node.attrs['data-value'];
        actionDisabled = (node.attrs['data-action'] === 'load' && options.disableLoad)
          || (node.attrs['data-action'] === 'save' && options.disableSave)
          || (node.attrs['data-action'] === 'continue' && options.disableContinue);
        if (actionDisabled) {
          if ('disabled' in element) element.disabled = true;
          else {
            element.setAttribute('aria-disabled', 'true');
            element.tabIndex = -1;
            element.style.pointerEvents = 'none';
          }
        }
        element.addEventListener('click', event => {
          event.stopPropagation();
          if (actionDisabled) { event.preventDefault(); return; }
          const actionNode = currentSlot === null ? node : { ...node, attrs: { ...node.attrs, 'data-slot-index': String(currentSlot) } };
          options.onAction?.(node.attrs['data-action'], node.attrs['data-target'], event, actionNode);
        });
      }
      applyElementStyle({ ...node.style, ...slotStateStyle });
      const hover = node.hoverStyle || {}, focus = node.focusStyle || {}, focusVisible = node.focusVisibleStyle || {};
      if (Object.keys(hover).length || Object.keys(focus).length || Object.keys(focusVisible).length) {
        let pointerActive = false, focusActive = false;
        const update = () => {
          const visible = focusActive && element.matches(':focus-visible');
          const stateStyle = { ...node.style, ...slotStateStyle, ...(pointerActive ? hover : {}), ...(focusActive ? focus : {}), ...(visible ? focusVisible : {}) };
          for (const key of new Set([...Object.keys(hover), ...Object.keys(focus), ...Object.keys(focusVisible)])) {
            if (stateStyle[key] === undefined) element.style.removeProperty(key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`));
          }
          applyElementStyle(stateStyle);
        };
        element.addEventListener('pointerenter', () => { pointerActive = true; update(); });
        element.addEventListener('pointerleave', () => { pointerActive = false; update(); });
        element.addEventListener('pointerdown', update);
        element.addEventListener('focus', () => { focusActive = true; update(); });
        element.addEventListener('blur', () => { focusActive = false; update(); });
        element.addEventListener('keydown', update);
      }
      const sourceChildren = (node.children || []).slice().sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0));
      const border = length(node.style?.['border-width'], 0, 0);
      const childOrigin = { x: node.rect.x + border, y: node.rect.y + border };
      for (const child of sourceChildren) element.append(mount(child, childOrigin, currentSlot, false));
      if (node.attrs?.['data-slot-index'] !== undefined) options.roleSlot?.(element, currentSlot, node);
      return element;
    };
    const fragment = documentRef.createDocumentFragment();
    for (const node of tree || []) fragment.append(mount(node, { x: 0, y: 0 }, null, true));
    return fragment;
  }


  return { DEFAULT_CANVAS, parseMarkup, parseStylesheet, parseControlSettings, validateControlSkins, compileScreenDocument, compileGameScreens, canvasTransform, buildScreenDom, shortcutActions: SHORTCUT_ACTIONS, shortcutActionLabels: SHORTCUT_ACTION_LABELS };
});
