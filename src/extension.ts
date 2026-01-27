import * as vscode from 'vscode';
import { NodeDependenciesProvider, FlowTreeItem as LegacyFlowTreeItem } from './explorer/explorer';
import { MultiRootFlowExplorer, FlowTreeItem } from './explorer/multiRootExplorer';
import { FlowFileSystem } from './vfs/flowFileSystem';
import { FlowEditorProvider } from './webview/flowEditor';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { getDfmCommand, testDfmDiscovery, showDiscoveryLog } from './utils/dfmUtil';
import { WorkspaceManager, WorkspaceInfo } from './workspace';
import { ActiveRootStatusBar, registerTraceTerminalLinkProvider } from './ui';
import {
    FlowDocumentCache,
    FlowHoverProvider,
    FlowDefinitionProvider,
    FlowReferencesProvider,
    FlowDiagnosticsProvider,
    FlowRenameProvider,
    FlowCompletionProvider
} from './language';
import { RunPanelProvider, TaskDetailsPanelProvider, PerfettoPanel, PerfettoEditorProvider } from './panels';

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


let treeDataProvider: MultiRootFlowExplorer | undefined;
let legacyTreeDataProvider: NodeDependenciesProvider | undefined;
let flowFileSystem: FlowFileSystem | undefined;
let workspaceManager: WorkspaceManager | undefined;
let activeRootStatusBar: ActiveRootStatusBar | undefined;
let documentCache: FlowDocumentCache | undefined;
let diagnosticsProvider: FlowDiagnosticsProvider | undefined;
let runPanelProvider: RunPanelProvider | undefined;
let taskDetailsPanelProvider: TaskDetailsPanelProvider | undefined;

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

    // Register Perfetto Trace Viewer components
    context.subscriptions.push(
        PerfettoEditorProvider.register(context),
        registerTraceTerminalLinkProvider(context)
    );

    // Register open trace command
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-dv-flow.openTrace', async (uri?: vscode.Uri) => {
            if (uri) {
                // Called with a URI (e.g., from explorer context menu)
                await PerfettoPanel.openTrace(context.extensionUri, uri.fsPath);
            } else {
                // Prompt user to select a trace file
                const files = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: {
                        'Perfetto Traces': ['perfetto-trace', 'pftrace', 'perfetto', 'trace', 'systrace', 'ctrace'],
                        'All Files': ['*']
                    },
                    title: 'Select Trace File'
                });
                if (files && files.length > 0) {
                    await PerfettoPanel.openTrace(context.extensionUri, files[0].fsPath);
                }
            }
        })
    );

    // Register dfm discovery test command
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-dv-flow.testDfmDiscovery', async () => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceRoot) {
                await testDfmDiscovery(workspaceRoot);
            } else {
                vscode.window.showErrorMessage('No workspace folder open');
            }
        })
    );

    // Register show discovery log command
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-dv-flow.showDiscoveryLog', () => {
            showDiscoveryLog();
        })
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

    // Register run task command (root-aware)
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-dv-flow.runTask', async (item: FlowTreeItem | LegacyFlowTreeItem | undefined) => {
            try {
                // If invoked from context menu, item will be provided
                let taskName: string | undefined;
                let runRootPath: string | undefined;
                
                if (item && item.label) {
                    const labelStr = typeof item.label === 'string' ? item.label : (item.label as vscode.TreeItemLabel).label;
                    taskName = labelStr;
                    // Get the root from the item data if available (new multi-root explorer)
                    const itemData = (item as FlowTreeItem).data;
                    if (itemData?.root?.path) {
                        runRootPath = path.dirname(itemData.root.path);
                    } else if (itemData?.task?.name) {
                        taskName = itemData.task.name;
                    }
                } else {
                    // Fallback: prompt for task name
                    taskName = await vscode.window.showInputBox({
                        placeHolder: 'Enter the task name to run',
                        prompt: 'Enter the name of the DV Flow task you want to execute'
                    });
                }

                if (!taskName) {
                    return;
                }

                // Use active root if no specific root was provided
                if (!runRootPath) {
                    const activeRoot = workspaceManager?.getActiveRoot();
                    if (activeRoot) {
                        runRootPath = path.dirname(activeRoot.path);
                    } else {
                        runRootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    }
                }
                
                if (!runRootPath) {
                    vscode.window.showErrorMessage('No workspace folder found');
                    return;
                }

                const command = await getDfmCommand(runRootPath, `run "${taskName}"`);
                outputChannel.clear();
                outputChannel.show(true);
                
                const activeRoot = workspaceManager?.getActiveRoot();
                if (activeRoot) {
                    outputChannel.appendLine(`[${activeRoot.packageName}] Running task: ${taskName}`);
                } else {
                    outputChannel.appendLine(`Running task: ${taskName}`);
                }

                const proc = child_process.exec(command, { cwd: runRootPath });

                proc.stdout?.on('data', (data: string) => {
                    outputChannel.append(data);
                });

                proc.stderr?.on('data', (data: string) => {
                    outputChannel.append(data);
                });

                proc.on('close', (code) => {
                    const exitMessage = `\nTask ${taskName} completed with exit code ${code}`;
                    outputChannel.appendLine(exitMessage);
                });
            } catch (error) {
                outputChannel.appendLine(`Error running task: ${error instanceof Error ? error.message : String(error)}`);
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
        // Initialize the workspace manager
        workspaceManager = WorkspaceManager.getInstance(rootPath);
        
        // Initialize document cache for language features
        documentCache = new FlowDocumentCache();
        
        // Register language providers for flow files
        const flowSelector: vscode.DocumentSelector = [
            { language: 'dvflow', scheme: 'file' },
            { pattern: '**/flow.yaml', scheme: 'file' },
            { pattern: '**/flow.yml', scheme: 'file' },
            { pattern: '**/*.dv', scheme: 'file' }
        ];
        
        // Hover provider
        const hoverProvider = new FlowHoverProvider(documentCache, workspaceManager);
        context.subscriptions.push(
            vscode.languages.registerHoverProvider(flowSelector, hoverProvider)
        );
        
        // Definition provider
        const definitionProvider = new FlowDefinitionProvider(documentCache, workspaceManager);
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider(flowSelector, definitionProvider)
        );
        
        // References provider
        const referencesProvider = new FlowReferencesProvider(documentCache, workspaceManager);
        context.subscriptions.push(
            vscode.languages.registerReferenceProvider(flowSelector, referencesProvider)
        );
        
        // Rename provider
        const renameProvider = new FlowRenameProvider(documentCache, workspaceManager);
        context.subscriptions.push(
            vscode.languages.registerRenameProvider(flowSelector, renameProvider)
        );
        
        // Enhanced completion provider
        const completionProvider = new FlowCompletionProvider(documentCache, workspaceManager);
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(flowSelector, completionProvider, ':', '.', ' ', '$', '{')
        );
        
        // Diagnostics provider
        diagnosticsProvider = new FlowDiagnosticsProvider(documentCache, workspaceManager);
        diagnosticsProvider.register(context);
        
        // Pre-load flow documents into cache when roots are discovered
        const docCache = documentCache; // Capture for closure
        workspaceManager.onDidDiscoverRoots(async (info) => {
            for (const root of info.flowRoots) {
                try {
                    await docCache.getDocument(vscode.Uri.file(root.path));
                } catch (error) {
                    console.error(`Error pre-loading document ${root.path}:`, error);
                }
            }
        });
        
        // Create the multi-root flow explorer
        treeDataProvider = new MultiRootFlowExplorer(rootPath);
        const treeView = vscode.window.registerTreeDataProvider('dvFlowWorkspace', treeDataProvider);
        context.subscriptions.push(treeView);
        
        // Create the active root status bar
        activeRootStatusBar = new ActiveRootStatusBar(workspaceManager);
        context.subscriptions.push(activeRootStatusBar);

        // Register Run Panel
        runPanelProvider = new RunPanelProvider(context.extensionUri, workspaceManager, outputChannel);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(RunPanelProvider.viewType, runPanelProvider)
        );

        // Register Task Details Panel
        taskDetailsPanelProvider = new TaskDetailsPanelProvider(context.extensionUri, workspaceManager, documentCache);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(TaskDetailsPanelProvider.viewType, taskDetailsPanelProvider)
        );

        // Register show task details command
        context.subscriptions.push(
            vscode.commands.registerCommand('vscode-dv-flow.showTaskDetails', async (item?: FlowTreeItem) => {
                if (taskDetailsPanelProvider && item?.data?.task?.name) {
                    await taskDetailsPanelProvider.selectTask(item.data.task.name);
                }
            })
        );

        // Register show run panel command
        context.subscriptions.push(
            vscode.commands.registerCommand('vscode-dv-flow.showRunPanel', async () => {
                // Focus the run panel view
                vscode.commands.executeCommand('dvflow.runPanel.focus');
            })
        );

        // Register select active root command (for status bar)
        context.subscriptions.push(
            vscode.commands.registerCommand('vscode-dv-flow.selectActiveRoot', async () => {
                if (activeRootStatusBar) {
                    await activeRootStatusBar.showRootPicker();
                }
            })
        );

        // Register set active root command (for tree view context menu)
        context.subscriptions.push(
            vscode.commands.registerCommand('vscode-dv-flow.setActiveRoot', async (item: FlowTreeItem) => {
                if (item && item.data && item.data.path) {
                    workspaceManager?.setActiveRoot(item.data.path);
                }
            })
        );

        // Register discover roots command
        context.subscriptions.push(
            vscode.commands.registerCommand('vscode-dv-flow.discoverRoots', async () => {
                if (workspaceManager) {
                    await workspaceManager.discoverFlows();
                    vscode.window.showInformationMessage(
                        `Discovered ${workspaceManager.getAllRoots().length} DV Flow root(s)`
                    );
                }
            })
        );

        // Register update tree data command
        let updateDisposable = vscode.commands.registerCommand('vscode-dv-flow.updateTree', (jsonData) => {
            // For backward compatibility
        });

        // Register refresh command
        let refreshDisposable = vscode.commands.registerCommand('vscode-dv-flow.refreshTree', () => {
            if (treeDataProvider) {
                treeDataProvider.refresh();
            }
        });

        // Register open flow graph command
        let openFlowGraphDisposable = vscode.commands.registerCommand('vscode-dv-flow.openFlowGraph', async (item: FlowTreeItem) => {
            try {
                // Get the task name
                const labelName = item.label.split('.').pop() || item.label;
                console.log(`[FlowGraph] Opening flow graph for task: ${labelName}`);
                
                // Create a unique filename using task name and timestamp
                const timestamp = Date.now();
                const safeTaskName = labelName.replace(/[^a-zA-Z0-9]/g, '_');
                const filename = `${safeTaskName}_${timestamp}.dvg`;
                const graphUri = vscode.Uri.parse(`dvflow:/${filename}`);
                console.log(`[FlowGraph] Graph URI: ${graphUri.toString()}`);
                
                // Try to get graph using dfm if configured, otherwise fall back to Python
                const command = await getDfmCommand(rootPath, `graph --json "${labelName}"`);
                console.log(`[FlowGraph] Command: ${command}`);
                console.log(`[FlowGraph] Working directory: ${rootPath}`);
                
                const dotContent = await new Promise<string>((resolve, reject) => {
                    child_process.exec(command, { cwd: rootPath }, (error: Error | null, stdout: string, stderr: string) => {
                        if (error) {
                            console.error(`[FlowGraph] Command error: ${error.message}`);
                            reject(error);
                            return;
                        }
                        if (stderr) {
                            console.warn(`[FlowGraph] Command stderr: ${stderr}`);
                        }
                        console.log(`[FlowGraph] Command stdout length: ${stdout.length}`);
                        
                        // Extract DOT content from JSON wrapper using markers
                        const beginMarker = '<<<DFM_GRAPH_BEGIN>>>';
                        const endMarker = '<<<DFM_GRAPH_END>>>';
                        const beginIdx = stdout.indexOf(beginMarker);
                        const endIdx = stdout.indexOf(endMarker);
                        
                        if (beginIdx !== -1 && endIdx !== -1) {
                            const jsonStr = stdout.substring(beginIdx + beginMarker.length, endIdx).trim();
                            try {
                                const parsed = JSON.parse(jsonStr);
                                console.log(`[FlowGraph] Successfully extracted DOT content from JSON`);
                                resolve(parsed.graph);
                            } catch (parseError) {
                                console.error(`[FlowGraph] Failed to parse JSON: ${parseError}`);
                                reject(new Error(`Failed to parse graph JSON output: ${parseError}`));
                            }
                        } else {
                            // Fallback: try to use raw output (for backwards compatibility)
                            console.warn(`[FlowGraph] Markers not found, using raw output`);
                            console.log(`[FlowGraph] DOT content preview: ${stdout.substring(0, 200)}`);
                            resolve(stdout);
                        }
                    });
                });

                console.log(`[FlowGraph] DOT content length: ${dotContent.length}`);
                
                // Write the DOT content to the virtual file
                if (flowFileSystem) {
                    flowFileSystem.writeFile(graphUri, Buffer.from(dotContent), { create: true, overwrite: true });
                    console.log(`[FlowGraph] Written content to virtual file`);
                    
                    // Open the file with the custom flow graph editor and get the panel
                    const panel = await vscode.commands.executeCommand('vscode.openWith', graphUri, 'dvFlow.graphView', {
                        preview: false,
                        viewColumn: vscode.ViewColumn.Beside
                    }) as vscode.WebviewPanel;
                    console.log(`[FlowGraph] Panel opened`);

                    // Set the panel title to the task name
//                    FlowEditorProvider.setTitle(panel, item.label);
                } else {
                    console.error(`[FlowGraph] flowFileSystem is not initialized!`);
                }
            } catch (error) {
                console.error(`[FlowGraph] Error: ${error instanceof Error ? error.message : String(error)}`);
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
            async (item: FlowTreeItem | LegacyFlowTreeItem) => {
                try {
                    // Handle both legacy and new tree items
                    const legacyItem = item as LegacyFlowTreeItem;
                    const newItem = item as FlowTreeItem;
                    
                    let importFilePath: string | undefined;
                    let importLine: number | undefined;
                    
                    if (legacyItem.importPath) {
                        // Legacy tree item
                        importFilePath = path.join(rootPath, legacyItem.importPath);
                    } else if (newItem.data?.path) {
                        // New multi-root tree item
                        importFilePath = path.isAbsolute(newItem.data.path)
                            ? newItem.data.path
                            : path.join(rootPath, newItem.data.path);
                        importLine = newItem.data.line;
                    }
                    
                    if (!importFilePath) {
                        throw new Error('No import path available');
                    }

                    const document = await vscode.workspace.openTextDocument(importFilePath);
                    const editor = await vscode.window.showTextDocument(document);
                    
                    if (importLine !== undefined) {
                        const pos = new vscode.Position(Math.max(0, importLine - 1), 0);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to open import declaration: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        );

        // Register open import command
        let openImportDisposable = vscode.commands.registerCommand(
            'vscode-dv-flow.openImport',
            async (filePath: string, line?: number) => {
                try {
                    const document = await vscode.workspace.openTextDocument(filePath);
                    const editor = await vscode.window.showTextDocument(document);
                    if (typeof line === "number" && !isNaN(line)) {
                        const pos = new vscode.Position(Math.max(0, line - 1), 0);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to open import: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        );

        context.subscriptions.push(
            updateDisposable, 
            refreshDisposable, 
            openTaskDisposable, 
            openFlowGraphDisposable,
            goToImportDeclarationDisposable,
            openImportDisposable
        );
    }
}

export function deactivate() {
    // Clean up workspace manager
    if (workspaceManager) {
        workspaceManager.dispose();
        workspaceManager = undefined;
    }
    
    // Clean up tree provider
    if (treeDataProvider) {
        treeDataProvider.dispose();
        treeDataProvider = undefined;
    }
    
    // Clean up status bar
    if (activeRootStatusBar) {
        activeRootStatusBar.dispose();
        activeRootStatusBar = undefined;
    }
    
    // Clean up diagnostics provider
    if (diagnosticsProvider) {
        diagnosticsProvider.dispose();
        diagnosticsProvider = undefined;
    }
    
    // Clean up document cache
    if (documentCache) {
        documentCache.clear();
        documentCache = undefined;
    }
    
    // Reset singleton instance
    WorkspaceManager.resetInstance();
}

// Export utilities that may be needed by other parts of the extension
export const utilities = {
    expandPath
};
