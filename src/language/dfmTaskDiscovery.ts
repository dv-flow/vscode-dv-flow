/**
 * DFM Task Discovery Service
 * 
 * Queries dv-flow-mgr (dfm) to dynamically discover available tasks
 * from packages, providing up-to-date completion suggestions.
 */

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { discoverDfm } from '../utils/dfmUtil';

/**
 * Task information from dfm
 */
export interface DfmTask {
    name: string;           // "std.Exec"
    short_name: string;     // "Exec"
    package: string;        // "std"
    desc: string;           // Short description
    doc: string;            // Full documentation
    uses: string | null;    // Base task type
    scope: string[];        // Visibility scope
    tags: any[];           // Tags
}

/**
 * Response from dfm show tasks
 */
interface DfmTasksResponse {
    command?: string;
    filters?: any;
    results: DfmTask[];
    count: number;
}

/**
 * Service for discovering tasks via dfm
 */
export class DfmTaskDiscovery {
    private cache: Map<string, DfmTask[]> = new Map();
    private lastRefresh: Map<string, number> = new Map();
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('DV Flow Task Discovery');
    }

    /**
     * Get cache timeout from configuration (default: 5 minutes)
     */
    private getCacheTimeout(): number {
        const config = vscode.workspace.getConfiguration('dvflow.completion');
        const timeout = config.get<number>('dfmCacheTimeout', 300);
        return timeout * 1000; // Convert to milliseconds
    }

    /**
     * Check if dfm discovery is enabled
     */
    private isEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('dvflow.completion');
        return config.get<boolean>('useDfmDiscovery', true);
    }

    /**
     * Discover all tasks from a package
     */
    async discoverTasks(
        packageName: string, 
        rootDir?: string
    ): Promise<DfmTask[]> {
        if (!this.isEnabled()) {
            this.log(`Task discovery disabled in configuration`);
            return [];
        }

        const cacheKey = `${packageName}:${rootDir || 'default'}`;
        
        // Check cache
        if (this.isCacheValid(cacheKey)) {
            this.log(`Using cached tasks for ${packageName} (${this.cache.get(cacheKey)?.length || 0} tasks)`);
            return this.cache.get(cacheKey) || [];
        }
        
        try {
            this.log(`Discovering tasks for package: ${packageName}`);
            const tasks = await this.queryDfm(packageName, rootDir);
            this.cache.set(cacheKey, tasks);
            this.lastRefresh.set(cacheKey, Date.now());
            this.log(`Discovered ${tasks.length} tasks from ${packageName}`);
            return tasks;
        } catch (error) {
            this.log(`Failed to discover tasks for ${packageName}: ${error}`);
            console.error(`Failed to discover tasks for ${packageName}:`, error);
            return [];
        }
    }

    /**
     * Query dfm for tasks
     */
    private async queryDfm(
        packageName: string, 
        rootDir?: string
    ): Promise<DfmTask[]> {
        try {
            const dfmCmd = await discoverDfm();
            this.log(`Discovered dfm command: ${dfmCmd}`);

            const args = ['show', 'tasks', '--package', packageName, '--json'];
            
            if (rootDir) {
                args.push('--root', rootDir);
            }

            this.log(`Executing: ${dfmCmd} ${args.join(' ')}`);

            // The dfmCmd might include quotes and additional args (e.g., "python -m dv_flow.mgr")
            // So we need to exec it as a shell command, not execFile
            const fullCommand = `${dfmCmd} ${args.join(' ')}`;

            return new Promise((resolve, reject) => {
                child_process.exec(
                    fullCommand,
                    { 
                        cwd: rootDir,
                        maxBuffer: 10 * 1024 * 1024, // 10MB
                        timeout: 30000 // 30 second timeout
                    },
                    (error, stdout, stderr) => {
                        if (error) {
                            // Log stderr but don't fail on warnings
                            if (stderr) {
                                this.log(`dfm stderr: ${stderr}`);
                            }
                            reject(new Error(`dfm failed: ${error.message}`));
                            return;
                        }

                        try {
                            // dfm may output warnings/errors before JSON
                            // Look for the JSON response which starts with {"command":
                            const jsonPattern = /\{\s*"command":\s*"show tasks"/;
                            const match = stdout.match(jsonPattern);
                            
                            if (!match) {
                                this.log(`No valid JSON response found in output. Full output: ${stdout.substring(0, 500)}`);
                                throw new Error('No valid JSON response found in output');
                            }
                            
                            const jsonStart = match.index!;
                            
                            // Log any warnings/messages before JSON
                            if (jsonStart > 0) {
                                const warnings = stdout.substring(0, jsonStart).trim();
                                if (warnings) {
                                    this.log(`dfm warnings/errors: ${warnings}`);
                                }
                            }
                            
                            // Parse just the JSON portion
                            const jsonOutput = stdout.substring(jsonStart);
                            this.log(`Attempting to parse JSON (first 200 chars): ${jsonOutput.substring(0, 200)}`);
                            
                            const response: DfmTasksResponse = JSON.parse(jsonOutput);
                            resolve(response.results || []);
                        } catch (parseError) {
                            this.log(`Failed to parse dfm output. Full stdout (first 500 chars): ${stdout.substring(0, 500)}`);
                            this.log(`Parse error: ${parseError}`);
                            reject(new Error(`Failed to parse dfm output: ${parseError}`));
                        }
                    }
                );
            });
        } catch (error) {
            this.log(`Error in queryDfm: ${error}`);
            throw error;
        }
    }

    /**
     * Check if cache is still valid
     */
    private isCacheValid(cacheKey: string): boolean {
        const lastRefresh = this.lastRefresh.get(cacheKey);
        if (!lastRefresh) {
            return false;
        }
        
        const timeout = this.getCacheTimeout();
        if (timeout === 0) {
            return false; // Cache disabled
        }
        
        return (Date.now() - lastRefresh) < timeout;
    }

    /**
     * Invalidate cache for a package
     */
    invalidateCache(packageName?: string): void {
        if (packageName) {
            // Invalidate specific package
            for (const key of this.cache.keys()) {
                if (key.startsWith(`${packageName}:`)) {
                    this.cache.delete(key);
                    this.lastRefresh.delete(key);
                }
            }
            this.log(`Invalidated cache for package: ${packageName}`);
        } else {
            // Invalidate all
            this.cache.clear();
            this.lastRefresh.clear();
            this.log(`Invalidated all task cache`);
        }
    }

    /**
     * Get all tasks from all available packages (not just imported ones)
     * 
     * This queries dfm without a package filter to discover all installed and 
     * visible tasks, including those from packages like hdlsim, fusesoc, cc, etc.
     * 
     * @param imports - List of imported packages (for context/logging, not used for filtering)
     * @param rootDir - Root directory for the query context
     * @returns Map of package name to array of tasks
     */
    async discoverAllTasks(
        imports: string[],
        rootDir?: string
    ): Promise<Map<string, DfmTask[]>> {
        if (!this.isEnabled()) {
            this.log(`Task discovery disabled in configuration`);
            return new Map();
        }

        const cacheKey = `__all__:${rootDir || 'default'}`;
        
        // Check cache
        if (this.isCacheValid(cacheKey)) {
            this.log(`Using cached tasks for all packages`);
            return this._reconstructMapFromCache(cacheKey);
        }
        
        try {
            this.log(`Discovering tasks from all available packages`);
            const tasks = await this.queryAllDfmTasks(rootDir);
            
            // Group tasks by package
            const result = new Map<string, DfmTask[]>();
            for (const task of tasks) {
                if (!result.has(task.package)) {
                    result.set(task.package, []);
                }
                result.get(task.package)!.push(task);
            }
            
            // Cache the flat list
            this.cache.set(cacheKey, tasks);
            this.lastRefresh.set(cacheKey, Date.now());
            
            this.log(`Discovered ${tasks.length} tasks from ${result.size} packages`);
            return result;
        } catch (error) {
            this.log(`Failed to discover all tasks: ${error}`);
            console.error(`Failed to discover all tasks:`, error);
            return new Map();
        }
    }

    /**
     * Reconstruct package map from cached flat list
     */
    private _reconstructMapFromCache(cacheKey: string): Map<string, DfmTask[]> {
        const tasks = this.cache.get(cacheKey) || [];
        const result = new Map<string, DfmTask[]>();
        
        for (const task of tasks) {
            if (!result.has(task.package)) {
                result.set(task.package, []);
            }
            result.get(task.package)!.push(task);
        }
        
        return result;
    }

    /**
     * Query all available tasks from dfm (without package filter)
     */
    private async queryAllDfmTasks(rootDir?: string): Promise<DfmTask[]> {
        try {
            const dfmCmd = await discoverDfm();
            this.log(`Discovered dfm command: ${dfmCmd}`);

            const args = ['show', 'tasks', '--json'];
            
            if (rootDir) {
                args.push('--root', rootDir);
            }

            this.log(`Executing: ${dfmCmd} ${args.join(' ')}`);

            const fullCommand = `${dfmCmd} ${args.join(' ')}`;

            return new Promise((resolve, reject) => {
                child_process.exec(
                    fullCommand,
                    { 
                        cwd: rootDir,
                        maxBuffer: 10 * 1024 * 1024, // 10MB
                        timeout: 30000 // 30 second timeout
                    },
                    (error, stdout, stderr) => {
                        if (error) {
                            // Log stderr but don't fail on warnings
                            if (stderr) {
                                this.log(`dfm stderr: ${stderr}`);
                            }
                            reject(new Error(`dfm failed: ${error.message}`));
                            return;
                        }

                        try {
                            // dfm may output warnings/errors before JSON
                            const jsonPattern = /\{\s*"command":\s*"show tasks"/;
                            const match = stdout.match(jsonPattern);
                            
                            if (!match) {
                                this.log(`No valid JSON response found in output. Full output: ${stdout.substring(0, 500)}`);
                                throw new Error('No valid JSON response found in output');
                            }
                            
                            const jsonStart = match.index!;
                            
                            // Log any warnings/messages before JSON
                            if (jsonStart > 0) {
                                const warnings = stdout.substring(0, jsonStart).trim();
                                if (warnings) {
                                    this.log(`dfm warnings/errors: ${warnings}`);
                                }
                            }
                            
                            // Parse just the JSON portion
                            const jsonOutput = stdout.substring(jsonStart);
                            this.log(`Attempting to parse JSON (first 200 chars): ${jsonOutput.substring(0, 200)}`);
                            
                            const response: DfmTasksResponse = JSON.parse(jsonOutput);
                            resolve(response.results || []);
                        } catch (parseError) {
                            this.log(`Failed to parse dfm output. Full stdout (first 500 chars): ${stdout.substring(0, 500)}`);
                            this.log(`Parse error: ${parseError}`);
                            reject(new Error(`Failed to parse dfm output: ${parseError}`));
                        }
                    }
                );
            });
        } catch (error) {
            this.log(`Error in queryAllDfmTasks: ${error}`);
            throw error;
        }
    }

    /**
     * Get tasks for a specific package with proper filtering
     */
    async getPackageTasks(
        packageName: string,
        rootDir?: string,
        scope?: 'root' | 'export' | 'local'
    ): Promise<DfmTask[]> {
        const tasks = await this.discoverTasks(packageName, rootDir);
        
        if (!scope) {
            return tasks;
        }
        
        // Filter by scope if specified
        return tasks.filter(task => 
            task.scope.length === 0 || // No scope restriction
            task.scope.includes(scope)
        );
    }

    /**
     * Search tasks across all packages
     */
    async searchTasks(
        query: string,
        packages: string[],
        rootDir?: string
    ): Promise<DfmTask[]> {
        const allTasks = await this.discoverAllTasks(packages, rootDir);
        const results: DfmTask[] = [];
        const queryLower = query.toLowerCase();

        for (const [pkg, tasks] of allTasks) {
            for (const task of tasks) {
                // Search in name, desc, and doc
                if (
                    task.name.toLowerCase().includes(queryLower) ||
                    task.short_name.toLowerCase().includes(queryLower) ||
                    task.desc.toLowerCase().includes(queryLower) ||
                    task.doc.toLowerCase().includes(queryLower)
                ) {
                    results.push(task);
                }
            }
        }

        return results;
    }

    /**
     * Get task by full name
     */
    async getTask(
        taskName: string,
        rootDir?: string
    ): Promise<DfmTask | undefined> {
        // Parse package from task name (e.g., "std.Exec" -> "std")
        const parts = taskName.split('.');
        if (parts.length < 2) {
            return undefined;
        }

        const packageName = parts[0];
        const tasks = await this.discoverTasks(packageName, rootDir);
        
        return tasks.find(t => t.name === taskName || t.short_name === parts[1]);
    }

    /**
     * Log to output channel
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    /**
     * Show output channel
     */
    showLog(): void {
        this.outputChannel.show();
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.outputChannel.dispose();
    }
}
