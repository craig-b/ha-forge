/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the compiled client bundle's components by importing the source directly.
// happy-dom provides a minimal DOM environment for Lit rendering.

// Import Lit components — these self-register via @customElement
import '../ui/client/components/tse-header.js';
import '../ui/client/components/tse-sidebar.js';
import '../ui/client/components/tse-editor-tabs.js';
import '../ui/client/components/tse-build-output.js';
import '../ui/client/components/tse-entity-table.js';
import '../ui/client/components/tse-exports-panel.js';
import '../ui/client/components/tse-log-viewer.js';
import '../ui/client/components/tse-bottom-panel.js';
import type { FileEntry, BuildStep, EntityInfo, LogEntry, OpenFile } from '../ui/client/types.js';

async function renderElement<T extends HTMLElement>(tag: string, props?: Record<string, unknown>): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      (el as Record<string, unknown>)[key] = value;
    }
  }
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
  return el;
}

function cleanup() {
  // Remove all child elements from body using DOM methods
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

// ---- tse-header ----

describe('tse-header', () => {
  beforeEach(cleanup);

  it('renders build button and status badge', async () => {
    const el = await renderElement('tse-header');
    expect(el.querySelector('.btn-primary')?.textContent).toContain('Rebuild All');
    expect(el.querySelector('.status-badge')?.textContent).toBe('Ready');
  });

  it('shows building state', async () => {
    const el = await renderElement('tse-header', {
      building: true, statusText: 'Building...', statusClass: 'building',
    });
    expect(el.querySelector('.btn-primary')?.hasAttribute('disabled')).toBe(true);
    expect(el.querySelector('.status-badge')?.textContent).toBe('Building...');
    expect(el.querySelector('.status-badge')?.classList.contains('building')).toBe(true);
  });

  it('dispatches tse-build event on button click', async () => {
    const el = await renderElement('tse-header');
    const handler = vi.fn();
    el.addEventListener('tse-build', handler);
    (el.querySelector('.btn-primary') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('dispatches tse-regen-types event', async () => {
    const el = await renderElement('tse-header');
    const handler = vi.fn();
    el.addEventListener('tse-regen-types', handler);
    const buttons = el.querySelectorAll('.btn');
    // Second button is Regen Types
    (buttons[1] as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ---- tse-sidebar ----

describe('tse-sidebar', () => {
  beforeEach(cleanup);

  const testFiles: FileEntry[] = [
    { name: 'sensors.ts', path: 'sensors.ts', type: 'file' },
    { name: 'lights', path: 'lights', type: 'directory', children: [
      { name: 'living.ts', path: 'lights/living.ts', type: 'file' },
    ]},
  ];

  it('renders file tree', async () => {
    const el = await renderElement('tse-sidebar', { files: testFiles });
    const items = el.querySelectorAll('.file-item');
    expect(items.length).toBe(2); // sensors.ts, lights dir (collapsed by default)
  });

  it('highlights active file', async () => {
    const el = await renderElement('tse-sidebar', {
      files: testFiles, activeFile: 'sensors.ts',
    });
    const active = el.querySelector('.file-item.active');
    expect(active?.textContent).toContain('sensors.ts');
  });

  it('dispatches tse-open-file on file click', async () => {
    const el = await renderElement('tse-sidebar', { files: testFiles });
    const handler = vi.fn();
    el.addEventListener('tse-open-file', handler);
    const fileItems = el.querySelectorAll('.file-item:not(.directory)');
    (fileItems[0] as HTMLElement).click();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.path).toBe('sensors.ts');
  });

  it('dispatches tse-new-file on + button click', async () => {
    const el = await renderElement('tse-sidebar', { files: [] });
    const handler = vi.fn();
    el.addEventListener('tse-new-file', handler);
    (el.querySelector('.btn-sm') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ---- tse-editor-tabs ----

describe('tse-editor-tabs', () => {
  beforeEach(cleanup);

  const testFiles: OpenFile[] = [
    { path: 'sensors.ts', content: '', modified: false, model: null },
    { path: 'lights.ts', content: '', modified: true, model: null },
  ];

  it('renders tabs for open files', async () => {
    const el = await renderElement('tse-editor-tabs', { openFiles: testFiles });
    const tabs = el.querySelectorAll('.editor-tab');
    expect(tabs.length).toBe(2);
  });

  it('shows modified indicator', async () => {
    const el = await renderElement('tse-editor-tabs', { openFiles: testFiles });
    const tabs = el.querySelectorAll('.editor-tab');
    expect(tabs[1].classList.contains('modified')).toBe(true);
  });

  it('highlights active tab', async () => {
    const el = await renderElement('tse-editor-tabs', {
      openFiles: testFiles, activeFile: 'lights.ts',
    });
    const active = el.querySelector('.editor-tab.active');
    expect(active?.textContent).toContain('lights.ts');
  });

  it('dispatches tse-close-file on close click', async () => {
    const el = await renderElement('tse-editor-tabs', { openFiles: testFiles });
    const handler = vi.fn();
    el.addEventListener('tse-close-file', handler);
    (el.querySelector('.close') as HTMLElement).click();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.path).toBe('sensors.ts');
  });
});

// ---- tse-build-output ----

describe('tse-build-output', () => {
  beforeEach(cleanup);

  it('renders build steps with icons', async () => {
    const steps: BuildStep[] = [
      { step: 'type-gen', success: true, duration: 100 },
      { step: 'tsc-check', success: false, duration: 200, error: 'TS2322' },
    ];
    const el = await renderElement('tse-build-output', { steps });
    const stepEls = el.querySelectorAll('.build-step');
    expect(stepEls.length).toBe(2);
    expect(stepEls[0].querySelector('.step-icon.ok')).toBeTruthy();
    expect(stepEls[1].querySelector('.step-icon.fail')).toBeTruthy();
    expect(stepEls[1].querySelector('.step-error')?.textContent).toBe('TS2322');
  });

  it('renders plain messages', async () => {
    const el = await renderElement('tse-build-output', {
      messages: ['Starting build...'],
      steps: [],
    });
    expect(el.querySelector('.build-step')?.textContent).toBe('Starting build...');
  });

  it('renders clickable diagnostics', async () => {
    const steps: BuildStep[] = [
      {
        step: 'tsc-check', success: true, duration: 300,
        diagnostics: [
          { file: 'sensors.ts', line: 10, column: 5, code: 2345, message: 'Type mismatch', severity: 'error' as const },
          { file: 'lights.ts', line: 3, column: 1, code: 2304, message: 'Cannot find name', severity: 'warning' as const },
        ],
      },
    ];
    const el = await renderElement('tse-build-output', { steps });
    const diags = el.querySelectorAll('.build-diagnostic');
    expect(diags.length).toBe(2);
    expect(diags[0].querySelector('.diag-location')?.textContent).toBe('sensors.ts:10:5');
    expect(diags[0].querySelector('.diag-code')?.textContent).toBe('TS2345');
    expect(diags[0].querySelector('.diag-message')?.textContent).toBe('Type mismatch');
    expect(diags[0].classList.contains('error')).toBe(true);
    expect(diags[1].classList.contains('warning')).toBe(true);
  });

  it('dispatches tse-open-diagnostic on click', async () => {
    const steps: BuildStep[] = [
      {
        step: 'tsc-check', success: true, duration: 100,
        diagnostics: [
          { file: 'sensors.ts', line: 10, column: 5, code: 2345, message: 'err', severity: 'error' as const },
        ],
      },
    ];
    const el = await renderElement('tse-build-output', { steps });
    const handler = vi.fn();
    el.addEventListener('tse-open-diagnostic', handler);
    (el.querySelector('.build-diagnostic') as HTMLElement).click();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail).toEqual({ file: 'sensors.ts', line: 10, column: 5 });
  });
});

// ---- tse-entity-table ----

describe('tse-entity-table', () => {
  beforeEach(cleanup);

  it('renders entity rows', async () => {
    const entities: EntityInfo[] = [
      { id: 'sensor.temp', name: 'Temperature', type: 'sensor', state: '22.5', sourceFile: 'sensors.ts', status: 'healthy' },
    ];
    const el = await renderElement('tse-entity-table', { entities });
    const rows = el.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('sensor.temp');
    expect(rows[0].querySelector('.entity-status.healthy')).toBeTruthy();
  });

  it('shows empty state', async () => {
    const el = await renderElement('tse-entity-table', { entities: [] });
    expect(el.querySelector('tbody td')?.textContent).toContain('No entities registered');
  });
});

// ---- tse-log-viewer ----

describe('tse-log-viewer', () => {
  beforeEach(cleanup);

  it('renders log entries', async () => {
    const logs: LogEntry[] = [
      { timestamp: Date.now(), level: 'info', entity_id: 'sensor.temp', message: 'Updated state' },
      { timestamp: Date.now(), level: 'error', message: 'Something failed' },
    ];
    const el = await renderElement('tse-log-viewer', { logs });
    const entries = el.querySelectorAll('.log-entry');
    expect(entries.length).toBe(2);
    expect(entries[0].querySelector('.log-level.info')).toBeTruthy();
    expect(entries[1].querySelector('.log-level.error')).toBeTruthy();
  });

  it('shows empty state when no logs', async () => {
    const el = await renderElement('tse-log-viewer', { logs: [] });
    expect(el.querySelector('.empty-state')?.textContent).toContain('No log entries');
  });

  it('dispatches tse-filter-change on level select', async () => {
    const el = await renderElement('tse-log-viewer', { logs: [] });
    const handler = vi.fn();
    el.addEventListener('tse-filter-change', handler);
    const select = el.querySelector('select') as HTMLSelectElement;
    select.value = 'error';
    select.dispatchEvent(new Event('change'));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.level).toBe('error');
  });
});

// ---- tse-exports-panel ----

describe('tse-exports-panel', () => {
  beforeEach(cleanup);

  it('groups entities by source file', async () => {
    const entities: EntityInfo[] = [
      { id: 'sensor.temp', name: 'Temperature', type: 'sensor', state: '22', sourceFile: 'sensors.ts', status: 'healthy' },
      { id: 'sensor.humidity', name: 'Humidity', type: 'sensor', state: '55', sourceFile: 'sensors.ts', status: 'healthy' },
      { id: 'light.living', name: 'Living Room', type: 'light', state: 'on', sourceFile: 'lights.ts', status: 'healthy' },
    ];
    const el = await renderElement('tse-exports-panel', { entities });
    const groups = el.querySelectorAll('.exports-file-group');
    expect(groups.length).toBe(2);
    // lights.ts comes first alphabetically
    expect(groups[0].querySelector('.exports-file-name')?.textContent).toBe('lights.ts');
    expect(groups[0].querySelectorAll('.exports-entity').length).toBe(1);
    expect(groups[1].querySelector('.exports-file-name')?.textContent).toBe('sensors.ts');
    expect(groups[1].querySelectorAll('.exports-entity').length).toBe(2);
  });

  it('shows empty state', async () => {
    const el = await renderElement('tse-exports-panel', { entities: [] });
    expect(el.querySelector('.exports-empty')?.textContent).toContain('No exports found');
  });

  it('dispatches tse-open-file on file header click', async () => {
    const entities: EntityInfo[] = [
      { id: 'sensor.temp', name: 'Temp', type: 'sensor', state: '22', sourceFile: 'sensors.ts', status: 'healthy' },
    ];
    const el = await renderElement('tse-exports-panel', { entities });
    const handler = vi.fn();
    el.addEventListener('tse-open-file', handler);
    (el.querySelector('.exports-file-header') as HTMLElement).click();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.path).toBe('sensors.ts');
  });

  it('shows entity count per file', async () => {
    const entities: EntityInfo[] = [
      { id: 'sensor.a', name: 'A', type: 'sensor', state: '', sourceFile: 'a.ts', status: 'healthy' },
      { id: 'sensor.b', name: 'B', type: 'sensor', state: '', sourceFile: 'a.ts', status: 'healthy' },
    ];
    const el = await renderElement('tse-exports-panel', { entities });
    expect(el.querySelector('.exports-file-count')?.textContent).toBe('2 entities');
  });
});

// ---- tse-bottom-panel ----

describe('tse-bottom-panel', () => {
  beforeEach(cleanup);

  it('renders panel tabs', async () => {
    const el = await renderElement('tse-bottom-panel');
    const tabs = el.querySelectorAll('.panel-tab');
    expect(tabs.length).toBe(4);
    expect(tabs[0].textContent).toContain('Build Output');
    expect(tabs[1].textContent).toContain('Exports');
    expect(tabs[2].textContent).toContain('Logs');
    expect(tabs[3].textContent).toContain('Simulate');
  });

  it('switches active panel on tab click', async () => {
    const el = await renderElement('tse-bottom-panel');
    const tabs = el.querySelectorAll('.panel-tab');
    (tabs[1] as HTMLButtonElement).click();
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
    expect(tabs[1].classList.contains('active')).toBe(true);
  });

  it('dispatches tse-panel-change event', async () => {
    const el = await renderElement('tse-bottom-panel');
    const handler = vi.fn();
    el.addEventListener('tse-panel-change', handler);
    const tabs = el.querySelectorAll('.panel-tab');
    (tabs[2] as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.panel).toBe('logs');
  });

  it('renders resize handle', async () => {
    const el = await renderElement('tse-bottom-panel');
    expect(el.querySelector('.panel-resize-handle')).toBeTruthy();
  });
});
