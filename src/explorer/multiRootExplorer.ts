/**
 * Multi-Root Flow Explorer
 * 
 * Enhanced tree view that supports multiple flow roots and shows the
 * categorized structure outlined in the update plan:
 * 
 * 🌐 DV Flow Workspace
 *   ├── 📂 Flow Roots
 *   │   ├── 📦 package_name [path] ← ACTIVE
 *   │   │   ├── 📑 Parameters
 *   │   │   ├── 📥 Imports
 *   │   │   ├── 📋 Tasks
 *   │   │   │   ├── 📁 FileSet
 *   │   │   │   ├── 🔧 Build
 *   │   │   │   └── ▶️ Run
 *   │   │   ├── 📝 Types
 *   │   │   └── ⚙️ Configurations
 *   └── 📚 Imported Packages
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { 
    WorkspaceManager, 
    FlowRoot, 
    PackageData, 
    TaskInfo, 
    ImportInfo 
} from '../workspace';
import { getDfmCommand } from '../utils/dfmUtil';

/**
 * Tree item types for context menus and icons
 */
export type FlowTreeItemType = 
    | 'workspace'
    | 'rootsCategory' 
    | 'importedCategory'
    | 'root'
    | 'activeRoot'
    | 'parametersCategory'
    | 'parameter'
    | 'importsCategory'
    | 'import'
    | 'localImport'
    | 'pluginImport'
    | 'tasksCategory'
    | 'taskTypeCategory'
    | 'task'
    | 'typesCategory'
    | 'type'
    | 'configurationsCategory'
    | 'configuration'
    | 'filesCategory'
    | 'file'
    | 'directory';

/**
 * Extended tree item with additional metadata
 */
export class FlowTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: FlowTreeItemType,
        public readonly data?: any
    ) {
        super(label, collapsibleState);
        this.contextValue = itemType;
        this.setIconAndDescription();
    }

    private setIconAndDescription(): void {
        switch (this.itemType) {
            case 'workspace':
                this.iconPath = new vscode.ThemeIcon('globe');
                break;
            case 'rootsCategory':
                this.iconPath = new vscode.ThemeIcon('folder-library');
                break;
            case 'importedCategory':
                this.iconPath = new vscode.ThemeIcon('library');
                break;
            case 'root':
                this.iconPath = new vscode.ThemeIcon('package');
                break;
            case 'activeRoot':
                this.iconPath = new vscode.ThemeIcon('package');
                this.description = '← ACTIVE';
                break;
            case 'parametersCategory':
                this.iconPath = new vscode.ThemeIcon('symbol-parameter');
                break;
            case 'parameter':
                this.iconPath = new vscode.ThemeIcon('symbol-variable');
                break;
            case 'importsCategory':
                this.iconPath = new vscode.ThemeIcon('references');
                break;
            case 'import':
            case 'localImport':
                this.iconPath = new vscode.ThemeIcon('file-symlink-directory');
                break;
            case 'pluginImport':
                this.iconPath = new vscode.ThemeIcon('plug');
                break;
            case 'tasksCategory':
                this.iconPath = new vscode.ThemeIcon('tasklist');
                break;
            case 'taskTypeCategory':
                this.iconPath = new vscode.ThemeIcon('folder');
                break;
            case 'task':
                this.iconPath = new vscode.ThemeIcon('symbol-method');
                break;
            case 'typesCategory':
                this.iconPath = new vscode.ThemeIcon('symbol-class');
                break;
            case 'type':
                this.iconPath = new vscode.ThemeIcon('symbol-interface');
                break;
            case 'configurationsCategory':
                this.iconPath = new vscode.ThemeIcon('gear');
                break;
            case 'configuration':
                this.iconPath = new vscode.ThemeIcon('settings-gear');
                break;
            case 'filesCategory':
                this.iconPath = new vscode.ThemeIcon('files');
                break;
            case 'file':
                this.iconPath = new vscode.ThemeIcon('file');
                break;
            case 'directory':
                this.iconPath = new vscode.ThemeIcon('folder');
                break;
        }
    }
}

/**
 * Tree data provider for the multi-root flow explorer
 */
export class MultiRootFlowExplorer implements vscode.TreeDataProvider<FlowTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FlowTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private workspaceManager: WorkspaceManager;
    private workspaceRoot: string;
    private fileWatchers: vscode.FileSystemWatcher[] = [];
    private isInitialized = false;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.workspaceManager = WorkspaceManager.getInstance(workspaceRoot);
        
        // Subscribe to workspace manager events
        this.workspaceManager.onDidChangeActiveRoot(() => {
            this._onDidChangeTreeData.fire();
        });
        
        this.workspaceManager.onDidDiscoverRoots(() => {
            this._onDidChangeTreeData.fire();
        });

        // Initialize asynchronously
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.workspaceManager.discoverFlows();
        this.setupFileWatchers();
        this.isInitialized = true;
        this._onDidChangeTreeData.fire();
    }

    private setupFileWatchers(): void {
        // Clean up existing watchers
        this.fileWatchers.forEach(w => w.dispose());
        this.fileWatchers = [];

        // Watch for flow file changes
        const patterns = ['**/flow.dv', '**/flow.yaml', '**/flow.yml'];
        for (const pattern of patterns) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.workspaceRoot, pattern)
            );
            watcher.onDidChange(() => this.refresh());
            watcher.onDidCreate(() => this.refresh());
            watcher.onDidDelete(() => this.refresh());
            this.fileWatchers.push(watcher);
        }
    }

    /**
     * Refresh the tree view
     */
    async refresh(): Promise<void> {
        await this.workspaceManager.discoverFlows();
        this._onDidChangeTreeData.fire();
    }

    /**
     * Set a root as the active root
     */
    setActiveRoot(flowPath: string): void {
        this.workspaceManager.setActiveRoot(flowPath);
    }

    getTreeItem(element: FlowTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: FlowTreeItem): Promise<FlowTreeItem[]> {
        if (!this.isInitialized) {
            return [new FlowTreeItem('Loading...', vscode.TreeItemCollapsibleState.None, 'workspace')];
        }

        if (!element) {
            // Root level - return workspace node
            return [new FlowTreeItem(
                'DV Flow Workspace',
                vscode.TreeItemCollapsibleState.Expanded,
                'workspace'
            )];
        }

        switch (element.itemType) {
            case 'workspace':
                return this.getWorkspaceChildren();
            case 'rootsCategory':
                return this.getFlowRootsChildren();
            case 'importedCategory':
                return this.getImportedPackagesChildren();
            case 'root':
            case 'activeRoot':
                return this.getRootChildren(element.data as FlowRoot);
            case 'parametersCategory':
                return this.getParametersChildren(element.data as FlowRoot);
            case 'importsCategory':
                return this.getImportsChildren(element.data as FlowRoot);
            case 'tasksCategory':
                return this.getTasksChildren(element.data as FlowRoot);
            case 'taskTypeCategory':
                return this.getTaskTypeCategoryChildren(element.data);
            case 'typesCategory':
                return this.getTypesChildren(element.data as FlowRoot);
            case 'configurationsCategory':
                return this.getConfigurationsChildren(element.data as FlowRoot);
            case 'filesCategory':
                return this.getFilesChildren(element.data as FlowRoot);
            case 'directory':
                return this.getDirectoryChildren(element.data);
            default:
                return [];
        }
    }

    private getWorkspaceChildren(): FlowTreeItem[] {
        const standaloneRoots = this.workspaceManager.getStandaloneRoots();
        const importedPackages = this.workspaceManager.getImportedPackages();
        
        const children: FlowTreeItem[] = [];
        
        // Flow Roots category
        const rootsLabel = `Flow Roots (${standaloneRoots.length} discovered)`;
        children.push(new FlowTreeItem(
            rootsLabel,
            vscode.TreeItemCollapsibleState.Expanded,
            'rootsCategory'
        ));

        // Imported Packages category (if any)
        if (importedPackages.length > 0) {
            children.push(new FlowTreeItem(
                `Imported Packages (${importedPackages.length})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'importedCategory'
            ));
        }

        return children;
    }

    private getFlowRootsChildren(): FlowTreeItem[] {
        const roots = this.workspaceManager.getStandaloneRoots();
        const activeRoot = this.workspaceManager.getActiveRoot();
        
        return roots.map(root => {
            const isActive = activeRoot?.path === root.path;
            const label = `${root.packageName} [${root.relativePath}]`;
            const item = new FlowTreeItem(
                label,
                isActive ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
                isActive ? 'activeRoot' : 'root',
                root
            );
            item.tooltip = `Package: ${root.packageName}\nPath: ${root.path}`;
            return item;
        });
    }

    private getImportedPackagesChildren(): FlowTreeItem[] {
        const packages = this.workspaceManager.getImportedPackages();
        
        return packages.map(pkg => {
            const item = new FlowTreeItem(
                `${pkg.packageName} [${pkg.relativePath}]`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'root',
                pkg
            );
            item.description = `Imported by: ${pkg.importedBy.length} root(s)`;
            item.tooltip = `Package: ${pkg.packageName}\nPath: ${pkg.path}\nImported by:\n${pkg.importedBy.map(p => '  - ' + path.basename(path.dirname(p))).join('\n')}`;
            return item;
        });
    }

    private getRootChildren(root: FlowRoot): FlowTreeItem[] {
        const children: FlowTreeItem[] = [];
        const packageData = this.workspaceManager.getPackageData(root.path);

        // Parameters category
        children.push(new FlowTreeItem(
            'Parameters',
            vscode.TreeItemCollapsibleState.Collapsed,
            'parametersCategory',
            root
        ));

        // Imports category
        const importCount = packageData?.imports ? Object.keys(packageData.imports).length : 0;
        if (importCount > 0) {
            children.push(new FlowTreeItem(
                `Imports (${importCount})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'importsCategory',
                root
            ));
        }

        // Tasks category
        const taskCount = packageData?.tasks?.length || 0;
        children.push(new FlowTreeItem(
            `Tasks (${taskCount})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'tasksCategory',
            root
        ));

        // Types category (placeholder for future)
        children.push(new FlowTreeItem(
            'Types',
            vscode.TreeItemCollapsibleState.Collapsed,
            'typesCategory',
            root
        ));

        // Configurations category (placeholder for future)
        children.push(new FlowTreeItem(
            'Configurations',
            vscode.TreeItemCollapsibleState.Collapsed,
            'configurationsCategory',
            root
        ));

        // Files category
        const fileCount = packageData?.files?.length || 0;
        if (fileCount > 0) {
            children.push(new FlowTreeItem(
                `Files (${fileCount})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'filesCategory',
                root
            ));
        }

        return children;
    }

    private getParametersChildren(root: FlowRoot): FlowTreeItem[] {
        const packageData = this.workspaceManager.getPackageData(root.path);
        if (!packageData?.params) {
            return [new FlowTreeItem('No parameters defined', vscode.TreeItemCollapsibleState.None, 'parameter')];
        }

        return packageData.params.map(param => {
            const label = `${param.name}: ${param.type}${param.default !== undefined ? ` = ${param.default}` : ''}`;
            const item = new FlowTreeItem(label, vscode.TreeItemCollapsibleState.None, 'parameter', param);
            if (param.description) {
                item.tooltip = param.description;
            }
            return item;
        });
    }

    private getImportsChildren(root: FlowRoot): FlowTreeItem[] {
        const packageData = this.workspaceManager.getPackageData(root.path);
        if (!packageData?.imports) {
            return [];
        }

        return Object.entries(packageData.imports).map(([name, importPath]) => {
            const pathOnly = importPath.split(':')[0];
            const lineMatch = importPath.match(/:(\d+)$/);
            const line = lineMatch ? parseInt(lineMatch[1]) : undefined;
            
            // Determine if this is a local import or plugin
            const isLocal = pathOnly.includes('/') || pathOnly.includes('\\') || 
                           pathOnly.endsWith('.dv') || pathOnly.endsWith('.yaml');
            
            const itemType: FlowTreeItemType = isLocal ? 'localImport' : 'pluginImport';
            const item = new FlowTreeItem(name, vscode.TreeItemCollapsibleState.None, itemType, {
                name,
                path: pathOnly,
                line,
                root
            });
            
            item.description = isLocal ? `(local)` : `(plugin)`;
            item.tooltip = pathOnly;
            
            // Add command to open the import
            if (isLocal) {
                const absPath = path.isAbsolute(pathOnly) 
                    ? pathOnly 
                    : path.join(path.dirname(root.path), pathOnly);
                item.command = {
                    command: 'vscode-dv-flow.openImport',
                    title: 'Open Import',
                    arguments: [absPath, line]
                };
            }
            
            return item;
        });
    }

    private getTasksChildren(root: FlowRoot): FlowTreeItem[] {
        const packageData = this.workspaceManager.getPackageData(root.path);
        if (!packageData?.tasks || packageData.tasks.length === 0) {
            return [new FlowTreeItem('No tasks defined', vscode.TreeItemCollapsibleState.None, 'task')];
        }

        // Group tasks by their type prefix (e.g., std.FileSet -> FileSet)
        const tasksByType = new Map<string, TaskInfo[]>();
        
        for (const task of packageData.tasks) {
            // Try to determine task type from the name or srcinfo
            // For now, just put all tasks in a flat list
            // In the future, we can categorize by task type
            const category = 'All Tasks';
            
            if (!tasksByType.has(category)) {
                tasksByType.set(category, []);
            }
            tasksByType.get(category)!.push(task);
        }

        // If we only have one category, show tasks directly
        if (tasksByType.size === 1) {
            return packageData.tasks.map(task => this.createTaskTreeItem(task, root));
        }

        // Otherwise, show categories
        return Array.from(tasksByType.entries()).map(([category, tasks]) => {
            const item = new FlowTreeItem(
                `${category} (${tasks.length})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'taskTypeCategory',
                { category, tasks, root }
            );
            return item;
        });
    }

    private getTaskTypeCategoryChildren(data: { category: string; tasks: TaskInfo[]; root: FlowRoot }): FlowTreeItem[] {
        return data.tasks.map(task => this.createTaskTreeItem(task, data.root));
    }

    private createTaskTreeItem(task: TaskInfo, root: FlowRoot): FlowTreeItem {
        const item = new FlowTreeItem(
            task.name,
            vscode.TreeItemCollapsibleState.None,
            'task',
            { task, root }
        );
        item.contextValue = 'task';
        
        if (task.srcinfo) {
            item.command = {
                command: 'vscode-dv-flow.openTask',
                title: 'Open Task',
                arguments: [task.srcinfo]
            };
            item.tooltip = `Click to open source\n${task.srcinfo}`;
        }
        
        if (task.description) {
            item.tooltip = task.description;
        }
        
        return item;
    }

    private getTypesChildren(root: FlowRoot): FlowTreeItem[] {
        const packageData = this.workspaceManager.getPackageData(root.path);
        if (!packageData?.types || packageData.types.length === 0) {
            return [new FlowTreeItem('No types defined', vscode.TreeItemCollapsibleState.None, 'type')];
        }

        return packageData.types.map(typeName => {
            return new FlowTreeItem(typeName, vscode.TreeItemCollapsibleState.None, 'type');
        });
    }

    private getConfigurationsChildren(root: FlowRoot): FlowTreeItem[] {
        // Placeholder - configurations will be implemented in a future phase
        return [new FlowTreeItem('No configurations defined', vscode.TreeItemCollapsibleState.None, 'configuration')];
    }

    private getFilesChildren(root: FlowRoot): FlowTreeItem[] {
        const packageData = this.workspaceManager.getPackageData(root.path);
        if (!packageData?.files || packageData.files.length === 0) {
            return [];
        }

        // Build a tree structure for files
        const tree = this.buildFileTree(packageData.files, root);
        return tree;
    }

    private buildFileTree(files: string[], root: FlowRoot): FlowTreeItem[] {
        interface FileNode {
            name: string;
            path: string;
            isDirectory: boolean;
            children: Map<string, FileNode>;
        }

        const rootNode: FileNode = {
            name: '',
            path: '',
            isDirectory: true,
            children: new Map()
        };

        // Build tree structure
        for (const filePath of files) {
            const relPath = path.isAbsolute(filePath) 
                ? path.relative(this.workspaceRoot, filePath)
                : filePath;
            const parts = relPath.split(/[\\/]/).filter(Boolean);
            
            let current = rootNode;
            let currentPath = '';
            
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                currentPath = currentPath ? path.join(currentPath, part) : part;
                
                if (!current.children.has(part)) {
                    current.children.set(part, {
                        name: part,
                        path: currentPath,
                        isDirectory: i < parts.length - 1,
                        children: new Map()
                    });
                }
                current = current.children.get(part)!;
            }
        }

        // Convert to tree items
        const convertToTreeItems = (node: FileNode): FlowTreeItem[] => {
            const items: FlowTreeItem[] = [];
            
            for (const [name, child] of node.children) {
                if (child.isDirectory) {
                    const item = new FlowTreeItem(
                        name,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'directory',
                        { node: child, root }
                    );
                    items.push(item);
                } else {
                    const item = new FlowTreeItem(
                        name,
                        vscode.TreeItemCollapsibleState.None,
                        'file',
                        { path: child.path, root }
                    );
                    item.command = {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [vscode.Uri.file(path.join(this.workspaceRoot, child.path))]
                    };
                    items.push(item);
                }
            }
            
            return items;
        };

        return convertToTreeItems(rootNode);
    }

    private getDirectoryChildren(data: { node: any; root: FlowRoot }): FlowTreeItem[] {
        const items: FlowTreeItem[] = [];
        
        for (const [name, child] of data.node.children) {
            if (child.isDirectory) {
                const item = new FlowTreeItem(
                    name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'directory',
                    { node: child, root: data.root }
                );
                items.push(item);
            } else {
                const item = new FlowTreeItem(
                    name,
                    vscode.TreeItemCollapsibleState.None,
                    'file',
                    { path: child.path, root: data.root }
                );
                item.command = {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [vscode.Uri.file(path.join(this.workspaceRoot, child.path))]
                };
                items.push(item);
            }
        }
        
        return items;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        this.fileWatchers.forEach(w => w.dispose());
    }
}
