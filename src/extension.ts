import * as vscode from 'vscode';
import { NodeDependenciesProvider, FlowTreeItem } from './explorer/explorer';
import { FlowFileSystem } from './vfs/flowFileSystem';
import { FlowEditorProvider } from './webview/flowEditor';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';

// Helper function to expand variables in paths
export function expandPath(pathWithVars: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    
    // Replace ${workspaceFolder} with actual workspace path
    let expandedPath = pathWithVars.replace(/\${workspaceFolder}/g, workspaceFolder || '');
    
    // Replace ${env:NAME} with environment variable values
    expandedPath = expandedPath.replace(/\${env:([^}]+)}/g, (_, name) => process.env[name] || '');
    
    // Handle user home directory
    expandedPath = expandedPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
    
    return expandedPath;
}

// Export this function so it can be used by other parts of the extension
export async function findPythonInterpreter(rootPath: string): Promise<string> {
    // Determine packages directory from ivpm.yaml if it exists
    let packagesDir = 'packages';
    const ivpmPath = path.join(rootPath, 'ivpm.yaml');
    
    if (fs.existsSync(ivpmPath)) {
        try {
            const ivpmContent = fs.readFileSync(ivpmPath, 'utf8');
            // Basic YAML parsing for the specific structure we need
            const matches = ivpmContent.match(/^package:\s*\n\s+(?:.*\n)*?\s+deps-dir:\s*(.+)$/m);
            if (matches && matches[1]) {
                packagesDir = matches[1].trim();
            }
        } catch (error) {
            console.error('Error reading ivpm.yaml:', error instanceof Error ? error.message : String(error));
        }
    }

    // Check for python in the packages directory
    const workspacePythonPath = path.join(rootPath, packagesDir, 'python/bin/python');
    if (fs.existsSync(workspacePythonPath)) {
        return workspacePythonPath;
    }

    // Check for VSCode's Python configuration
    const pythonConfig = vscode.workspace.getConfiguration('python');
    const configuredPython = pythonConfig.get<string>('defaultInterpreterPath');
    if (configuredPython && fs.existsSync(configuredPython)) {
        return configuredPython;
    }

    // Fallback to system Python
    try {
        const isWindows = process.platform === 'win32';
        const pythonCmd = isWindows ? 'where python' : 'which python3';
        const systemPython = child_process.execSync(pythonCmd).toString().trim().split('\n')[0];
        if (systemPython && fs.existsSync(systemPython)) {
            return systemPython;
        }
    } catch (error) {
        console.error('Error finding system Python:', error instanceof Error ? error.message : String(error));
    }

    throw new Error('No Python interpreter found');
}

let treeDataProvider: NodeDependenciesProvider | undefined;
let flowFileSystem: FlowFileSystem | undefined;

import { DVFlowTaskProvider } from './taskRunner';
import { DVFlowDebugConfigProvider, DVFlowDebugAdapterFactory } from './debugProvider';
import { DVFlowYAMLEditorProvider } from './dvYamlEditor';
export async function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vscode-dv-flow" is now active!');

    // Register DV Flow language features
    context.subscriptions.push(...DVFlowYAMLEditorProvider.register(context));

    // Associate .dv files with YAML validation from RedHat extension
    // const yamlValidation = await vscode.commands.executeCommand('yaml.getSchemaContributions');
    // if (yamlValidation) {
    //     vscode.languages.setLanguageConfiguration('dvflow', {
    //         // Inherit YAML language configuration
    //         wordPattern: /[^\s,\{\}\[\]"']+/
    //     });
    // }

    // Create output channel for DV Flow
    const outputChannel = vscode.window.createOutputChannel('DV Flow');
    context.subscriptions.push(outputChannel);
    
    // Register the task provider
    const taskProvider = new DVFlowTaskProvider();
    context.subscriptions.push(taskProvider.registerTaskProvider());

    // Register debug adapter
    const debugProvider = new DVFlowDebugConfigProvider(outputChannel);
    const debugFactory = new DVFlowDebugAdapterFactory(outputChannel);

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('dvflow', debugProvider),
        vscode.debug.registerDebugAdapterDescriptorFactory('dvflow', debugFactory)
    );

    // Register pickTask command
    context.subscriptions.push(
        vscode.commands.registerCommand('dvflow.pickTask', async () => {
            const taskName = await vscode.window.showInputBox({
                placeHolder: 'Enter the task name to run',
                prompt: 'Enter the name of the DV Flow task you want to execute'
            });
            return taskName;
        })
    );

    // Register run task command
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-dv-flow.runTask', async () => {
            const taskName = await vscode.window.showInputBox({
                placeHolder: 'Enter the task name to run',
                prompt: 'Enter the name of the DV Flow task you want to execute'
            });

            if (taskName) {
                const task = new vscode.Task(
                    { type: 'dvflow', task: taskName },
                    vscode.TaskScope.Workspace,
                    taskName,
                    'dvflow'
                );
                await vscode.tasks.executeTask(task);
            }
        })
    );

    // Check for flow.dv in workspace
    const hasFlow = vscode.workspace.workspaceFolders?.some(folder => {
        const flowPath = path.join(folder.uri.fsPath, 'flow.dv');
        return fs.existsSync(flowPath);
    });

    if (hasFlow) {
        vscode.commands.executeCommand('setContext', 'workspaceHasFlow', true);
    }

    const rootPath =
        vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined;

    // Register virtual filesystem
    flowFileSystem = new FlowFileSystem(context);
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('dvflow', flowFileSystem, {
            isCaseSensitive: true,
            isReadonly: false
        }),
        FlowEditorProvider.register(context)
    );

    if (rootPath) {
        treeDataProvider = new NodeDependenciesProvider(rootPath);
        const treeView = vscode.window.registerTreeDataProvider('dvFlowWorkspace', treeDataProvider);
        context.subscriptions.push(treeView);

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

        // Register open flow graph command
        let openFlowGraphDisposable = vscode.commands.registerCommand('vscode-dv-flow.openFlowGraph', async (item: FlowTreeItem) => {
            try {
                // Get the task name
                const labelName = item.label.split('.').pop() || item.label;
                
                // Create a unique filename using task name and timestamp
                const timestamp = Date.now();
                const safeTaskName = labelName.replace(/[^a-zA-Z0-9]/g, '_');
                const filename = `${safeTaskName}_${timestamp}.dvg`;
                const graphUri = vscode.Uri.parse(`dvflow:/${filename}`);
                
                // Try to get graph using dfm if configured, otherwise fall back to Python
                const config = vscode.workspace.getConfiguration('dvflow');
                const rawDfmPath = config.get<string>('dfmPath');
                
                let command: string;
                if (rawDfmPath) {
                    const dfmPath = expandPath(rawDfmPath);
                    if (fs.existsSync(dfmPath)) {
                        command = `"${dfmPath}" graph "${labelName}"`;
                    } else {
                        const pythonPath = await findPythonInterpreter(rootPath);
                        command = `"${pythonPath}" -m dv_flow.mgr graph "${labelName}"`;
                    }
                } else {
                    const pythonPath = await findPythonInterpreter(rootPath);
                    command = `"${pythonPath}" -m dv_flow.mgr graph "${labelName}"`;
                }
                
                const dotContent = await new Promise<string>((resolve, reject) => {
                    child_process.exec(command, { cwd: rootPath }, (error: Error | null, stdout: string, stderr: string) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve(stdout);
                    });
                });

                // Write the DOT content to the virtual file
                if (flowFileSystem) {
                    flowFileSystem.writeFile(graphUri, Buffer.from(dotContent), { create: true, overwrite: true });
                    
                    // Open the file with the custom flow graph editor and get the panel
                    const panel = await vscode.commands.executeCommand('vscode.openWith', graphUri, 'dvFlow.graphView', {
                        preview: false,
                        viewColumn: vscode.ViewColumn.Beside
                    }) as vscode.WebviewPanel;

                    // Set the panel title to the task name
//                    FlowEditorProvider.setTitle(panel, item.label);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open flow graph: ${error instanceof Error ? error.message : String(error)}`);
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

        // Register go to import declaration command
        let goToImportDeclarationDisposable = vscode.commands.registerCommand(
            'vscode-dv-flow.goToImportDeclaration', 
            async (item: FlowTreeItem) => {
                try {
                    if (!item.importPath) {
                        throw new Error('No import path available');
                    }

                    const importPath = path.join(rootPath, item.importPath);
                    const document = await vscode.workspace.openTextDocument(importPath);
                    await vscode.window.showTextDocument(document);
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to open import declaration: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        );

        context.subscriptions.push(
            updateDisposable, 
            refreshDisposable, 
            openTaskDisposable, 
            openFlowGraphDisposable,
            goToImportDeclarationDisposable
        );
    }
}

export function deactivate() {}

// Export utilities that may be needed by other parts of the extension
export const utilities = {
    findPythonInterpreter,
    expandPath
};
