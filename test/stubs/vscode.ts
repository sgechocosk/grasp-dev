// テスト用の vscode の代わり。ChatViewProvider が使う範囲だけを持つ。
export const state = { folder: '' };

export class Range {
  constructor(public startLine: number, public startCharacter: number, public endLine: number, public endCharacter: number) {}
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/'), scheme: 'file' }),
};

export const window = {
  activeTextEditor: undefined,
  showTextDocument: async () => undefined,
};

export const workspace = {
  get workspaceFolders() {
    return state.folder ? [{ uri: Uri.file(state.folder) }] : undefined;
  },
};

export const env = { appRoot: '/nonexistent' };
export const commands = { executeCommand: async () => undefined };
