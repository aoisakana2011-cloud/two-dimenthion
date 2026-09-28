'use strict';

const SCREEN_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const ACTIONS = new Set(['start', 'resume', 'save', 'load', 'open-screen', 'back', 'quit']);

function emptyScreenSlots() {
  return { x: 420, y: 190, width: 440, height: 420, rowHeight: 42, gap: 8, count: 8 };
}

function defaultGameScreens() {
  return {
    version: 1,
    initial: 'title',
    screens: {
      title: {
        title: '',
        background: '',
        items: [
          { id: 'start', type: 'button', label: 'はじめから', action: 'start', x: 64, y: 150, width: 300, height: 56 },
        ],
      },
      pause: {
        title: 'MENU',
        background: '',
        items: [
          { id: 'resume', type: 'button', label: 'ゲームに戻る', action: 'resume', x: 470, y: 190, width: 340, height: 56 },
          { id: 'save', type: 'button', label: 'Save', action: 'save', x: 470, y: 264, width: 340, height: 48 },
          { id: 'load', type: 'button', label: 'Load', action: 'load', x: 470, y: 328, width: 340, height: 48 },
        ],
      },
      save: {
        title: 'SAVE', role: 'save-slots', background: '', slotLayout: emptyScreenSlots(),
        items: [{ id: 'back', type: 'button', label: '戻る', action: 'back', x: 500, y: 640, width: 280, height: 48 }],
      },
      load: {
        title: 'LOAD', role: 'load-slots', background: '', slotLayout: emptyScreenSlots(),
        items: [{ id: 'back', type: 'button', label: '戻る', action: 'back', x: 500, y: 640, width: 280, height: 48 }],
      },
    },
  };
}

function withSaveLoadScreens(value) {
  const result = structuredClone(value);
  const defaults = defaultGameScreens();
  for (const role of ['save-slots', 'load-slots']) {
    if (!Object.values(result.screens).some(screen => screen.role === role)) {
      const id = role === 'save-slots' ? 'save' : 'load';
      let safeId = id, suffix = 2;
      while (Object.hasOwn(result.screens, safeId)) safeId = `${id}-${suffix++}`;
      result.screens[safeId] = defaults.screens[id];
    }
  }
  const pause = result.screens.pause;
  if (pause) {
    let y = Math.max(0, ...pause.items.map(item => item.y + item.height)) + 16;
    const first = pause.items[0] || { x: 32, width: 260 };
    for (const [id, label, action] of [['save', 'Save', 'save'], ['load', 'Load', 'load']]) {
      if (!pause.items.some(item => item.action === action)) {
        let itemId = id, suffix = 2;
        while (pause.items.some(item => item.id === itemId)) itemId = `${id}-${suffix++}`;
        pause.items.push({ id: itemId, type: 'button', label, action, x: first.x, y, width: first.width, height: 48 });
        y += 60;
      }
    }
  }
  return result;
}

function validateGameScreens(value) {
  const canvas = value?.canvas;
  if (!value || value.version !== 1 || canvas && (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width < 320 || canvas.width > 4096 || canvas.height < 180 || canvas.height > 4096) || typeof value.initial !== 'string' || !value.screens || typeof value.screens !== 'object' || Array.isArray(value.screens)) {
    throw new Error('画面設定の形式が不正です。');
  }
  const screenIds = Object.keys(value.screens);
  if (!screenIds.length || screenIds.length > 24 || !SCREEN_ID.test(value.initial) || !Object.hasOwn(value.screens, value.initial)) {
    throw new Error('開始画面または画面数が不正です。');
  }
  if (value.titleScene !== undefined) {
    const titleScene = value.titleScene;
    if (!titleScene || typeof titleScene !== 'object' || Array.isArray(titleScene)
      || typeof titleScene.file !== 'string' || !titleScene.file.trim() || titleScene.file.length > 240
      || titleScene.file.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..')
      || !/\.tds$/i.test(titleScene.file) || typeof titleScene.scene !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(titleScene.scene)) {
      throw new Error('TDSタイトルシーンのファイルまたはscene名が不正です。');
    }
  }
  const roles = new Set();
  for (const [screenId, screen] of Object.entries(value.screens)) {
    if (!SCREEN_ID.test(screenId) || !screen || typeof screen !== 'object' || Array.isArray(screen)) throw new Error(`画面 '${screenId}' の定義が不正です。`);
    if (typeof (screen.title ?? '') !== 'string' || typeof (screen.description ?? '') !== 'string' || (screen.description?.length || 0) > 2000 || typeof (screen.background ?? '') !== 'string' || !Array.isArray(screen.items) || screen.items.length > 100) throw new Error(`画面 '${screenId}' の項目が不正です。`);
    if (screen.role !== undefined) {
      if (!['save-slots', 'load-slots'].includes(screen.role) || roles.has(screen.role)) throw new Error(`画面 '${screenId}' のroleが不正または重複しています。`);
      roles.add(screen.role);
      const layout = screen.slotLayout || emptyScreenSlots();
      for (const key of ['x', 'y', 'width', 'height', 'rowHeight', 'gap', 'count']) {
        if (!Number.isInteger(layout[key]) || layout[key] < 0 || layout[key] > 4096 || (['width', 'height', 'rowHeight', 'count'].includes(key) && layout[key] === 0)
          || (key === 'count' && layout[key] > 100)) throw new Error(`画面 '${screenId}' のslotLayout.${key}が不正です。`);
      }
    }
    if (screen.music !== undefined && (typeof screen.music !== 'string' || screen.music.length > 120)) throw new Error(`画面 '${screenId}' のmusic指定が不正です。`);
    if (screen.music !== undefined && (typeof screen.music !== 'string' || screen.music.length > 240 || screen.music && screen.music.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Invalid screen music asset path');
    if (screen.slotStyle !== undefined && (!screen.slotStyle || typeof screen.slotStyle !== 'object' || Array.isArray(screen.slotStyle))) throw new Error('Invalid slotStyle');
    for (const key of ['image', 'hoverImage', 'color', 'hoverColor', 'backgroundColor', 'hoverBackgroundColor', 'borderColor', 'hoverBorderColor']) {
      if (screen.slotStyle?.[key] !== undefined && (typeof screen.slotStyle[key] !== 'string' || screen.slotStyle[key].length > 240)) throw new Error(`Invalid slotStyle.${key}`);
    }
    if (screen.slotStyle?.fontSize !== undefined && (!Number.isInteger(screen.slotStyle.fontSize) || screen.slotStyle.fontSize < 8 || screen.slotStyle.fontSize > 48)) throw new Error('Invalid slotStyle.fontSize');
    const imageNames = [screen.background, screen.slotStyle?.image, screen.slotStyle?.hoverImage, ...screen.items.flatMap(item => [item?.image || '', item?.hoverImage || ''])];
    for (const image of imageNames) {
      const relative = String(image || '').replaceAll('\\', '/').replace(/^asset\//i, '');
      if (relative && (relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error(`画面 '${screenId}' に作品フォルダー外の素材パスがあります。`);
    }
    const itemIds = new Set();
    for (const item of screen.items) {
      if (!item || item.type !== 'button' || typeof item.id !== 'string' || !SCREEN_ID.test(item.id) || itemIds.has(item.id)) throw new Error(`画面 '${screenId}' のボタンIDが不正または重複しています。`);
      itemIds.add(item.id);
      if (typeof item.label !== 'string' || item.label.length > 120 || !ACTIONS.has(item.action)) throw new Error(`画面 '${screenId}' のボタン '${item.id}' の文字または動作が不正です。`);
      for (const key of ['image', 'hoverImage', 'hoverLabel', 'color', 'hoverColor', 'backgroundColor', 'hoverBackgroundColor', 'borderColor', 'hoverBorderColor']) {
        if (item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > 240)) throw new Error(`ボタン '${item.id}' の${key}指定が不正です。`);
      }
      if (item.fontSize !== undefined && (!Number.isInteger(item.fontSize) || item.fontSize < 8 || item.fontSize > 96)) throw new Error(`ボタン '${item.id}' のfontSizeが不正です。`);
      for (const key of ['x', 'y', 'width', 'height']) {
        if (!Number.isInteger(item[key]) || item[key] < 0 || item[key] > 4096 || ((key === 'width' || key === 'height') && item[key] === 0)) throw new Error(`ボタン '${item.id}' の${key}が不正です。`);
      }
      if (item.display !== undefined && !['text', 'image', 'both'].includes(item.display)) throw new Error(`Invalid button display mode: ${item.id}`);
      if (item.action === 'open-screen' && (typeof item.target !== 'string' || !Object.hasOwn(value.screens, item.target))) throw new Error(`ボタン '${item.id}' の遷移先画面がありません。`);
    }
  }
  if (!value.titleScene && !value.screens[value.initial].items.some(item => item.action === 'start')) throw new Error('開始画面には「ゲーム開始」ボタンまたはTDSタイトルシーンが必要です。');
  return value;
}

module.exports = { defaultGameScreens, validateGameScreens, withSaveLoadScreens };
