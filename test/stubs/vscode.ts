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
/** 保存ダイアログへの答え (選んだパス。undefined は取り消し) と、開いたときの初期位置 */
export const saveAnswers: Array<string | undefined> = [];
export const saveDialogs: Array<{ defaultPath?: string; filters?: Record<string, string[]> }> = [];

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
  showSaveDialog: async (options: { defaultUri?: { fsPath: string }; filters?: Record<string, string[]> }) => {
    saveDialogs.push({ defaultPath: options.defaultUri?.fsPath, filters: options.filters });
    const picked = saveAnswers.shift();
    return picked === undefined ? undefined : Uri.file(picked);
  },
};

export const workspace = {
  get workspaceFolders() {
    return state.folder ? [{ uri: Uri.file(state.folder) }] : undefined;
  },
};

export const env = { appRoot: '/nonexistent' };
export const commands = { executeCommand: async () => undefined };
