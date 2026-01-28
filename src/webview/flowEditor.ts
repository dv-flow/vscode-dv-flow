import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceManager } from '../workspace/workspaceManager.js';

export class FlowEditorProvider implements vscode.CustomTextEditorProvider {
    public static register(context: vscode.ExtensionContext, workspaceManager: WorkspaceManager): vscode.Disposable {
        const provider = new FlowEditorProvider(context, workspaceManager);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            FlowEditorProvider.viewType,
            provider
        );
        return providerRegistration;
    }

    private static readonly viewType = 'dvFlow.graphView';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly workspaceManager: WorkspaceManager
    ) {}

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        console.log('[FlowGraph Extension] Initializing webview...');
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
        console.log('[FlowGraph Extension] HTML set');

        function updateWebview() {
            const content = document.getText();
            console.log(`[FlowGraph Extension] updateWebview called, content length: ${content.length}`);
            console.log(`[FlowGraph Extension] Content preview (first 200 chars): ${content.substring(0, 200)}`);
            webviewPanel.webview.postMessage({
                type: 'update',
                content: content,
            });
            console.log('[FlowGraph Extension] Message posted to webview');
        }

        // Hook up event handlers
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                updateWebview();
            }
        });

        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(e => {
            console.log(`[FlowGraph Extension] <<<< Received message from webview: ${e.type}`);
            console.log(`[FlowGraph Extension] <<<< Full message:`, JSON.stringify(e));
            switch (e.type) {
                case 'ready':
                    console.log('[FlowGraph Extension] Webview signaled ready, sending content...');
                    updateWebview();
                    return;
                case 'openTaskDefinition':
                    console.log(`[FlowGraph Extension] Opening task definition for: ${e.nodeId}`);
                    // The nodeId is the task name (e.g., "my_package.MyTask")
                    // We need to get the srcinfo for this task from the workspace
                    this.openTaskByName(e.nodeId);
                    return;
                case 'showTaskDetails':
                    console.log(`[FlowGraph Extension] Showing task details for: ${e.nodeId}`);
                    // Show the task in the Task Details Panel
                    vscode.commands.executeCommand('vscode-dv-flow.showTaskDetails', { 
                        label: e.nodeId,
                        data: { task: { name: e.nodeId } }
                    });
                    return;
                case 'debug':
                    console.log(`[FlowGraph Extension] Debug from webview: ${e.message}`);
                    return;
                case 'error':
                    console.error(`[FlowGraph Extension] ERROR from webview: ${e.message}`, e.error);
                    vscode.window.showErrorMessage(`Graph Viewer Error: ${e.message}`);
                    return;
            }
        });
        
        console.log('[FlowGraph Extension] resolveCustomTextEditor complete, waiting for ready message...');
    }

    private async openTaskByName(taskName: string) {
        try {
            console.log(`[FlowGraph Extension] Looking up task: ${taskName}`);
            
            // Get package data from workspace manager using active root
            const packageData = this.workspaceManager.getActivePackageData();
            
            if (!packageData) {
                // Try all roots if no active root
                const allRoots = this.workspaceManager.getAllRoots();
                console.log(`[FlowGraph Extension] No active package data, trying all roots (${allRoots.length} roots)`);
                
                for (const root of allRoots) {
                    const data = this.workspaceManager.getPackageData(root.path);
                    if (data && data.tasks) {
                        const task = data.tasks.find(t => t.name === taskName);
                        if (task) {
                            console.log(`[FlowGraph Extension] Found task in root: ${root.path}`);
                            if (task.srcinfo) {
                                console.log(`[FlowGraph Extension] Opening srcinfo: ${task.srcinfo}`);
                                await vscode.commands.executeCommand('vscode-dv-flow.openTask', task.srcinfo);
                                return;
                            }
                        }
                    }
                }
                
                throw new Error('No package data available or task not found in any root');
            }

            // Find the task by name in active package
            const task = packageData.tasks?.find(t => t.name === taskName);
            if (!task) {
                throw new Error(`Task not found: ${taskName}`);
            }

            console.log(`[FlowGraph Extension] Found task:`, task);

            if (task.srcinfo) {
                console.log(`[FlowGraph Extension] Opening srcinfo: ${task.srcinfo}`);
                await vscode.commands.executeCommand('vscode-dv-flow.openTask', task.srcinfo);
            } else {
                throw new Error(`No source info available for task: ${taskName}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[FlowGraph Extension] Failed to open task: ${message}`);
            vscode.window.showErrorMessage(`Failed to open task: ${message}`);
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        // Get the current theme
        const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light';
        
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' https://d3js.org https://unpkg.com; worker-src blob:; child-src blob:; connect-src https:;">
                <title>Flow Graph View</title>
                <script src="https://d3js.org/d3.v7.min.js"></script>
                <script src="https://unpkg.com/@hpcc-js/wasm@2.13.0/dist/graphviz.umd.js"></script>
                <script src="https://unpkg.com/d3-graphviz@5.0.2/build/d3-graphviz.js"></script>
                <style>
                    * {
                        box-sizing: border-box;
                    }
                    
                    body {
                        padding: 0;
                        margin: 0;
                        width: 100vw;
                        height: 100vh;
                        display: flex;
                        flex-direction: column;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        font-family: var(--vscode-font-family);
                        overflow: hidden;
                    }
                    
                    .toolbar {
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        padding: 8px 12px;
                        background-color: var(--vscode-sideBar-background);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        flex-shrink: 0;
                    }
                    
                    .toolbar-group {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    
                    .toolbar-label {
                        font-size: 12px;
                        color: var(--vscode-foreground);
                    }
                    
                    .toolbar-select {
                        background-color: var(--vscode-dropdown-background);
                        color: var(--vscode-dropdown-foreground);
                        border: 1px solid var(--vscode-dropdown-border);
                        padding: 4px 8px;
                        font-size: 12px;
                        border-radius: 2px;
                        cursor: pointer;
                    }
                    
                    .toolbar-search {
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        padding: 4px 8px;
                        font-size: 13px;
                        border-radius: 2px;
                        min-width: 200px;
                        outline: none;
                    }
                    
                    .toolbar-search:focus {
                        border-color: var(--vscode-focusBorder);
                    }
                    
                    .search-count {
                        font-size: 12px;
                        color: var(--vscode-descriptionForeground);
                        margin-left: 8px;
                        min-width: 50px;
                    }
                    
                    .toolbar-button {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        border: none;
                        padding: 6px 10px;
                        font-size: 14px;
                        border-radius: 2px;
                        cursor: pointer;
                        min-width: 32px;
                        height: 28px;
                    }
                    
                    .toolbar-button:hover:not(:disabled) {
                        background-color: var(--vscode-button-secondaryHoverBackground);
                    }
                    
                    .toolbar-button:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                    }
                    
                    .toolbar-divider {
                        width: 1px;
                        height: 20px;
                        background-color: var(--vscode-panel-border);
                    }
                    
                    .zoom-controls {
                        margin-left: auto;
                    }
                    
                    #graph {
                        flex: 1;
                        width: 100%;
                        overflow: hidden;
                        position: relative;
                        background-color: var(--vscode-editor-background);
                    }
                    
                    #graph svg {
                        width: 100%;
                        height: 100%;
                        cursor: grab;
                        background-color: transparent;
                    }
                    
                    #graph svg:active {
                        cursor: grabbing;
                    }
                    
                    /* Make graph background transparent and blend with editor */
                    .graph > polygon {
                        fill: transparent !important;
                    }
                    
                    /* Theme-aware node styles with better contrast */
                    .node polygon, .node ellipse, .node path {
                        fill: var(--vscode-button-secondaryBackground);
                        stroke: var(--vscode-textLink-foreground);
                        stroke-width: 2px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                    }
                    
                    .node:hover polygon, .node:hover ellipse, .node:hover path {
                        fill: var(--vscode-button-hoverBackground);
                        stroke: var(--vscode-textLink-activeForeground);
                        stroke-width: 2.5px;
                    }
                    
                    .node.selected polygon, .node.selected ellipse, .node.selected path {
                        fill: var(--vscode-button-hoverBackground);
                        stroke: var(--vscode-focusBorder);
                        stroke-width: 3px;
                        filter: brightness(1.1);
                    }
                    
                    .node.search-match polygon, .node.search-match ellipse, .node.search-match path {
                        fill: var(--vscode-editor-findMatchBackground);
                        stroke: var(--vscode-editor-findMatchHighlightBorder);
                        stroke-width: 2.5px;
                    }
                    
                    .node.search-current polygon, .node.search-current ellipse, .node.search-current path {
                        fill: var(--vscode-editor-findMatchHighlightBackground);
                        stroke: var(--vscode-editor-findMatchHighlightBorder);
                        stroke-width: 3px;
                        animation: pulse 1s ease-in-out;
                    }
                    
                    @keyframes pulse {
                        0%, 100% { opacity: 1; }
                        50% { opacity: 0.7; }
                    }
                    
                    .node text {
                        fill: var(--vscode-editor-foreground) !important;
                        font-family: var(--vscode-font-family);
                        font-size: 12px;
                        font-weight: 500;
                        pointer-events: none;
                    }
                    
                    .edge path {
                        stroke: var(--vscode-editorWidget-border);
                        stroke-width: 1.5px;
                        fill: none;
                    }
                    
                    .edge:hover path {
                        stroke: var(--vscode-textLink-foreground);
                        stroke-width: 2px;
                    }
                    
                    .edge polygon {
                        fill: var(--vscode-editorWidget-border);
                        stroke: var(--vscode-editorWidget-border);
                    }
                    
                    .edge:hover polygon {
                        fill: var(--vscode-textLink-foreground);
                        stroke: var(--vscode-textLink-foreground);
                    }
                    
                    .edge text {
                        fill: var(--vscode-descriptionForeground);
                        font-family: var(--vscode-font-family);
                        font-size: 10px;
                    }
                    
                    .context-menu {
                        position: fixed;
                        background: var(--vscode-menu-background);
                        border: 1px solid var(--vscode-menu-border);
                        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
                        padding: 4px 0;
                        z-index: 1000;
                        border-radius: 4px;
                    }
                    
                    .menu-item {
                        padding: 6px 12px;
                        cursor: pointer;
                        color: var(--vscode-menu-foreground);
                        white-space: nowrap;
                        font-size: 13px;
                    }
                    
                    .menu-item:hover {
                        background: var(--vscode-menu-selectionBackground);
                        color: var(--vscode-menu-selectionForeground);
                    }
                </style>
            </head>
            <body>
                <div class="toolbar">
                    <div class="toolbar-group">
                        <label class="toolbar-label">Layout:</label>
                        <select class="toolbar-select" id="layoutSelect">
                            <option value="TB" selected>Top to Bottom</option>
                            <option value="LR">Left to Right</option>
                            <option value="BT">Bottom to Top</option>
                            <option value="RL">Right to Left</option>
                        </select>
                    </div>
                    
                    <div class="toolbar-divider"></div>
                    
                    <div class="toolbar-group">
                        <input type="text" class="toolbar-search" id="searchInput" placeholder="Search tasks... (Ctrl+F)" />
                        <button class="toolbar-button" id="searchPrev" title="Previous Match (Shift+Enter)" disabled>↑</button>
                        <button class="toolbar-button" id="searchNext" title="Next Match (Enter)" disabled>↓</button>
                        <span class="search-count" id="searchCount"></span>
                    </div>
                    
                    <div class="toolbar-divider"></div>
                    
                    <div class="toolbar-group zoom-controls">
                        <button class="toolbar-button" id="zoomIn" title="Zoom In (Ctrl++)">+</button>
                        <button class="toolbar-button" id="zoomOut" title="Zoom Out (Ctrl+-)">−</button>
                        <button class="toolbar-button" id="zoomFit" title="Fit to View (Ctrl+0)">⤢</button>
                    </div>
                </div>
                
                <div id="graph"></div>
                
                <script>
                    (function() {
                        console.log('[FlowGraph Webview] ==== SCRIPT STARTING ====');
                        console.log('[FlowGraph Webview] D3 available:', typeof d3 !== 'undefined');
                        console.log('[FlowGraph Webview] Graphviz available:', typeof d3.graphviz !== 'undefined');
                        
                        try {
                            const vscode = acquireVsCodeApi();
                            console.log('[FlowGraph Webview] VS Code API acquired');
                            
                            // Send debug message
                            vscode.postMessage({ type: 'debug', message: 'Webview script loaded' });
                            
                            let currentZoom = 1;
                            const zoomStep = 0.25;
                            let zoomBehavior;
                            let lastTransform = d3.zoomIdentity;
                            let currentLayout = 'TB';

                            console.log('[FlowGraph Webview] Initializing graphviz...');
                            let graphviz;
                            try {
                                graphviz = d3.select("#graph")
                                    .graphviz()
                                    .fade(false)
                                    .fit(false)
                                    .zoom(false);
                                console.log('[FlowGraph Webview] Graphviz initialized successfully');
                                vscode.postMessage({ type: 'debug', message: 'Graphviz initialized' });
                            } catch (error) {
                                console.error('[FlowGraph Webview] ERROR initializing graphviz:', error);
                                vscode.postMessage({ type: 'error', message: 'Failed to initialize graphviz', error: error.toString() });
                                throw error;
                            }

                        // Layout selector
                        document.getElementById('layoutSelect').addEventListener('change', (e) => {
                            currentLayout = e.target.value;
                            // Note: Changing layout requires re-generating the graph from dfm
                            console.log('Layout changed to:', currentLayout);
                        });

                        function initZoom() {
                            const svg = d3.select("#graph svg");
                            if (svg.empty()) return;

                            zoomBehavior = d3.zoom()
                                .scaleExtent([0.1, 10])
                                .on("zoom", (event) => {
                                    const g = svg.select("g");
                                    lastTransform = event.transform;
                                    currentZoom = event.transform.k;
                                    g.attr("transform", event.transform);
                                });

                            svg.call(zoomBehavior);

                            const initialTransform = svg.select("g").attr("transform") || "";
                            if (initialTransform) {
                                const match = initialTransform.match(/translate\\(([\\d.-]+)[, ]([\\d.-]+)\\)/);
                                if (match) {
                                    lastTransform = d3.zoomIdentity
                                        .translate(parseFloat(match[1]), parseFloat(match[2]))
                                        .scale(1);
                                    svg.call(zoomBehavior.transform, lastTransform);
                                }
                            }
                        }

                        function zoomGraph(newZoom) {
                            const svg = d3.select("#graph svg");
                            if (svg.empty() || !zoomBehavior) return;

                            const g = svg.select("g");
                            const width = svg.node().clientWidth;
                            const height = svg.node().clientHeight;
                            
                            const centerX = width / 2;
                            const centerY = height / 2;
                            const currentPoint = lastTransform.invert([centerX, centerY]);
                            
                            const scale = newZoom;
                            const x = centerX - currentPoint[0] * scale;
                            const y = centerY - currentPoint[1] * scale;
                            
                            const transform = d3.zoomIdentity
                                .translate(x, y)
                                .scale(scale);

                            svg.transition()
                                .duration(250)
                                .call(zoomBehavior.transform, transform);
                        }

                        // Zoom control handlers
                        document.getElementById('zoomIn').addEventListener('click', () => {
                            zoomGraph(currentZoom + zoomStep);
                        });

                        document.getElementById('zoomOut').addEventListener('click', () => {
                            zoomGraph(Math.max(0.1, currentZoom - zoomStep));
                        });

                        document.getElementById('zoomFit').addEventListener('click', () => {
                            currentZoom = 1;
                            scaleToFit();
                        });

                        // Keyboard shortcuts
                        document.addEventListener('keydown', (e) => {
                            // Don't handle shortcuts when typing in search
                            if (e.target === document.getElementById('searchInput')) {
                                return;
                            }
                            
                            if ((e.ctrlKey || e.metaKey) && e.key === '+') {
                                e.preventDefault();
                                zoomGraph(currentZoom + zoomStep);
                            } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
                                e.preventDefault();
                                zoomGraph(Math.max(0.1, currentZoom - zoomStep));
                            } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
                                e.preventDefault();
                                scaleToFit();
                            } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                                e.preventDefault();
                                document.getElementById('searchInput').focus();
                                document.getElementById('searchInput').select();
                            } else if (e.key === 'Escape') {
                                // Clear selection and search
                                d3.selectAll(".node").classed("selected", false);
                                d3.selectAll(".node polygon, .node ellipse, .node path")
                                    .style("stroke-width", "2px")
                                    .style("stroke", "var(--vscode-textLink-foreground)");
                                selectedNode = null;
                                selectedTaskName = null;
                                clearSearch();
                            } else if (e.key === 'Enter' && selectedNode) {
                                // Open definition on Enter
                                e.preventDefault();
                                if (selectedTaskName) {
                                    vscode.postMessage({
                                        type: 'openTaskDefinition',
                                        nodeId: selectedTaskName
                                    });
                                }
                            }
                        });

                        function scaleToFit() {
                            const container = document.getElementById('graph');
                            const width = container.clientWidth;
                            const height = container.clientHeight;
                            
                            const svg = d3.select("#graph svg");
                            if (!svg.empty()) {
                                const g = svg.select("g");
                                const bounds = g.node().getBBox();
                                
                                g.attr("transform", "");
                                
                                const scale = Math.min(
                                    width / (bounds.width + 40),
                                    height / (bounds.height + 40),
                                    1.0
                                );
                                
                                const tx = (width - bounds.width * scale) / 2 - bounds.x * scale;
                                const ty = (height - bounds.height * scale) / 2 - bounds.y * scale;
                                
                                lastTransform = d3.zoomIdentity
                                    .translate(tx, ty)
                                    .scale(scale);
                                
                                currentZoom = scale;
                                
                                if (zoomBehavior) {
                                    svg.transition()
                                        .duration(250)
                                        .call(zoomBehavior.transform, lastTransform);
                                }
                                
                                graphviz
                                    .width(width)
                                    .height(height)
                                    .fit(false)
                                    .zoom(false);
                                
                                // Make graph background transparent
                                svg.selectAll('polygon').each(function() {
                                    const polygon = d3.select(this);
                                    const parentClass = d3.select(this.parentNode).attr('class');
                                    // Only make the root graph background transparent, not node shapes
                                    if (!parentClass || parentClass === 'graph') {
                                        polygon.style('fill', 'transparent');
                                    }
                                });
                            }
                        }

                        // Handle window resize
                        let resizeTimeout;
                        window.addEventListener('resize', () => {
                            clearTimeout(resizeTimeout);
                            resizeTimeout = setTimeout(() => {
                                const prevZoom = currentZoom;
                                scaleToFit();
                                if (prevZoom !== 1) {
                                    setTimeout(() => zoomGraph(prevZoom), 100);
                                }
                            }, 250);
                        });

                        // Track selected node
                        let selectedNode = null;
                        let selectedTaskName = null;

                        // Add node interaction handlers
                        function initNodeHandlers() {
                            const nodes = d3.selectAll(".node");
                            
                            // Single-click to select and show details
                            nodes.on("click", function(event) {
                                event.stopPropagation();
                                
                                const node = d3.select(this);
                                const labelText = node.select("text").text();
                                const taskName = labelText ? labelText.trim() : null;
                                
                                if (!taskName) return;
                                
                                // Update selection
                                selectNode(node, taskName);
                                
                                console.log('[FlowGraph Webview] Node clicked, showing task details for:', taskName);
                                vscode.postMessage({
                                    type: 'showTaskDetails',
                                    nodeId: taskName
                                });
                            });
                            
                            // Double-click to open definition
                            nodes.on("dblclick", function(event) {
                                event.stopPropagation();
                                
                                const node = d3.select(this);
                                const labelText = node.select("text").text();
                                const taskName = labelText ? labelText.trim() : null;
                                
                                if (!taskName) return;
                                
                                console.log('[FlowGraph Webview] Node double-clicked, opening definition for:', taskName);
                                vscode.postMessage({
                                    type: 'openTaskDefinition',
                                    nodeId: taskName
                                });
                            });
                            
                            // Right-click for context menu
                            nodes.on("contextmenu", function(event) {
                                event.preventDefault();
                                d3.selectAll(".context-menu").remove();
                                
                                const node = d3.select(this);
                                const title = node.select("title").text();
                                
                                // Extract task name from title
                                // Title format is typically the node ID (e.g., "n2")
                                // But we need the actual task name from the label
                                let taskName = title;
                                
                                // Try to get the label text instead
                                const labelText = node.select("text").text();
                                if (labelText && labelText.trim()) {
                                    taskName = labelText.trim();
                                }
                                
                                console.log('[FlowGraph Webview] Context menu for node:', {
                                    nodeId: title,
                                    labelText: labelText,
                                    taskName: taskName
                                });
                                
                                const menu = d3.select("body")
                                    .append("div")
                                    .attr("class", "context-menu")
                                    .style("left", event.pageX + "px")
                                    .style("top", event.pageY + "px");

                                menu.append("div")
                                    .attr("class", "menu-item")
                                    .text("📝 Show Task Details")
                                    .on("click", () => {
                                        vscode.postMessage({
                                            type: 'showTaskDetails',
                                            nodeId: taskName
                                        });
                                        menu.remove();
                                    });

                                menu.append("div")
                                    .attr("class", "menu-item")
                                    .text("📄 Go to Definition")
                                    .on("click", () => {
                                        console.log('[FlowGraph Webview] Sending openTaskDefinition for:', taskName);
                                        vscode.postMessage({
                                            type: 'openTaskDefinition',
                                            nodeId: taskName
                                        });
                                        menu.remove();
                                    });

                                d3.select("body").on("click.menu", () => {
                                    menu.remove();
                                    d3.select("body").on("click.menu", null);
                                });
                            });
                        }
                        
                        // Select a node and update visual state
                        function selectNode(node, taskName) {
                            // Clear previous selection
                            d3.selectAll(".node").classed("selected", false);
                            d3.selectAll(".node polygon, .node ellipse, .node path")
                                .style("stroke-width", "2px");
                            
                            // Apply selection to new node
                            node.classed("selected", true);
                            node.selectAll("polygon, ellipse, path")
                                .style("stroke-width", "3px")
                                .style("stroke", "var(--vscode-focusBorder)");
                            
                            selectedNode = node;
                            selectedTaskName = taskName;
                        }
                        
                        // Clear selection when clicking canvas
                        d3.select("#graph").on("click", function(event) {
                            if (event.target === this || event.target.tagName === 'svg') {
                                d3.selectAll(".node").classed("selected", false);
                                d3.selectAll(".node polygon, .node ellipse, .node path")
                                    .style("stroke-width", "2px")
                                    .style("stroke", "var(--vscode-textLink-foreground)");
                                selectedNode = null;
                                selectedTaskName = null;
                            }
                        });

                        // Search functionality
                        let searchMatches = [];
                        let currentMatchIndex = -1;
                        
                        function performSearch(query) {
                            // Clear previous search highlights
                            d3.selectAll(".node").classed("search-match", false).classed("search-current", false);
                            searchMatches = [];
                            currentMatchIndex = -1;
                            
                            if (!query || query.trim() === '') {
                                updateSearchUI();
                                return;
                            }
                            
                            const searchTerm = query.toLowerCase();
                            const nodes = d3.selectAll(".node");
                            
                            nodes.each(function() {
                                const node = d3.select(this);
                                const labelText = node.select("text").text();
                                if (labelText && labelText.toLowerCase().includes(searchTerm)) {
                                    node.classed("search-match", true);
                                    searchMatches.push({ node, taskName: labelText.trim() });
                                }
                            });
                            
                            updateSearchUI();
                            
                            // Auto-select first match
                            if (searchMatches.length > 0) {
                                navigateToMatch(0);
                            }
                        }
                        
                        function navigateToMatch(index) {
                            if (searchMatches.length === 0) return;
                            
                            // Wrap around
                            if (index < 0) index = searchMatches.length - 1;
                            if (index >= searchMatches.length) index = 0;
                            
                            currentMatchIndex = index;
                            
                            // Clear current highlighting
                            d3.selectAll(".node").classed("search-current", false);
                            
                            // Highlight current match
                            const match = searchMatches[currentMatchIndex];
                            match.node.classed("search-current", true);
                            
                            // Center on the node
                            centerOnNode(match.node);
                            
                            updateSearchUI();
                        }
                        
                        function centerOnNode(node) {
                            const svg = d3.select("#graph svg");
                            if (svg.empty() || !zoomBehavior) return;
                            
                            try {
                                // Get node position
                                const g = node.node();
                                const transform = g.getAttribute('transform');
                                if (!transform) return;
                                
                                const match = transform.match(/translate\\(([\\d.-]+)[, ]([\\d.-]+)\\)/);
                                if (!match) return;
                                
                                const nodeX = parseFloat(match[1]);
                                const nodeY = parseFloat(match[2]);
                                
                                // Get container dimensions
                                const container = document.getElementById('graph');
                                const width = container.clientWidth;
                                const height = container.clientHeight;
                                
                                // Calculate transform to center node
                                const scale = currentZoom;
                                const x = width / 2 - nodeX * scale;
                                const y = height / 2 - nodeY * scale;
                                
                                const newTransform = d3.zoomIdentity
                                    .translate(x, y)
                                    .scale(scale);
                                
                                svg.transition()
                                    .duration(500)
                                    .call(zoomBehavior.transform, newTransform);
                            } catch (error) {
                                console.log('[FlowGraph Webview] Could not center on node:', error);
                            }
                        }
                        
                        function updateSearchUI() {
                            const countEl = document.getElementById('searchCount');
                            const prevBtn = document.getElementById('searchPrev');
                            const nextBtn = document.getElementById('searchNext');
                            
                            if (searchMatches.length === 0) {
                                countEl.textContent = '';
                                prevBtn.disabled = true;
                                nextBtn.disabled = true;
                            } else {
                                countEl.textContent = \`\${currentMatchIndex + 1} / \${searchMatches.length}\`;
                                prevBtn.disabled = false;
                                nextBtn.disabled = false;
                            }
                        }
                        
                        function clearSearch() {
                            document.getElementById('searchInput').value = '';
                            d3.selectAll(".node").classed("search-match", false).classed("search-current", false);
                            searchMatches = [];
                            currentMatchIndex = -1;
                            updateSearchUI();
                        }
                        
                        // Search input handlers
                        const searchInput = document.getElementById('searchInput');
                        searchInput.addEventListener('input', (e) => {
                            performSearch(e.target.value);
                        });
                        
                        searchInput.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                if (e.shiftKey) {
                                    navigateToMatch(currentMatchIndex - 1);
                                } else {
                                    navigateToMatch(currentMatchIndex + 1);
                                }
                            } else if (e.key === 'Escape') {
                                clearSearch();
                                e.target.blur();
                            }
                        });
                        
                        document.getElementById('searchPrev').addEventListener('click', () => {
                            navigateToMatch(currentMatchIndex - 1);
                        });
                        
                        document.getElementById('searchNext').addEventListener('click', () => {
                            navigateToMatch(currentMatchIndex + 1);
                        });

                        // Handle messages from the extension
                        window.addEventListener('message', event => {
                            const message = event.data;
                            console.log('[FlowGraph Webview] >>>> Received message:', message.type);
                            console.log('[FlowGraph Webview] >>>> Full message data:', message);
                            
                            switch (message.type) {
                                case 'update':
                                    console.log('[FlowGraph Webview] Content length:', message.content ? message.content.length : 0);
                                    console.log('[FlowGraph Webview] Content preview (first 200 chars):', message.content ? message.content.substring(0, 200) : 'EMPTY');
                                    
                                    if (!message.content || message.content.trim().length === 0) {
                                        console.error('[FlowGraph Webview] ERROR: Empty content received!');
                                        vscode.postMessage({ type: 'error', message: 'Empty DOT content received' });
                                        return;
                                    }
                                    
                                    try {
                                        console.log('[FlowGraph Webview] Calling graphviz.renderDot...');
                                        vscode.postMessage({ type: 'debug', message: 'Starting render' });
                                        
                                        graphviz
                                            .renderDot(message.content)
                                            .on("end", function() {
                                                console.log('[FlowGraph Webview] ✓ Graph rendered successfully');
                                                vscode.postMessage({ type: 'debug', message: 'Render complete' });
                                                
                                                scaleToFit();
                                                setTimeout(() => {
                                                    initZoom();
                                                    if (currentZoom !== 1) {
                                                        zoomGraph(currentZoom);
                                                    }
                                                    initNodeHandlers();
                                                    console.log('[FlowGraph Webview] ✓ Post-render initialization complete');
                                                }, 100);
                                            });
                                    } catch (error) {
                                        console.error('[FlowGraph Webview] ERROR: Failed to render graph:', error);
                                        vscode.postMessage({ type: 'error', message: 'Exception during render', error: error.toString() });
                                    }
                                    break;
                                    
                                default:
                                    console.log('[FlowGraph Webview] Unknown message type:', message.type);
                            }
                        });

                        // Signal that we're ready
                        console.log('[FlowGraph Webview] ==== SENDING READY MESSAGE ====');
                        vscode.postMessage({ type: 'ready' });
                        console.log('[FlowGraph Webview] Ready message sent, waiting for content...');
                        
                        } catch (mainError) {
                            console.error('[FlowGraph Webview] FATAL ERROR in script:', mainError);
                            try {
                                const vscode = acquireVsCodeApi();
                                vscode.postMessage({ type: 'error', message: 'Fatal error in webview', error: mainError.toString() });
                            } catch (e) {
                                console.error('[FlowGraph Webview] Could not send error to extension:', e);
                            }
                        }
                    })()
                </script>
            </body>
            </html>
        `;
    }
}
