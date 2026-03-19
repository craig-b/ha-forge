/**
 * Generates the complete UI HTML as a string.
 * Monaco Editor is loaded from CDN. All application JS/CSS is inlined
 * for single-request loading through HA ingress.
 *
 * NOTE: All dynamic content inserted via innerHTML is first sanitized
 * through escHtml() which uses textContent-based escaping to prevent XSS.
 */
export function generateUIHtml(ingressPath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TS Entities</title>
  <style>${CSS}</style>
</head>
<body>
  <div id="app">
    <header id="header">
      <div class="header-left">
        <h1>TS Entities</h1>
      </div>
      <div class="header-center">
        <button id="btn-build" class="btn btn-primary">Build &amp; Deploy</button>
        <button id="btn-regen-types" class="btn">Regen Types</button>
      </div>
      <div class="header-right">
        <span id="build-status" class="status-badge">Ready</span>
      </div>
    </header>

    <div id="main">
      <aside id="sidebar">
        <div class="sidebar-header">
          <span>Files</span>
          <button id="btn-new-file" class="btn btn-sm" title="New file">+</button>
        </div>
        <div id="file-tree"></div>
      </aside>

      <div id="content">
        <div id="editor-container">
          <div id="editor-tabs"></div>
          <div id="monaco-editor"></div>
        </div>

        <div id="bottom-panel">
          <div class="panel-tabs">
            <button class="panel-tab active" data-panel="build-output">Build Output</button>
            <button class="panel-tab" data-panel="entities">Entities</button>
            <button class="panel-tab" data-panel="logs">Logs</button>
          </div>

          <div id="panel-build-output" class="panel-content active">
            <div id="build-output"></div>
          </div>

          <div id="panel-entities" class="panel-content">
            <table id="entity-table">
              <thead>
                <tr>
                  <th>Entity ID</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>State</th>
                  <th>Source</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="entity-tbody"></tbody>
            </table>
          </div>

          <div id="panel-logs" class="panel-content">
            <div class="log-filters">
              <select id="log-level-filter">
                <option value="">All levels</option>
                <option value="error">Error</option>
                <option value="warn">Warning</option>
                <option value="info">Info</option>
                <option value="debug">Debug</option>
              </select>
              <input id="log-search" type="text" placeholder="Search logs..." />
            </div>
            <div id="log-entries"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    window.__INGRESS_PATH__ = ${JSON.stringify(ingressPath)};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js"><\/script>
  <script>${APP_JS}<\/script>
</body>
</html>`;
}

// ---- Embedded CSS ----

const CSS = `
:root {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d2d;
  --bg-hover: #37373d;
  --text-primary: #cccccc;
  --text-secondary: #858585;
  --text-bright: #e0e0e0;
  --accent: #0078d4;
  --accent-hover: #1a8cff;
  --error: #f44747;
  --warning: #cca700;
  --success: #89d185;
  --info: #75beff;
  --border: #3c3c3c;
  --sidebar-width: 240px;
  --header-height: 44px;
  --panel-height: 260px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  overflow: hidden;
  height: 100vh;
}

#app { display: flex; flex-direction: column; height: 100vh; }

#header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
#header h1 { font-size: 14px; font-weight: 600; color: var(--text-bright); }
.header-center { display: flex; gap: 8px; }
.header-right { display: flex; align-items: center; gap: 8px; }

.btn {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { background: var(--bg-hover); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 2px 8px; font-size: 11px; }

.status-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}
.status-badge.ready { background: var(--bg-tertiary); }
.status-badge.building { background: var(--accent); color: white; }
.status-badge.success { background: #2d4a2d; color: var(--success); }
.status-badge.error { background: #4a2d2d; color: var(--error); }

#main { display: flex; flex: 1; overflow: hidden; }

#sidebar {
  width: var(--sidebar-width);
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow-y: auto;
}
.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}
#file-tree { padding: 4px 0; flex: 1; overflow-y: auto; }
.file-item {
  display: flex;
  align-items: center;
  padding: 3px 12px 3px 16px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-primary);
}
.file-item:hover { background: var(--bg-hover); }
.file-item.active { background: var(--bg-tertiary); color: var(--text-bright); }
.file-item .icon { margin-right: 6px; font-size: 12px; opacity: 0.7; }
.file-item.directory { color: var(--text-secondary); }
.file-item.indent-1 { padding-left: 28px; }
.file-item.indent-2 { padding-left: 40px; }

#content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

#editor-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
#editor-tabs {
  display: flex;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  min-height: 35px;
  overflow-x: auto;
}
.editor-tab {
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 12px;
  cursor: pointer;
  border-right: 1px solid var(--border);
  color: var(--text-secondary);
  white-space: nowrap;
  gap: 6px;
}
.editor-tab:hover { color: var(--text-primary); }
.editor-tab.active { background: var(--bg-primary); color: var(--text-bright); }
.editor-tab .close {
  font-size: 14px;
  opacity: 0;
  padding: 0 2px;
  border-radius: 3px;
}
.editor-tab:hover .close { opacity: 0.7; }
.editor-tab .close:hover { opacity: 1; background: var(--bg-hover); }
.editor-tab.modified .name::after { content: ' \\2022'; color: var(--text-secondary); }
#monaco-editor { flex: 1; }

#bottom-panel {
  height: var(--panel-height);
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.panel-tabs {
  display: flex;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}
.panel-tab {
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  border: none;
  background: none;
  color: var(--text-secondary);
  border-bottom: 2px solid transparent;
}
.panel-tab:hover { color: var(--text-primary); }
.panel-tab.active { color: var(--text-bright); border-bottom-color: var(--accent); }
.panel-content { flex: 1; overflow-y: auto; padding: 8px 12px; display: none; font-size: 12px; }
.panel-content.active { display: block; }

.build-step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}
.build-step .step-icon { width: 16px; text-align: center; }
.build-step .step-icon.ok { color: var(--success); }
.build-step .step-icon.fail { color: var(--error); }
.build-step .step-name { color: var(--text-bright); min-width: 100px; }
.build-step .step-duration { color: var(--text-secondary); }
.build-step .step-error { color: var(--error); }

#entity-table { width: 100%; border-collapse: collapse; }
#entity-table th {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
}
#entity-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}
.entity-status { padding: 1px 6px; border-radius: 3px; font-size: 11px; }
.entity-status.healthy { background: #2d4a2d; color: var(--success); }
.entity-status.error { background: #4a2d2d; color: var(--error); }
.entity-status.unavailable { background: var(--bg-tertiary); color: var(--text-secondary); }

.log-filters { display: flex; gap: 8px; padding: 4px 0 8px; }
.log-filters select, .log-filters input {
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
}
.log-filters input { flex: 1; }
.log-entry {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 12px;
}
.log-entry .log-time { color: var(--text-secondary); white-space: nowrap; }
.log-entry .log-level { width: 44px; font-weight: 500; }
.log-entry .log-level.error { color: var(--error); }
.log-entry .log-level.warn { color: var(--warning); }
.log-entry .log-level.info { color: var(--info); }
.log-entry .log-level.debug { color: var(--text-secondary); }
.log-entry .log-entity { color: var(--accent); min-width: 140px; }
.log-entry .log-msg { color: var(--text-primary); flex: 1; }

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 13px;
}
`;

// ---- Embedded Application JS ----
// All dynamic content uses escHtml() (textContent-based escaping) before DOM insertion.

const APP_JS = `
(function() {
  'use strict';

  var BASE = window.__INGRESS_PATH__ || '';

  var state = {
    files: [],
    openFiles: [],
    activeFile: null,
    editor: null,
    building: false,
    entities: [],
    logs: [],
  };

  function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(BASE + path, opts).then(function(res) { return res.json(); });
  }

  /** Escape HTML using textContent to prevent XSS */
  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---- File tree ----
  function loadFileTree() {
    return api('GET', '/api/files').then(function(data) {
      state.files = data.files || [];
      renderFileTree();
    });
  }

  function renderFileTree() {
    var container = document.getElementById('file-tree');
    while (container.firstChild) container.removeChild(container.firstChild);
    renderFileEntries(container, state.files, 0);
  }

  function renderFileEntries(container, entries, depth) {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var el = document.createElement('div');
      el.className = 'file-item' + (depth > 0 ? ' indent-' + Math.min(depth, 2) : '');

      var icon = document.createElement('span');
      icon.className = 'icon';
      var nameSpan = document.createElement('span');
      nameSpan.textContent = entry.name;

      if (entry.type === 'directory') {
        el.classList.add('directory');
        icon.textContent = '\\u25B6';
      } else {
        icon.textContent = '\\u25A0';
        if (state.activeFile === entry.path) el.classList.add('active');
        (function(p) {
          el.addEventListener('click', function() { openFile(p); });
        })(entry.path);
      }

      el.appendChild(icon);
      el.appendChild(nameSpan);
      container.appendChild(el);

      if (entry.children) {
        renderFileEntries(container, entry.children, depth + 1);
      }
    }
  }

  // ---- Editor ----
  function openFile(filePath) {
    var existing = null;
    for (var i = 0; i < state.openFiles.length; i++) {
      if (state.openFiles[i].path === filePath) { existing = state.openFiles[i]; break; }
    }
    if (!existing) {
      return api('GET', '/api/files/' + encodeURIComponent(filePath)).then(function(data) {
        if (data.error) return;
        var lang = (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) ? 'typescript' : 'json';
        var model = monaco.editor.createModel(
          data.content, lang,
          monaco.Uri.parse('file:///' + filePath)
        );
        var file = { path: filePath, content: data.content, modified: false, model: model };
        model.onDidChangeContent(function() {
          file.modified = file.model.getValue() !== file.content;
          renderTabs();
        });
        state.openFiles.push(file);
        state.activeFile = filePath;
        state.editor.setModel(file.model);
        renderTabs();
        renderFileTree();
      });
    }
    state.activeFile = filePath;
    state.editor.setModel(existing.model);
    renderTabs();
    renderFileTree();
  }

  function closeFile(filePath) {
    var idx = -1;
    for (var i = 0; i < state.openFiles.length; i++) {
      if (state.openFiles[i].path === filePath) { idx = i; break; }
    }
    if (idx === -1) return;
    state.openFiles[idx].model.dispose();
    state.openFiles.splice(idx, 1);
    if (state.activeFile === filePath) {
      if (state.openFiles.length > 0) {
        var next = state.openFiles[Math.min(idx, state.openFiles.length - 1)];
        state.activeFile = next.path;
        state.editor.setModel(next.model);
      } else {
        state.activeFile = null;
        state.editor.setModel(null);
      }
    }
    renderTabs();
    renderFileTree();
  }

  function saveFile(filePath) {
    var file = null;
    for (var i = 0; i < state.openFiles.length; i++) {
      if (state.openFiles[i].path === filePath) { file = state.openFiles[i]; break; }
    }
    if (!file) return Promise.resolve();
    var content = file.model.getValue();
    return api('PUT', '/api/files/' + encodeURIComponent(filePath), { content: content }).then(function() {
      file.content = content;
      file.modified = false;
      renderTabs();
    });
  }

  function renderTabs() {
    var container = document.getElementById('editor-tabs');
    while (container.firstChild) container.removeChild(container.firstChild);

    for (var i = 0; i < state.openFiles.length; i++) {
      var file = state.openFiles[i];
      var tab = document.createElement('div');
      tab.className = 'editor-tab' + (state.activeFile === file.path ? ' active' : '') + (file.modified ? ' modified' : '');

      var nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = file.path.split('/').pop();

      var closeEl = document.createElement('span');
      closeEl.className = 'close';
      closeEl.textContent = '\\u00D7';

      (function(p) {
        nameEl.addEventListener('click', function() {
          state.activeFile = p;
          for (var j = 0; j < state.openFiles.length; j++) {
            if (state.openFiles[j].path === p) {
              state.editor.setModel(state.openFiles[j].model);
              break;
            }
          }
          renderTabs();
          renderFileTree();
        });
        closeEl.addEventListener('click', function(e) {
          e.stopPropagation();
          closeFile(p);
        });
      })(file.path);

      tab.appendChild(nameEl);
      tab.appendChild(closeEl);
      container.appendChild(tab);
    }
  }

  // ---- Build ----
  function triggerBuild() {
    if (state.building) return;
    state.building = true;
    setBuildStatus('building', 'Building...');
    document.getElementById('btn-build').disabled = true;
    clearBuildOutput();
    appendBuildText('Starting build pipeline...');

    var savePromises = [];
    for (var i = 0; i < state.openFiles.length; i++) {
      if (state.openFiles[i].modified) savePromises.push(saveFile(state.openFiles[i].path));
    }

    Promise.all(savePromises).then(function() {
      return api('POST', '/api/build');
    }).then(function(result) {
      if (result.lastBuild) renderBuildResult(result.lastBuild);
      setBuildStatus(
        result.lastBuild && result.lastBuild.success ? 'success' : 'error',
        result.lastBuild && result.lastBuild.success ? 'Build OK' : 'Build Failed'
      );
    }).catch(function(err) {
      appendBuildText('Build request failed: ' + err.message);
      setBuildStatus('error', 'Error');
    }).finally(function() {
      state.building = false;
      document.getElementById('btn-build').disabled = false;
      loadEntities();
    });
  }

  function renderBuildResult(build) {
    clearBuildOutput();
    for (var i = 0; i < build.steps.length; i++) {
      var step = build.steps[i];
      appendBuildStep(step.step, step.success, step.duration, step.error);
    }
    if (build.entityCount !== undefined) {
      appendBuildText('Deployed ' + build.entityCount + ' entities');
    }
  }

  function clearBuildOutput() {
    var el = document.getElementById('build-output');
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function appendBuildText(text) {
    var el = document.createElement('div');
    el.className = 'build-step';
    el.textContent = text;
    document.getElementById('build-output').appendChild(el);
  }

  function appendBuildStep(name, success, duration, error) {
    var el = document.createElement('div');
    el.className = 'build-step';

    var iconEl = document.createElement('span');
    iconEl.className = 'step-icon ' + (success ? 'ok' : 'fail');
    iconEl.textContent = success ? '\\u2713' : '\\u2717';

    var nameEl = document.createElement('span');
    nameEl.className = 'step-name';
    nameEl.textContent = name;

    var durEl = document.createElement('span');
    durEl.className = 'step-duration';
    durEl.textContent = duration + 'ms';

    el.appendChild(iconEl);
    el.appendChild(nameEl);
    el.appendChild(durEl);

    if (error) {
      var errEl = document.createElement('span');
      errEl.className = 'step-error';
      errEl.textContent = error;
      el.appendChild(errEl);
    }

    document.getElementById('build-output').appendChild(el);
  }

  function setBuildStatus(cls, text) {
    var badge = document.getElementById('build-status');
    badge.className = 'status-badge ' + cls;
    badge.textContent = text;
  }

  // ---- Type regeneration ----
  function regenTypes() {
    appendBuildText('Regenerating types...');
    api('POST', '/api/types/regenerate').then(function(result) {
      if (result.success) {
        appendBuildText('Types regenerated: ' + result.entityCount + ' entities, ' + result.serviceCount + ' services');
        loadExtraTypes();
      } else {
        appendBuildText('Type regeneration failed: ' + (result.errors || []).join(', '));
      }
    });
  }

  // ---- Entities ----
  function loadEntities() {
    return api('GET', '/api/entities').then(function(data) {
      state.entities = data.entities || [];
      renderEntities();
    });
  }

  function renderEntities() {
    var tbody = document.getElementById('entity-tbody');
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    if (state.entities.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.setAttribute('colspan', '6');
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-secondary)';
      td.textContent = 'No entities registered';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (var i = 0; i < state.entities.length; i++) {
      var e = state.entities[i];
      var tr = document.createElement('tr');
      var fields = [e.id, e.name, e.type, String(e.state != null ? e.state : ''), e.sourceFile || ''];
      for (var j = 0; j < fields.length; j++) {
        var td = document.createElement('td');
        td.textContent = fields[j];
        tr.appendChild(td);
      }
      var statusTd = document.createElement('td');
      var statusSpan = document.createElement('span');
      statusSpan.className = 'entity-status ' + e.status;
      statusSpan.textContent = e.status;
      statusTd.appendChild(statusSpan);
      tr.appendChild(statusTd);
      tbody.appendChild(tr);
    }
  }

  // ---- Logs ----
  function loadLogs() {
    var level = document.getElementById('log-level-filter').value;
    var search = document.getElementById('log-search').value;
    var params = [];
    if (level) params.push('level=' + encodeURIComponent(level));
    if (search) params.push('search=' + encodeURIComponent(search));
    params.push('limit=200');

    return api('GET', '/api/logs?' + params.join('&')).then(function(data) {
      state.logs = data.logs || [];
      renderLogs();
    });
  }

  function renderLogs() {
    var container = document.getElementById('log-entries');
    while (container.firstChild) container.removeChild(container.firstChild);

    if (state.logs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No log entries';
      container.appendChild(empty);
      return;
    }

    for (var i = 0; i < state.logs.length; i++) {
      var log = state.logs[i];
      var el = document.createElement('div');
      el.className = 'log-entry';

      var timeEl = document.createElement('span');
      timeEl.className = 'log-time';
      timeEl.textContent = new Date(log.timestamp).toLocaleTimeString();

      var levelEl = document.createElement('span');
      levelEl.className = 'log-level ' + log.level;
      levelEl.textContent = log.level.toUpperCase();

      var entityEl = document.createElement('span');
      entityEl.className = 'log-entity';
      entityEl.textContent = log.entity_id || '';

      var msgEl = document.createElement('span');
      msgEl.className = 'log-msg';
      msgEl.textContent = log.message;

      el.appendChild(timeEl);
      el.appendChild(levelEl);
      el.appendChild(entityEl);
      el.appendChild(msgEl);
      container.appendChild(el);
    }
  }

  // ---- Panel tabs ----
  function setupPanelTabs() {
    var tabs = document.querySelectorAll('.panel-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function(tab) {
        tab.addEventListener('click', function() {
          var allTabs = document.querySelectorAll('.panel-tab');
          var allPanels = document.querySelectorAll('.panel-content');
          for (var j = 0; j < allTabs.length; j++) allTabs[j].classList.remove('active');
          for (var j = 0; j < allPanels.length; j++) allPanels[j].classList.remove('active');
          tab.classList.add('active');
          document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
          if (tab.dataset.panel === 'entities') loadEntities();
          if (tab.dataset.panel === 'logs') loadLogs();
        });
      })(tabs[i]);
    }
  }

  // ---- New file ----
  function createNewFile() {
    var name = prompt('File name (e.g., sensors.ts):');
    if (!name) return;
    var safeName = name.endsWith('.ts') ? name : name + '.ts';
    api('PUT', '/api/files/' + encodeURIComponent(safeName), { content: '' }).then(function() {
      return loadFileTree();
    }).then(function() {
      openFile(safeName);
    });
  }

  // ---- Keyboard shortcuts ----
  function setupKeyboard() {
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (state.activeFile) saveFile(state.activeFile);
      }
    });
  }

  // ---- WebSocket for live updates ----
  function connectWebSocket() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      var ws = new WebSocket(proto + '//' + location.host + BASE + '/ws');
      ws.onmessage = function(event) {
        try {
          var msg = JSON.parse(event.data);
          if (msg.channel === 'entities') loadEntities();
          if (msg.channel === 'logs') loadLogs();
          if (msg.channel === 'build' && msg.event === 'step_complete' && msg.data) {
            appendBuildStep(msg.data.step, msg.data.success, msg.data.duration, msg.data.error);
          }
        } catch(e) {}
      };
      ws.onclose = function() { setTimeout(connectWebSocket, 3000); };
    } catch(e) {
      setTimeout(connectWebSocket, 5000);
    }
  }

  // ---- Load SDK + generated types into Monaco ----
  function loadExtraTypes() {
    // Load SDK types as a single self-contained declaration
    api('GET', '/api/types/sdk').then(function(sdkResult) {
      if (sdkResult && sdkResult.declaration) {
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          sdkResult.declaration,
          'ts:sdk/globals.d.ts'
        );
      }
    }).catch(function() {});

    // Load generated HA registry types
    api('GET', '/api/types/status').then(function(typesStatus) {
      if (typesStatus.generated) {
        return api('GET', '/api/files/.generated/ha-registry.d.ts');
      }
      return null;
    }).then(function(registryDts) {
      if (registryDts && registryDts.content) {
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          registryDts.content,
          'file:///node_modules/@types/ha-registry/index.d.ts'
        );
      }
    }).catch(function() {});
  }

  function debounce(fn, ms) {
    var timer;
    return function() {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // ---- Init ----
  function init() {
    require.config({
      paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' }
    });

    require(['vs/editor/editor.main'], function() {
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2022,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
      });

      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });

      state.editor = monaco.editor.create(document.getElementById('monaco-editor'), {
        theme: 'vs-dark',
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Fira Code', monospace",
        minimap: { enabled: false },
        automaticLayout: true,
        tabSize: 2,
        scrollBeyondLastLine: false,
        padding: { top: 8 },
      });

      loadExtraTypes();
      loadFileTree();
      loadEntities();
    });

    document.getElementById('btn-build').addEventListener('click', triggerBuild);
    document.getElementById('btn-regen-types').addEventListener('click', regenTypes);
    document.getElementById('btn-new-file').addEventListener('click', createNewFile);
    document.getElementById('log-level-filter').addEventListener('change', loadLogs);
    document.getElementById('log-search').addEventListener('input', debounce(loadLogs, 300));

    setupPanelTabs();
    setupKeyboard();
    connectWebSocket();
  }

  if (typeof require !== 'undefined' && require.config) {
    init();
  } else {
    window.addEventListener('load', function() { setTimeout(init, 100); });
  }
})();
`;
