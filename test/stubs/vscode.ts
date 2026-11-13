// テスト用の vscode の代わり。ChatViewProvider が使う範囲だけを持つ。
export const state = { folder: '' };

export class Range {
  constructor(public startLine: number, public startCharacter: number, public endLine: number, public endCharacter: number) {}
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/'), scheme: 'file' }),
};

/** テストから、出力パネルの内容と、ダイアログへの答えを扱う */
export const output: string[] = [];
export const dialogs: Array<{ message: string; detail?: string; items: string[] }> = [];
export const answers: Array<string | undefined> = [];

export const window = {
  activeTextEditor: undefined,
  showTextDocument: async () => undefined,
  createOutputChannel: () => ({ appendLine: (line: string) => void output.push(line), dispose() {} }),
  showInformationMessage: async (message: string, ...rest: any[]) => {
    const options = typeof rest[0] === 'object' ? rest.shift() : {};
    dialogs.push({ message, detail: options.detail, items: rest });
    return answers.shift();
  },
  showErrorMessage: async (message: string) => void dialogs.push({ message, items: [] }),
};

export const workspace = {
  get workspaceFolders() {
    return state.folder ? [{ uri: Uri.file(state.folder) }] : undefined;
  },
};

export const env = { appRoot: '/nonexistent' };
export const commands = { executeCommand: async () => undefined };
