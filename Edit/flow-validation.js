const startSelect = document.querySelector('#start');
const endSelect = document.querySelector('#end');
const result = document.querySelector('#result');

function setPicker(target) {
  window.setFlowRangePicker?.(target);
  document.querySelectorAll('[data-range-target]').forEach((button) => {
    const active = button.dataset.rangeTarget === target;
    button.classList.toggle('is-picking', active);
    button.textContent = active ? '図で選択中…' : '図から指定';
  });
}
window.updateFlowPicker = (completed) => setPicker(completed === 'start' ? 'end' : null);

function addOptions(select, nodes) {
  const folders = new Map();
  nodes.forEach((node) => {
    const path = String(node.id).replaceAll('\\', '/');
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(root)';
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(node);
  });
  [...folders.entries()].sort(([a], [b]) => a.localeCompare(b, 'ja')).forEach(([folder, files]) => {
    const group = document.createElement('optgroup'); group.label = folder;
    files.sort((a, b) => a.id.localeCompare(b.id, 'ja')).forEach((node) => group.append(new Option(node.label, node.id)));
    select.append(group);
  });
}

function fileButton(file, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = String(file).replaceAll('\\', '/');
  button.addEventListener('click', () => window.selectFlowNode?.(file));
  return button;
}

function showReport(report) {
  result.replaceChildren();
  window.showFlowValidation?.(report);
  if (!report.ok) {
    const heading = document.createElement('div'); heading.className = 'validation-summary'; heading.textContent = '検証できません'; result.append(heading);
    const errors = document.createElement('div'); errors.className = 'validation-errors';
    (report.errors || []).forEach((error) => {
      const button = fileButton(error.file, 'validation-error-link');
      button.textContent = `${error.file}: ${error.message}`;
      errors.append(button);
    });
    result.append(errors);
    return;
  }
  const heading = document.createElement('div'); heading.className = 'validation-summary'; heading.textContent = '検証 OK：青色の線が最短経路です'; result.append(heading);
  const route = document.createElement('div'); route.className = 'validation-route';
  (report.path || []).forEach((file, index) => {
    if (index) { const arrow = document.createElement('span'); arrow.className = 'validation-arrow'; arrow.textContent = '→'; route.append(arrow); }
    route.append(fileButton(file));
  });
  result.append(route);
  const branchFiles = (report.checked || []).filter((file) => !(report.path || []).includes(file));
  if (branchFiles.length) {
    const note = document.createElement('div'); note.className = 'validation-note'; note.textContent = `黄枠: この範囲で併せて検証した分岐 ${branchFiles.length} 件`; result.append(note);
  }
}

fetch('/api/scene-graph').then((response) => {
  if (!response.ok) throw Error(`Scene Flow API error: ${response.status}`);
  return response.json();
}).then((flow) => {
  addOptions(startSelect, flow.nodes);
  endSelect.prepend(new Option('終了ファイルを選択', ''));
  addOptions(endSelect, flow.nodes);
  if (flow.nodes.length) {
    startSelect.value = flow.nodes.find((node) => node.reachable)?.id || flow.nodes[0].id;
    endSelect.value = '';
  }
  setPicker(null);
}).catch((error) => { result.textContent = error.message; });

document.querySelectorAll('[data-range-target]').forEach((button) => button.addEventListener('click', () => setPicker(button.dataset.rangeTarget)));
document.querySelector('#swap-range').addEventListener('click', () => {
  const value = startSelect.value; startSelect.value = endSelect.value; endSelect.value = value;
  setPicker(null);
});
document.querySelector('#validate').addEventListener('click', async () => {
  if (!startSelect.value || !endSelect.value) { result.textContent = '開始ファイルと終了ファイルを指定してください'; return; }
  try {
    const response = await fetch('/api/validate-flow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: startSelect.value, end: endSelect.value }) });
    const report = await response.json();
    showReport(report);
  } catch (error) { result.textContent = error.message; }
});
