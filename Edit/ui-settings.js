'use strict';

(() => {
  const page = document.querySelector('#ui-settings-page');
  if (!page) return;
  const app = document.querySelector('.app-shell');
  const panel = document.querySelector('.editor-panel');
  const activity = document.querySelector('[data-activity="ui-settings"]');
  const nav = page.querySelector('.ui-settings-nav');
  const fields = page.querySelector('#ui-settings-fields');
  const jsonEditor = page.querySelector('#ui-settings-json');
  const saveButton = page.querySelector('#ui-settings-save');
  const dirtyMark = page.querySelector('#ui-settings-dirty');
  const errorBox = page.querySelector('#ui-settings-error');
  const imagePathList = page.querySelector('#ui-settings-image-paths');
  const viewport = page.querySelector('#ui-settings-preview-viewport');
  const stage = page.querySelector('#ui-settings-preview-stage');
  const playerPreview = page.querySelector('#ui-settings-player-preview');
  const previewTarget = page.querySelector('#ui-settings-preview-target');
  const targetBasis = page.querySelector('#ui-settings-target-basis');
  const selectionOverlay = page.querySelector('#ui-preview-selection');
  const resizeHandle = page.querySelector('#ui-preview-resize-handle');
  const gridToggle = page.querySelector('#ui-settings-grid-toggle');
  const gridSize = page.querySelector('#ui-settings-grid-size');
  const snapToggle = page.querySelector('#ui-settings-snap');
  const fieldLabels = {
    background: '背景', video: '動画', character: '立ち絵', image: '画像', fog: 'Bottom Fog', dialogue: '会話と選択肢', controls: '再生コントロール', menu: 'Menu Overlay',
    width: '幅', height: '高さ', x: 'X', y: 'Y', size: '文字サイズ',
    itemHeight: '項目の高さ', gap: '項目間隔', image: '画像パス', activeImage: '選択中の画像',
    opacity: '不透明度', enabled: '有効', color: '色 (RGBA)', fontSize: '文字サイズ',
    label: '表示名', hoverLabel: 'Hover Label', hoverImage: 'Hover Image',
    display: '表示形式', anchor: '基準位置', action: '操作', backgroundColor: '背景色',
    hoverBackgroundColor: 'Hover Background Color', borderColor: '枠線色', hoverBorderColor: 'Hover Border Color',
    hoverColor: 'Hover Text Color', borderRadius: '角丸', bottomFog: 'Bottom Fog',
    message: '本文', nameplate: 'Speaker Nameplate', text: '文字', screen: '画面', dialog: 'Dialog Panel', choices: '選択肢',
  };
  const sectionSpecs = {
    screen: { title: '画面', description: 'Browser と Native が共有する論理キャンバスのサイズです。', paths: [['screen', 'width'], ['screen', 'height']] },
    backdrop: { title: 'Background / Fog', description: '画面下部の Fog を含む、キャンバスの背景効果を調整します。', paths: [['screen', 'backdrop']] },
    dialog: { title: 'Dialog Panel', description: '会話枠の画像、位置、サイズ、不透明度を設定します。', paths: [['dialog', 'image'], ['dialog', 'opacity'], ['dialog', 'x'], ['dialog', 'y'], ['dialog', 'width'], ['dialog', 'height']] },
    message: { title: '本文', description: '会話枠の中で本文を表示する領域と文字スタイルを設定します。', paths: [['dialog', 'message']] },
    nameplate: { title: '話者名', description: '話者名プレートと、その内部に表示する文字の位置・色を設定します。', paths: [['dialog', 'nameplate']] },
    choices: { title: '選択肢', description: '選択肢一覧と各項目の文字、通常時・選択時の画像を設定します。', paths: [['choices']] },
    controls: { title: 'Save / Load', description: '会話画面上のボタンを個別に設定します。', paths: [['controls']] },
    audio: { title: '基準音量', description: '作品の BGM・SE・voice の基準音量です。Player settings の音量とは別に適用されます。', paths: [['audio']] },
    layers: { title: 'Layers', description: '8種類の描画要素の既定の重なり順を設定します。値は0〜7.999の範囲で、0.001刻みです。', paths: [['layers']] },
    advanced: { title: 'Advanced JSON', description: 'テーマ全体を直接編集します。v1 の全プロパティを確認できます。', paths: [] },
  };
  const defaultControls = {
    enabled: true,
    anchor: 'dialogue-top-left',
    buttons: [
      { id: 'save', label: 'Save', action: 'save', x: 0, y: -44, width: 84, height: 36 },
      { id: 'load', label: 'Load', action: 'load', x: 92, y: -44, width: 84, height: 36 },
    ],
  };
  const previewParts = {
    fog: { label: 'Bottom Fog', section: 'backdrop', path: ['screen', 'backdrop', 'bottomFog'], basis: '画面下端基準', sizeKeys: ['height'], movable: false },
    dialog: { label: 'Dialog Panel', section: 'dialog', path: ['dialog'], basis: '画面基準' },
    message: { label: '本文領域', section: 'message', path: ['dialog', 'message'], basis: 'Dialog Panel 内' },
    nameplate: { label: 'Speaker Nameplate', section: 'nameplate', path: ['dialog', 'nameplate'], basis: 'Dialog Panel 内' },
    speakerText: { label: 'Speaker Name Text', section: 'nameplate', path: ['dialog', 'nameplate', 'text'], basis: 'Speaker Nameplate 内' },
    choices: { label: '選択肢一覧', section: 'choices', path: ['choices'], basis: '画面基準' },
    choiceText: { label: '選択肢テキスト', section: 'choices', path: ['choices', 'text'], basis: '選択肢項目内' },
    'control-save': { label: 'Save Button', section: 'controls', action: 'save', basis: '設定した配置基準' },
    'control-load': { label: 'Load Button', section: 'controls', action: 'load', basis: '設定した配置基準' },
  };
  let originalTheme = null;
  let draftTheme = null;
  let activeSection = 'screen';
  let jsonInvalid = false;
  let fieldInvalid = false;
  let themePath = 'setting/player-ui.json';
  let loading = false;
  let saving = false;
  let previewScale = 1;
  let previewZoom = 1;
  let playerPreviewReady = false;
  let gridVisible = false;
  let selectedPart = '';
  let activeDrag = null;

  const clone = value => JSON.parse(JSON.stringify(value));
  const getPath = (object, path) => path.reduce((value, key) => value?.[key], object);
  function setPath(object, path, value) {
    if (path[0] === 'controls' && !object.controls) object.controls = clone(defaultControls);
    const parent = path.slice(0, -1).reduce((node, key) => node[key], object);
    parent[path.at(-1)] = value;
  }
  function resolvePart(id) {
    const spec = previewParts[id];
    if (!spec) return null;
    if (!spec.action) return { ...spec, id, path: spec.path.slice() };
    const buttons = (draftTheme?.controls || defaultControls).buttons || [];
    const index = buttons.findIndex(button => button.action === spec.action);
    return index < 0 ? null : { ...spec, id, path: ['controls', 'buttons', index] };
  }
  function humanize(key) { return fieldLabels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2'); }
  function rgba(value) {
    if (!Array.isArray(value) || value.length !== 4) return 'rgba(255,255,255,1)';
    const [r, g, b, a] = value.map(Number);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a / 255))})`;
  }
  function hexColor(value) {
    if (!Array.isArray(value) || value.length < 3) return '#ffffff';
    return '#' + value.slice(0, 3).map(channel => Math.max(0, Math.min(255, Number(channel) || 0)).toString(16).padStart(2, '0')).join('');
  }
  function assetUrl(value) {
    const normalized = String(value || '').replaceAll('\\', '/');
    const directory = themePath.replaceAll('\\', '/').startsWith('setting/') ? [] : themePath.replaceAll('\\', '/').split('/').slice(0, -1);
    const relative = normalized.replace(/^asset\//i, '');
    if (!relative || relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) return '';
    return '/asset/' + [...directory, ...relative.split('/')].filter(Boolean).map(encodeURIComponent).join('/');
  }
  function setStatus(message, isError = false) {
    const status = page.querySelector('#ui-settings-preview-status');
    status.textContent = message;
    status.classList.toggle('error', isError);
    errorBox.hidden = !isError;
    errorBox.textContent = isError ? message : '';
  }
  function changed() {
    const isDirty = JSON.stringify(draftTheme) !== JSON.stringify(originalTheme);
    dirtyMark.hidden = !isDirty;
    saveButton.disabled = !isDirty || jsonInvalid || fieldInvalid || saving || loading;
  }
  function showPage() {
    page.hidden = false;
    app?.classList.add('ui-settings-mode');
    panel?.classList.add('ui-settings-mode');
    document.querySelector('.sidebar')?.classList.remove('search-mode', 'presentation-mode');
    document.querySelectorAll('.activity-button').forEach(button => button.classList.toggle('active', button === activity || (!activity && button.dataset.activity === 'presentation')));
  }
  function hidePage() {
    page.hidden = true;
    app?.classList.remove('ui-settings-mode');
    panel?.classList.remove('ui-settings-mode');
  }
  async function loadTheme() {
    loading = true;
    changed();
    setStatus('テーマを読み込んでいます…');
    try {
      const [result, assetData] = await Promise.all([request('/api/player-ui'), request('/api/ui-assets').catch(() => ({ images: [] }))]);
      themePath = result.path || 'setting/player-ui.json';
      const normalizedThemePath = themePath.replaceAll('\\', '/');
      const assetBase = normalizedThemePath.startsWith('setting/') ? [] : normalizedThemePath.split('/').slice(0, -1);
      const assetOptions = document.createDocumentFragment();
      for (const image of assetData.images || []) {
        const parts = image.split('/');
        if (assetBase.some((part, index) => parts[index] !== part)) continue;
        const option = document.createElement('option'); option.value = parts.slice(assetBase.length).join('/'); assetOptions.append(option);
      }
      imagePathList.replaceChildren(assetOptions);
      originalTheme = clone(result.theme);
      draftTheme = clone(result.theme);
      const defaultLayers = { background: 0, video: 1, character: 2, image: 3, fog: 4, dialogue: 5, controls: 6, menu: 7 };
      originalTheme.layers = { ...defaultLayers, ...(originalTheme.layers || {}) };
      draftTheme.layers = { ...defaultLayers, ...(draftTheme.layers || {}) };
      page.querySelector('#ui-settings-document-path').textContent = themePath;
      loading = false;
      jsonInvalid = false;
      fieldInvalid = false;
      renderFields();
      renderPreview();
      changed();
      setStatus('Previewing theme changes');
    } catch (error) {
      loading = false;
      changed();
      setStatus(error.message, true);
    }
  }
  async function openPage() {
    window.hideSceneFlowView?.();
    showPage();
    if (playerPreview && !playerPreview.hasAttribute('src')) playerPreview.src = playerPreview.dataset.previewSrc || '/player.html?ui-preview=1';
    if (!draftTheme || loading) await loadTheme();
    else {
      renderFields();
      renderPreview();
    }
  }

  function updatePreviewColor(input, path, color) {
    const next = getPath(draftTheme, path).slice();
    if (color) {
      next[0] = Number.parseInt(color.slice(1, 3), 16);
      next[1] = Number.parseInt(color.slice(3, 5), 16);
      next[2] = Number.parseInt(color.slice(5, 7), 16);
    } else {
      const parts = input.value.split(',').map(part => Number(part.trim()));
      if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
        input.classList.add('invalid'); fieldInvalid = true; changed(); return;
      }
      next.splice(0, 4, ...parts);
      input.classList.remove('invalid');
    }
    setPath(draftTheme, path, next);
    fieldInvalid = Boolean(fields.querySelector('.invalid'));
    changed(); renderPreview();
  }
  function addPrimitiveEditor(container, key, value, path) {
    const label = document.createElement('label');
    label.className = 'ui-settings-field';
    const title = document.createElement('span'); title.textContent = humanize(key);
    label.append(title);
    if (typeof value === 'boolean') {
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = value;
      input.addEventListener('change', () => { setPath(draftTheme, path, input.checked); changed(); renderPreview(); });
      label.classList.add('ui-settings-toggle'); label.append(input); container.append(label); return;
    }
    if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) {
      const row = document.createElement('span'); row.className = 'ui-settings-color-row';
      const picker = document.createElement('input'); picker.type = 'color'; picker.value = hexColor(value); picker.setAttribute('aria-label', `${humanize(key)} color picker`);
      const channels = document.createElement('input'); channels.type = 'text'; channels.value = value.join(', '); channels.spellcheck = false; channels.setAttribute('aria-label', `${humanize(key)} RGBA`);
      picker.addEventListener('input', () => { channels.classList.remove('invalid'); updatePreviewColor(channels, path, picker.value); channels.value = getPath(draftTheme, path).join(', '); });
      channels.addEventListener('change', () => { updatePreviewColor(channels, path, ''); picker.value = hexColor(getPath(draftTheme, path)); });
      row.append(picker, channels); label.append(row); container.append(label); return;
    }
    const input = document.createElement('input');
    if (typeof value === 'string' && (key === 'action' || key === 'display' || path[0] === 'controls' && key === 'anchor')) {
      const options = key === 'action' ? ['save', 'load'] : key === 'display' ? ['text', 'image', 'both'] : ['dialogue-top-left', 'stage'];
      const select = document.createElement('select');
      select.className = 'ui-settings-select';
      for (const optionValue of options) {
        const option = document.createElement('option'); option.value = optionValue; option.textContent = optionValue; select.append(option);
      }
      select.value = value;
      select.addEventListener('change', () => { setPath(draftTheme, path, select.value); changed(); renderPreview(); });
      label.append(select); container.append(label); return;
    }
    if (typeof value === 'number' && (key === 'opacity' || path[0] === 'audio')) {
      input.type = 'number'; input.min = '0'; input.max = '1'; input.step = '0.01'; input.value = String(value);
      const row = document.createElement('div'); row.className = 'ui-settings-range-row';
      const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '1'; range.step = '0.01'; range.value = String(value);
      const output = document.createElement('output'); output.textContent = `${Math.round(value * 100)}%`;
      const apply = raw => {
        const next = Number(raw);
        if (!Number.isFinite(next) || next < 0 || next > 1) return;
        input.value = String(next); range.value = String(next); output.textContent = `${Math.round(next * 100)}%`;
        input.classList.remove('invalid'); fieldInvalid = Boolean(fields.querySelector('.invalid'));
        setPath(draftTheme, path, next); changed(); renderPreview();
      };
      input.addEventListener('input', () => {
        const next = input.value === '' ? NaN : Number(input.value);
        if (!Number.isFinite(next) || next < 0 || next > 1) { input.classList.add('invalid'); fieldInvalid = true; changed(); return; }
        apply(next);
      });
      input.addEventListener('blur', () => { if (input.classList.contains('invalid')) input.value = String(getPath(draftTheme, path)); });
      range.addEventListener('input', () => apply(range.value));
      row.append(input, range, output); label.append(row); container.append(label); return;
    }
    if (typeof value === 'number') {
      input.type = 'number'; input.value = String(value); input.step = Number.isInteger(value) ? '1' : '0.01';
      const name = String(key).toLowerCase();
      if (path[0] === 'layers') { input.min = '0'; input.max = '7.999'; input.step = '0.001'; }
      else if (name === 'opacity' || path[0] === 'audio') { input.min = '0'; input.max = '1'; }
      else if (path[0] === 'screen' && key === 'width') { input.min = '320'; input.max = '4096'; }
      else if (path[0] === 'screen' && key === 'height') { input.min = '180'; input.max = '4096'; }
      else if (['width', 'height', 'size', 'itemHeight', 'fontSize'].includes(key)) input.min = '1';
      else if (path.includes('color')) { input.min = '0'; input.max = '255'; }
    } else {
      input.type = 'text'; input.value = value ?? ''; input.maxLength = 240; input.spellcheck = false;
      if (['image', 'activeImage', 'hoverImage'].includes(key)) {
        input.setAttribute('list', 'ui-settings-image-paths');
        input.placeholder = 'ui/panel.png';
        input.title = 'Relative path within Asset Folder';
      }
    }
    const commit = () => {
      if (input.type === 'number') {
        const next = input.value === '' ? NaN : Number(input.value);
        const badLayerStep = path[0] === 'layers' && Math.abs(Math.round(next * 1000) - next * 1000) > 1e-7;
        if (!Number.isFinite(next) || input.min !== '' && next < Number(input.min) || input.max !== '' && next > Number(input.max) || badLayerStep) {
          input.classList.add('invalid'); fieldInvalid = true; changed(); return;
        }
        input.classList.remove('invalid'); setPath(draftTheme, path, next);
      } else setPath(draftTheme, path, input.value);
      fieldInvalid = Boolean(fields.querySelector('.invalid'));
      changed(); renderPreview();
    };
    input.addEventListener(input.type === 'number' ? 'input' : 'change', commit);
    input.addEventListener('blur', commit);
    label.append(input); container.append(label);
  }
  function renderValue(container, key, value, path) {
    if (Array.isArray(value) && value.some(item => item && typeof item === 'object')) {
      const group = document.createElement('fieldset'); group.className = 'ui-settings-fieldset';
      const legend = document.createElement('legend'); legend.textContent = humanize(key); group.append(legend);
      value.forEach((item, index) => renderValue(group, `${key} ${index + 1}`, item, [...path, index]));
      container.append(group); return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const group = document.createElement('fieldset'); group.className = 'ui-settings-fieldset';
      const legend = document.createElement('legend'); legend.textContent = humanize(key); group.append(legend);
      for (const [childKey, childValue] of Object.entries(value)) renderValue(group, childKey, childValue, [...path, childKey]);
      container.append(group); return;
    }
    if (Array.isArray(value)) { addPrimitiveEditor(container, key, value, path); return; }
    addPrimitiveEditor(container, key, value, path);
  }
  function renderFields() {
    const spec = sectionSpecs[activeSection];
    page.querySelector('#ui-settings-section-title').textContent = spec.title;
    page.querySelector('#ui-settings-section-description').textContent = spec.description;
    fields.replaceChildren();
    fields.hidden = activeSection === 'advanced';
    jsonEditor.hidden = activeSection !== 'advanced';
    page.querySelector('#ui-settings-json-format').hidden = activeSection !== 'advanced';
    if (activeSection === 'advanced') {
      jsonEditor.value = JSON.stringify(draftTheme, null, 2);
      return;
    }
    for (const path of spec.paths) {
      const value = path[0] === 'controls' && getPath(draftTheme, path) === undefined
        ? clone(defaultControls)
        : getPath(draftTheme, path);
      if (value === undefined) {
        const note = document.createElement('p'); note.className = 'ui-settings-empty'; note.textContent = `${path.at(-1)} は未設定です。必要な場合は JSON 詳細から追加できます。`; fields.append(note); continue;
      }
      renderValue(fields, path.at(-1), value, path);
    }
    fieldInvalid = false;
    changed();
  }
  function position(element, x, y, width, height, scale) {
    Object.assign(element.style, { left: `${Number(x || 0) * scale}px`, top: `${Number(y || 0) * scale}px`, width: `${Number(width || 0) * scale}px`, height: `${Number(height || 0) * scale}px` });
  }
  function partElement(id) {
    return [...stage.querySelectorAll('[data-ui-preview-part]')].find(element => element.dataset.uiPreviewPart === id) || null;
  }
  function renderSelection() {
    const spec = resolvePart(selectedPart);
    const element = spec && partElement(selectedPart);
    if (!spec || !element || element.getClientRects().length === 0) {
      selectionOverlay.hidden = true;
      targetBasis.textContent = spec ? `${spec.basis} (Not shown in Preview)` : '';
      return;
    }
    const rect = element.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    Object.assign(selectionOverlay.style, {
      left: `${rect.left - stageRect.left - stage.clientLeft}px`, top: `${rect.top - stageRect.top - stage.clientTop}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
    selectionOverlay.querySelector('span').textContent = spec.label;
    selectionOverlay.hidden = false;
    targetBasis.textContent = `${spec.basis} / ドラッグで移動・右下でサイズ変更`;
  }
  function coordinateOrigin(spec) {
    const dialog = draftTheme.dialog || {};
    if (spec.id === 'message' || spec.id === 'nameplate') return { x: Number(dialog.x || 0), y: Number(dialog.y || 0) };
    if (spec.id === 'speakerText') return { x: Number(dialog.x || 0) + Number(dialog.nameplate?.x || 0), y: Number(dialog.y || 0) + Number(dialog.nameplate?.y || 0) };
    if (spec.id === 'choiceText') return { x: Number(draftTheme.choices?.x || 0), y: Number(draftTheme.choices?.y || 0) };
    if (spec.id.startsWith('control-') && (draftTheme.controls || defaultControls).anchor === 'dialogue-top-left') return { x: Number(dialog.x || 0), y: Number(dialog.y || 0) };
    return { x: 0, y: 0 };
  }
  function selectPart(id) {
    if (id && !resolvePart(id)) return;
    const spec = id ? previewParts[id] : null;
    if (activeSection === 'advanced' && spec && !parseJsonDraft()) return;
    selectedPart = id;
    previewTarget.value = id;
    if (spec && activeSection !== spec.section) {
      activeSection = spec.section;
      nav.querySelectorAll('[data-ui-settings-section]').forEach(button => button.classList.toggle('active', button.dataset.uiSettingsSection === activeSection));
      renderFields();
    }
    renderPreview();
  }
  function beginDrag(event, id, mode = 'move') {
    if (event.button !== 0) return;
    event.preventDefault();
    selectPart(id);
    const spec = resolvePart(id);
    if (!spec) return;
    const origin = coordinateOrigin(spec);
    activeDrag = {
      id, mode, path: spec.path,
      startX: event.clientX, startY: event.clientY,
      x: Number(getPath(draftTheme, [...spec.path, 'x']) || 0),
      y: Number(getPath(draftTheme, [...spec.path, 'y']) || 0),
      width: Number(getPath(draftTheme, [...spec.path, 'width']) || 0),
      height: Number(getPath(draftTheme, [...spec.path, 'height']) || 0),
      sizeKeys: spec.sizeKeys || ['width', 'height'],
      origin,
    };
    window.addEventListener('pointermove', dragMove);
    window.addEventListener('pointerup', endDrag, { once: true });
    window.addEventListener('pointercancel', endDrag, { once: true });
  }
  function dragMove(event) {
    if (!activeDrag) return;
    const step = Number(gridSize.value) || 8;
    const snap = (value, origin = 0) => snapToggle.checked
      ? Math.round((value + origin) / step) * step - origin
      : Math.round(value);
    const dx = (event.clientX - activeDrag.startX) / previewScale;
    const dy = (event.clientY - activeDrag.startY) / previewScale;
    if (activeDrag.mode === 'resize') {
      if (activeDrag.sizeKeys.includes('width')) setPath(draftTheme, [...activeDrag.path, 'width'], Math.max(1, snap(activeDrag.width + dx)));
      if (activeDrag.sizeKeys.includes('height')) {
        const delta = activeDrag.id === 'fog' ? -dy : dy;
        setPath(draftTheme, [...activeDrag.path, 'height'], Math.max(1, snap(activeDrag.height + delta)));
      }
    } else {
      setPath(draftTheme, [...activeDrag.path, 'x'], snap(activeDrag.x + dx, activeDrag.origin.x));
      setPath(draftTheme, [...activeDrag.path, 'y'], snap(activeDrag.y + dy, activeDrag.origin.y));
    }
    changed();
    renderPreview();
  }
  function endDrag() {
    if (!activeDrag) return;
    activeDrag = null;
    window.removeEventListener('pointermove', dragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    renderFields();
    renderPreview();
  }
  function renderPreview() {
    if (!draftTheme?.screen || !viewport.clientWidth || !viewport.clientHeight) return;
    const theme = draftTheme;
    const width = Number(theme.screen.width) || NovelScreenDocument.DEFAULT_CANVAS.width;
    const height = Number(theme.screen.height) || NovelScreenDocument.DEFAULT_CANVAS.height;
    const scale = Math.max(0.01, Math.min((viewport.clientWidth - 36) / width, (viewport.clientHeight - 36) / height)) * previewZoom;
    previewScale = scale;
    page.querySelector('#ui-settings-zoom-value').textContent = `${Math.round(previewZoom * 100)}%`;
    stage.style.setProperty('--ui-preview-grid-size', `${(Number(gridSize.value) || 8) * scale}px`);
    stage.classList.toggle('show-grid', gridVisible);
    stage.style.width = `${width * scale}px`; stage.style.height = `${height * scale}px`;
    stage.style.aspectRatio = `${width} / ${height}`;
    page.querySelector('#ui-settings-dimensions').textContent = `${width} × ${height}`;
    const fog = theme.screen.backdrop?.bottomFog;
    const fogLayer = page.querySelector('#ui-preview-fog');
    fogLayer.hidden = !fog?.enabled;
    if (fog?.enabled) {
      const fogHeight = Math.min(Number(fog.height || 300), height * 0.6);
      Object.assign(fogLayer.style, { top: `${(height - fogHeight) * scale}px`, right: 'auto', bottom: 'auto', left: '0', width: `${width * scale}px`, height: `${fogHeight * scale}px`, background: `linear-gradient(to top, ${rgba(fog.color)}, transparent)` });
    }
    const dialog = theme.dialog || {};
    const message = dialog.message || {};
    const nameplate = dialog.nameplate || {};
    const dialogElement = page.querySelector('#ui-preview-dialog');
    position(dialogElement, dialog.x, dialog.y, dialog.width, dialog.height, scale);
    dialogElement.style.setProperty('--ui-dialog-opacity', String(dialog.opacity ?? 1));
    dialogElement.style.backgroundImage = dialog.image ? `url("${assetUrl(dialog.image)}")` : 'none';
    dialogElement.classList.toggle('has-image', Boolean(dialog.image));
    const messageElement = page.querySelector('#ui-preview-message');
    position(messageElement, message.x, message.y, message.width, message.height, scale);
    Object.assign(messageElement.style, { fontSize: `${Number(message.size || 24) * scale}px`, color: rgba(message.color) });
    const nameElement = page.querySelector('#ui-preview-nameplate');
    position(nameElement, nameplate.x, nameplate.y, nameplate.width, nameplate.height, scale);
    nameElement.style.backgroundImage = nameplate.image ? `url("${assetUrl(nameplate.image)}")` : 'none';
    nameElement.classList.toggle('has-image', Boolean(nameplate.image));
    const speaker = page.querySelector('#ui-preview-speaker');
    speaker.textContent = '話者名';
    position(speaker, nameplate.text?.x, nameplate.text?.y, nameplate.text?.width ?? nameplate.width, nameplate.text?.height ?? nameplate.height, scale);
    Object.assign(speaker.style, { fontSize: `${Number(nameplate.text?.size || 22) * scale}px`, color: rgba(nameplate.text?.color) });
    const choices = theme.choices || {};
    const choiceList = page.querySelector('#ui-preview-choices');
    position(choiceList, choices.x, choices.y, choices.width, choices.height, scale);
    const choice = page.querySelector('#ui-preview-choice');
    choice.style.height = `${Number(choices.itemHeight || 48) * scale}px`;
    choice.style.marginBottom = `${Number(choices.gap || 0) * scale}px`;
    choice.style.backgroundImage = (choices.activeImage || choices.image) ? `url("${assetUrl(choices.activeImage || choices.image)}")` : 'none';
    choice.classList.toggle('has-image', Boolean(choices.activeImage || choices.image));
    position(choice.querySelector('span') || choice, choices.text?.x, choices.text?.y, choices.text?.width ?? choices.width, choices.text?.height ?? choices.itemHeight, scale);
    Object.assign(choice.style, { fontSize: `${Number(choices.text?.size || 20) * scale}px`, color: rgba(choices.text?.color) });
    const controlLayer = page.querySelector('#ui-preview-controls');
    controlLayer.replaceChildren();
    const controls = theme.controls || defaultControls;
    controlLayer.hidden = controls.enabled === false;
    for (const item of controls.buttons || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ui-preview-control';
      button.dataset.uiPreviewPart = `control-${item.action}`;
      button.textContent = item.label || item.action || 'Control';
      button.style.backgroundImage = item.image ? `url("${assetUrl(item.image)}")` : 'none';
      button.style.backgroundColor = item.backgroundColor || '';
      button.style.color = item.color || '';
      button.style.borderColor = item.borderColor || '';
      button.style.borderRadius = `${Number(item.borderRadius || 0) * scale}px`;
      button.style.fontSize = `${Number(item.fontSize || 15) * scale}px`;
      const anchor = controls.anchor === 'dialogue-top-left';
      position(button, (anchor ? Number(dialog.x || 0) : 0) + Number(item.x || 0), (anchor ? Number(dialog.y || 0) : 0) + Number(item.y || 0), item.width || 84, item.height || 36, scale);
      controlLayer.append(button);
    }
    renderAudioMeters(theme.audio || {});
    renderSelection();
    sendPlayerPreviewTheme();
  }
  function sendPlayerPreviewTheme() {
    if (!playerPreviewReady || !draftTheme || !playerPreview?.contentWindow) return;
    playerPreview.contentWindow.postMessage({ type: 'novel-ui-preview:theme', path: themePath, theme: draftTheme }, location.origin);
  }
  function renderAudioMeters(audio) {
    const container = page.querySelector('#ui-settings-audio-preview');
    if (!container) return;
    container.replaceChildren();
    for (const [key, label] of [['bgm', 'BGM'], ['se', 'SE'], ['voice', 'VOICE']]) {
      const row = document.createElement('div'); row.className = 'ui-audio-meter';
      const name = document.createElement('span'); name.textContent = label;
      const track = document.createElement('span'); track.className = 'ui-audio-track';
      const fill = document.createElement('span'); fill.style.width = `${Math.max(0, Math.min(1, Number(audio[key] ?? 1)) * 100)}%`; track.append(fill);
      const value = document.createElement('output'); value.textContent = `${Math.round(Number(audio[key] ?? 1) * 100)}%`;
      row.append(name, track, value); container.append(row);
    }
  }

  function parseJsonDraft() {
    try {
      const parsed = JSON.parse(jsonEditor.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('テーマJSONの最上位はオブジェクトにしてください。');
      draftTheme = parsed;
      jsonInvalid = false;
      errorBox.hidden = true;
      renderPreview();
      changed();
      return true;
    } catch (error) {
      jsonInvalid = true;
      errorBox.hidden = false;
      errorBox.textContent = error.message;
      changed();
      return false;
    }
  }
  async function saveTheme() {
    if (activeSection === 'advanced' && !parseJsonDraft()) return;
    if (fieldInvalid || saving || !draftTheme) return;
    if (draftTheme.version !== 1 || !draftTheme.screen || !draftTheme.dialog || !draftTheme.choices) {
      setStatus('version 1 の screen / dialog / choices が必要です。', true); return;
    }
    saving = true; changed(); setStatus('UIテーマを保存しています…');
    try {
      const result = await request('/api/player-ui', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: draftTheme }) });
      originalTheme = clone(result.theme || draftTheme);
      draftTheme = clone(originalTheme);
      saving = false; jsonInvalid = false; fieldInvalid = false;
      renderFields(); renderPreview(); changed();
      setStatus('UIテーマを保存しました');
      window.setStatus?.('UIテーマを保存しました', 'ok');
    } catch (error) {
      saving = false; changed(); setStatus(error.message, true);
    }
  }
  function selectSection(id) {
    if (!sectionSpecs[id]) return;
    if (activeSection === 'advanced' && id !== activeSection && !parseJsonDraft()) return;
    const sectionPart = { backdrop: 'fog', dialog: 'dialog', message: 'message', nameplate: 'nameplate', choices: 'choices', controls: 'control-save' };
    activeSection = id;
    selectedPart = sectionPart[id] || '';
    previewTarget.value = selectedPart;
    nav.querySelectorAll('[data-ui-settings-section]').forEach(button => button.classList.toggle('active', button.dataset.uiSettingsSection === id));
    renderFields(); renderPreview();
  }
  nav.addEventListener('click', event => {
    const button = event.target.closest('[data-ui-settings-section]');
    if (button) selectSection(button.dataset.uiSettingsSection);
  });
  previewTarget.addEventListener('change', () => selectPart(previewTarget.value));
  gridToggle.addEventListener('click', () => {
    gridVisible = !gridVisible;
    gridToggle.setAttribute('aria-pressed', String(gridVisible));
    renderPreview();
  });
  gridSize.addEventListener('change', renderPreview);
  snapToggle.addEventListener('change', () => targetBasis.classList.toggle('snap-enabled', snapToggle.checked));
  page.querySelector('#ui-settings-zoom-out').addEventListener('click', () => { previewZoom = Math.max(0.5, Math.round((previewZoom - 0.1) * 10) / 10); renderPreview(); });
  page.querySelector('#ui-settings-zoom-in').addEventListener('click', () => { previewZoom = Math.min(2, Math.round((previewZoom + 0.1) * 10) / 10); renderPreview(); });
  page.querySelector('#ui-settings-zoom-fit').addEventListener('click', () => { previewZoom = 1; renderPreview(); });
  stage.addEventListener('pointerdown', event => {
    const element = event.target.closest('[data-ui-preview-part]');
    if (element && stage.contains(element)) {
      const id = element.dataset.uiPreviewPart;
      if (previewParts[id]?.movable === false) selectPart(id);
      else beginDrag(event, id);
    }
  });
  resizeHandle.addEventListener('pointerdown', event => {
    event.stopPropagation();
    if (selectedPart) beginDrag(event, selectedPart, 'resize');
  });
  jsonEditor.addEventListener('input', parseJsonDraft);
  page.querySelector('#ui-settings-json-format').addEventListener('click', () => {
    if (parseJsonDraft()) jsonEditor.value = JSON.stringify(draftTheme, null, 2);
  });
  page.querySelector('#ui-settings-revert').addEventListener('click', () => {
    if (!originalTheme) return;
    draftTheme = clone(originalTheme); jsonInvalid = false; fieldInvalid = false;
    errorBox.hidden = true; renderFields(); renderPreview(); changed(); setStatus('保存済みテーマに戻しました');
  });
  saveButton.addEventListener('click', () => saveTheme().catch(error => setStatus(error.message, true)));
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== playerPreview?.contentWindow || event.data?.type !== 'novel-ui-preview:ready') return;
    playerPreviewReady = true;
    sendPlayerPreviewTheme();
  });
  const observer = new ResizeObserver(() => renderPreview());
  observer.observe(viewport);
  window.openUiSettingsPage = openPage;
  window.closeUiSettingsPage = hidePage;
  activity?.addEventListener('click', () => openPage().catch(error => setStatus(error.message, true)));
  document.querySelectorAll('.activity-button:not([data-activity="ui-settings"])').forEach(button => button.addEventListener('click', hidePage));
  document.querySelector('[data-presentation-action="player-ui"]')?.addEventListener('click', () => openPage().catch(error => setStatus(error.message, true)));
})();
