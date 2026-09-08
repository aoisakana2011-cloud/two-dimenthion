'use strict';

const panel = document.querySelector('#workbench-panel');
const tabs = [...document.querySelectorAll('[data-workbench-tab]')];
const views = [...document.querySelectorAll('[data-workbench-view]')];
const consoleOutput = document.querySelector('#workbench-console-output');
const consoleInput = document.querySelector('#workbench-console-input');
const consoleForm = document.querySelector('#workbench-console-form');
const chatOutput = document.querySelector('#workbench-chat-output');
const chatInput = document.querySelector('#workbench-chat-input');
const chatForm = document.querySelector('#workbench-chat-form');
const sceneInput = () => document.querySelector('#scene-name')?.value || '';

function appendBlock(target, lines, className = '') {
  const block = document.createElement('pre');
  block.className = `workbench-block ${className}`.trim();
  block.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
  target.append(block);
  target.scrollTop = target.scrollHeight;
}

function setTab(name) {
  tabs.forEach((tab) => {
    const active = tab.dataset.workbenchTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  views.forEach((view) => { view.hidden = view.dataset.workbenchView !== name; });
}

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: '応答を読み取れませんでした。' }));
  if (!response.ok) throw new Error(data.error || '処理に失敗しました。');
  return data;
}

async function runConsole(command) {
  appendBlock(consoleOutput, `> ${command}`, 'command');
  consoleInput.value = '';
  consoleInput.disabled = true;
  try {
    const result = await post('/api/workbench/command', { command, scene: sceneInput() });
    appendBlock(consoleOutput, result.lines, result.ok ? '' : 'error');
  } catch (error) {
    appendBlock(consoleOutput, error.message, 'error');
  } finally {
    consoleInput.disabled = false;
    consoleInput.focus();
  }
}

async function sendChat(message) {
  const text = String(message || '').trim();
  if (!text) return;
  appendBlock(chatOutput, `あなた\n${text}`, 'chat-user');
  chatInput.value = '';
  chatInput.disabled = true;
  try {
    const result = await post('/api/workbench/chat', { message: text, scene: sceneInput() });
    appendBlock(chatOutput, `Workbench\n${result.reply}`, 'chat-system');
  } catch (error) {
    appendBlock(chatOutput, `Workbench\n${error.message}`, 'error');
  } finally {
    chatInput.disabled = false;
    chatInput.focus();
  }
}

tabs.forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.workbenchTab)));
consoleForm?.addEventListener('submit', (event) => { event.preventDefault(); runConsole(consoleInput.value); });
chatForm?.addEventListener('submit', (event) => { event.preventDefault(); sendChat(chatInput.value); });
panel?.addEventListener('keydown', (event) => event.stopPropagation());
setTab('console');
appendBlock(consoleOutput, ['Workbench console', 'help で利用可能なコマンドを表示します。'], 'system');
appendBlock(chatOutput, 'AI接続待ちです。現在はローカルの会話骨組みだけが動作します。', 'system');
