/**
 * WorkspaceManager - Multi-root workspace discovery and management for DV Flow
 * 
 * Handles discovery of all flow.yaml/flow.dv files in a workspace and tracks
 * their relationships (which roots import which packages).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as yaml from 'yaml';
import { getDfmCommand } from '../utils/dfmUtil';

/**
 * Information about a discovered flow file
 */
export interface FlowRoot {
    /** Absolute path to the flow file */
    path: string;
    /** Package name from the file */
    packageName: string;
    /** Source info for the package definition */
    srcinfo?: string;
    /** True if not imported by another root (can be run standalone) */
    isStandalone: boolean;
    /** Paths of roots that import this package */
    importedBy: string[];
    /** Paths this root imports (local packages) */
    imports: string[];
    /** Relative path from workspace root */
    relativePath: string;
}

/**
 * Task information from a package
 */
export interface TaskInfo {
    name: string;
    srcinfo?: string;
    type?: string;
    needs?: string[];
    description?: string;
}

/**
 * Import information from a package
 */
export interface ImportInfo {
    name: string;
    path: string;
    line?: number;
    isLocal: boolean;
    isPlugin: boolean;
}

/**
 * Parameter information from a package
 */
export interface ParamInfo {
    name: string;
    type: string;
    default?: any;
    description?: string;
}

/**
 * Complete package data retrieved from dfm
 */
export interface PackageData {
    name: string;
    file?: string;
    imports: { [key: string]: string };
    tasks: TaskInfo[];
    files: string[];
    params?: ParamInfo[];
    types?: string[];
    markers?: { msg: string; severity: string }[];
}

/**
 * Complete workspace information
 */
export interface WorkspaceInfo {
    workspaceRoot: string;
    flowRoots: FlowRoot[];
    standaloneRoots: FlowRoot[];
    importedPackages: FlowRoot[];
    importGraph: Map<string, string[]>;
}

/**
 * Manages multi-root workspace discovery and state
 */
export class WorkspaceManager {
    private static instance: WorkspaceManager | undefined;
    
    private workspaceRoot: string;
    private _roots: Map<string, FlowRoot> = new Map();
    private _activeRoot: string | undefined;
    private _packageDataCache: Map<string, PackageData> = new Map();
    private _onDidChangeActiveRoot = new vscode.EventEmitter<FlowRoot | undefined>();
    private _onDidDiscoverRoots = new vscode.EventEmitter<WorkspaceInfo>();
    
    public readonly onDidChangeActiveRoot = this._onDidChangeActiveRoot.event;
    public readonly onDidDiscoverRoots = this._onDidDiscoverRoots.event;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    static getInstance(workspaceRoot?: string): WorkspaceManager {
        if (!WorkspaceManager.instance && workspaceRoot) {
            WorkspaceManager.instance = new WorkspaceManager(workspaceRoot);
        }
        return WorkspaceManager.instance!;
    }

    static resetInstance(): void {
        WorkspaceManager.instance = undefined;
    }

    /**
     * Check if a flow file is a package file (has 'package' key) vs a fragment file.
     * Fragment files should not be treated as roots.
     */
    private isPackageFile(flowPath: string): boolean {
        try {
            const content = fs.readFileSync(flowPath, 'utf8');
            const doc = yaml.parse(content);
            // A package file must have a 'package' key at the top level
            // Fragment files have 'fragment' instead
            return doc !== null && typeof doc === 'object' && 'package' in doc;
        } catch (error) {
            console.error(`Error checking if ${flowPath} is a package file:`, error);
            return false;
        }
    }

    /**
     * Discover all flow files in the workspace
     */
    async discoverFlows(
        includePatterns: string[] = ['**/flow.dv', '**/flow.yaml', '**/flow.yml'],
        excludePatterns: string[] = ['**/node_modules/**', '**/build/**', '**/rundir/**', '**/.git/**']
    ): Promise<WorkspaceInfo> {
        const flowFiles: string[] = [];
        
        // Find all flow files using glob patterns
        for (const pattern of includePatterns) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(this.workspaceRoot, pattern),
                `{${excludePatterns.join(',')}}`
            );
            for (const file of files) {
                if (!flowFiles.includes(file.fsPath)) {
                    flowFiles.push(file.fsPath);
                }
            }
        }

        // Clear existing roots
        this._roots.clear();
        this._packageDataCache.clear();

        // Load package data for each flow file (skip fragment files)
        for (const flowFile of flowFiles) {
            // Skip fragment files - only process package files
            if (!this.isPackageFile(flowFile)) {
                console.log(`Skipping fragment file: ${flowFile}`);
                continue;
            }

            try {
                const packageData = await this.loadPackageData(flowFile);
                if (packageData) {
                    const relativePath = path.relative(this.workspaceRoot, flowFile);
                    const root: FlowRoot = {
                        path: flowFile,
                        packageName: packageData.name,
                        isStandalone: true, // Will be updated after analyzing imports
                        importedBy: [],
                        imports: [],
                        relativePath
                    };
                    
                    // Extract local imports
                    if (packageData.imports) {
                        for (const [importName, importPath] of Object.entries(packageData.imports)) {
                            const pathOnly = importPath.split(':')[0];
                            if (pathOnly && !pathOnly.includes('/') === false) {
                                // This is a local import (file path), not a plugin
                                const absoluteImportPath = path.isAbsolute(pathOnly) 
                                    ? pathOnly 
                                    : path.join(path.dirname(flowFile), pathOnly);
                                root.imports.push(absoluteImportPath);
                            }
                        }
                    }
                    
                    this._roots.set(flowFile, root);
                    this._packageDataCache.set(flowFile, packageData);
                }
            } catch (error) {
                console.error(`Failed to load package data for ${flowFile}:`, error);
            }
        }

        // Analyze import relationships to determine standalone vs imported
        this.analyzeImportRelationships();

        // Build the workspace info
        const info = this.buildWorkspaceInfo();
        
        // Set active root to first standalone root if not set
        if (!this._activeRoot && info.standaloneRoots.length > 0) {
            this.setActiveRoot(info.standaloneRoots[0].path);
        }

        this._onDidDiscoverRoots.fire(info);
        return info;
    }

    /**
     * Load package data for a specific flow file using dfm
     */
    private async loadPackageData(flowPath: string): Promise<PackageData | undefined> {
        try {
            const flowDir = path.dirname(flowPath);
            const command = await getDfmCommand(flowDir, 'util workspace');
            
            const output = await new Promise<string>((resolve, reject) => {
                child_process.exec(command, { cwd: flowDir }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(stdout);
                });
            });

            // Extract JSON from output
            const startIdx = output.indexOf('{');
            const endIdx = output.lastIndexOf('}');
            if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
                return undefined;
            }

            const jsonStr = output.substring(startIdx, endIdx + 1);
            return JSON.parse(jsonStr) as PackageData;
        } catch (error) {
            console.error(`Error loading package data for ${flowPath}:`, error);
            return undefined;
        }
    }

    /**
     * Analyze import relationships between discovered roots
     */
    private analyzeImportRelationships(): void {
        // Build a map of imported paths to the roots that import them
        for (const [rootPath, root] of this._roots) {
            for (const importPath of root.imports) {
                // Find if this import corresponds to another discovered root
                for (const [otherPath, otherRoot] of this._roots) {
                    if (otherPath !== rootPath) {
                        // Check if the import path matches this root's directory
                        const otherDir = path.dirname(otherPath);
                        if (importPath === otherPath || importPath === otherDir || 
                            importPath.startsWith(otherDir + path.sep)) {
                            otherRoot.importedBy.push(rootPath);
                            otherRoot.isStandalone = false;
                        }
                    }
                }
            }
        }
    }

    /**
     * Build complete workspace info from discovered roots
     */
    private buildWorkspaceInfo(): WorkspaceInfo {
        const allRoots = Array.from(this._roots.values());
        const standaloneRoots = allRoots.filter(r => r.isStandalone);
        const importedPackages = allRoots.filter(r => !r.isStandalone);
        
        const importGraph = new Map<string, string[]>();
        for (const root of allRoots) {
            importGraph.set(root.path, root.imports);
        }

        return {
            workspaceRoot: this.workspaceRoot,
            flowRoots: allRoots,
            standaloneRoots,
            importedPackages,
            importGraph
        };
    }

    /**
     * Get the active root
     */
    getActiveRoot(): FlowRoot | undefined {
        if (this._activeRoot) {
            return this._roots.get(this._activeRoot);
        }
        return undefined;
    }

    /**
     * Set the active root
     */
    setActiveRoot(flowPath: string): boolean {
        if (this._roots.has(flowPath)) {
            this._activeRoot = flowPath;
            this._onDidChangeActiveRoot.fire(this._roots.get(flowPath));
            return true;
        }
        return false;
    }

    /**
     * Get package data for a root
     */
    getPackageData(flowPath: string): PackageData | undefined {
        return this._packageDataCache.get(flowPath);
    }

    /**
     * Get package data for the active root
     */
    getActivePackageData(): PackageData | undefined {
        if (this._activeRoot) {
            return this._packageDataCache.get(this._activeRoot);
        }
        return undefined;
    }

    /**
     * Get all discovered roots
     */
    getAllRoots(): FlowRoot[] {
        return Array.from(this._roots.values());
    }

    /**
     * Get standalone (runnable) roots
     */
    getStandaloneRoots(): FlowRoot[] {
        return Array.from(this._roots.values()).filter(r => r.isStandalone);
    }

    /**
     * Get imported-only packages
     */
    getImportedPackages(): FlowRoot[] {
        return Array.from(this._roots.values()).filter(r => !r.isStandalone);
    }

    /**
     * Refresh data for a specific root
     */
    async refreshRoot(flowPath: string): Promise<PackageData | undefined> {
        const packageData = await this.loadPackageData(flowPath);
        if (packageData) {
            this._packageDataCache.set(flowPath, packageData);
        }
        return packageData;
    }

    /**
     * Refresh data for the active root
     */
    async refreshActiveRoot(): Promise<PackageData | undefined> {
        if (this._activeRoot) {
            return this.refreshRoot(this._activeRoot);
        }
        return undefined;
    }

    /**
     * Get the rundir path for a specific root
     */
    getRundirForRoot(flowPath: string): string {
        const root = this._roots.get(flowPath);
        if (root) {
            // Use package name for rundir isolation
            const safeName = root.packageName.replace(/[^a-zA-Z0-9_-]/g, '_');
            return path.join(this.workspaceRoot, 'rundir', safeName);
        }
        return path.join(this.workspaceRoot, 'rundir');
    }

    dispose(): void {
        this._onDidChangeActiveRoot.dispose();
        this._onDidDiscoverRoots.dispose();
        WorkspaceManager.instance = undefined;
    }
}
