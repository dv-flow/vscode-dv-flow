import * as vscode from 'vscode';

export class FlowEditorProvider implements vscode.CustomTextEditorProvider {
    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new FlowEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            FlowEditorProvider.viewType,
            provider
        );
        return providerRegistration;
    }

    private static readonly viewType = 'dvFlow.graphView';

    constructor(
        private readonly context: vscode.ExtensionContext
    ) {}

    /**
     * Sets the webview panel title
     */
    public static setTitle(panel: vscode.WebviewPanel, title: string) {
        panel.title = title;
    }

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        webviewPanel.webview.html = this.getHtmlForWebview();

        function updateWebview() {
            webviewPanel.webview.postMessage({
                type: 'update',
                content: document.getText(),
            });
        }

        // Initial content
        updateWebview();

        // Hook up event handlers to update the webview when the document changes
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                updateWebview();
            }
        });

        // Clean up event listener when the editor is closed
        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(e => {
            switch (e.type) {
                case 'ready':
                    updateWebview();
                    return;
            }
        });
    }

    private getHtmlForWebview(): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Flow Graph View</title>
                <script src="https://d3js.org/d3.v7.min.js"></script>
                <script src="https://unpkg.com/@hpcc-js/wasm@2.13.0/dist/graphviz.umd.js"></script>
                <script src="https://unpkg.com/d3-graphviz@5.0.2/build/d3-graphviz.js"></script>
                <style>
                    body {
                        padding: 0;
                        margin: 0;
                        width: 100vw;
                        height: 100vh;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                    }
                    #graph {
                        width: 100%;
                        height: 100%;
                        overflow: auto;
                        position: relative;
                    }
                    #graph svg {
                        min-width: 100%;
                        min-height: 100%;
                    }
                    .zoom-controls {
                        position: fixed;
                        bottom: 20px;
                        right: 20px;
                        display: flex;
                        gap: 8px;
                        z-index: 1000;
                    }
                    .zoom-button {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px;
                        cursor: pointer;
                        border-radius: 4px;
                        font-size: 16px;
                        width: 36px;
                        height: 36px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    .zoom-button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .node {
                        fill: var(--vscode-button-background);
                    }
                    .edge {
                        stroke: var(--vscode-editor-foreground);
                    }
                    .node text {
                        fill: #000000;
                    }
                </style>
            </head>
            <body>
                <div id="graph">
                    <div class="zoom-controls">
                        <button class="zoom-button" id="zoomIn">+</button>
                        <button class="zoom-button" id="zoomOut">−</button>
                        <button class="zoom-button" id="zoomFull">⤢</button>
                    </div>
                </div>
                <script>
                    (function() {
                        const vscode = acquireVsCodeApi();
                        let currentZoom = 1;
                        const zoomStep = 0.25;
                        let zoomBehavior;
                        let lastTransform = d3.zoomIdentity;

                        let graphviz = d3.select("#graph")
                            .graphviz()
                            .fade(false)
                            .fit(true)
                            .zoom(false);

                        function initZoom() {
                            const svg = d3.select("#graph svg");
                            if (svg.empty()) return;

                            // Initialize zoom behavior
                            zoomBehavior = d3.zoom()
                                .scaleExtent([0.1, 10])
                                .on("zoom", (event) => {
                                    const g = svg.select("g");
                                    lastTransform = event.transform;
                                    currentZoom = event.transform.k;
                                    g.attr("transform", event.transform);
                                });

                            svg.call(zoomBehavior);

                            // Store initial transform from graphviz
                            const initialTransform = svg.select("g").attr("transform") || "";
                            if (initialTransform) {
                                const match = initialTransform.match(/translate\(([\d.-]+)[, ]([\d.-]+)\)/);
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
                            
                            // Get the current center point in transformed coordinates
                            const centerX = width / 2;
                            const centerY = height / 2;
                            const currentPoint = lastTransform.invert([centerX, centerY]);
                            
                            // Calculate the new transform to maintain the center point
                            const scale = newZoom;
                            const x = centerX - currentPoint[0] * scale;
                            const y = centerY - currentPoint[1] * scale;
                            
                            const transform = d3.zoomIdentity
                                .translate(x, y)
                                .scale(scale);

                            // Apply new transform with transition
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

                        document.getElementById('zoomFull').addEventListener('click', () => {
                            // Reset zoom and fit graph to viewport
                            currentZoom = 1;
                            scaleToFit();
                        });

                        // Function to scale and center graph in window
                        function scaleToFit() {
                            const container = document.getElementById('graph');
                            const width = container.clientWidth;
                            const height = container.clientHeight;
                            
                            const svg = d3.select("#graph svg");
                            if (!svg.empty()) {
                                const g = svg.select("g");
                                const bounds = g.node().getBBox();
                                
                                // Reset any existing transforms first
                                g.attr("transform", "");
                                
                                // Calculate scale to fit
                                const scale = Math.min(
                                    width / bounds.width,
                                    height / bounds.height,
                                    1.0 // Don't scale up if graph is smaller than viewport
                                );
                                
                                // Calculate translation to center
                                const tx = (width - bounds.width * scale) / 2;
                                const ty = (height - bounds.height * scale) / 2;
                                
                                // Create new transform
                                lastTransform = d3.zoomIdentity
                                    .translate(tx, ty)
                                    .scale(scale);
                                
                                currentZoom = scale;
                                
                                // Apply the transform
                                if (zoomBehavior) {
                                    svg.transition()
                                        .duration(250)
                                        .call(zoomBehavior.transform, lastTransform);
                                }
                                
                                // Update graphviz settings after transform
                                graphviz
                                    .width(width)
                                    .height(height)
                                    .fit(false)
                                    .zoom(false);
                            }
                        }

                        // Handle window resize
                        let resizeTimeout;
                        window.addEventListener('resize', () => {
                            // Debounce resize events
                            clearTimeout(resizeTimeout);
                            resizeTimeout = setTimeout(() => {
                                const prevZoom = currentZoom;
                                scaleToFit();
                                // Restore zoom level after resize
                                if (prevZoom !== 1) {
                                    setTimeout(() => zoomGraph(prevZoom), 100);
                                }
                            }, 250);
                        });

                        scaleToFit();

                        // Handle messages from the extension
                        window.addEventListener('message', event => {
                            const message = event.data;
                            switch (message.type) {
                                case 'update':
                                    try {
                                        graphviz
                                            .renderDot(message.content)
                                            .on("end", () => {
                                                // After rendering, initialize zoom and scale
                                                scaleToFit();
                                                setTimeout(() => {
                                                    initZoom();
                                                    if (currentZoom !== 1) {
                                                        zoomGraph(currentZoom);
                                                    }
                                                }, 100);
                                            });
                                    } catch (error) {
                                        console.error('Failed to render graph:', error);
                                    }
                                    break;
                            }
                        });

                        // Signal that we're ready to receive content
                        vscode.postMessage({ type: 'ready' });
                    }())
                </script>
            </body>
            </html>
        `;
    }
}
