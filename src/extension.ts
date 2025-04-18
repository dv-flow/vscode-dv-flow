import * as vscode from 'vscode';
import { NodeDependenciesProvider } from './explorer/explorer';
import * as path from 'path';

let treeDataProvider: NodeDependenciesProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vscode-dv-flow" is now active!');

    const rootPath =
        vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined;

    if (rootPath) {
        treeDataProvider = new NodeDependenciesProvider(rootPath);
        vscode.window.registerTreeDataProvider('dvFlowWorkspace', treeDataProvider);

        // Register update tree data command
        let updateDisposable = vscode.commands.registerCommand('vscode-dv-flow.updateTree', (jsonData) => {
            if (treeDataProvider) {
                treeDataProvider.refresh(jsonData);
            }
        });

        // Register refresh command
        let refreshDisposable = vscode.commands.registerCommand('vscode-dv-flow.refreshTree', () => {
            if (treeDataProvider) {
                treeDataProvider.refreshView();
            }
        });

        // Register open task command
        let openTaskDisposable = vscode.commands.registerCommand('vscode-dv-flow.openTask', async (srcinfo: string) => {
            try {
                // Parse the srcinfo string to extract filepath
                // Format is expected to be filename:line:column where filename is absolute
                const [filename, line, column] = srcinfo.split(':');
                
                if (!filename) {
                    throw new Error('Invalid srcinfo format');
                }

                // Open the document using absolute path
                const document = await vscode.workspace.openTextDocument(filename);
                const editor = await vscode.window.showTextDocument(document);

                // If line number is provided, move cursor there
                if (line) {
                    const lineNum = parseInt(line) - 1; // Convert to 0-based line number
                    const colNum = column ? parseInt(column) - 1 : 0;
                    
                    // Create a new selection at the specified position
                    const position = new vscode.Position(lineNum, colNum);
                    editor.selection = new vscode.Selection(position, position);
                    
                    // Reveal the line in the editor
                    editor.revealRange(
                        new vscode.Range(position, position),
                        vscode.TextEditorRevealType.InCenter
                    );
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open task source: ${error instanceof Error ? error.message : String(error)}`);
            }
        });

        context.subscriptions.push(updateDisposable, refreshDisposable, openTaskDisposable);
    }
}

export function deactivate() {}
