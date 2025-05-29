import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { findPythonInterpreter, expandPath } from '../extension';

interface TaskInfo {
    name: string;
    srcinfo: string;
}

interface ImportInfo {
    path: string;
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
            const config = vscode.workspace.getConfiguration('dvflow');
            const rawDfmPath = config.get<string>('dfmPath');
            
            let command: string;
            if (rawDfmPath) {
                const dfmPath = expandPath(rawDfmPath);
                if (fs.existsSync(dfmPath)) {
                    command = `"${dfmPath}" util workspace`;
                } else {
                    const pythonPath = await findPythonInterpreter(this.workspaceRoot);
                    command = `"${pythonPath}" -m dv_flow.mgr.util workspace`;
                }
            } else {
                const pythonPath = await findPythonInterpreter(this.workspaceRoot);
                command = `"${pythonPath}" -m dv_flow.mgr util workspace`;
            }
            
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
                const data = JSON.parse(output);
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
                        const item = new FlowTreeItem(
                            `${imp_name} : ${info.path}`, 
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            info.path
                        );
                        item.contextValue = 'import';
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
                return Promise.resolve(
                    (this.flowData.files || []).map(file => 
                        new FlowTreeItem(file, vscode.TreeItemCollapsibleState.None)
                    )
                );
            default:
                return Promise.resolve([]);
        }
    }
}
