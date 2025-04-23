import * as vscode from 'vscode';

export class DVFlowYAMLEditorProvider implements vscode.CompletionItemProvider {
    public static register(context: vscode.ExtensionContext): vscode.Disposable[] {
        const provider = new DVFlowYAMLEditorProvider();
        
        return [
            // Register the language's custom completion provider
            vscode.languages.registerCompletionItemProvider('dvflow', provider, ':', ' ')
        ];
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        // Get the line text up to the cursor
        const linePrefix = document.lineAt(position).text.slice(0, position.character);

        // Basic completion items for DV Flow YAML
        const items: vscode.CompletionItem[] = [];

        // Top-level completions
        if (linePrefix.match(/^\s*$/)) {
            items.push(
                new vscode.CompletionItem('tasks', vscode.CompletionItemKind.Folder),
                new vscode.CompletionItem('vars', vscode.CompletionItemKind.Variable),
                new vscode.CompletionItem('imports', vscode.CompletionItemKind.Module)
            );
        }

        // Task properties
        if (linePrefix.match(/^\s+$/)) {
            items.push(
                new vscode.CompletionItem('exec', vscode.CompletionItemKind.Function),
                new vscode.CompletionItem('deps', vscode.CompletionItemKind.Reference),
                new vscode.CompletionItem('description', vscode.CompletionItemKind.Text)
            );
        }

        return items;
    }
}
