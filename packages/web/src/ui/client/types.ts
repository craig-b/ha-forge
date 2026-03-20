export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileEntry[];
}

export interface OpenFile {
  path: string;
  content: string;
  modified: boolean;
  model: MonacoModel | null;
}

export interface BuildStep {
  step: string;
  success: boolean;
  duration: number;
  error?: string;
}

export interface EntityInfo {
  id: string;
  name: string;
  type: string;
  state: unknown;
  sourceFile?: string;
  status: string;
}

export interface LogEntry {
  timestamp: number;
  level: string;
  entity_id?: string;
  source_file?: string;
  message: string;
  data?: string;
  caller?: string;
}

// Minimal Monaco types for what we use
export interface MonacoModel {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeContent(listener: () => void): { dispose(): void };
  dispose(): void;
}

export interface MonacoEditor {
  setModel(model: MonacoModel | null): void;
  getModel(): MonacoModel | null;
}
