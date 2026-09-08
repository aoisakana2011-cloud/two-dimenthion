'use strict';

const COMMANDS = ['help', 'status', 'scene', 'files', 'validate'];

function formatDiagnostics(diagnostics = []) {
  return diagnostics.slice(0, 8).map((item) => {
    const location = item.file ? `${item.file}:${item.line || 1}` : `line ${item.line || 1}`;
    return `${item.severity || 'info'} ${location} ${item.message}`;
  });
}

async function runWorkbenchCommand(input, context) {
  const source = String(input || '').trim();
  const [command, ...args] = source.split(/\s+/);
  if (!source || command === 'help') {
    return { ok: true, kind: 'help', lines: [
      '利用可能なコマンド:',
      '  help                 コマンド一覧',
      '  status               現在の作品とシーン',
      '  scene                現在のシナリオ本文',
      '  files                作品内ファイル一覧',
      '  validate             現在のシーンを検証',
    ] };
  }
  if (!COMMANDS.includes(command)) {
    return { ok: false, kind: 'error', lines: [`未対応のコマンドです: ${command}`, 'help で利用可能なコマンドを確認できます。'] };
  }
  if (command === 'status') {
    return { ok: true, kind: 'status', lines: [
      `作品: ${context.project.title || '(untitled)'}`,
      `シーン: ${context.scene || '(未選択)'}`,
      `ルート: ${context.project.projectRoot || '(不明)'}`,
    ] };
  }
  if (command === 'files') {
    const files = await context.files();
    const visible = files.filter((file) => !file.directory).map((file) => file.path);
    return { ok: true, kind: 'files', lines: visible.length ? visible : ['ファイルがありません。'] };
  }
  if (command === 'scene') {
    if (!context.scene) return { ok: false, kind: 'error', lines: ['シーンが選択されていません。'] };
    const sourceText = await context.readScene(context.scene);
    const lines = sourceText.split(/\r?\n/);
    const limit = 80;
    return { ok: true, kind: 'scene', lines: lines.length > limit ? [...lines.slice(0, limit), `... (${lines.length - limit} 行を省略)`] : lines };
  }
  if (command === 'validate') {
    if (!context.scene) return { ok: false, kind: 'error', lines: ['シーンが選択されていません。'] };
    const report = await context.validate(context.scene);
    const diagnostics = formatDiagnostics(report.diagnostics);
    return { ok: report.ok, kind: 'validate', lines: report.ok ? ['検証に成功しました。', ...diagnostics] : ['検証に失敗しました。', ...diagnostics, report.error || '詳細は検証結果を確認してください。'] };
  }
  return { ok: false, kind: 'error', lines: ['コマンドを実行できませんでした。'] };
}

async function runWorkbenchChat(message, context) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, reply: 'メッセージを入力してください。' };
  return {
    ok: true,
    reply: `AI接続の骨組みです。現在のシーンは「${context.scene || '未選択'}」。\n\n受け取った内容: ${text}\n\n外部AIプロバイダーは未接続です。ここにコンテキスト収集、提案生成、差分適用の処理を接続できます。`,
  };
}

module.exports = { runWorkbenchCommand, runWorkbenchChat };
