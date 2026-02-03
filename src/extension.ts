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
import { ActiveRootStatusBar, DfmStatusBar, registerTraceTerminalLinkProvider } from './ui';
import {
    FlowDocumentCache,
    FlowHoverProvider,
    FlowDefinitionProvider,
    FlowReferencesProvider,
    FlowDiagnosticsProvider,
    FlowRenameProvider,
    FlowCompletionProvider,
    FlowCodeLensProvider
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

// Transform DOT graph to replace node IDs with task names in edge labels and tooltips
function transformDotGraphLabels(dotContent: string): string {
    // Build a map of node ID to task name by parsing node definitions
    const nodeMap = new Map<string, string>();
    
    // Match node definitions like: n1 [label="TaskName" ...]
    // Match only lines with -> to avoid confusion with node definitions
    const lines = dotContent.split('\n');
    
    // First pass: extract node labels and remove graph title
    for (const line of lines) {
        if (line.includes('->')) {
            continue; // Skip edge lines
        }
        
        // Check for graph-level label attribute and skip it
        if (line.trim().startsWith('graph [') || line.trim().startsWith('label=')) {
            continue;
        }
        
        const nodeMatch = /(\w+)\s*\[([^\]]+)\]/.exec(line);
        if (nodeMatch) {
            const nodeId = nodeMatch[1];
            const attributes = nodeMatch[2];
            const labelMatch = /label\s*=\s*"([^"]+)"/.exec(attributes);
            if (labelMatch) {
                nodeMap.set(nodeId, labelMatch[1]);
            }
        }
    }
    
    console.log(`[FlowGraph] Found ${nodeMap.size} nodes with labels`);
    if (nodeMap.size > 0) {
        console.log(`[FlowGraph] Sample node mappings:`, Array.from(nodeMap.entries()).slice(0, 3));
    }
    
    // Second pass: transform edge labels and remove graph title
    let edgeCount = 0;
    const transformedLines = lines.map(line => {
        // Remove graph-level label statements
        if (line.trim().startsWith('label=') || 
            (line.trim().startsWith('graph [') && line.includes('label='))) {
            console.log(`[FlowGraph] Removing graph title line: ${line.trim()}`);
            return ''; // Remove the line
        }
        
        // Only process lines with edges
        if (!line.includes('->')) {
            return line;
        }
        
        // Try matching edges with attributes first: n1 -> n2 [...]
        const edgeWithAttrs = /(\w+)\s*->\s*(\w+)\s*\[([^\]]+)\]/.exec(line);
        if (edgeWithAttrs) {
            edgeCount++;
            const fromNode = edgeWithAttrs[1];
            const toNode = edgeWithAttrs[2];
            let attributes = edgeWithAttrs[3];
            
            const fromTask = nodeMap.get(fromNode) || fromNode;
            const toTask = nodeMap.get(toNode) || toNode;
            
            if (edgeCount <= 2) {
                console.log(`[FlowGraph] Adding tooltip for edge: ${fromNode}->${toNode} = ${fromTask} → ${toTask}`);
            }
            
            // Remove any existing label attribute
            attributes = attributes.replace(/label\s*=\s*"([^"]*)"\s*,?\s*/g, '');
            
            // Replace or add tooltip with task names
            if (/tooltip\s*=/.test(attributes)) {
                attributes = attributes.replace(/tooltip\s*=\s*"([^"]*)"/g, `tooltip="${fromTask} → ${toTask}"`);
            } else {
                // Add comma if there are other attributes
                if (attributes.trim().length > 0 && !attributes.trim().endsWith(',')) {
                    attributes = attributes.trim() + ', ';
                }
                attributes += `tooltip="${fromTask} → ${toTask}"`;
            }
            
            // Reconstruct the line
            const indent = line.match(/^\s*/)?.[0] || '';
            return `${indent}${fromNode} -> ${toNode} [${attributes}]`;
        }
        
        // Try matching edges without attributes: n1 -> n2;
        const edgeSimple = /(\w+)\s*->\s*(\w+)\s*;/.exec(line);
        if (edgeSimple) {
            edgeCount++;
            const fromNode = edgeSimple[1];
            const toNode = edgeSimple[2];
            
            const fromTask = nodeMap.get(fromNode) || fromNode;
            const toTask = nodeMap.get(toNode) || toNode;
            
            if (edgeCount <= 2) {
                console.log(`[FlowGraph] Adding tooltip for simple edge: ${fromNode}->${toNode} = ${fromTask} → ${toTask}`);
            }
            
            // Add only tooltip attribute (no label)
            const indent = line.match(/^\s*/)?.[0] || '';
            return `${indent}${fromNode} -> ${toNode} [tooltip="${fromTask} → ${toTask}"];`;
        }
        
        return line;
    });
    
    console.log(`[FlowGraph] Transformed ${edgeCount} edges`);
    
    // Filter out empty lines that were removed
    return transformedLines.filter(line => line !== '').join('\n');
}


let treeDataProvider: MultiRootFlowExplorer | undefined;
let legacyTreeDataProvider: NodeDependenciesProvider | undefined;
let flowFileSystem: FlowFileSystem | undefined;
let workspaceManager: WorkspaceManager | undefined;
let activeRootStatusBar: ActiveRootStatusBar | undefined;
let dfmStatusBar: DfmStatusBar | undefined;
let documentCache: FlowDocumentCache | undefined;
let diagnosticsProvider: FlowDiagnosticsProvider | undefined;
let runPanelProvider: RunPanelProvider | undefined;
let taskDetailsPanelProvider: TaskDetailsPanelProvider | undefined;
let completionProvider: FlowCompletionProvider | undefined;

import { DVFlowTaskProvider } from './taskRunner';
import { DVFlowDebugConfigProvider, DVFlowDebugAdapterFactory } from './debugProvider';
import { DVFlowYAMLEditorProvider } from './dvYamlEditor';
export async function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vscode-dv-flow" is now active!');

    // NOTE: DVFlowYAMLEditorProvider is deprecated - using FlowCompletionProvider instead
    // Register DV Flow language features
    // context.subscriptions.push(...DVFlowYAMLEditorProvider.register(context));

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

    // Register show task discovery log command
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-dv-flow.showTaskDiscoveryLog', () => {
            // This will be set after completionProvider is created
            if (completionProvider) {
                completionProvider.showTaskDiscoveryLog();
            }
        })
    );

    // Register test task discovery command
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-dv-flow.testTaskDiscovery', async () => {
            const config = vscode.workspace.getConfiguration('dvflow.completion');
            const isEnabled = config.get<boolean>('useDfmDiscovery', true);
            const cacheTimeout = config.get<number>('dfmCacheTimeout', 300);
            
            const message = `Task Discovery Settings:\n` +
                          `  Enabled: ${isEnabled}\n` +
                          `  Cache Timeout: ${cacheTimeout} seconds\n\n` +
                          `Check the Developer Console (Help > Toggle Developer Tools) for detailed logs.`;
            
            vscode.window.showInformationMessage(message);
            
            console.log('=== DV Flow Task Discovery Test ===');
            console.log(`Enabled: ${isEnabled}`);
            console.log(`Cache Timeout: ${cacheTimeout}`);
            console.log(`Completion Provider: ${completionProvider ? 'Available' : 'Not initialized'}`);
            console.log('===================================');
        })
    );

    // Register test DFM status command
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-dv-flow.testDfmStatus', async () => {
            if (dfmStatusBar) {
                await dfmStatusBar.showDetailedStatus();
            } else {
                vscode.window.showWarningMessage('DFM Status Bar not initialized');
            }
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
        })
    );

    if (rootPath) {
        // Initialize the workspace manager
        workspaceManager = WorkspaceManager.getInstance(rootPath);
        
        // Register flow editor provider with workspace manager
        context.subscriptions.push(
            FlowEditorProvider.register(context, workspaceManager)
        );
        
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
            vscode.languages.registerHoverProvider(flowSelector, hoverProvider),
            hoverProvider
        );
        
        // Definition provider
        const definitionProvider = new FlowDefinitionProvider(documentCache, workspaceManager);
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider(flowSelector, definitionProvider),
            definitionProvider
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
        completionProvider = new FlowCompletionProvider(documentCache, workspaceManager);
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(flowSelector, completionProvider, ':', '.', ' ', '$', '{')
        );
        // Register completion provider for disposal
        context.subscriptions.push(completionProvider);
        
        // Invalidate dfm task cache when configuration changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('dvflow.completion') || 
                    event.affectsConfiguration('dvflow.dfmPath') ||
                    event.affectsConfiguration('dvflow.pythonPath')) {
                    completionProvider?.invalidateDfmCache();
                    dfmStatusBar?.refresh(); // Refresh DFM status
                }
            })
        );
        
        // Invalidate cache when flow files change
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.uri.fsPath.endsWith('flow.yaml') || 
                    doc.uri.fsPath.endsWith('flow.yml') ||
                    doc.uri.fsPath.endsWith('.dv')) {
                    completionProvider?.invalidateDfmCache();
                }
            })
        );
        
        // CodeLens provider
        const codeLensProvider = new FlowCodeLensProvider(documentCache, workspaceManager);
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(flowSelector, codeLensProvider)
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

        // Create the DFM status bar
        dfmStatusBar = new DfmStatusBar();
        context.subscriptions.push(dfmStatusBar);
        dfmStatusBar.startAutoCheck(); // Periodic status checks

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
                console.log(`[FlowGraph] ============ TRANSFORMING GRAPH LABELS ============`);
                
                // Transform DOT content to replace node IDs with task names in edge labels
                const transformedDotContent = transformDotGraphLabels(dotContent);
                console.log(`[FlowGraph] Transformed DOT content length: ${transformedDotContent.length}`);
                console.log(`[FlowGraph] ============================================`);
                
                // Write the DOT content to the virtual file
                if (flowFileSystem) {
                    flowFileSystem.writeFile(graphUri, Buffer.from(transformedDotContent), { create: true, overwrite: true });
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

        // Register open flow graph from editor command (for CodeLens and context menu)
        let openFlowGraphFromEditorDisposable = vscode.commands.registerCommand(
            'vscode-dv-flow.openFlowGraphFromEditor', 
            async (taskName?: string, documentUri?: vscode.Uri) => {
                try {
                    // If taskName is not provided (context menu), try to extract from cursor position
                    if (!taskName) {
                        const editor = vscode.window.activeTextEditor;
                        if (!editor) {
                            vscode.window.showErrorMessage('No active editor');
                            return;
                        }
                        
                        documentUri = editor.document.uri;
                        const position = editor.selection.active;
                        
                        // Get the flow document and find task at cursor position
                        if (documentCache) {
                            const flowDoc = await documentCache.getDocument(documentUri);
                            
                            if (flowDoc) {
                                // Find task that contains the cursor position
                                for (const [name, task] of flowDoc.tasks) {
                                    const taskStartLine = task.location.line - 1;
                                    const taskEndLine = task.location.endLine ? task.location.endLine - 1 : taskStartLine;
                                    
                                    if (position.line >= taskStartLine && position.line <= taskEndLine) {
                                        taskName = task.name;
                                        break;
                                    }
                                }
                            }
                            
                            if (!taskName) {
                                vscode.window.showErrorMessage('No task found at cursor position. Please place cursor on or within a task declaration.');
                                return;
                            }
                        } else {
                            vscode.window.showErrorMessage('Document cache not initialized');
                            return;
                        }
                    }
                    
                    console.log(`[FlowGraph] Opening flow graph for task from editor: ${taskName}`);
                    
                    // Create a unique filename using task name and timestamp
                    const timestamp = Date.now();
                    const safeTaskName = taskName.replace(/[^a-zA-Z0-9]/g, '_');
                    const filename = `${safeTaskName}_${timestamp}.dvg`;
                    const graphUri = vscode.Uri.parse(`dvflow:/${filename}`);
                    console.log(`[FlowGraph] Graph URI: ${graphUri.toString()}`);
                    
                    // Determine working directory - use the directory containing the document
                    let workingDir = rootPath;
                    if (documentUri) {
                        // Use the directory containing the flow file
                        workingDir = path.dirname(documentUri.fsPath);
                    }
                    
                    // Try to get graph using dfm
                    const command = await getDfmCommand(workingDir, `graph --json "${taskName}"`);
                    console.log(`[FlowGraph] Command: ${command}`);
                    console.log(`[FlowGraph] Working directory: ${workingDir}`);
                    
                    const dotContent = await new Promise<string>((resolve, reject) => {
                        child_process.exec(command, { cwd: workingDir }, (error: Error | null, stdout: string, stderr: string) => {
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
                    console.log(`[FlowGraph] ============ TRANSFORMING GRAPH LABELS ============`);
                    
                    // Transform DOT content to replace node IDs with task names in edge labels
                    const transformedDotContent = transformDotGraphLabels(dotContent);
                    console.log(`[FlowGraph] Transformed DOT content length: ${transformedDotContent.length}`);
                    console.log(`[FlowGraph] ============================================`);
                    
                    // Write the DOT content to the virtual file
                    if (flowFileSystem) {
                        flowFileSystem.writeFile(graphUri, Buffer.from(transformedDotContent), { create: true, overwrite: true });
                        console.log(`[FlowGraph] Written content to virtual file`);
                        
                        // Open the file with the custom flow graph editor
                        await vscode.commands.executeCommand('vscode.openWith', graphUri, 'dvFlow.graphView', {
                            preview: false,
                            viewColumn: vscode.ViewColumn.Beside
                        });
                        console.log(`[FlowGraph] Panel opened`);
                    } else {
                        console.error(`[FlowGraph] flowFileSystem is not initialized!`);
                    }
                } catch (error) {
                    console.error(`[FlowGraph] Error: ${error instanceof Error ? error.message : String(error)}`);
                    vscode.window.showErrorMessage(`Failed to open flow graph: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        );

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
            openFlowGraphFromEditorDisposable,
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
