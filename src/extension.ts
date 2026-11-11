import * as vscode from 'vscode';
import { createDefaultProviderRegistry, type ProviderFactory } from './providers';
import { createDefaultToolRegistry, type Tool } from './tools';
import { ChatViewProvider } from './ui/chatViewProvider';

/** 他の拡張機能から `vscode.extensions.getExtension('local.grasp-dev')?.exports` で使える公開API。 */
export interface GraspDevApi {
  registerTool(tool: Tool): vscode.Disposable;
  registerProvider(id: string, factory: ProviderFactory): void;
}

export function activate(context: vscode.ExtensionContext): GraspDevApi {
  const tools = createDefaultToolRegistry();
  const providers = createDefaultProviderRegistry();
  const chat = new ChatViewProvider(context, tools, providers);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('graspDev.openSettings', () => chat.toggleSettings()),
    vscode.commands.registerCommand('graspDev.focus', () => vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`)),
  );

  return {
    registerTool(tool) {
      tools.register(tool);
      return new vscode.Disposable(() => tools.unregister(tool.name));
    },
    registerProvider: (id, factory) => providers.register(id, factory),
  };
}

export function deactivate(): void {}
