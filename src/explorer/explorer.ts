import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { findPythonInterpreter } from '../utils/dfmUtil';
import { expandPath } from '../extension';
import { getDfmCommand } from '../utils/dfmUtil';

interface TaskInfo {
    name: string;
    srcinfo: string;
}

interface ImportInfo {
    path: string;
    line?: number;
}

interface FlowData {
    name: string;
    imports?: { [key: string]: ImportInfo };
    tasks?: TaskInfo[];
    files?: string[];
}

export class FlowTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly srcinfo?: string,
        public readonly importPath?: string
    ) {
        super(label, collapsibleState);
        
        if (srcinfo) {
            this.command = {
                command: 'vscode-dv-flow.openTask',
                title: 'Open Task',
                arguments: [srcinfo]
            };
        }
    }
}

interface FileTreeNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileTreeNode[];
}

export class NodeDependenciesProvider implements vscode.TreeDataProvider<FlowTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<FlowTreeItem | undefined | null | void> = new vscode.EventEmitter<FlowTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FlowTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private flowData: FlowData = {
        name: "No Workspace",
        imports: {},
        tasks: [],
        files: []
    };

    private hasWorkspace = false;
    private fileWatchers: vscode.FileSystemWatcher[] = [];

    constructor(private workspaceRoot: string) {
        this.loadWorkspaceData();
        
        // Watch the root flow.dv file
        const flowWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, 'flow.dv')
        );
        flowWatcher.onDidChange(() => this.refreshView());
        flowWatcher.onDidCreate(() => this.refreshView());
        flowWatcher.onDidDelete(() => this.refreshView());
        this.fileWatchers.push(flowWatcher);
    }

    private updateFileWatchers(): void {
        // Clear existing file watchers
        this.fileWatchers.forEach(watcher => watcher.dispose());
        this.fileWatchers = [];

        // Create watcher for flow.dv
        const flowWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, 'flow.dv')
        );
        flowWatcher.onDidChange(() => this.refreshView());
        flowWatcher.onDidCreate(() => this.refreshView());
        flowWatcher.onDidDelete(() => this.refreshView());
        this.fileWatchers.push(flowWatcher);

        // Create watchers for files from workspace data
        if (this.flowData.files) {
            for (const file of this.flowData.files) {
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(this.workspaceRoot, file)
                );
                watcher.onDidChange(() => this.refreshView());
                watcher.onDidCreate(() => this.refreshView());
                watcher.onDidDelete(() => this.refreshView());
                this.fileWatchers.push(watcher);
            }
        }
    }

    private async loadWorkspaceData(): Promise<void> {
        try {
            const command = await getDfmCommand(this.workspaceRoot, 'util workspace');
            const output = await new Promise<string>((resolve, reject) => {
                child_process.exec(command, { cwd: this.workspaceRoot }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(stdout);
                });
            });

            try {
                // Extract JSON block from output
                const lines = output.split('\n');
                const startIdx = lines.findIndex(line => line.trim().startsWith('{'));
                const endIdx = lines.map(line => line.trim()).lastIndexOf('}');
                if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
                    throw new Error('No valid JSON block found in workspace output');
                }
                const jsonStr = lines.slice(startIdx, endIdx + 1).join('\n');
                const data = JSON.parse(jsonStr);

                // Parse imports to extract file and line number if present
                if (data.imports) {
                    for (const [pkg, val] of Object.entries(data.imports)) {
                        if (typeof val === "string") {
                            // Format: "file:line" or just "file"
                            const match = /^(.+?):(\d+)$/.exec(val);
                            if (match) {
                                data.imports[pkg] = {
                                    path: match[1],
                                    line: parseInt(match[2], 10)
                                };
                            } else {
                                data.imports[pkg] = {
                                    path: val
                                };
                            }
                        }
                    }
                }

                console.log('Workspace data:', data);
                this.hasWorkspace = true;
                this.refresh(data);
            } catch (error) {
                this.setNoWorkspace();
                vscode.window.showErrorMessage('Failed to parse workspace data');
                console.error('Parse error:', error instanceof Error ? error.message : String(error));
            }
        } catch (error) {
            this.setNoWorkspace();
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load workspace data: ${errorMessage}`);
            console.error('Load error:', errorMessage);
        }
    }

    private setNoWorkspace(): void {
        this.hasWorkspace = false;
        this.flowData = {
            name: "No Workspace",
            imports: {},
            tasks: [],
            files: []
        };
        this._onDidChangeTreeData.fire();
    }

    refresh(data: FlowData): void {
        this.flowData = data;
        this._onDidChangeTreeData.fire();
        this.updateFileWatchers();
    }

    refreshView(): void {
        this.loadWorkspaceData();
    }

    getTreeItem(element: FlowTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: FlowTreeItem): Thenable<FlowTreeItem[]> {
        if (!element) {
            // Root level - return the name node
            return Promise.resolve([
                new FlowTreeItem(this.flowData.name, 
                    this.hasWorkspace ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)
            ]);
        }

        if (!this.hasWorkspace) {
            return Promise.resolve([]);
        }

        if (element.label === this.flowData.name) {
            // First level - return category nodes
            return Promise.resolve([
                new FlowTreeItem("imports", vscode.TreeItemCollapsibleState.Collapsed),
                new FlowTreeItem("tasks", vscode.TreeItemCollapsibleState.Collapsed),
                new FlowTreeItem("files", vscode.TreeItemCollapsibleState.Collapsed)
            ]);
        }

        // Second level - return items for each category
        switch (element.label) {
            case "imports":
                return Promise.resolve(
                    Object.entries(this.flowData.imports || {}).map(([imp_name, info]) => {
                        // Always strip any ':<lineno>' from info.path for display and open
                        const fileOnly = info.path.split(':')[0];
                        const absPath = path.isAbsolute(fileOnly)
                            ? fileOnly
                            : path.join(this.workspaceRoot, fileOnly);
                        const item = new FlowTreeItem(
                            imp_name,
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            info.path
                        );
                        item.contextValue = 'import';
                        // Attach import info for click handler
                        (item as any).importInfo = info;
                        item.tooltip = absPath;
                        item.command = {
                            command: 'vscode-dv-flow.openImport',
                            title: 'Open Import',
                            arguments: [
                                absPath,
                                info.line
                            ]
                        };
                        return item;
                    })
                );
            case "tasks":
                return Promise.resolve(
                    (this.flowData.tasks || []).map(task => {
                        const item = new FlowTreeItem(task.name, vscode.TreeItemCollapsibleState.None, task.srcinfo);
                        item.contextValue = 'task';
                        return item;
                    })
                );
case "files":
    // Always include root flow.dv file if it exists and isn't already listed
    let files = this.flowData.files ? [...this.flowData.files] : [];
    const flowDvPath = path.join(this.workspaceRoot, "flow.dv");
    if (fs.existsSync(flowDvPath)) {
        if (!files.includes("flow.dv")) {
            files.unshift("flow.dv");
        }
    }
    // Build tree structure for files
    const tree = this.buildFileTree(files);
    return Promise.resolve(
        tree.map(node => this.fileTreeNodeToTreeItem(node))
    );
            default:
                // Directory or file node
                if ((element as any).fileTreeNode) {
                    const node: FileTreeNode = (element as any).fileTreeNode;
                    if (node.isDirectory && node.children) {
                        return Promise.resolve(
                            node.children.map(child => this.fileTreeNodeToTreeItem(child))
                        );
                    }
                }
                return Promise.resolve([]);
        }
    }

    private buildFileTree(files: string[]): FileTreeNode[] {
        // Internal node type for building the tree
        type InternalNode = {
            name: string;
            path: string;
            isDirectory: boolean;
            children?: { [key: string]: InternalNode };
        };

        const root: { [key: string]: InternalNode } = {};
        for (const filePath of files) {
            // Always get workspace-relative path
            let relPath = filePath;
            if (path.isAbsolute(filePath)) {
                relPath = path.relative(this.workspaceRoot, filePath);
            }
            const parts = relPath.split(/[\\/]/).filter(Boolean);
            let current = root;
            let fullPath = '';
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                fullPath = fullPath ? path.join(fullPath, part) : part;
                if (!current[part]) {
                    current[part] = {
                        name: part,
                        path: fullPath,
                        isDirectory: i < parts.length - 1,
                        children: i < parts.length - 1 ? {} : undefined
                    };
                }
                if (i < parts.length - 1) {
                    current = current[part].children!;
                }
            }
        }
        // Convert internal nodes to FileTreeNode[]
        function toArray(obj: { [key: string]: InternalNode }): FileTreeNode[] {
            return Object.values(obj).map(node => {
                if (node.isDirectory && node.children) {
                    return {
                        name: node.name,
                        path: node.path,
                        isDirectory: true,
                        children: toArray(node.children)
                    };
                }
                return {
                    name: node.name,
                    path: node.path,
                    isDirectory: false
                };
            });
        }
        return toArray(root);
    }

    private fileTreeNodeToTreeItem(node: FileTreeNode): FlowTreeItem {
        // For files, show just the filename; for directories, show just the directory name
        let label = node.name;
        if (!node.isDirectory) {
            label = path.basename(node.path);
        }
        const item = new FlowTreeItem(
            label,
            node.isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );
        (item as any).fileTreeNode = node;
        if (!node.isDirectory) {
            item.tooltip = node.path;
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(path.join(this.workspaceRoot, node.path))]
            };
        }
        return item;
    }
}
