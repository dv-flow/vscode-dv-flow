// Centralized utility for constructing the 'dfm' command invocation

import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { expandPath } from '../extension';

/**
 * Finds the Python interpreter to use for DV Flow operations.
 * @param rootPath - The workspace root directory
 * @returns Promise<string> - The path to the Python interpreter
 */
export async function findPythonInterpreter(rootPath: string): Promise<string> {
    // Determine packages directory from ivpm.yaml if it exists
    let packagesDir = 'packages';
    const ivpmPath = path.join(rootPath, 'ivpm.yaml');
    
    if (fs.existsSync(ivpmPath)) {
        try {
            const ivpmContent = fs.readFileSync(ivpmPath, 'utf8');
            // Basic YAML parsing for the specific structure we need
            const matches = ivpmContent.match(/^package:\s*\n\s+(?:.*\n)*?\s+deps-dir:\s*(.+)$/m);
            if (matches && matches[1]) {
                packagesDir = matches[1].trim();
            }
        } catch (error) {
            console.error('Error reading ivpm.yaml:', error instanceof Error ? error.message : String(error));
        }
    }

    // Check for python in the packages directory
    const workspacePythonPath = path.join(rootPath, packagesDir, 'python/bin/python');
    if (fs.existsSync(workspacePythonPath)) {
        return workspacePythonPath;
    }

    // Check for VSCode's Python configuration
    const pythonConfig = vscode.workspace.getConfiguration('python');
    const configuredPython = pythonConfig.get<string>('defaultInterpreterPath');
    if (configuredPython && fs.existsSync(configuredPython)) {
        return configuredPython;
    }

    // Fallback to system Python
    try {
        const isWindows = process.platform === 'win32';
        const pythonCmd = isWindows ? 'where python' : 'which python3';
        const systemPython = child_process.execSync(pythonCmd).toString().trim().split('\n')[0];
        if (systemPython && fs.existsSync(systemPython)) {
            return systemPython;
        }
    } catch (error) {
        console.error('Error finding system Python:', error instanceof Error ? error.message : String(error));
    }

    throw new Error('No Python interpreter found');
}

/**
 * Returns the command string to invoke the base 'dfm' command with the given subcommand and arguments.
 * Implements the following priority:
 * 1. If ivpm.yaml exists, parse deps-dir (default 'packages'), check for python/bin/dfm or python/scripts/dfm.
 * 2. If .envrc exists and direnv is in PATH, run "direnv exec ${workspaceRoot} which dfm".
 * 3. If dfm is in PATH, use it.
 * 4. Fallback to "python3 -m dv_flow.mgr".
 * 
 * @param workspaceRoot - The workspace root directory
 * @param subcommand - The subcommand and arguments to pass (e.g., 'util list', 'graph "taskName"')
 * @returns Promise<string> - The full command string to execute
 */
export async function getDfmCommand(
    workspaceRoot: string,
    subcommand: string
): Promise<string> {
    // 1. ivpm.yaml check
    let depsDir = 'packages';
    const ivpmPath = path.join(workspaceRoot, 'ivpm.yaml');
    if (fs.existsSync(ivpmPath)) {
        try {
            const ivpmContent = fs.readFileSync(ivpmPath, 'utf8');
            const match = ivpmContent.match(/^\s*deps-dir:\s*(.+)$/m);
            if (match && match[1]) {
                depsDir = match[1].trim();
            }
        } catch (err) {
            console.error('Error reading ivpm.yaml:', err instanceof Error ? err.message : String(err));
        }
        const dfmBin = path.join(workspaceRoot, depsDir, 'python', 'bin', 'dfm');
        const dfmScripts = path.join(workspaceRoot, depsDir, 'python', 'scripts', 'dfm');
        if (fs.existsSync(dfmBin)) {
            return `"${dfmBin}" ${subcommand}`;
        }
        if (fs.existsSync(dfmScripts)) {
            return `"${dfmScripts}" ${subcommand}`;
        }
    }

    // 2. .envrc + direnv check
    const envrcPath = path.join(workspaceRoot, '.envrc');
    let direnvPath: string | undefined;
    if (fs.existsSync(envrcPath)) {
        try {
            direnvPath = child_process.execSync('which direnv').toString().trim();
        } catch {
            direnvPath = undefined;
        }
        if (direnvPath) {
            try {
                const dfmAllow = child_process.execSync(`direnv allow "${workspaceRoot}"`).toString().trim();
                const dfmEnvrc = child_process.execSync(`direnv exec "${workspaceRoot}" which dfm`).toString().trim();
                if (dfmEnvrc) {
                    return `"${dfmEnvrc}" ${subcommand}`;
                }
            } catch {
                // ignore
            }
        }
    }

    // 3. PATH check
    try {
        const dfmPath = child_process.execSync('which dfm').toString().trim();
        if (dfmPath) {
            return `"${dfmPath}" ${subcommand}`;
        }
    } catch {
        // ignore
    }

    // 4. Fallback
    return `python3 -m dv_flow.mgr ${subcommand}`;
}
