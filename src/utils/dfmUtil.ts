// Centralized utility for constructing the 'dfm' command invocation

import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { expandPath } from '../extension';

// Output channel for dfm discovery logging
let dfmOutputChannel: vscode.OutputChannel | undefined;

// Cached dfm command - discovered once at workspace root
let cachedDfmPath: string | undefined;
let cachedWorkspaceRoot: string | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!dfmOutputChannel) {
        dfmOutputChannel = vscode.window.createOutputChannel('DV Flow Discovery');
    }
    return dfmOutputChannel;
}

function logDiscovery(message: string): void {
    const config = vscode.workspace.getConfiguration('dvflow');
    const debugEnabled = config.get<boolean>('debug.logDfmDiscovery', false);
    
    if (debugEnabled) {
        const channel = getOutputChannel();
        const timestamp = new Date().toISOString();
        channel.appendLine(`[${timestamp}] ${message}`);
    }
    
    // Always log to console for development
    console.log(`[dfm-discovery] ${message}`);
}

/**
 * Get the workspace root directory
 */
function getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Clear the cached dfm path (call when configuration changes)
 */
export function clearDfmCache(): void {
    logDiscovery('Clearing dfm cache');
    cachedDfmPath = undefined;
    cachedWorkspaceRoot = undefined;
}

/**
 * Finds the Python interpreter to use for DV Flow operations.
 * Always searches from the workspace root.
 * @returns Promise<string> - The path to the Python interpreter
 */
export async function findPythonInterpreter(): Promise<string> {
    const rootPath = getWorkspaceRoot();
    if (!rootPath) {
        throw new Error('No workspace folder open');
    }
    
    logDiscovery(`Finding Python interpreter for workspace: ${rootPath}`);
    
    // Check config first
    const config = vscode.workspace.getConfiguration('dvflow');
    const configuredPythonPath = config.get<string>('pythonPath', '');
    if (configuredPythonPath) {
        const expandedPath = expandPath(configuredPythonPath);
        logDiscovery(`Checking configured pythonPath: ${expandedPath}`);
        if (fs.existsSync(expandedPath)) {
            logDiscovery(`Using configured pythonPath: ${expandedPath}`);
            return expandedPath;
        }
        logDiscovery(`Configured pythonPath not found: ${expandedPath}`);
    }
    
    // Determine packages directory from ivpm.yaml if it exists
    let packagesDir = 'packages';
    const ivpmPath = path.join(rootPath, 'ivpm.yaml');
    
    if (fs.existsSync(ivpmPath)) {
        logDiscovery(`Found ivpm.yaml at: ${ivpmPath}`);
        try {
            const ivpmContent = fs.readFileSync(ivpmPath, 'utf8');
            const matches = ivpmContent.match(/^package:\s*\n\s+(?:.*\n)*?\s+deps-dir:\s*(.+)$/m);
            if (matches && matches[1]) {
                packagesDir = matches[1].trim();
                logDiscovery(`Parsed deps-dir from ivpm.yaml: ${packagesDir}`);
            }
        } catch (error) {
            logDiscovery(`Error reading ivpm.yaml: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Check for python in the packages directory
    const workspacePythonPath = path.join(rootPath, packagesDir, 'python/bin/python');
    logDiscovery(`Checking workspace python: ${workspacePythonPath}`);
    if (fs.existsSync(workspacePythonPath)) {
        logDiscovery(`Found workspace python: ${workspacePythonPath}`);
        return workspacePythonPath;
    }

    // Check for VSCode's Python configuration
    const pythonConfig = vscode.workspace.getConfiguration('python');
    const vscodePython = pythonConfig.get<string>('defaultInterpreterPath');
    if (vscodePython) {
        logDiscovery(`Checking VSCode python.defaultInterpreterPath: ${vscodePython}`);
        if (fs.existsSync(vscodePython)) {
            logDiscovery(`Using VSCode python: ${vscodePython}`);
            return vscodePython;
        }
    }

    // Fallback to system Python
    logDiscovery('Searching for system Python...');
    try {
        const isWindows = process.platform === 'win32';
        const pythonCmd = isWindows ? 'where python' : 'which python3';
        logDiscovery(`Running: ${pythonCmd}`);
        const systemPython = child_process.execSync(pythonCmd, { encoding: 'utf8' }).trim().split('\n')[0];
        if (systemPython && fs.existsSync(systemPython)) {
            logDiscovery(`Found system python: ${systemPython}`);
            return systemPython;
        }
    } catch (error) {
        logDiscovery(`Error finding system Python: ${error instanceof Error ? error.message : String(error)}`);
    }

    logDiscovery('ERROR: No Python interpreter found');
    throw new Error('No Python interpreter found');
}

/**
 * Discovers the dfm executable path once and caches it.
 * Discovery is always performed from the workspace root.
 * 
 * Priority:
 * 1. Configured dfmPath setting
 * 2. ivpm.yaml deps-dir: packages/python/bin/dfm or packages/python/scripts/dfm
 * 3. .envrc with direnv: direnv exec . which dfm
 * 4. System PATH: which dfm
 * 5. Fallback: python -m dv_flow.mgr
 * 
 * @returns Promise<string> - The dfm executable path (or python -m command)
 */
async function discoverDfm(): Promise<string> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        throw new Error('No workspace folder open');
    }
    
    // Return cached value if workspace hasn't changed
    if (cachedDfmPath && cachedWorkspaceRoot === workspaceRoot) {
        logDiscovery(`Using cached dfm path: ${cachedDfmPath}`);
        return cachedDfmPath;
    }
    
    logDiscovery(`=== Discovering dfm executable ===`);
    logDiscovery(`Workspace root: ${workspaceRoot}`);
    
    // 1. Check configured dfmPath first
    const config = vscode.workspace.getConfiguration('dvflow');
    const configuredDfmPath = config.get<string>('dfmPath', '');
    if (configuredDfmPath) {
        const expandedPath = expandPath(configuredDfmPath);
        logDiscovery(`Checking configured dfmPath: ${expandedPath}`);
        if (fs.existsSync(expandedPath)) {
            logDiscovery(`SUCCESS: Using configured dfmPath: ${expandedPath}`);
            cachedDfmPath = `"${expandedPath}"`;
            cachedWorkspaceRoot = workspaceRoot;
            return cachedDfmPath;
        }
        logDiscovery(`WARNING: Configured dfmPath not found: ${expandedPath}`);
    }
    
    // 2. ivpm.yaml check
    let depsDir = 'packages';
    const ivpmPath = path.join(workspaceRoot, 'ivpm.yaml');
    logDiscovery(`Checking for ivpm.yaml: ${ivpmPath}`);
    
    if (fs.existsSync(ivpmPath)) {
        logDiscovery(`Found ivpm.yaml`);
        try {
            const ivpmContent = fs.readFileSync(ivpmPath, 'utf8');
            const match = ivpmContent.match(/^\s*deps-dir:\s*(.+)$/m);
            if (match && match[1]) {
                depsDir = match[1].trim();
                logDiscovery(`Parsed deps-dir: ${depsDir}`);
            } else {
                logDiscovery(`No deps-dir found, using default: ${depsDir}`);
            }
        } catch (err) {
            logDiscovery(`Error reading ivpm.yaml: ${err instanceof Error ? err.message : String(err)}`);
        }
        
        const dfmBin = path.join(workspaceRoot, depsDir, 'python', 'bin', 'dfm');
        const dfmScripts = path.join(workspaceRoot, depsDir, 'python', 'scripts', 'dfm');
        
        logDiscovery(`Checking dfm bin: ${dfmBin}`);
        if (fs.existsSync(dfmBin)) {
            logDiscovery(`SUCCESS: Found dfm at: ${dfmBin}`);
            cachedDfmPath = `"${dfmBin}"`;
            cachedWorkspaceRoot = workspaceRoot;
            return cachedDfmPath;
        }
        
        logDiscovery(`Checking dfm scripts: ${dfmScripts}`);
        if (fs.existsSync(dfmScripts)) {
            logDiscovery(`SUCCESS: Found dfm at: ${dfmScripts}`);
            cachedDfmPath = `"${dfmScripts}"`;
            cachedWorkspaceRoot = workspaceRoot;
            return cachedDfmPath;
        }
        
        logDiscovery(`dfm not found in ivpm packages directory`);
    } else {
        logDiscovery(`ivpm.yaml not found`);
    }

    // 3. .envrc + direnv check
    const envrcPath = path.join(workspaceRoot, '.envrc');
    logDiscovery(`Checking for .envrc: ${envrcPath}`);
    
    if (fs.existsSync(envrcPath)) {
        logDiscovery(`Found .envrc, checking for direnv...`);
        let direnvPath: string | undefined;
        try {
            direnvPath = child_process.execSync('which direnv 2>/dev/null', { encoding: 'utf8' }).trim();
            logDiscovery(`Found direnv at: ${direnvPath}`);
        } catch {
            logDiscovery(`direnv not found in PATH`);
            direnvPath = undefined;
        }
        
        if (direnvPath) {
            try {
                logDiscovery(`Running: direnv allow "${workspaceRoot}"`);
                child_process.execSync(`direnv allow "${workspaceRoot}" 2>/dev/null`, { encoding: 'utf8' });
                
                logDiscovery(`Running: direnv exec "${workspaceRoot}" which dfm`);
                const dfmEnvrc = child_process.execSync(`direnv exec "${workspaceRoot}" which dfm 2>/dev/null`, { encoding: 'utf8' }).trim();
                if (dfmEnvrc) {
                    logDiscovery(`SUCCESS: Found dfm via direnv: ${dfmEnvrc}`);
                    cachedDfmPath = `"${dfmEnvrc}"`;
                    cachedWorkspaceRoot = workspaceRoot;
                    return cachedDfmPath;
                }
            } catch (err) {
                logDiscovery(`direnv lookup failed: ${err instanceof Error ? err.message : 'unknown error'}`);
            }
        }
    } else {
        logDiscovery(`.envrc not found`);
    }

    // 4. PATH check
    logDiscovery(`Checking for dfm in PATH...`);
    try {
        const isWindows = process.platform === 'win32';
        const whichCmd = isWindows ? 'where dfm' : 'which dfm';
        logDiscovery(`Running: ${whichCmd}`);
        const dfmPath = child_process.execSync(`${whichCmd} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n')[0];
        if (dfmPath) {
            logDiscovery(`SUCCESS: Found dfm in PATH: ${dfmPath}`);
            cachedDfmPath = `"${dfmPath}"`;
            cachedWorkspaceRoot = workspaceRoot;
            return cachedDfmPath;
        }
    } catch {
        logDiscovery(`dfm not found in PATH`);
    }

    // 5. Fallback - try to find python and use -m
    logDiscovery(`Falling back to python -m dv_flow.mgr...`);
    
    try {
        const pythonPath = await findPythonInterpreter();
        cachedDfmPath = `"${pythonPath}" -m dv_flow.mgr`;
        cachedWorkspaceRoot = workspaceRoot;
        logDiscovery(`SUCCESS: Using fallback: ${cachedDfmPath}`);
        return cachedDfmPath;
    } catch (err) {
        logDiscovery(`Could not find Python interpreter: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Last resort
    cachedDfmPath = `python3 -m dv_flow.mgr`;
    cachedWorkspaceRoot = workspaceRoot;
    logDiscovery(`WARNING: Using last resort fallback: ${cachedDfmPath}`);
    return cachedDfmPath;
}

/**
 * Returns the command string to invoke dfm with the given subcommand.
 * The dfm executable is discovered once from the workspace root and cached.
 * 
 * @param _workspaceRoot - Ignored, kept for API compatibility. Discovery always uses workspace root.
 * @param subcommand - The subcommand and arguments to pass (e.g., 'util list', 'graph "taskName"')
 * @returns Promise<string> - The full command string to execute
 */
export async function getDfmCommand(
    _workspaceRoot: string,
    subcommand: string
): Promise<string> {
    const dfmPath = await discoverDfm();
    const cmd = `${dfmPath} ${subcommand}`;
    logDiscovery(`Command: ${cmd}`);
    return cmd;
}

/**
 * Get the working directory for dfm commands.
 * This should be the directory containing the flow file being operated on.
 */
export function getDfmWorkingDirectory(flowFilePath?: string): string {
    if (flowFilePath) {
        return path.dirname(flowFilePath);
    }
    return getWorkspaceRoot() || process.cwd();
}

/**
 * Show the discovery output channel (for debugging)
 */
export function showDiscoveryLog(): void {
    getOutputChannel().show();
}

/**
 * Test dfm discovery and show results
 */
export async function testDfmDiscovery(workspaceRoot: string): Promise<void> {
    const channel = getOutputChannel();
    channel.clear();
    channel.show();
    
    channel.appendLine('=== DFM Discovery Test ===');
    channel.appendLine(`Workspace: ${workspaceRoot}`);
    channel.appendLine(`Platform: ${process.platform}`);
    channel.appendLine('');
    
    // Check config
    const config = vscode.workspace.getConfiguration('dvflow');
    channel.appendLine('--- Configuration ---');
    channel.appendLine(`dvflow.dfmPath: "${config.get<string>('dfmPath', '')}"`);
    channel.appendLine(`dvflow.pythonPath: "${config.get<string>('pythonPath', '')}"`);
    channel.appendLine(`dvflow.debug.logDfmDiscovery: ${config.get<boolean>('debug.logDfmDiscovery', false)}`);
    channel.appendLine('');
    
    // Clear cache to force fresh discovery
    clearDfmCache();
    
    // Run discovery
    channel.appendLine('--- Discovery Process ---');
    try {
        const dfmPath = await discoverDfm();
        channel.appendLine('');
        channel.appendLine('--- Result ---');
        channel.appendLine(`Discovered dfm: ${dfmPath}`);
        channel.appendLine(`Cached workspace: ${cachedWorkspaceRoot}`);
        
        // Try to run it
        channel.appendLine('');
        channel.appendLine('--- Execution Test ---');
        const cmd = `${dfmPath} --version`;
        channel.appendLine(`Running: ${cmd}`);
        try {
            const result = child_process.execSync(cmd, { 
                cwd: workspaceRoot,
                timeout: 10000,
                encoding: 'utf8'
            });
            channel.appendLine(`Output: ${result}`);
            channel.appendLine('SUCCESS: dfm is working!');
        } catch (execErr) {
            channel.appendLine(`ERROR executing command: ${execErr instanceof Error ? execErr.message : String(execErr)}`);
        }
    } catch (err) {
        channel.appendLine(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// Listen for configuration changes to clear cache
vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('dvflow.dfmPath') || 
        e.affectsConfiguration('dvflow.pythonPath')) {
        clearDfmCache();
    }
});

