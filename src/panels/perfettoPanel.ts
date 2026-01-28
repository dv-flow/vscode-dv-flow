/**
 * Perfetto Trace Viewer Panel
 * 
 * Provides a webview panel for viewing Perfetto traces with:
 * - Embedded Perfetto UI (via iframe or bundled)
 * - Trace file loading via postMessage protocol
 * - Support for .perfetto-trace and .pftrace files
 * - Integration with Run Panel for viewing execution traces
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Default Perfetto UI URL (can be overridden in settings for self-hosted)
const DEFAULT_PERFETTO_ORIGIN = 'https://ui.perfetto.dev';

/**
 * Configuration for Perfetto panel
 */
interface PerfettoConfig {
    perfettoOrigin: string;
    useLocalBundle: boolean;
}

/**
 * Get Perfetto configuration from settings
 */
function getPerfettoConfig(): PerfettoConfig {
    const config = vscode.workspace.getConfiguration('dvflow.perfetto');
    return {
        perfettoOrigin: config.get<string>('url', DEFAULT_PERFETTO_ORIGIN),
        useLocalBundle: config.get<boolean>('useLocalBundle', false)
    };
}

/**
 * Perfetto Trace Viewer Panel
 */
export class PerfettoPanel {
    public static readonly viewType = 'dvflow.perfettoViewer';
    
    private static _panels: Map<string, PerfettoPanel> = new Map();
    
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _traceUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _isTraceLoaded: boolean = false;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        traceUri: vscode.Uri
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._traceUri = traceUri;

        // Set up the webview content
        this._update();

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'ui-ready':
                        // Perfetto UI is ready, send the trace data
                        await this._loadTrace();
                        break;
                    case 'trace-loaded':
                        this._isTraceLoaded = true;
                        break;
                    case 'error':
                        vscode.window.showErrorMessage(`Perfetto error: ${message.text}`);
                        break;
                }
            },
            null,
            this._disposables
        );

        // Handle panel disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * Create or show a Perfetto panel for the given trace file
     */
    public static createOrShow(
        extensionUri: vscode.Uri,
        traceUri: vscode.Uri
    ): PerfettoPanel {
        const key = traceUri.toString();
        
        // Check if we already have a panel for this trace
        const existingPanel = PerfettoPanel._panels.get(key);
        if (existingPanel) {
            existingPanel._panel.reveal(vscode.ViewColumn.Beside);
            return existingPanel;
        }

        // Create a new panel
        const panel = vscode.window.createWebviewPanel(
            PerfettoPanel.viewType,
            `Trace: ${path.basename(traceUri.fsPath)}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'node_modules')
                ]
            }
        );

        const perfettoPanel = new PerfettoPanel(panel, extensionUri, traceUri);
        PerfettoPanel._panels.set(key, perfettoPanel);
        
        return perfettoPanel;
    }

    /**
     * Open a trace file from a path string
     */
    public static async openTrace(
        extensionUri: vscode.Uri,
        tracePath: string
    ): Promise<PerfettoPanel | undefined> {
        // Resolve the path
        let resolvedPath = tracePath;
        
        // Handle relative paths
        if (!path.isAbsolute(tracePath)) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                resolvedPath = path.join(workspaceFolder.uri.fsPath, tracePath);
            }
        }

        // Check if file exists
        if (!fs.existsSync(resolvedPath)) {
            vscode.window.showErrorMessage(`Trace file not found: ${resolvedPath}`);
            return undefined;
        }

        const traceUri = vscode.Uri.file(resolvedPath);
        return PerfettoPanel.createOrShow(extensionUri, traceUri);
    }

    /**
     * Load the trace data and send to Perfetto UI
     */
    private async _loadTrace(): Promise<void> {
        try {
            const traceData = await vscode.workspace.fs.readFile(this._traceUri);
            
            // Send trace data to the webview
            this._panel.webview.postMessage({
                command: 'load-trace',
                data: {
                    buffer: Array.from(traceData),
                    title: path.basename(this._traceUri.fsPath),
                    fileName: this._traceUri.fsPath
                }
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load trace: ${errorMsg}`);
        }
    }

    /**
     * Update the webview content
     */
    private _update(): void {
        const config = getPerfettoConfig();
        this._panel.webview.html = this._getHtmlForWebview(config);
    }

    /**
     * Generate HTML content for the webview
     */
    private _getHtmlForWebview(config: PerfettoConfig): string {
        const perfettoOrigin = config.perfettoOrigin;
        const cspSource = this._panel.webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
            script-src ${cspSource} ${perfettoOrigin} 'unsafe-inline';
            style-src ${cspSource} ${perfettoOrigin} 'unsafe-inline';
            frame-src ${perfettoOrigin};
            connect-src ${perfettoOrigin};">
    <title>Perfetto Trace Viewer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        html, body {
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: #1a1a2e;
        }
        .loading-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background-color: #1a1a2e;
            color: #ffffff;
            z-index: 1000;
            transition: opacity 0.3s ease;
        }
        .loading-overlay.hidden {
            opacity: 0;
            pointer-events: none;
        }
        .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-top-color: #4fc3f7;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .loading-text {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 16px;
            color: #b0bec5;
        }
        iframe {
            border: none;
            width: 100%;
            height: 100%;
        }
    </style>
</head>
<body>
    <div class="loading-overlay" id="loadingOverlay">
        <div class="spinner"></div>
        <div class="loading-text">Loading Perfetto Trace Viewer...</div>
    </div>
    <iframe id="perfetto-frame" src="${perfettoOrigin}"></iframe>
    
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const iframe = document.getElementById('perfetto-frame');
            const loadingOverlay = document.getElementById('loadingOverlay');
            
            let uiReady = false;
            let traceLoaded = false;
            let pendingTraceData = null;
            let pingInterval = null;
            
            // Start pinging Perfetto to check if it's ready
            function startPinging() {
                pingInterval = setInterval(() => {
                    if (iframe.contentWindow) {
                        iframe.contentWindow.postMessage('PING', '${perfettoOrigin}');
                    }
                }, 500);
            }
            
            // Handle messages from Perfetto UI and extension
            window.addEventListener('message', (event) => {
                // Messages from Perfetto iframe
                if (event.origin === '${perfettoOrigin}') {
                    if (event.data === 'PONG') {
                        if (!uiReady) {
                            uiReady = true;
                            console.log('Perfetto UI is ready');
                            vscode.postMessage({ command: 'ui-ready' });
                            
                            // If we have pending trace data, send it
                            if (pendingTraceData) {
                                sendTraceToUI(pendingTraceData);
                                pendingTraceData = null;
                            }
                        } else if (traceLoaded) {
                            // Trace is fully loaded
                            clearInterval(pingInterval);
                            pingInterval = null;
                            loadingOverlay.classList.add('hidden');
                            vscode.postMessage({ command: 'trace-loaded' });
                        }
                    }
                    return;
                }
                
                // Messages from VSCode extension
                const message = event.data;
                if (message.command === 'load-trace') {
                    const traceData = {
                        buffer: new Uint8Array(message.data.buffer).buffer,
                        title: message.data.title,
                        fileName: message.data.fileName,
                        keepApiOpen: true
                    };
                    
                    if (uiReady) {
                        sendTraceToUI(traceData);
                    } else {
                        pendingTraceData = traceData;
                    }
                }
            });
            
            function sendTraceToUI(traceData) {
                loadingOverlay.querySelector('.loading-text').textContent = 'Loading trace...';
                traceLoaded = true;
                iframe.contentWindow.postMessage({ perfetto: traceData }, '${perfettoOrigin}');
            }
            
            // Start pinging when iframe loads
            iframe.addEventListener('load', () => {
                startPinging();
            });
        })();
    </script>
</body>
</html>`;
    }

    /**
     * Dispose of the panel
     */
    public dispose(): void {
        const key = this._traceUri.toString();
        PerfettoPanel._panels.delete(key);

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}

/**
 * Custom editor provider for Perfetto trace files
 */
export class PerfettoEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'dvflow.perfettoEditor';
    
    constructor(private readonly extensionUri: vscode.Uri) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new PerfettoEditorProvider(context.extensionUri);
        return vscode.window.registerCustomEditorProvider(
            PerfettoEditorProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                },
                supportsMultipleEditorsPerDocument: false
            }
        );
    }

    public async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    public async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Configure webview
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media')
            ]
        };

        const config = getPerfettoConfig();
        const perfettoOrigin = config.perfettoOrigin;
        const cspSource = webviewPanel.webview.cspSource;

        // Set up message handling
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'ui-ready') {
                // Load and send trace data
                try {
                    const traceData = await vscode.workspace.fs.readFile(document.uri);
                    webviewPanel.webview.postMessage({
                        command: 'load-trace',
                        data: {
                            buffer: Array.from(traceData),
                            title: path.basename(document.uri.fsPath),
                            fileName: document.uri.fsPath
                        }
                    });
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Failed to load trace: ${errorMsg}`);
                }
            }
        });

        // Set HTML content (same as PerfettoPanel)
        webviewPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
            script-src ${cspSource} ${perfettoOrigin} 'unsafe-inline';
            style-src ${cspSource} ${perfettoOrigin} 'unsafe-inline';
            frame-src ${perfettoOrigin};
            connect-src ${perfettoOrigin};">
    <title>Perfetto Trace Viewer</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; overflow: hidden; background-color: #1a1a2e; }
        .loading-overlay {
            position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            background-color: #1a1a2e; color: #ffffff; z-index: 1000;
            transition: opacity 0.3s ease;
        }
        .loading-overlay.hidden { opacity: 0; pointer-events: none; }
        .spinner {
            width: 50px; height: 50px; border: 4px solid rgba(255, 255, 255, 0.3);
            border-top-color: #4fc3f7; border-radius: 50%;
            animation: spin 1s linear infinite; margin-bottom: 20px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .loading-text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 16px; color: #b0bec5; }
        iframe { border: none; width: 100%; height: 100%; }
    </style>
</head>
<body>
    <div class="loading-overlay" id="loadingOverlay">
        <div class="spinner"></div>
        <div class="loading-text">Loading Perfetto Trace Viewer...</div>
    </div>
    <iframe id="perfetto-frame" src="${perfettoOrigin}"></iframe>
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const iframe = document.getElementById('perfetto-frame');
            const loadingOverlay = document.getElementById('loadingOverlay');
            let uiReady = false, traceLoaded = false, pendingTraceData = null, pingInterval = null;
            
            function startPinging() {
                pingInterval = setInterval(() => {
                    if (iframe.contentWindow) iframe.contentWindow.postMessage('PING', '${perfettoOrigin}');
                }, 500);
            }
            
            window.addEventListener('message', (event) => {
                if (event.origin === '${perfettoOrigin}') {
                    if (event.data === 'PONG') {
                        if (!uiReady) {
                            uiReady = true;
                            vscode.postMessage({ command: 'ui-ready' });
                            if (pendingTraceData) { sendTraceToUI(pendingTraceData); pendingTraceData = null; }
                        } else if (traceLoaded) {
                            clearInterval(pingInterval);
                            loadingOverlay.classList.add('hidden');
                        }
                    }
                    return;
                }
                const message = event.data;
                if (message.command === 'load-trace') {
                    const traceData = { buffer: new Uint8Array(message.data.buffer).buffer, title: message.data.title, fileName: message.data.fileName, keepApiOpen: true };
                    if (uiReady) sendTraceToUI(traceData); else pendingTraceData = traceData;
                }
            });
            
            function sendTraceToUI(traceData) {
                loadingOverlay.querySelector('.loading-text').textContent = 'Loading trace...';
                traceLoaded = true;
                iframe.contentWindow.postMessage({ perfetto: traceData }, '${perfettoOrigin}');
            }
            
            iframe.addEventListener('load', () => startPinging());
        })();
    </script>
</body>
</html>`;
    }
}
