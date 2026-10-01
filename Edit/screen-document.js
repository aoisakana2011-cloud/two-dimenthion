'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NovelScreenDocument = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const TAGS = new Set(['main', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'small', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'label', 'button', 'input', 'img', 'br', 'save-slots']);
  const ACTIONS = new Set(['start', 'continue', 'resume', 'save', 'load', 'open-screen', 'back', 'quit']);
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
  const INHERITED = new Set(['color', 'font-size', 'text-align']);
  const CONTROL_TYPES = new Set(['range', 'checkbox']);
  const CONTROL_KEYS = new Set(['audio.master', 'audio.bgm', 'audio.se', 'audio.voice', 'audio.bgmMuted', 'audio.seMuted', 'audio.voiceMuted', 'ui.dialogOpacity']);

  function parseControlSettings(source) {
    if (typeof source !== 'string' || source.length > 20_000) throw Error('画面コントロール設定は20KB以内で指定してください。');
    const settings = {};
    for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^([A-Za-z][\w.]*)\s*=\s*(.+)$/.exec(line);
      if (!match || !CONTROL_KEYS.has(match[1]) || Object.hasOwn(settings, match[1])) throw Error(`画面コントロール設定の${index + 1}行目が不正、未対応、または重複しています。`);
      const key = match[1], sourceValue = match[2].trim();
      if (key.endsWith('Muted')) {
        if (!['true', 'false'].includes(sourceValue)) throw Error(`${key}はtrueまたはfalseで指定してください。`);
        settings[key] = sourceValue === 'true';
      } else {
        const value = Number(sourceValue);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw Error(`${key}は0〜1の数値で指定してください。`);
        settings[key] = value;
      }
    }
    return settings;
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
        if (text) stack.at(-1).text += (stack.at(-1).text ? ' ' : '') + text;
        continue;
      }
      if (/^<!|^<\?/.test(token)) continue;
      const closing = /^<\s*\//.test(token);
      const name = /^<\s*\/?\s*([A-Za-z][\w-]*)/.exec(token)?.[1]?.toLowerCase();
      if (!name || !TAGS.has(name)) throw Error(`画面HTMLに未対応の要素があります: ${name || token.slice(0, 24)}`);
      if (closing) {
        if (stack.length === 1 || stack.at(-1).tag !== name) throw Error(`画面HTMLの閉じタグが一致しません: ${name}`);
        stack.pop();
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
        if (key.startsWith('on') || !['id', 'class', 'src', 'alt', 'title', 'for', 'type', 'min', 'max', 'step', 'value', 'checked', 'aria-label', 'aria-hidden', 'tabindex', 'data-action', 'data-target', 'data-role', 'data-count', 'data-setting', 'data-slot-field'].includes(key)) throw Error(`画面HTMLに未対応の属性があります: ${key}`);
        if (Object.hasOwn(attrs, key)) throw Error(`画面HTMLの属性が重複しています: ${key}`);
        attrs[key] = value;
      }
      if (rawAttrs.slice(consumedAttributes).trim()) throw Error('HTML属性は引用符付きの値で指定してください。');
      if (name === 'img' && !attrs.src && attrs['data-slot-field'] !== 'thumbnail') throw Error('img要素にはsrcかサムネイルの指定が必要です。');
      if (name === 'input') {
        if (!CONTROL_TYPES.has(attrs.type) || !attrs['data-setting'] || !CONTROL_KEYS.has(attrs['data-setting'])) throw Error('inputには対応するtypeとdata-settingが必要です。');
        if (attrs.type === 'range') {
          const min = Number(attrs.min ?? 0), max = Number(attrs.max ?? 1), step = Number(attrs.step ?? 0.01);
          if (![min, max, step].every(Number.isFinite) || min < 0 || max > 1 || max <= min || step <= 0 || step > max - min) throw Error('rangeのmin/max/stepは0〜1の有効範囲で指定してください。');
          if (attrs['data-setting'].endsWith('Muted')) throw Error('Muted設定はcheckboxを使ってください。');
        } else if (!attrs['data-setting'].endsWith('Muted')) throw Error('checkboxはMuted設定にのみ使用できます。');
      } else if (attrs['data-setting']) throw Error('data-settingはinputでのみ使用できます。');
      if (attrs['data-action'] && !ACTIONS.has(attrs['data-action'])) throw Error(`未対応の画面動作です: ${attrs['data-action']}`);
      if (attrs['data-action'] === 'open-screen' && !attrs['data-target']) throw Error('open-screenにはdata-targetが必要です。');
      if (attrs['data-role'] && !['save-slots', 'load-slots'].includes(attrs['data-role'])) throw Error(`未対応の画面roleです: ${attrs['data-role']}`);
      if (attrs['data-count'] && (!/^\d+$/.test(attrs['data-count']) || Number(attrs['data-count']) < 1 || Number(attrs['data-count']) > 100)) throw Error('data-countは1〜100の整数です。');
      if (attrs['data-slot-field'] && !SLOT_FIELDS.has(attrs['data-slot-field'])) throw Error(`未対応のセーブ枠フィールドです: ${attrs['data-slot-field']}`);
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

  function parseDeclarations(source) {
    const style = {};
    const sharedColor = value => value === 'transparent' || /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)
      || /^rgb\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\)$/i.test(value)
      || /^rgba\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*(?:0(?:\.\d+)?|\.\d+|1(?:\.0+)?)\s*\)$/i.test(value);
    for (const declaration of source.split(';')) {
      if (!declaration.trim()) continue;
      const colon = declaration.indexOf(':');
      if (colon < 1) throw Error('CSSの宣言は「property: value;」形式で指定してください。');
      const key = declaration.slice(0, colon).trim().toLowerCase(), value = declaration.slice(colon + 1).trim();
      if (!PROPERTIES.has(key) && !/^--[a-z][\w-]*$/.test(key)) throw Error(`未対応の画面CSSプロパティです: ${key}`);
      if (!value || value.length > 1000 || /[{}<>;]/.test(value) || /expression\s*\(|javascript:|data:|@import/i.test(value)) throw Error(`CSS値が不正です: ${key}`);
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
      if (['color','background-color','border-color','accent-color'].includes(key) && !sharedColor(value) && !/^var\(--[a-z][\w-]*\)$/.test(value)) throw Error(`${key}は色またはCSS変数で指定してください。`);
      if (key === 'background' && !/url\s*\(/i.test(value) && !sharedColor(value) && !/^(?:linear|radial)-gradient\(.+\)$/i.test(value) && !/^var\(--[a-z][\w-]*\)$/i.test(value)) throw Error('backgroundの値が不正です。');
      if (key === 'border' && !/^(?:\d+(?:\.\d+)?px\s+)?solid\s+(.+)$/.test(value)) throw Error('borderは「1px solid #RRGGBB」形式で指定してください。');
      style[key] = value;
    }
    return style;
  }

  function parseStylesheet(css) {
    if (typeof css !== 'string' || css.length > 80_000) throw Error('画面CSSは80KB以内で指定してください。');
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/@|url\s*\([^)]*(?:https?:|\\|\.\.)/i.test(source)) throw Error('画面CSSの外部参照やat-ruleは使用できません。');
    const rules = [];
    const pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match, consumed = '';
    while ((match = pattern.exec(source))) {
      consumed += match[0];
      const declarations = parseDeclarations(match[2]);
      for (const selector of match[1].split(',')) {
        const normalized = selector.trim();
        const matchSelector = /^([A-Za-z][\w-]*)?(?:#([A-Za-z][\w-]*))?((?:\.[A-Za-z_][\w-]*)*)(:hover)?$/.exec(normalized);
        if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9_#.\s>+~:\[\]="'()\-*]+$/.test(normalized)) throw Error(`画面CSSのセレクターが不正です: ${normalized}`);
        rules.push({ selector: normalized, tag: matchSelector?.[1]?.toLowerCase() || '', id: matchSelector?.[2] || '', classes: matchSelector?.[3].split('.').filter(Boolean) || [], hover: Boolean(matchSelector?.[4]), webOnly: !matchSelector, declarations });
      }
    }
    if (source.replace(pattern, '').trim()) throw Error('画面CSSのルール構文が不正です。');
    return rules;
  }

  function matches(node, rule) {
    return !rule.webOnly && (!rule.tag || node.tag === rule.tag) && (!rule.id || node.attrs.id === rule.id)
      && rule.classes.every(name => (node.attrs.class || '').split(/\s+/).includes(name));
  }
  function mergeStyles(node, rules, inherited) {
    const base = {}, hover = {};
    for (const key of INHERITED) if (inherited[key] !== undefined) base[key] = inherited[key];
    for (const rule of rules) if (matches(node, rule)) Object.assign(rule.hover ? hover : base, rule.declarations);
    Object.assign(base, node.attrs.style || {});
    const nextInherited = { ...inherited };
    for (const key of INHERITED) if (base[key] !== undefined) nextInherited[key] = base[key];
    node.style = base; node.hoverStyle = hover; node.inherited = nextInherited;
    node.children.forEach(child => mergeStyles(child, rules, nextInherited));
  }

  function length(value, available, fallback = 0) {
    if (value === undefined) return fallback;
    const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|%|vw|vh)?$/i.exec(String(value).trim());
    if (!match) throw Error(`寸法はpx、%、vw、vhで指定してください: ${value}`);
    const number = Number(match[1]);
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) throw Error(`寸法が範囲外です: ${value}`);
    return match[2] === '%' ? available * number / 100 : number;
  }
  function edge(style, key, available) { return length(style[key], available, 0); }
  function boxEdges(style, prefix, available) {
    const all = (style[prefix] === undefined ? 0 : length(style[prefix], available));
    return {
      left: edge(style, `${prefix}-left`, available) || all,
      right: edge(style, `${prefix}-right`, available) || all,
      top: edge(style, `${prefix}-top`, available) || all,
      bottom: edge(style, `${prefix}-bottom`, available) || all,
    };
  }
  function intrinsicSize(node, availableWidth, availableHeight) {
    const style = node.style || {};
    const children = node.children || [];
    const vertical = style.display === 'flex' && (style['flex-direction'] || 'row') === 'column';
    const gap = length(style.gap || (vertical ? style['row-gap'] : style['column-gap']), vertical ? availableHeight : availableWidth, 0);
    const padding = boxEdges(style, 'padding', availableWidth);
    const measured = children.map(child => intrinsicSize(child, availableWidth, availableHeight));
    const contentWidth = vertical ? Math.max(0, ...measured.map(size => size.width)) : measured.reduce((sum, size) => sum + size.width, 0) + gap * Math.max(0, children.length - 1);
    const contentHeight = vertical ? measured.reduce((sum, size) => sum + size.height, 0) + gap * Math.max(0, children.length - 1) : Math.max(0, ...measured.map(size => size.height));
    const fallbackHeight = node.text ? Math.max(24, length(style['font-size'], availableHeight, 16) * 1.5) : 0;
    return {
      width: length(style.width, availableWidth, contentWidth + padding.left + padding.right),
      height: length(style.height, availableHeight, (contentHeight || fallbackHeight) + padding.top + padding.bottom),
    };
  }

  function layoutNodes(nodes, rect, rules) {
    const laid = nodes.map(node => ({ ...node, children: node.children.map(child => ({ ...child })) }));
    const flexChildren = (node, box) => {
      const direction = node.style['flex-direction'] || 'row';
      const vertical = direction === 'column';
      const gap = length(node.style.gap || (vertical ? node.style['row-gap'] : node.style['column-gap']), vertical ? box.height : box.width, 0);
      const content = box;
      const basis = vertical ? content.height : content.width;
      const fixed = node.children.reduce((sum, child) => {
        if (child.style.flex || child.style['flex-grow']) return sum;
        const measured = intrinsicSize(child, content.width, content.height);
        return sum + length(child.style[vertical ? 'height' : 'width'], basis, vertical ? measured.height : measured.width);
      }, 0);
      const grow = node.children.reduce((sum, child) => sum + Number(child.style.flex || child.style['flex-grow'] || 0), 0);
      const free = Math.max(0, basis - fixed - gap * Math.max(0, node.children.length - 1));
      let itemGap = gap, offset = 0;
      if (node.style['justify-content'] === 'space-between' && node.children.length > 1) itemGap += free / (node.children.length - 1);
      else if (node.style['justify-content'] === 'space-around' && node.children.length) { itemGap += free / node.children.length; offset = free / node.children.length / 2; }
      else if (node.style['justify-content'] === 'space-evenly') { itemGap += free / (node.children.length + 1); offset = free / (node.children.length + 1); }
      let cursor = vertical ? content.y : content.x;
      cursor += offset;
      if (node.style['justify-content'] === 'center') cursor += Math.max(0, free) / 2;
      if (node.style['justify-content'] === 'end' || node.style['justify-content'] === 'flex-end') cursor += free;
      const placed = node.children.map(child => {
        const flex = Number(child.style.flex || child.style['flex-grow'] || 0);
        const measured = intrinsicSize(child, content.width, content.height);
        const main = flex ? (grow ? free * flex / grow : 0) : length(child.style[vertical ? 'height' : 'width'], basis, vertical ? measured.height : measured.width);
        const crossAvailable = vertical ? content.width : content.height;
        const cross = length(child.style[vertical ? 'width' : 'height'], crossAvailable, node.style['align-items'] === 'stretch' || !node.style['align-items'] ? crossAvailable : vertical ? measured.width : measured.height);
        const crossAlign = node.style['align-items'] || 'stretch';
        const crossOffset = crossAlign === 'center' ? ((vertical ? content.width : content.height) - cross) / 2 : crossAlign === 'end' || crossAlign === 'flex-end' ? (vertical ? content.width : content.height) - cross : 0;
        const childRect = vertical
          ? { x: content.x + crossOffset, y: cursor, width: Math.min(content.width, cross), height: main }
          : { x: cursor, y: content.y + crossOffset, width: main, height: Math.min(content.height, cross) };
        cursor += main + itemGap;
        return childRect;
      });
      return placed;
    };
    const gridChildren = (node, box) => {
      const expression = node.style['grid-template-columns'] || '1fr';
      const repeated = /^repeat\(\s*(\d+)\s*,\s*([\d.]+)?\s*(px|fr|%)\s*\)$/.exec(expression);
      let definitions = ['1fr'];
      if (repeated) definitions = Array.from({ length: Number(repeated[1]) }, () => `${repeated[2] || '1'}${repeated[3]}`);
      else definitions = expression.trim().split(/\s+/);
      if (!definitions.length || definitions.some(value => !/^[\d.]+(?:px|fr|%)$/.test(value))) throw Error(`grid-template-columnsはpx、%、frの列幅を指定してください: ${expression}`);
      const columns = definitions.length;
      const gap = length(node.style.gap || node.style['column-gap'], box.width, 0), rowGap = length(node.style.gap || node.style['row-gap'], box.height, 0);
      const available = Math.max(0, box.width - gap * (columns - 1));
      const parsed = definitions.map(value => /^([\d.]+)(px|fr|%)$/.exec(value));
      const fixed = parsed.reduce((sum, part) => sum + (part[2] === 'px' ? Number(part[1]) : part[2] === '%' ? available * Number(part[1]) / 100 : 0), 0);
      const fractions = parsed.reduce((sum, part) => sum + (part[2] === 'fr' ? Number(part[1]) : 0), 0);
      const remaining = Math.max(0, available - fixed);
      const widths = parsed.map(part => part[2] === 'px' ? Number(part[1]) : part[2] === '%' ? available * Number(part[1]) / 100 : fractions ? remaining * Number(part[1]) / fractions : 0);
      return node.children.map((_, index) => {
        const col = index % columns, row = Math.floor(index / columns);
        const rowHeight = length(node.style['grid-auto-rows'] || node.style.height, box.height, 0);
        const x = box.x + widths.slice(0,col).reduce((sum,width) => sum + width + gap,0);
        return { x, y: box.y + row * (rowHeight + rowGap), width: widths[col], height: rowHeight };
      });
    };
    const place = (node, box, root = false) => {
      if (node.style.display === 'none') { node.rect = { ...box, width: 0, height: 0 }; return; }
      const padding = boxEdges(node.style, 'padding', box.width);
      const content = { x: box.x + padding.left, y: box.y + padding.top, width: Math.max(0, box.width - padding.left - padding.right), height: Math.max(0, box.height - padding.top - padding.bottom) };
      node.rect = box;
      const display = node.style.display || (root ? 'block' : 'block');
      let flowRects = [];
      if (display === 'flex') flowRects = flexChildren(node, content);
      else if (display === 'grid') flowRects = gridChildren(node, content);
      else {
        let nextY = content.y;
        flowRects = node.children.map(child => {
          const measured = intrinsicSize(child, content.width, content.height);
          const h = length(child.style.height, content.height, measured.height);
          const r = { x: content.x, y: nextY, width: length(child.style.width, content.width, content.width), height: h };
          nextY += h;
          return r;
        });
      }
      node.children.forEach((child, index) => {
        const style = child.style;
        let childRect = flowRects[index] || { x: content.x, y: content.y, width: 0, height: 0 };
        if (style.position === 'absolute') {
          const w = length(style.width, content.width, childRect.width || content.width);
          const measured = intrinsicSize(child, content.width, content.height);
          const h = length(style.height, content.height, childRect.height || measured.height);
          const x = style.left !== undefined ? content.x + length(style.left, content.width) : style.right !== undefined ? content.x + content.width - length(style.right, content.width) - w : childRect.x;
          const y = style.top !== undefined ? content.y + length(style.top, content.height) : style.bottom !== undefined ? content.y + content.height - length(style.bottom, content.height) - h : childRect.y;
          childRect = { x, y, width: w, height: h };
        } else {
          childRect.width = length(style.width, childRect.width || content.width, childRect.width);
          childRect.height = length(style.height, childRect.height || content.height, childRect.height);
        }
        place(child, childRect);
      });
    };
    laid.forEach(node => mergeStyles(node, rules, {}));
    laid.forEach(node => place(node, rect, true));
    const sortByStacking = node => {
      node.children.sort((a,b) => Number(a.style?.['z-index'] || 0) - Number(b.style?.['z-index'] || 0));
      node.children.forEach(sortByStacking);
    };
    laid.forEach(sortByStacking);
    return laid;
  }

  function compileScreenDocument(markup, stylesheet, canvas = { width: 1280, height: 720 }, targets = [], controlSettings = {}) {
    const nodes = parseMarkup(markup);
    if (nodes.length !== 1) throw Error('画面HTMLは1つのルート要素（通常はmain）で囲んでください。');
    const rules = parseStylesheet(stylesheet);
    nodes.forEach(node => mergeStyles(node, rules, {}));
    const expandRoles = (node, insideSlot = false) => {
      if (node.attrs['data-slot-field'] && !insideSlot) throw Error('data-slot-fieldはセーブ枠テンプレート内だけで使えます。');
      if (node.attrs['data-role']) {
        const role = node.attrs['data-role'];
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
          item.attrs = { ...item.attrs, id: `${role}-${index + 1}`, 'data-action': role === 'save-slots' ? 'save' : 'load', 'data-slot-index': String(index) };
          return item;
        });
      } else node.children.forEach(child => expandRoles(child, insideSlot));
    };
    nodes.forEach(expandRoles);
    nodes.forEach(node => mergeStyles(node, rules, {}));
    const actions = [];
    const collect = node => {
      if (node.attrs['data-action'] === 'open-screen' && targets.length && !targets.includes(node.attrs['data-target'])) throw Error(`画面HTMLの遷移先がありません: ${node.attrs['data-target']}`);
      if (node.tag === 'input' && !Object.hasOwn(controlSettings, node.attrs['data-setting'])) throw Error(`data-settingが画面コントロール設定にありません: ${node.attrs['data-setting']}`);
      if (node.tag === 'input' && (node.attrs.type === 'checkbox') !== (typeof controlSettings[node.attrs['data-setting']] === 'boolean')) throw Error(`data-settingの型がinput typeと一致しません: ${node.attrs['data-setting']}`);
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
  function serializeSafeMarkup(nodes) {
    const escape = text => String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const write = node => {
      const attrs = Object.entries(node.attrs).map(([key,value]) => ` ${key}="${escape(value)}"`).join('');
      const open = `<${node.tag}${attrs}>`;
      if (['img','br','input'].includes(node.tag)) return open;
      return `${open}${escape(node.text)}${node.children.map(write).join('')}</${node.tag}>`;
    };
    return nodes.map(write).join('');
  }
  function compileGameScreens(value, documents, canvas) {
    const result = JSON.parse(JSON.stringify(value));
    const controlSettings = result.controlSettings ? parseControlSettings(documents?.[result.controlSettings]) : {};
    result.controlDefaults = controlSettings;
    for (const [screenId, screen] of Object.entries(result.screens || {})) {
      if (!screen.template) continue;
      const markup = documents?.[screen.template];
      const stylesheet = result.stylesheet ? documents?.[result.stylesheet] : '';
      if (typeof markup !== 'string') throw Error(`画面HTMLがありません: ${screen.template}`);
      if (result.stylesheet && typeof stylesheet !== 'string') throw Error(`画面CSSがありません: ${result.stylesheet}`);
      const compiled = compileScreenDocument(markup, stylesheet || '', canvas || result.canvas || { width: 1280, height: 720 }, Object.keys(result.screens), controlSettings);
      screen.uiTree = compiled.tree;
      screen.webDocument = { markup: serializeSafeMarkup(parseMarkup(markup)), stylesheet: stylesheet || '' };
      const items = [];
      const visit = node => {
        if (node.style?.display === 'none') return;
        const action = node.attrs?.['data-action'];
        if (action) {
          if (items.length >= 100) throw Error(`画面 '${screenId}' の動作要素は100個以内にしてください。`);
          items.push({
          id: node.attrs.id || `html_${items.length + 1}`, type: 'button', action,
          ...(node.attrs['data-target'] ? { target: node.attrs['data-target'] } : {}),
          ...(node.attrs['data-slot-index'] !== undefined ? { slotIndex: Number(node.attrs['data-slot-index']) } : {}),
          label: textContent(node), x: Math.round(node.rect.x), y: Math.round(node.rect.y),
          width: Math.max(1, Math.round(node.rect.width)), height: Math.max(1, Math.round(node.rect.height)),
          });
        }
        if (node.attrs?.['data-role']) {
          screen.role = node.attrs['data-role'];
          const rect = node.rect;
          screen.slotLayout = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)), rowHeight: Math.max(1, Math.round(node.children[0]?.rect.height || 48)), gap: 0, count: node.children.length };
        }
        (node.children || []).forEach(visit);
      };
      screen.uiTree.forEach(visit);
      screen.items = items;
    }
    if (!result.titleScene && !result.screens?.[result.initial]?.items?.some(item => item.action === 'start')) {
      throw Error('開始画面には「ゲーム開始」ボタンまたはTDSタイトルシーンが必要です。');
    }
    return result;
  }

  function buildScreenDom(tree, documentRef, options = {}) {
    const scaleX = options.scaleX ?? 1, scaleY = options.scaleY ?? 1;
    const setStyle = (element, style = {}, rect = {}) => {
      element.style.position = 'absolute';
      element.style.left = `${rect.x * scaleX}px`; element.style.top = `${rect.y * scaleY}px`;
      element.style.width = `${rect.width * scaleX}px`; element.style.height = `${rect.height * scaleY}px`;
      for (const [key, value] of Object.entries(style)) {
        const property = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        if (['position','left','right','top','bottom','width','height','flex','flex-grow','flex-direction','justify-content','align-items','gap','row-gap','column-gap','grid-template-columns','grid-template-rows','grid-auto-rows'].includes(property)) continue;
        let resolved = value;
        if (['font-size', 'line-height', 'gap', 'row-gap', 'column-gap', 'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'border-radius', 'border-width'].includes(property)) {
          const number = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(value);
          if (number) resolved = `${Number(number[1]) * scaleY}px`;
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
    const mount = (node, parentRect = { x: 0, y: 0 }, slotContext = null) => {
      const localRect = { ...node.rect, x: node.rect.x - parentRect.x, y: node.rect.y - parentRect.y };
      const currentSlot = node.attrs?.['data-slot-index'] !== undefined ? Number(node.attrs['data-slot-index']) : slotContext;
      if (node.attrs?.['data-role'] && options.roleContent) {
        const host = documentRef.createElement('div');
        host.dataset.role = node.attrs['data-role'];
        if (node.attrs['data-count']) host.dataset.count = node.attrs['data-count'];
        setStyle(host, node.style, localRect);
        options.roleContent(host, node);
        return host;
      }
      const element = documentRef.createElement(node.tag === 'screen-root' ? 'div' : node.tag);
      if (node.attrs?.id) element.id = node.attrs.id;
      if (node.attrs?.class) element.className = node.attrs.class;
      if (node.attrs?.['data-slot-index'] !== undefined) element.dataset.slotIndex = node.attrs['data-slot-index'];
      if (node.attrs?.['data-slot-field']) element.dataset.slotField = node.attrs['data-slot-field'];
      if (node.tag === 'button') element.type = 'button';
      if (node.attrs?.alt) element.setAttribute('alt', node.attrs.alt);
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
      setStyle(element, node.style, localRect);
      if (node.attrs?.['data-slot-field'] && currentSlot !== null) {
        const value = String(options.slotField?.(currentSlot, node.attrs['data-slot-field']) ?? '');
        if (node.tag === 'img') element.src = value;
        else element.textContent = value;
      }
      else if (node.text) element.textContent = node.text;
      if (node.tag === 'img' && node.attrs.src && !node.attrs['data-slot-field']) element.src = options.assetUrl ? options.assetUrl(node.attrs.src) : node.attrs.src;
      if (node.attrs?.['data-action']) {
        element.dataset.action = node.attrs['data-action'];
        if (node.attrs['data-target']) element.dataset.target = node.attrs['data-target'];
        if (node.attrs['data-action'] === 'load' && options.disableLoad) element.disabled = true;
        if (node.attrs['data-action'] === 'save' && options.disableSave) element.disabled = true;
        if (node.attrs['data-action'] === 'continue' && options.disableContinue) element.disabled = true;
        element.addEventListener('click', event => { event.stopPropagation(); options.onAction?.(node.attrs['data-action'], node.attrs['data-target'], event, node); });
      }
      const hover = node.hoverStyle || {};
      if (Object.keys(hover).length) {
        const update = active => {
          const next = active ? hover : {};
          for (const [key, value] of Object.entries(hover)) {
            const property = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
            if (active) element.style.setProperty(property, value);
            else element.style.removeProperty(property);
          }
          if (!active) setStyle(element, node.style, localRect);
          void next;
        };
        element.addEventListener('pointerenter', () => update(true)); element.addEventListener('pointerleave', () => update(false));
        element.addEventListener('focus', () => update(true)); element.addEventListener('blur', () => update(false));
      }
      for (const child of node.children || []) element.append(mount(child, node.rect, currentSlot));
      if (node.attrs?.['data-slot-index'] !== undefined) options.roleSlot?.(element, currentSlot, node);
      return element;
    };
    const fragment = documentRef.createDocumentFragment();
    for (const node of tree || []) fragment.append(mount(node));
    return fragment;
  }

  // Browser and editor use the browser layout engine; uiTree remains the SDL fallback.
  function buildWebScreen(markup, stylesheet, documentRef, options = {}) {
    const nodes = parseMarkup(markup);
    const rules = parseStylesheet(stylesheet);
    const canvas = documentRef.createElement('div');
    canvas.id = 'novel-screen-canvas';
    Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: `${options.width || 1280}px`, height: `${options.height || 720}px`, transformOrigin: 'top left', transform: `scale(${options.scaleX ?? 1}, ${options.scaleY ?? 1})` });
    const resolveValue = value => String(value).replace(/url\((['"]?)([^'"\)]+)\1\)/g, (_all, _quote, name) => `url("${options.assetUrl?.(name.replace(/^asset\//, '')) || name}")`);
    const style = documentRef.createElement('style');
    style.textContent = rules.map(rule => `#novel-screen-canvas ${rule.selector}{${Object.entries(rule.declarations).map(([key, value]) => `${key}:${resolveValue(value)}`).join(';')}}`).join('\n');
    const create = (node, slot = null) => {
      const element = documentRef.createElement(node.tag === 'save-slots' ? 'div' : node.tag);
      for (const [key, value] of Object.entries(node.attrs)) {
        if (key === 'src') element.setAttribute('src', options.assetUrl?.(value.replace(/^asset\//, '')) || value);
        else element.setAttribute(key, value);
      }
      if (node.tag === 'button') element.type = 'button';
      if (node.text) element.append(documentRef.createTextNode(node.text));
      if (node.attrs['data-role']) {
        const count = Number(node.attrs['data-count'] || 8);
        const prototype = node.children[0] || { tag: 'button', attrs: {}, text: '', children: [] };
        for (let index = 0; index < count; index++) {
          const button = create(prototype, index);
          button.dataset.action = node.attrs['data-role'] === 'save-slots' ? 'save' : 'load';
          button.dataset.slotIndex = String(index);
          button.addEventListener('click', event => { event.stopPropagation(); options.onAction?.(button.dataset.action, undefined, index); });
          const saved = options.saved?.(index);
          button.dataset.state = options.slotState?.(index) || (saved ? 'ready' : 'empty');
          button.disabled = button.dataset.action === 'load' ? !saved : !options.canSave;
          button.setAttribute('aria-label', `${index + 1} ${saved ? `${saved.scene || ''} ${saved.text || ''}` : button.dataset.state}`);
          element.append(button);
        }
      } else for (const child of node.children) element.append(create(child, slot));
      if (slot !== null && node.attrs['data-slot-field']) {
        const value = String(options.slotField?.(slot, node.attrs['data-slot-field']) ?? '');
        if (node.tag === 'img') { if (value) element.src = value; else element.removeAttribute('src'); }
        else element.textContent = value;
      }
      if (node.tag === 'input') {
        const setting = node.attrs['data-setting'];
        const value = options.settings?.[setting] ?? options.controlDefaults?.[setting];
        if (node.attrs.type === 'checkbox') element.checked = Boolean(value);
        else element.value = String(value ?? node.attrs.value ?? 0);
        element.addEventListener(node.attrs.type === 'checkbox' ? 'change' : 'input', event => options.onSettingChange?.(setting, node.attrs.type === 'checkbox' ? event.currentTarget.checked : Number(event.currentTarget.value)));
      }
      if (node.attrs['data-action']) {
        if (node.attrs['data-action'] === 'continue' && !options.canContinue) element.disabled = true;
        element.addEventListener('click', event => { event.stopPropagation(); options.onAction?.(node.attrs['data-action'], node.attrs['data-target'], node.attrs['data-slot-index'] !== undefined ? Number(node.attrs['data-slot-index']) : slot); });
      }
      return element;
    };
    for (const node of nodes) canvas.append(create(node));
    const fragment = documentRef.createDocumentFragment(); fragment.append(style, canvas);
    return fragment;
  }

  return { parseMarkup, parseStylesheet, parseControlSettings, compileScreenDocument, compileGameScreens, buildScreenDom, buildWebScreen };
});
