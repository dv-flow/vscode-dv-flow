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
                        overflow: hidden;
                    }
                    .node {
                        fill: var(--vscode-button-background);
                    }
                    .edge {
                        stroke: var(--vscode-editor-foreground);
                    }
                    .node text {
                        fill: var(--vscode-button-foreground);
                    }
                </style>
            </head>
            <body>
                <div id="graph"></div>
                <script>
                    (function() {
                        const vscode = acquireVsCodeApi();
                        let graphviz;

                        // Initialize graphviz
                        d3.select("#graph")
                            .graphviz()
                            .fade(false)
                            .fit(true)
                            .zoom(true);

                        // Handle messages from the extension
                        window.addEventListener('message', event => {
                            const message = event.data;
                            switch (message.type) {
                                case 'update':
                                    try {
                                        d3.select("#graph")
                                            .graphviz()
                                            .renderDot(message.content);
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
