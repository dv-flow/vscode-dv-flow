/**
 * Run Panel Provider
 * 
 * Provides a dedicated webview panel for workflow execution with:
 * - Real-time progress display
 * - Task status tracking
 * - Output streaming
 * - Cancel support
 * - Multi-root awareness
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import { WorkspaceManager, FlowRoot } from '../workspace';
import { getDfmCommand } from '../utils/dfmUtil';

/**
 * Task execution state
 */
export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'cached' | 'skipped';

/**
 * Individual task status during execution
 */
export interface TaskStatus {
    name: string;
    state: TaskState;
    progress?: number;
    duration?: number;
    message?: string;
    startTime?: number;
    endTime?: number;
}

/**
 * Overall run status
 */
export interface RunStatus {
    target: string;
    root: FlowRoot;
    state: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
    tasks: Map<string, TaskStatus>;
    totalTasks: number;
    completedTasks: number;
    startTime?: number;
    endTime?: number;
    output: string[];
    tracePath?: string;  // Path to Perfetto trace file if detected
}

/**
 * Run Panel Provider - manages the webview panel for task execution
 */
export class RunPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'dvflow.runPanel';
    
    private _view?: vscode.WebviewView;
    private _runStatus?: RunStatus;
    private _currentProcess?: child_process.ChildProcess;
    private _outputChannel: vscode.OutputChannel;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _workspaceManager: WorkspaceManager,
        outputChannel: vscode.OutputChannel
    ) {
        this._outputChannel = outputChannel;
    }

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
                    await this.runTask(message.task, message.clean);
                    break;
                case 'stop':
                    this.stopExecution();
                    break;
                case 'selectRoot':
                    await this.selectRoot();
                    break;
                case 'selectTask':
                    await this.selectTask();
                    break;
                case 'openOutput':
                    this._outputChannel.show();
                    break;
                case 'openTrace':
                    if (this._runStatus?.tracePath) {
                        vscode.commands.executeCommand('vscode-dv-flow.openTrace', vscode.Uri.file(this._runStatus.tracePath));
                    }
                    break;
                case 'ready':
                    this.updateWebview();
                    break;
            }
        });

        // Update view when active root changes
        this._workspaceManager.onDidChangeActiveRoot(() => {
            this.updateWebview();
        });
    }

    /**
     * Run a task
     */
    public async runTask(taskName?: string, clean: boolean = false): Promise<void> {
        const activeRoot = this._workspaceManager.getActiveRoot();
        if (!activeRoot) {
            vscode.window.showErrorMessage('No active DV Flow root selected');
            return;
        }

        if (!taskName) {
            taskName = await this.selectTask();
            if (!taskName) {
                return;
            }
        }

        // Initialize run status
        this._runStatus = {
            target: taskName,
            root: activeRoot,
            state: 'running',
            tasks: new Map(),
            totalTasks: 0,
            completedTasks: 0,
            startTime: Date.now(),
            output: []
        };

        this.updateWebview();

        const rootDir = path.dirname(activeRoot.path);
        const cleanFlag = clean ? ' --clean' : '';
        const command = await getDfmCommand(rootDir, `run "${taskName}"${cleanFlag}`);

        this._outputChannel.clear();
        this._outputChannel.appendLine(`[${activeRoot.packageName}] Running task: ${taskName}`);
        this._outputChannel.appendLine(`Command: ${command}`);
        this._outputChannel.appendLine('---');
        this._outputChannel.show(true); // Show output panel, preserving focus on editor

        try {
            this._currentProcess = child_process.spawn(command, {
                cwd: rootDir,
                shell: true,
                env: { ...process.env, FORCE_COLOR: '1' }
            });

            this._currentProcess.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                this._outputChannel.append(text);
                this.parseOutput(text);
            });

            this._currentProcess.stderr?.on('data', (data: Buffer) => {
                const text = data.toString();
                this._outputChannel.append(text);
                this.parseOutput(text);
            });

            this._currentProcess.on('close', (code) => {
                if (this._runStatus) {
                    this._runStatus.state = code === 0 ? 'completed' : 'failed';
                    this._runStatus.endTime = Date.now();
                }
                this._currentProcess = undefined;
                
                const exitMessage = `\n--- Task ${taskName} completed with exit code ${code} ---`;
                this._outputChannel.appendLine(exitMessage);
                this.updateWebview();
            });

            this._currentProcess.on('error', (error) => {
                if (this._runStatus) {
                    this._runStatus.state = 'failed';
                    this._runStatus.output.push(`Error: ${error.message}`);
                }
                this._currentProcess = undefined;
                this.updateWebview();
            });

        } catch (error) {
            if (this._runStatus) {
                this._runStatus.state = 'failed';
            }
            const errorMsg = error instanceof Error ? error.message : String(error);
            this._outputChannel.appendLine(`Error: ${errorMsg}`);
            this.updateWebview();
        }
    }

    /**
     * Stop the current execution
     */
    public stopExecution(): void {
        if (this._currentProcess) {
            this._currentProcess.kill('SIGTERM');
            if (this._runStatus) {
                this._runStatus.state = 'cancelled';
                this._runStatus.endTime = Date.now();
            }
            this._outputChannel.appendLine('\n--- Execution cancelled ---');
            this.updateWebview();
        }
    }

    /**
     * Parse output to extract task status
     */
    private parseOutput(text: string): void {
        if (!this._runStatus) {
            return;
        }

        // Add to output buffer
        this._runStatus.output.push(text);

        // Parse task status patterns from dfm output
        // Pattern: [TASK_NAME] status message
        const taskPattern = /\[([^\]]+)\]\s*(Starting|Completed|Failed|Cached|Running|Skipped)(?:\s+(.*))?/gi;
        let match;
        
        while ((match = taskPattern.exec(text)) !== null) {
            const taskName = match[1];
            const status = match[2].toLowerCase();
            const message = match[3];

            let state: TaskState = 'pending';
            switch (status) {
                case 'starting':
                case 'running':
                    state = 'running';
                    break;
                case 'completed':
                    state = 'completed';
                    break;
                case 'failed':
                    state = 'failed';
                    break;
                case 'cached':
                    state = 'cached';
                    break;
                case 'skipped':
                    state = 'skipped';
                    break;
            }

            const existing = this._runStatus.tasks.get(taskName);
            if (existing) {
                existing.state = state;
                existing.message = message;
                if (state === 'running' && !existing.startTime) {
                    existing.startTime = Date.now();
                }
                if (state === 'completed' || state === 'failed' || state === 'cached') {
                    existing.endTime = Date.now();
                    if (existing.startTime) {
                        existing.duration = existing.endTime - existing.startTime;
                    }
                }
            } else {
                this._runStatus.tasks.set(taskName, {
                    name: taskName,
                    state,
                    message,
                    startTime: state === 'running' ? Date.now() : undefined
                });
                this._runStatus.totalTasks++;
            }

            // Count completed
            this._runStatus.completedTasks = Array.from(this._runStatus.tasks.values())
                .filter(t => ['completed', 'failed', 'cached', 'skipped'].includes(t.state))
                .length;
        }

        // Also look for progress patterns like "12/18 tasks"
        const progressPattern = /(\d+)\/(\d+)\s*tasks?/i;
        const progressMatch = text.match(progressPattern);
        if (progressMatch) {
            this._runStatus.completedTasks = parseInt(progressMatch[1]);
            this._runStatus.totalTasks = parseInt(progressMatch[2]);
        }

        // Detect trace file paths in output
        // Common patterns: "Trace written to: path", "trace: path", or just paths with trace extensions
        const tracePatterns = [
            /(?:Trace\s+(?:written|saved)\s+(?:to|at)[:\s]+)([^\s'"]+)/i,
            /(?:trace[:\s]+)([^\s'"]*(?:\.perfetto-trace|\.pftrace|\.perfetto|\.trace))/i,
            /((?:\/[^\s'"]+|\.\/[^\s'"]+)(?:\.perfetto-trace|\.pftrace|\.perfetto))/,
            /(rundir\/[^\s'"]*(?:trace|\.perfetto)[^\s'"]*)/i
        ];

        for (const pattern of tracePatterns) {
            const traceMatch = text.match(pattern);
            if (traceMatch && traceMatch[1]) {
                let tracePath = traceMatch[1];
                // Resolve relative paths
                if (!path.isAbsolute(tracePath) && this._runStatus.root) {
                    tracePath = path.join(path.dirname(this._runStatus.root.path), tracePath);
                }
                this._runStatus.tracePath = tracePath;
                break;
            }
        }

        this.updateWebview();
    }

    /**
     * Select a root package
     */
    private async selectRoot(): Promise<void> {
        const roots = this._workspaceManager.getStandaloneRoots();
        if (roots.length === 0) {
            vscode.window.showInformationMessage('No DV Flow roots found');
            return;
        }

        const items = roots.map(root => ({
            label: root.packageName,
            description: root.relativePath,
            root
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select DV Flow Root'
        });

        if (selected) {
            this._workspaceManager.setActiveRoot(selected.root.path);
        }
    }

    /**
     * Select a task to run
     */
    private async selectTask(): Promise<string | undefined> {
        const activeRoot = this._workspaceManager.getActiveRoot();
        if (!activeRoot) {
            vscode.window.showErrorMessage('No active root selected');
            return undefined;
        }

        const packageData = this._workspaceManager.getPackageData(activeRoot.path);
        if (!packageData?.tasks || packageData.tasks.length === 0) {
            vscode.window.showInformationMessage('No tasks found in the active root');
            return undefined;
        }

        const items = packageData.tasks.map(task => ({
            label: task.name,
            description: task.srcinfo,
            detail: task.description
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select task to run'
        });

        return selected?.label;
    }

    /**
     * Update the webview content
     */
    private updateWebview(): void {
        if (!this._view) {
            return;
        }

        const activeRoot = this._workspaceManager.getActiveRoot();
        const packageData = activeRoot ? this._workspaceManager.getPackageData(activeRoot.path) : undefined;

        this._view.webview.postMessage({
            type: 'update',
            data: {
                activeRoot: activeRoot ? {
                    name: activeRoot.packageName,
                    path: activeRoot.relativePath
                } : null,
                tasks: packageData?.tasks || [],
                runStatus: this._runStatus ? {
                    target: this._runStatus.target,
                    state: this._runStatus.state,
                    totalTasks: this._runStatus.totalTasks,
                    completedTasks: this._runStatus.completedTasks,
                    tasks: Array.from(this._runStatus.tasks.values()),
                    tracePath: this._runStatus.tracePath,
                    duration: this._runStatus.endTime && this._runStatus.startTime
                        ? this._runStatus.endTime - this._runStatus.startTime
                        : this._runStatus.startTime
                            ? Date.now() - this._runStatus.startTime
                            : 0
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
    <title>DV Flow Run Panel</title>
    <style>
        body {
            padding: 10px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-panel-background);
        }
        
        .section {
            margin-bottom: 16px;
        }
        
        .section-header {
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 4px;
        }
        
        .root-selector {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            margin-bottom: 12px;
        }
        
        .root-icon {
            font-size: 16px;
        }
        
        .root-name {
            flex: 1;
            font-weight: 500;
        }
        
        .root-path {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        
        .change-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 8px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 0.85em;
        }
        
        .change-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .task-selector {
            margin-bottom: 12px;
        }
        
        .task-selector select {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
        }
        
        .action-buttons {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
        }
        
        .action-btn {
            flex: 1;
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        
        .run-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .run-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .run-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .stop-btn {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
        }
        
        .stop-btn:hover {
            opacity: 0.9;
        }
        
        .progress-section {
            margin-bottom: 16px;
        }
        
        .progress-bar {
            height: 8px;
            background: var(--vscode-progressBar-background);
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 8px;
        }
        
        .progress-fill {
            height: 100%;
            background: var(--vscode-progressBar-background);
            transition: width 0.3s ease;
        }
        
        .progress-fill.running {
            background: var(--vscode-charts-blue);
        }
        
        .progress-fill.completed {
            background: var(--vscode-charts-green);
        }
        
        .progress-fill.failed {
            background: var(--vscode-charts-red);
        }
        
        .progress-text {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        
        .task-list {
            max-height: 200px;
            overflow-y: auto;
        }
        
        .task-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            border-radius: 2px;
            margin-bottom: 2px;
        }
        
        .task-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .task-icon {
            width: 16px;
            text-align: center;
        }
        
        .task-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .task-duration {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        
        .task-item.running {
            background: var(--vscode-editor-findMatchHighlightBackground);
        }
        
        .task-item.completed .task-icon { color: var(--vscode-charts-green); }
        .task-item.failed .task-icon { color: var(--vscode-charts-red); }
        .task-item.cached .task-icon { color: var(--vscode-charts-yellow); }
        .task-item.running .task-icon { color: var(--vscode-charts-blue); }
        
        .output-link {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 12px;
            margin-top: 10px;
            background: var(--vscode-button-secondaryBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
            color: var(--vscode-button-secondaryForeground);
            font-size: 13px;
        }
        
        .output-link:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .output-link .icon {
            margin-right: 8px;
        }
        
        .trace-link {
            background: var(--vscode-statusBarItem-prominentBackground, #4fc3f7);
            color: var(--vscode-statusBarItem-prominentForeground, #000000);
            border-color: var(--vscode-statusBarItem-prominentBackground, #4fc3f7);
        }
        
        .trace-link:hover {
            background: var(--vscode-statusBarItem-prominentHoverBackground, #29b6f6);
        }
        
        .no-root {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid currentColor;
            border-right-color: transparent;
            border-radius: 50%;
            animation: spin 0.75s linear infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div id="app">
        <div class="no-root" id="noRoot">
            <p>No DV Flow root selected</p>
            <button class="action-btn run-btn" onclick="selectRoot()">Select Root</button>
        </div>
        
        <div id="mainContent" style="display: none;">
            <div class="root-selector" id="rootSelector">
                <span class="root-icon">📦</span>
                <div>
                    <div class="root-name" id="rootName">-</div>
                    <div class="root-path" id="rootPath">-</div>
                </div>
                <button class="change-btn" onclick="selectRoot()">Change</button>
            </div>
            
            <div class="section task-selector">
                <label>Target Task:</label>
                <select id="taskSelect" onchange="updateSelectedTask()">
                    <option value="">-- Select a task --</option>
                </select>
            </div>
            
            <div class="action-buttons">
                <button class="action-btn run-btn" id="runBtn" onclick="runTask(false)">
                    <span>▶</span> Run
                </button>
                <button class="action-btn run-btn" id="runCleanBtn" onclick="runTask(true)">
                    <span>🔄</span> Run Clean
                </button>
                <button class="action-btn stop-btn" id="stopBtn" onclick="stopExecution()" style="display: none;">
                    <span>⏹</span> Stop
                </button>
            </div>
            
            <div class="section progress-section" id="progressSection" style="display: none;">
                <div class="section-header">Progress</div>
                <div class="progress-bar">
                    <div class="progress-fill" id="progressFill" style="width: 0%"></div>
                </div>
                <div class="progress-text" id="progressText">0/0 tasks</div>
            </div>
            
            <div class="section" id="tasksSection" style="display: none;">
                <div class="section-header">Tasks</div>
                <div class="task-list" id="taskList"></div>
            </div>
            
            <div class="output-link" id="outputLink" onclick="openOutput()" style="display: none;">
                <span class="icon">📋</span> View Output in Output Panel
            </div>
            
            <div class="output-link trace-link" id="traceLink" onclick="openTrace()" style="display: none;">
                <span class="icon">📊</span> View Trace in Perfetto Viewer
            </div>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let state = {
            activeRoot: null,
            tasks: [],
            runStatus: null,
            selectedTask: ''
        };
        
        function updateUI() {
            const noRoot = document.getElementById('noRoot');
            const mainContent = document.getElementById('mainContent');
            
            if (!state.activeRoot) {
                noRoot.style.display = 'block';
                mainContent.style.display = 'none';
                return;
            }
            
            noRoot.style.display = 'none';
            mainContent.style.display = 'block';
            
            // Update root info
            document.getElementById('rootName').textContent = state.activeRoot.name;
            document.getElementById('rootPath').textContent = state.activeRoot.path;
            
            // Update task selector
            const taskSelect = document.getElementById('taskSelect');
            const currentValue = taskSelect.value;
            taskSelect.innerHTML = '<option value="">-- Select a task --</option>';
            state.tasks.forEach(task => {
                const option = document.createElement('option');
                option.value = task.name;
                option.textContent = task.name;
                taskSelect.appendChild(option);
            });
            if (currentValue && state.tasks.some(t => t.name === currentValue)) {
                taskSelect.value = currentValue;
            }
            
            // Update buttons based on run state
            const isRunning = state.runStatus?.state === 'running';
            document.getElementById('runBtn').style.display = isRunning ? 'none' : 'flex';
            document.getElementById('runCleanBtn').style.display = isRunning ? 'none' : 'flex';
            document.getElementById('stopBtn').style.display = isRunning ? 'flex' : 'none';
            
            // Update progress section
            const progressSection = document.getElementById('progressSection');
            const tasksSection = document.getElementById('tasksSection');
            const outputLink = document.getElementById('outputLink');
            const traceLink = document.getElementById('traceLink');
            
            if (state.runStatus) {
                progressSection.style.display = 'block';
                tasksSection.style.display = 'block';
                outputLink.style.display = 'flex';
                
                // Show trace link if trace path is available and run is not running
                const showTrace = state.runStatus.tracePath && state.runStatus.state !== 'running';
                traceLink.style.display = showTrace ? 'flex' : 'none';
                
                const percent = state.runStatus.totalTasks > 0 
                    ? (state.runStatus.completedTasks / state.runStatus.totalTasks * 100) 
                    : 0;
                
                const progressFill = document.getElementById('progressFill');
                progressFill.style.width = percent + '%';
                progressFill.className = 'progress-fill ' + state.runStatus.state;
                
                document.getElementById('progressText').textContent = 
                    state.runStatus.completedTasks + '/' + state.runStatus.totalTasks + ' tasks' +
                    (state.runStatus.duration ? ' (' + formatDuration(state.runStatus.duration) + ')' : '');
                
                // Update task list
                const taskList = document.getElementById('taskList');
                taskList.innerHTML = '';
                
                // Sort: running first, then by state
                const sortedTasks = [...(state.runStatus.tasks || [])].sort((a, b) => {
                    const order = { running: 0, pending: 1, completed: 2, cached: 3, failed: 4, skipped: 5 };
                    return (order[a.state] || 5) - (order[b.state] || 5);
                });
                
                sortedTasks.forEach(task => {
                    const item = document.createElement('div');
                    item.className = 'task-item ' + task.state;
                    
                    const icon = getTaskIcon(task.state);
                    const duration = task.duration ? formatDuration(task.duration) : '';
                    
                    item.innerHTML = 
                        '<span class="task-icon">' + icon + '</span>' +
                        '<span class="task-name">' + task.name + '</span>' +
                        '<span class="task-duration">' + duration + '</span>';
                    
                    taskList.appendChild(item);
                });
            } else {
                progressSection.style.display = 'none';
                tasksSection.style.display = 'none';
                outputLink.style.display = 'none';
                traceLink.style.display = 'none';
            }
        }
        
        function getTaskIcon(state) {
            switch (state) {
                case 'running': return '<span class="spinner"></span>';
                case 'completed': return '✅';
                case 'failed': return '❌';
                case 'cached': return '⏭️';
                case 'skipped': return '⏩';
                default: return '⏳';
            }
        }
        
        function formatDuration(ms) {
            if (ms < 1000) return ms + 'ms';
            if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
            return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
        }
        
        function selectRoot() {
            vscode.postMessage({ command: 'selectRoot' });
        }
        
        function runTask(clean) {
            const task = document.getElementById('taskSelect').value;
            if (!task) {
                vscode.postMessage({ command: 'selectTask' });
                return;
            }
            vscode.postMessage({ command: 'run', task: task, clean: clean });
        }
        
        function stopExecution() {
            vscode.postMessage({ command: 'stop' });
        }
        
        function openOutput() {
            vscode.postMessage({ command: 'openOutput' });
        }
        
        function openTrace() {
            vscode.postMessage({ command: 'openTrace' });
        }
        
        function updateSelectedTask() {
            state.selectedTask = document.getElementById('taskSelect').value;
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                state = { ...state, ...message.data };
                updateUI();
            }
        });
        
        // Signal ready
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
