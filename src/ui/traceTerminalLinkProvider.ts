/**
 * Terminal Link Provider for Perfetto Trace Files
 * 
 * Detects trace file paths in terminal output and makes them clickable
 * to open in the Perfetto Trace Viewer.
 * 
 * Supported file patterns:
 * - .perfetto-trace
 * - .pftrace
 * - trace.perfetto
 * - Any path containing "trace" with common trace extensions
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PerfettoPanel } from '../panels/perfettoPanel';

/**
 * Trace file extensions that we recognize
 */
const TRACE_EXTENSIONS = [
    '.perfetto-trace',
    '.pftrace',
    '.perfetto',
    '.trace',
    '.systrace',
    '.ctrace'
];

/**
 * Regex patterns for matching trace file paths in terminal output
 */
const TRACE_PATH_PATTERNS = [
    // Absolute paths (Unix)
    /(?:^|[\s'"(])(\/?(?:[\w.-]+\/)*[\w.-]+(?:\.perfetto-trace|\.pftrace|\.perfetto|\.trace|\.systrace|\.ctrace))(?:$|[\s'")])/g,
    // Relative paths with trace in filename
    /(?:^|[\s'"(])(\.{0,2}\/(?:[\w.-]+\/)*[\w.-]*trace[\w.-]*(?:\.perfetto-trace|\.pftrace|\.perfetto|\.trace|\.bin)?)(?:$|[\s'")])/g,
    // Paths with "Trace written to:" prefix (common in dfm output)
    /(?:Trace\s+(?:written|saved)\s+(?:to|at)[:\s]+)([^\s'"]+)/gi,
    // rundir/trace.perfetto pattern
    /(?:rundir\/[^\s'"]*trace[^\s'"]*)/gi
];

/**
 * Terminal link for trace files
 */
class TraceTerminalLink extends vscode.TerminalLink {
    constructor(
        public readonly tracePath: string,
        startIndex: number,
        length: number,
        tooltip?: string
    ) {
        super(startIndex, length, tooltip);
    }
}

/**
 * Terminal Link Provider that detects trace file paths
 */
export class TraceTerminalLinkProvider implements vscode.TerminalLinkProvider<TraceTerminalLink> {
    constructor(private readonly extensionUri: vscode.Uri) {}

    /**
     * Provide terminal links for the given context
     */
    provideTerminalLinks(
        context: vscode.TerminalLinkContext,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<TraceTerminalLink[]> {
        const links: TraceTerminalLink[] = [];
        const line = context.line;

        // Try each pattern
        for (const pattern of TRACE_PATH_PATTERNS) {
            // Reset regex state
            pattern.lastIndex = 0;
            
            let match;
            while ((match = pattern.exec(line)) !== null) {
                // Get the captured path (group 1 or full match)
                const tracePath = match[1] || match[0];
                const startIndex = line.indexOf(tracePath);
                
                if (startIndex >= 0 && this._isLikelyTracePath(tracePath)) {
                    links.push(new TraceTerminalLink(
                        tracePath,
                        startIndex,
                        tracePath.length,
                        `Open trace in Perfetto Viewer: ${tracePath}`
                    ));
                }
            }
        }

        // Also do a simple scan for known trace extensions
        for (const ext of TRACE_EXTENSIONS) {
            let searchStart = 0;
            while (true) {
                const extIndex = line.indexOf(ext, searchStart);
                if (extIndex === -1) {
                    break;
                }
                
                // Find the start of the path (go back until whitespace or special char)
                let pathStart = extIndex;
                while (pathStart > 0 && !/[\s'"()]/.test(line[pathStart - 1])) {
                    pathStart--;
                }
                
                const tracePath = line.substring(pathStart, extIndex + ext.length);
                
                // Check if we already have a link for this path
                const alreadyLinked = links.some(l => 
                    l.startIndex === pathStart && l.tracePath === tracePath
                );
                
                if (!alreadyLinked && tracePath.length > ext.length) {
                    links.push(new TraceTerminalLink(
                        tracePath,
                        pathStart,
                        tracePath.length,
                        `Open trace in Perfetto Viewer: ${tracePath}`
                    ));
                }
                
                searchStart = extIndex + ext.length;
            }
        }

        return links;
    }

    /**
     * Handle terminal link activation
     */
    async handleTerminalLink(link: TraceTerminalLink): Promise<void> {
        const tracePath = link.tracePath;
        
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
            // Try to find the file in the workspace
            const files = await vscode.workspace.findFiles(
                `**/${path.basename(tracePath)}`,
                '**/node_modules/**',
                1
            );
            
            if (files.length > 0) {
                resolvedPath = files[0].fsPath;
            } else {
                vscode.window.showErrorMessage(`Trace file not found: ${tracePath}`);
                return;
            }
        }

        // Open the trace in Perfetto viewer
        await PerfettoPanel.openTrace(this.extensionUri, resolvedPath);
    }

    /**
     * Check if a path looks like a trace file path
     */
    private _isLikelyTracePath(pathStr: string): boolean {
        const lowerPath = pathStr.toLowerCase();
        
        // Check for trace-related extensions
        for (const ext of TRACE_EXTENSIONS) {
            if (lowerPath.endsWith(ext)) {
                return true;
            }
        }
        
        // Check for trace-related patterns in filename
        const filename = path.basename(lowerPath);
        if (filename.includes('trace') || filename.includes('perfetto')) {
            return true;
        }
        
        return false;
    }
}

/**
 * Register the terminal link provider
 */
export function registerTraceTerminalLinkProvider(
    context: vscode.ExtensionContext
): vscode.Disposable {
    const provider = new TraceTerminalLinkProvider(context.extensionUri);
    return vscode.window.registerTerminalLinkProvider(provider);
}
