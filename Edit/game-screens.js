'use strict';

const SCREEN_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const ACTIONS = new Set(['start', 'resume', 'open-screen', 'back', 'quit']);

function defaultGameScreens() {
  return {
    version: 1,
    canvas: { width: 1280, height: 720 },
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
          { id: 'resume', type: 'button', label: 'ゲームに戻る', action: 'resume', x: 470, y: 270, width: 340, height: 56 },
        ],
      },
    },
  };
}

function validateGameScreens(value) {
  if (!value || value.version !== 1 || !value.canvas || !Number.isInteger(value.canvas.width) || !Number.isInteger(value.canvas.height) || value.canvas.width < 320 || value.canvas.width > 4096 || value.canvas.height < 180 || value.canvas.height > 4096 || typeof value.initial !== 'string' || !value.screens || typeof value.screens !== 'object' || Array.isArray(value.screens)) {
    throw new Error('画面設定の形式が不正です。');
  }
  const screenIds = Object.keys(value.screens);
  if (!screenIds.length || screenIds.length > 24 || !SCREEN_ID.test(value.initial) || !Object.hasOwn(value.screens, value.initial)) {
    throw new Error('開始画面または画面数が不正です。');
  }
  for (const [screenId, screen] of Object.entries(value.screens)) {
    if (!SCREEN_ID.test(screenId) || !screen || typeof screen !== 'object' || Array.isArray(screen)) throw new Error(`画面 '${screenId}' の定義が不正です。`);
    if (typeof (screen.title ?? '') !== 'string' || typeof (screen.description ?? '') !== 'string' || (screen.description?.length || 0) > 2000 || typeof (screen.background ?? '') !== 'string' || !Array.isArray(screen.items) || screen.items.length > 100) throw new Error(`画面 '${screenId}' の項目が不正です。`);
    for (const image of [screen.background, ...screen.items.map(item => item?.image || '')]) {
      const relative = String(image || '').replaceAll('\\', '/').replace(/^asset\//i, '');
      if (relative && (relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error(`画面 '${screenId}' に作品フォルダー外の素材パスがあります。`);
    }
    const itemIds = new Set();
    for (const item of screen.items) {
      if (!item || item.type !== 'button' || typeof item.id !== 'string' || !SCREEN_ID.test(item.id) || itemIds.has(item.id)) throw new Error(`画面 '${screenId}' のボタンIDが不正または重複しています。`);
      itemIds.add(item.id);
      if (typeof item.label !== 'string' || item.label.length > 120 || !ACTIONS.has(item.action)) throw new Error(`画面 '${screenId}' のボタン '${item.id}' の文字または動作が不正です。`);
      if (item.image !== undefined && typeof item.image !== 'string') throw new Error(`ボタン '${item.id}' の画像指定が不正です。`);
      for (const key of ['x', 'y', 'width', 'height']) {
        if (!Number.isInteger(item[key]) || item[key] < 0 || item[key] > 4096 || ((key === 'width' || key === 'height') && item[key] === 0)) throw new Error(`ボタン '${item.id}' の${key}が不正です。`);
      }
      if (item.action === 'open-screen' && (typeof item.target !== 'string' || !Object.hasOwn(value.screens, item.target))) throw new Error(`ボタン '${item.id}' の遷移先画面がありません。`);
    }
  }
  if (!value.screens[value.initial].items.some(item => item.action === 'start')) throw new Error('開始画面には「ゲーム開始」ボタンが必要です。');
  return value;
}

module.exports = { defaultGameScreens, validateGameScreens };
