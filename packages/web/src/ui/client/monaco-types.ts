export interface MonacoMarkerData {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
}

export interface MonacoCodeAction {
  title: string;
  diagnostics: MonacoMarkerData[];
  kind: string;
  edit: { edits: Array<{ resource: unknown; textEdit: { range: unknown; text: string }; versionId: number }> };
  isPreferred: boolean;
}

export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface MonacoDocumentSymbol {
  name: string;
  detail: string;
  kind: number;
  range: MonacoRange;
  selectionRange: MonacoRange;
  tags?: number[];
}

export interface MonacoModelInstance {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeContent(listener: () => void): { dispose(): void };
  getVersionId(): number;
  uri: { path: string; toString(): string };
  dispose(): void;
  updateOptions(opts: { readOnly?: boolean }): void;
}

export interface MonacoDecorationOptions {
  range: MonacoRange;
  options: {
    isWholeLine?: boolean;
    minimap?: { color: string; position: number };
    overviewRuler?: { color: string; position: number };
  };
}

export interface MonacoDecorationsCollection {
  set(decorations: MonacoDecorationOptions[]): void;
  clear(): void;
}

export interface MonacoEditorInstance {
  setModel(model: MonacoModelInstance | null): void;
  getModel(): MonacoModelInstance | null;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
  setPosition(pos: { lineNumber: number; column: number }): void;
  revealPositionInCenterIfOutsideViewport(pos: { lineNumber: number; column: number }): void;
  createDecorationsCollection(decorations?: MonacoDecorationOptions[]): MonacoDecorationsCollection;
}

export interface Monaco {
  editor: {
    create(el: HTMLElement, opts: Record<string, unknown>): MonacoEditorInstance;
    createModel(content: string, language: string, uri: unknown): MonacoModelInstance;
    getModel(uri: unknown): MonacoModelInstance | null;
    setModelMarkers(model: MonacoModelInstance, owner: string, markers: MonacoMarkerData[]): void;
    getModelMarkers(filter: { resource?: unknown; owner?: string }): MonacoMarkerData[];
    onDidChangeMarkers(listener: (uris: unknown[]) => void): { dispose(): void };
    registerEditorOpener(opener: {
      openCodeEditor(
        source: MonacoEditorInstance & {
          revealRangeInCenterIfOutsideViewport(range: unknown): void;
          setSelection(range: unknown): void;
          revealPositionInCenterIfOutsideViewport(pos: unknown): void;
          setPosition(pos: unknown): void;
        },
        resource: { path: string; toString(): string },
        selectionOrPosition: unknown,
      ): boolean;
    }): { dispose(): void };
  };
  languages: {
    typescript: {
      typescriptDefaults: {
        setCompilerOptions(opts: Record<string, unknown>): void;
        setDiagnosticsOptions(opts: Record<string, unknown>): void;
        addExtraLib(content: string, uri: string): void;
      };
      ScriptTarget: { ESNext: number };
      ModuleResolutionKind: { NodeJs: number };
      ModuleKind: { ESNext: number };
    };
    registerCodeActionProvider(languageId: string, provider: {
      provideCodeActions(model: MonacoModelInstance, range: unknown, context: { markers: MonacoMarkerData[] }): { actions: MonacoCodeAction[]; dispose(): void };
    }): void;
    registerDocumentSymbolProvider(languageId: string, provider: {
      displayName?: string;
      provideDocumentSymbols(model: MonacoModelInstance): MonacoDocumentSymbol[];
    }): { dispose(): void };
    registerHoverProvider(languageId: string, provider: {
      provideHover(model: MonacoModelInstance, position: { lineNumber: number; column: number }): { range: MonacoRange; contents: Array<{ value: string }> } | null;
    }): { dispose(): void };
    registerCodeLensProvider(languageId: string, provider: {
      onDidChange?: { (listener: () => void): { dispose(): void } };
      provideCodeLenses(model: MonacoModelInstance): { lenses: Array<{ range: MonacoRange; command?: { id: string; title: string } }>; dispose(): void };
    }): { dispose(): void };
    registerDocumentHighlightProvider(languageId: string, provider: {
      provideDocumentHighlights(model: MonacoModelInstance, position: { lineNumber: number; column: number }): Array<{ range: MonacoRange; kind?: number }>;
    }): { dispose(): void };
    registerCompletionItemProvider(languageId: string, provider: {
      triggerCharacters?: string[];
      provideCompletionItems(model: MonacoModelInstance, position: { lineNumber: number; column: number }): { suggestions: Array<{ label: string; kind: number; insertText: string; insertTextRules?: number; detail?: string; documentation?: string | { value: string }; range?: MonacoRange; sortText?: string }> };
    }): { dispose(): void };
    CompletionItemKind: { Snippet: number; Function: number; Text: number };
    CompletionItemInsertTextRule: { InsertAsSnippet: number };
    registerInlayHintsProvider(languageId: string, provider: {
      onDidChangeInlayHints?: { (listener: () => void): { dispose(): void } };
      provideInlayHints(model: MonacoModelInstance, range: MonacoRange, token: unknown): {
        hints: Array<{
          position: { lineNumber: number; column: number };
          label: string;
          kind?: number;
          paddingLeft?: boolean;
          paddingRight?: boolean;
          tooltip?: string;
        }>;
        dispose(): void;
      };
    }): { dispose(): void };
    InlayHintKind: { Type: number; Parameter: number };
    registerColorProvider(languageId: string, provider: {
      provideDocumentColors(model: MonacoModelInstance, token: unknown): Array<{
        color: { red: number; green: number; blue: number; alpha: number };
        range: MonacoRange;
      }>;
      provideColorPresentations(model: MonacoModelInstance, colorInfo: {
        color: { red: number; green: number; blue: number; alpha: number };
        range: MonacoRange;
      }, token: unknown): Array<{ label: string; textEdit?: { range: MonacoRange; text: string } }>;
    }): { dispose(): void };
    registerRenameProvider(languageId: string, provider: {
      provideRenameEdits(model: MonacoModelInstance, position: { lineNumber: number; column: number },
        newName: string, token: unknown): {
        edits: Array<{ resource: unknown; textEdit: { range: MonacoRange; text: string }; versionId?: number }>;
        rejectReason?: string;
      };
      resolveRenameLocation?(model: MonacoModelInstance, position: { lineNumber: number; column: number },
        token: unknown): { range: MonacoRange; text: string; rejectReason?: string };
    }): { dispose(): void };
    DocumentHighlightKind: { Text: number; Read: number; Write: number };
    SymbolKind: { Variable: number; Function: number; Module: number };
  };
  MarkerSeverity: { Error: number; Warning: number; Info: number; Hint: number };
  Range: {
    new (startLine: number, startCol: number, endLine: number, endCol: number): MonacoRange;
    isIRange(val: unknown): boolean;
  };
  Uri: { parse(uri: string): { path: string; toString(): string } };
}

export interface OpenFileInternal {
  path: string;
  content: string;
  modified: boolean;
  model: MonacoModelInstance;
}
