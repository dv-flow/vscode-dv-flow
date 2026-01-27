/**
 * Task Details Panel Provider
 * 
 * Shows detailed information about a selected task including:
 * - Source location
 * - Task type (uses)
 * - Parameters
 * - Dependencies (needs)
 * - Dependents
 * - Quick actions
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceManager, FlowRoot, PackageData, TaskInfo } from '../workspace';
import { FlowDocumentCache, FlowDocument } from '../language';

/**
 * Extended task details with resolved information
 */
export interface TaskDetails {
    name: string;
    fullName: string;
    srcinfo?: string;
    uses?: string;
    description?: string;
    needs?: string[];
    dependents?: string[];
    params?: { [key: string]: any };
    outputs?: string[];
    lastRun?: {
        time: Date;
        duration: number;
        status: 'success' | 'failure' | 'cached';
    };
}

/**
 * Task Details Panel Provider
 */
export class TaskDetailsPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'dvflow.taskDetails';
    
    private _view?: vscode.WebviewView;
    private _selectedTask?: TaskDetails;
    private _currentRoot?: FlowRoot;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _workspaceManager: WorkspaceManager,
        private readonly _documentCache: FlowDocumentCache
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'run':
                    if (this._selectedTask) {
                        vscode.commands.executeCommand('vscode-dv-flow.runTask', {
                            label: this._selectedTask.name,
                            data: { task: { name: this._selectedTask.name }, root: this._currentRoot }
                        });
                    }
                    break;
                case 'debug':
                    if (this._selectedTask) {
                        vscode.debug.startDebugging(undefined, {
                            type: 'dvflow',
                            request: 'launch',
                            name: `Debug ${this._selectedTask.name}`,
                            task: this._selectedTask.name
                        });
                    }
                    break;
                case 'openSource':
                    if (this._selectedTask?.srcinfo) {
                        vscode.commands.executeCommand('vscode-dv-flow.openTask', this._selectedTask.srcinfo);
                    }
                    break;
                case 'openRundir':
                    if (this._currentRoot) {
                        const rundirPath = this._workspaceManager.getRundirForRoot(this._currentRoot.path);
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(rundirPath));
                    }
                    break;
                case 'showGraph':
                    if (this._selectedTask) {
                        vscode.commands.executeCommand('vscode-dv-flow.openFlowGraph', {
                            label: this._selectedTask.name
                        });
                    }
                    break;
                case 'selectDependency':
                    await this.selectTask(message.taskName);
                    break;
                case 'ready':
                    this.updateWebview();
                    break;
            }
        });

        // Update when active root changes
        this._workspaceManager.onDidChangeActiveRoot((root) => {
            this._currentRoot = root;
            this._selectedTask = undefined;
            this.updateWebview();
        });

        // Initialize with current root
        this._currentRoot = this._workspaceManager.getActiveRoot();
    }

    /**
     * Select and display details for a task
     */
    public async selectTask(taskName: string): Promise<void> {
        if (!this._currentRoot) {
            this._currentRoot = this._workspaceManager.getActiveRoot();
        }

        if (!this._currentRoot) {
            return;
        }

        const packageData = this._workspaceManager.getPackageData(this._currentRoot.path);
        if (!packageData) {
            return;
        }

        const task = packageData.tasks?.find(t => t.name === taskName);
        if (!task) {
            return;
        }

        // Build detailed task information
        this._selectedTask = await this.buildTaskDetails(task, packageData);
        this.updateWebview();

        // Reveal the panel
        if (this._view) {
            this._view.show?.(true);
        }
    }

    /**
     * Build detailed task information
     */
    private async buildTaskDetails(task: TaskInfo, packageData: PackageData): Promise<TaskDetails> {
        const details: TaskDetails = {
            name: task.name,
            fullName: packageData.name ? `${packageData.name}.${task.name}` : task.name,
            srcinfo: task.srcinfo,
            description: task.description,
            needs: task.needs
        };

        // Try to get more details from the document cache
        if (this._currentRoot) {
            const doc = await this._documentCache.getDocument(vscode.Uri.file(this._currentRoot.path));
            if (doc) {
                const taskDef = doc.tasks.get(task.name);
                if (taskDef) {
                    details.uses = taskDef.uses;
                    details.needs = taskDef.needs;
                    
                    // Find dependents (tasks that need this task)
                    details.dependents = [];
                    for (const [name, otherTask] of doc.tasks) {
                        if (otherTask.needs?.includes(task.name)) {
                            details.dependents.push(name);
                        }
                    }
                }
            }
        }

        return details;
    }

    /**
     * Update the webview content
     */
    private updateWebview(): void {
        if (!this._view) return;

        this._view.webview.postMessage({
            type: 'update',
            data: {
                task: this._selectedTask,
                root: this._currentRoot ? {
                    name: this._currentRoot.packageName,
                    path: this._currentRoot.relativePath
                } : null
            }
        });
    }

    /**
     * Get HTML content for the webview
     */
    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Task Details</title>
    <style>
        body {
            padding: 12px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-panel-background);
        }
        
        .no-selection {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .no-selection .icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.5;
        }
        
        .task-header {
            margin-bottom: 16px;
        }
        
        .task-name {
            font-size: 1.3em;
            font-weight: 600;
            margin-bottom: 4px;
            word-break: break-all;
        }
        
        .task-type {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        
        .task-type .badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.85em;
        }
        
        .task-source {
            font-size: 0.85em;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            margin-bottom: 8px;
        }
        
        .task-source:hover {
            text-decoration: underline;
        }
        
        .section {
            margin-bottom: 16px;
        }
        
        .section-header {
            font-weight: 600;
            font-size: 0.9em;
            margin-bottom: 8px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
        }
        
        .description {
            font-style: italic;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 12px;
        }
        
        .dep-list {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        
        .dep-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            margin-bottom: 2px;
            border-radius: 2px;
            cursor: pointer;
        }
        
        .dep-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .dep-icon {
            width: 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        
        .dep-name {
            flex: 1;
            color: var(--vscode-textLink-foreground);
        }
        
        .param-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9em;
        }
        
        .param-table th,
        .param-table td {
            text-align: left;
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .param-table th {
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
        }
        
        .param-name {
            font-family: var(--vscode-editor-font-family);
            color: var(--vscode-symbolIcon-variableForeground);
        }
        
        .param-value {
            font-family: var(--vscode-editor-font-family);
            color: var(--vscode-debugTokenExpression-string);
        }
        
        .action-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 16px;
        }
        
        .action-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .action-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .action-btn.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .action-btn.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .empty-section {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div id="app">
        <div class="no-selection" id="noSelection">
            <div class="icon">📋</div>
            <div>Select a task to view details</div>
            <div style="font-size: 0.85em; margin-top: 8px;">
                Click on a task in the explorer or graph view
            </div>
        </div>
        
        <div id="taskDetails" style="display: none;">
            <div class="task-header">
                <div class="task-name" id="taskName">-</div>
                <div class="task-type">
                    <span class="badge" id="taskType">-</span>
                </div>
                <div class="task-source" id="taskSource" onclick="openSource()">📍 -</div>
            </div>
            
            <div class="description" id="taskDescription" style="display: none;"></div>
            
            <div class="section" id="paramsSection" style="display: none;">
                <div class="section-header">Parameters</div>
                <table class="param-table" id="paramsTable">
                    <tbody></tbody>
                </table>
            </div>
            
            <div class="section" id="depsSection">
                <div class="section-header">← Dependencies</div>
                <ul class="dep-list" id="depsList"></ul>
            </div>
            
            <div class="section" id="dependentsSection">
                <div class="section-header">→ Dependents</div>
                <ul class="dep-list" id="dependentsList"></ul>
            </div>
            
            <div class="action-buttons">
                <button class="action-btn primary" onclick="runTask()">
                    <span>▶</span> Run
                </button>
                <button class="action-btn" onclick="debugTask()">
                    <span>🐛</span> Debug
                </button>
                <button class="action-btn" onclick="showGraph()">
                    <span>📊</span> Graph
                </button>
                <button class="action-btn" onclick="openRundir()">
                    <span>📂</span> Rundir
                </button>
            </div>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let currentTask = null;
        
        function updateUI(data) {
            const noSelection = document.getElementById('noSelection');
            const taskDetails = document.getElementById('taskDetails');
            
            if (!data.task) {
                noSelection.style.display = 'block';
                taskDetails.style.display = 'none';
                currentTask = null;
                return;
            }
            
            currentTask = data.task;
            noSelection.style.display = 'none';
            taskDetails.style.display = 'block';
            
            // Update header
            document.getElementById('taskName').textContent = data.task.fullName || data.task.name;
            document.getElementById('taskType').textContent = data.task.uses || 'Task';
            
            const srcinfo = data.task.srcinfo || '';
            const shortPath = srcinfo.split('/').pop() || srcinfo;
            document.getElementById('taskSource').textContent = '📍 ' + shortPath;
            document.getElementById('taskSource').title = srcinfo;
            
            // Description
            const descEl = document.getElementById('taskDescription');
            if (data.task.description) {
                descEl.textContent = data.task.description;
                descEl.style.display = 'block';
            } else {
                descEl.style.display = 'none';
            }
            
            // Parameters
            const paramsSection = document.getElementById('paramsSection');
            const paramsTable = document.getElementById('paramsTable').querySelector('tbody');
            paramsTable.innerHTML = '';
            
            if (data.task.params && Object.keys(data.task.params).length > 0) {
                paramsSection.style.display = 'block';
                Object.entries(data.task.params).forEach(([name, value]) => {
                    const row = document.createElement('tr');
                    row.innerHTML = 
                        '<td class="param-name">' + escapeHtml(name) + '</td>' +
                        '<td class="param-value">' + escapeHtml(JSON.stringify(value)) + '</td>';
                    paramsTable.appendChild(row);
                });
            } else {
                paramsSection.style.display = 'none';
            }
            
            // Dependencies
            const depsList = document.getElementById('depsList');
            depsList.innerHTML = '';
            
            if (data.task.needs && data.task.needs.length > 0) {
                data.task.needs.forEach(dep => {
                    const li = document.createElement('li');
                    li.className = 'dep-item';
                    li.innerHTML = 
                        '<span class="dep-icon">←</span>' +
                        '<span class="dep-name">' + escapeHtml(dep) + '</span>';
                    li.onclick = () => selectDependency(dep);
                    depsList.appendChild(li);
                });
            } else {
                depsList.innerHTML = '<li class="empty-section">No dependencies</li>';
            }
            
            // Dependents
            const dependentsList = document.getElementById('dependentsList');
            dependentsList.innerHTML = '';
            
            if (data.task.dependents && data.task.dependents.length > 0) {
                data.task.dependents.forEach(dep => {
                    const li = document.createElement('li');
                    li.className = 'dep-item';
                    li.innerHTML = 
                        '<span class="dep-icon">→</span>' +
                        '<span class="dep-name">' + escapeHtml(dep) + '</span>';
                    li.onclick = () => selectDependency(dep);
                    dependentsList.appendChild(li);
                });
            } else {
                dependentsList.innerHTML = '<li class="empty-section">No dependents</li>';
            }
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function runTask() {
            vscode.postMessage({ command: 'run' });
        }
        
        function debugTask() {
            vscode.postMessage({ command: 'debug' });
        }
        
        function showGraph() {
            vscode.postMessage({ command: 'showGraph' });
        }
        
        function openSource() {
            vscode.postMessage({ command: 'openSource' });
        }
        
        function openRundir() {
            vscode.postMessage({ command: 'openRundir' });
        }
        
        function selectDependency(taskName) {
            vscode.postMessage({ command: 'selectDependency', taskName: taskName });
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                updateUI(message.data);
            }
        });
        
        // Signal ready
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
