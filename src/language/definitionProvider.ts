/**
 * Flow Definition Provider
 * 
 * Provides "Go to Definition" functionality for tasks, types, and imports
 * in flow.yaml/flow.dv files.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { FlowDocumentCache, FlowDocument, FlowTaskDef, FlowLocation } from './flowDocumentModel';
import { WorkspaceManager } from '../workspace';
import { DfmTaskDiscovery } from './dfmTaskDiscovery';

export class FlowDefinitionProvider implements vscode.DefinitionProvider {
    private taskDiscovery: DfmTaskDiscovery;
    private packageLocations: Map<string, string> = new Map();

    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {
        this.taskDiscovery = new DfmTaskDiscovery();
    }

    dispose(): void {
        this.taskDiscovery.dispose();
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | vscode.LocationLink[] | null> {
        // Parse the current document
        const flowDoc = await this.documentCache.parseFromText(document.uri, document.getText());
        
        const line = document.lineAt(position.line).text;
        
        // Check for fragment path (e.g., "  - ./fragments/common.dv")
        const fragmentMatch = line.match(/^\s*-\s*(.+\.(?:dv|yaml|yml))\s*$/);
        if (fragmentMatch) {
            return this.findFragmentDefinition(fragmentMatch[1].trim().replace(/^["']|["']$/g, ''), document);
        }
        
        // Check for import path (e.g., "  - common: ./common/common.dv")
        const importPathMatch = line.match(/^\s*-\s*[a-zA-Z_][a-zA-Z0-9_-]*:\s*(.+\.(?:dv|yaml|yml))\s*$/);
        if (importPathMatch) {
            return this.findFragmentDefinition(importPathMatch[1].trim().replace(/^["']|["']$/g, ''), document);
        }
        
        // Get the word at the position
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_.]*/);
        if (!wordRange) {
            return null;
        }
        
        const word = document.getText(wordRange);
        
        // Determine what kind of reference this is
        const context = this.determineContext(line, position.character, word);
        
        switch (context) {
            case 'task-uses':
                return this.findTaskTypeDefinition(word, flowDoc, document);
            case 'task-needs':
                return this.findTaskDefinition(word, flowDoc, document);
            case 'import':
                return this.findImportDefinition(word, flowDoc, document);
            case 'expression':
                return this.findExpressionDefinition(word, flowDoc, document);
            default:
                // Try to find any matching definition
                return this.findAnyDefinition(word, flowDoc, document);
        }
    }

    private determineContext(line: string, column: number, word: string): string {
        const trimmed = line.trim();
        
        // Check for uses (base task type)
        if (trimmed.match(/^uses:\s*/) || line.match(/^\s+uses:\s*/)) {
            return 'task-uses';
        }
        
        // Check for needs (dependencies) - inline array format
        if (trimmed.match(/^needs:\s*\[/) || line.match(/^\s+needs:\s*\[/)) {
            return 'task-needs';
        }
        
        // Check for needs list item format: "  - task_name" or "  - fragment.task_name"
        // Allow dots for fragment-qualified names
        if (trimmed.match(/^-\s*["']?[a-zA-Z_][a-zA-Z0-9_.]*["']?\s*$/)) {
            // This could be a needs list item - need to check context
            // For now, treat any list item that looks like a task name as a potential needs reference
            return 'task-needs';
        }
        
        // Check for expression
        if (line.includes('${{') && line.includes('}}')) {
            const exprStart = line.indexOf('${{');
            const exprEnd = line.indexOf('}}') + 2;
            if (column >= exprStart && column <= exprEnd) {
                return 'expression';
            }
        }
        
        // Check for import reference (qualified name like pkg.task)
        // But be careful - could also be fragment.task in a needs list
        if (word.includes('.') && !trimmed.startsWith('uses:')) {
            // If this is a list item (starts with -), treat as task reference
            if (trimmed.startsWith('- ')) {
                return 'task-needs';
            }
            return 'import';
        }
        
        return 'unknown';
    }

    private async findTaskTypeDefinition(typeName: string, flowDoc?: FlowDocument, document?: vscode.TextDocument): Promise<vscode.Location[] | null> {
        // For task types like std.FileSet, try to find the definition
        
        // Check if it's a reference to a task in the current workspace
        const found = this.documentCache.findTask(typeName);
        if (found) {
            return [this.locationFromFlowLocation(found.task.location)];
        }
        
        // Try dfm-discovered tasks
        if (flowDoc) {
            const dfmLocation = await this.findDfmTaskLocation(typeName, flowDoc);
            if (dfmLocation) {
                return [dfmLocation];
            }
        }
        
        // Check if this is a library package reference (e.g., std.Message)
        if (typeName.includes('.')) {
            const parts = typeName.split('.');
            const packageName = parts[0];
            const taskName = parts.slice(1).join('.');
            
            // Try to load the library package
            const packageLocation = await this.findLibraryPackageLocation(packageName);
            if (packageLocation) {
                // Load the package's flow file
                const flowFile = path.join(packageLocation, 'flow.dv');
                try {
                    const flowUri = vscode.Uri.file(flowFile);
                    await this.documentCache.getDocument(flowUri);
                    
                    // Now try to find the task again
                    const foundAfterLoad = this.documentCache.findTask(typeName);
                    if (foundAfterLoad) {
                        return [this.locationFromFlowLocation(foundAfterLoad.task.location)];
                    }
                } catch (error) {
                    console.debug(`Could not load library package ${packageName}:`, error);
                }
            }
        }
        
        // For plugin tasks we couldn't resolve, return null
        return null;
    }
    
    /**
     * Find the location of a library package using dfm
     */
    private async findLibraryPackageLocation(packageName: string): Promise<string | null> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                return null;
            }
            
            // Use the getDfmCommand utility to get the correct dfm command
            const { getDfmCommand, getDfmWorkingDirectory } = require('../utils/dfmUtil');
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            const workspaceRoot = workspaceFolder.uri.fsPath;
            const cwd = getDfmWorkingDirectory();
            
            // getDfmCommand returns the full command including the subcommand
            const fullCommand = await getDfmCommand(workspaceRoot, `show package ${packageName}`);
            
            console.log(`[definitionProvider] Executing: ${fullCommand} in ${cwd}`);
            const result = await execAsync(fullCommand, { cwd });
            
            // Parse the output to find the Location: line
            const lines = result.stdout.split('\n');
            for (const line of lines) {
                const match = line.match(/^Location:\s*(.+)$/);
                if (match) {
                    const location = match[1].trim();
                    console.log(`[definitionProvider] Found package ${packageName} at: ${location}`);
                    return location;
                }
            }
            
            console.log(`[definitionProvider] No location found in output for package ${packageName}`);
        } catch (error) {
            console.debug(`Could not find package location for ${packageName}:`, error);
        }
        
        return null;
    }

    private async findTaskDefinition(
        taskName: string, 
        flowDoc: FlowDocument,
        document: vscode.TextDocument
    ): Promise<vscode.Location[] | null> {
        // First check local document
        const localTask = flowDoc.tasks.get(taskName);
        if (localTask) {
            return [this.locationFromFlowLocation(localTask.location)];
        }
        
        // Check with package prefix
        for (const [name, task] of flowDoc.tasks) {
            if (task.fullName === taskName || name === taskName) {
                return [this.locationFromFlowLocation(task.location)];
            }
        }
        
        // Check other documents in the cache
        const found = this.documentCache.findTask(taskName);
        if (found) {
            return [this.locationFromFlowLocation(found.task.location)];
        }
        
        // Try dfm-discovered tasks
        const dfmLocation = await this.findDfmTaskLocation(taskName, flowDoc);
        if (dfmLocation) {
            return [dfmLocation];
        }
        
        // Try to find as fragment-qualified name (e.g., "sub.MyTask3")
        // If taskName contains a dot but wasn't found above, it might be a fragment reference
        const parts = taskName.split('.');
        if (parts.length > 1) {
            // Could be fragment.task or package.task or package.fragment.task
            // Try to resolve it by checking all loaded fragments
            const fragmentName = parts[0];
            const taskOnlyName = parts.slice(1).join('.');
            
            // Look for tasks with matching fragment and task names
            const fragmentTask = this.documentCache.findTaskByFragment(
                flowDoc.packageName || '',
                fragmentName,
                taskOnlyName
            );
            if (fragmentTask) {
                return [this.locationFromFlowLocation(fragmentTask.task.location)];
            }
            
            // Try to find in imports
            const packageName = parts[0];
            const importDef = flowDoc.imports.get(packageName);
            if (importDef && importDef.path) {
                // Try to find the task in the imported package
                const importPath = path.isAbsolute(importDef.path)
                    ? importDef.path
                    : path.join(path.dirname(document.uri.fsPath), importDef.path);
                
                const importUri = vscode.Uri.file(importPath);
                const importDoc = await this.documentCache.getDocument(importUri);
                if (importDoc) {
                    const task = importDoc.tasks.get(taskOnlyName);
                    if (task) {
                        return [this.locationFromFlowLocation(task.location)];
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * Find the location of a dfm-discovered task
     */
    private async findDfmTaskLocation(
        taskName: string,
        flowDoc: FlowDocument
    ): Promise<vscode.Location | null> {
        try {
            // Get list of imported packages for context
            const imports = Array.from(flowDoc.imports.keys());
            
            // Get workspace root for context
            const rootDir = path.dirname(flowDoc.uri.fsPath);
            
            // Discover tasks from all available packages
            const discoveredTasks = await this.taskDiscovery.discoverAllTasks(
                imports,
                rootDir
            );
            
            // Find the task
            let dfmTask: any = null;
            for (const [pkg, pkgTasks] of discoveredTasks) {
                for (const task of pkgTasks) {
                    if (task.name === taskName) {
                        dfmTask = task;
                        break;
                    }
                }
                if (dfmTask) break;
            }
            
            if (!dfmTask) {
                console.log(`[DefinitionProvider] Task ${taskName} not found in dfm tasks`);
                return null;
            }
            
            console.log(`[DefinitionProvider] Found dfm task ${taskName} in package ${dfmTask.package}`);
            
            // Get the package location
            const packageLocation = await this.getPackageLocation(dfmTask.package, rootDir);
            if (!packageLocation) {
                console.log(`[DefinitionProvider] Could not find location for package ${dfmTask.package}`);
                return null;
            }
            
            console.log(`[DefinitionProvider] Package ${dfmTask.package} located at ${packageLocation}`);
            
            // Try to find the flow file in the package
            const flowFiles = ['flow.dv', 'flow.yaml', 'flow.yml'];
            
            // For multi-level packages like hdlsim.ivl, also check for ivl_flow.dv pattern
            const packageParts = dfmTask.package.split('.');
            if (packageParts.length > 1) {
                const lastPart = packageParts[packageParts.length - 1];
                flowFiles.unshift(`${lastPart}_flow.dv`);
            }
            
            for (const flowFile of flowFiles) {
                const flowPath = path.join(packageLocation, flowFile);
                try {
                    const flowUri = vscode.Uri.file(flowPath);
                    await vscode.workspace.fs.stat(flowUri);
                    
                    console.log(`[DefinitionProvider] Found flow file: ${flowPath}`);
                    
                    // Load and parse the flow file
                    const flowDoc = await this.documentCache.getDocument(flowUri);
                    if (flowDoc) {
                        // Find the task in this document
                        const task = flowDoc.tasks.get(dfmTask.short_name);
                        if (task) {
                            console.log(`[DefinitionProvider] Found task ${dfmTask.short_name} at ${task.location.file}:${task.location.line}`);
                            return this.locationFromFlowLocation(task.location);
                        }
                    }
                } catch (error) {
                    // File doesn't exist, try next
                    continue;
                }
            }
            
            // If we couldn't find the exact task location, return the package directory
            console.log(`[DefinitionProvider] Could not find task definition in flow files, returning package location`);
            return new vscode.Location(
                vscode.Uri.file(packageLocation),
                new vscode.Position(0, 0)
            );
            
        } catch (error) {
            console.error(`[DefinitionProvider] Error finding dfm task location:`, error);
            return null;
        }
    }

    /**
     * Get the file system location of a package
     */
    private async getPackageLocation(packageName: string, rootDir: string): Promise<string | null> {
        // Check cache
        if (this.packageLocations.has(packageName)) {
            return this.packageLocations.get(packageName)!;
        }
        
        try {
            const { getDfmCommand } = require('../utils/dfmUtil');
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            const fullCommand = await getDfmCommand(rootDir, `show package ${packageName}`);
            
            console.log(`[DefinitionProvider] Executing: ${fullCommand} in ${rootDir}`);
            const result = await execAsync(fullCommand, { cwd: rootDir });
            
            // Parse the output to find the Location: line
            const lines = result.stdout.split('\n');
            for (const line of lines) {
                const match = line.match(/^Location:\s*(.+)$/);
                if (match) {
                    const location = match[1].trim();
                    console.log(`[DefinitionProvider] Found package ${packageName} at: ${location}`);
                    
                    // Cache the location
                    this.packageLocations.set(packageName, location);
                    
                    return location;
                }
            }
            
            console.log(`[DefinitionProvider] No location found in output for package ${packageName}`);
        } catch (error) {
            console.error(`[DefinitionProvider] Could not find package location for ${packageName}:`, error);
        }
        
        return null;
    }

    private async findImportDefinition(
        name: string,
        flowDoc: FlowDocument,
        document: vscode.TextDocument
    ): Promise<vscode.Location[] | null> {
        // Check if this is a package reference (e.g., pkg.task)
        const parts = name.split('.');
        const packageName = parts[0];
        
        const importDef = flowDoc.imports.get(packageName);
        if (importDef && importDef.path) {
            const importPath = path.isAbsolute(importDef.path)
                ? importDef.path
                : path.join(path.dirname(document.uri.fsPath), importDef.path);
            
            // Return the location of the import file
            return [new vscode.Location(
                vscode.Uri.file(importPath),
                new vscode.Position(0, 0)
            )];
        }
        
        // Check if the import definition itself has a location
        if (importDef) {
            return [this.locationFromFlowLocation(importDef.location)];
        }
        
        return null;
    }

    private findExpressionDefinition(
        word: string,
        flowDoc: FlowDocument,
        document: vscode.TextDocument
    ): vscode.Location[] | null {
        const parts = word.split('.');
        
        // Check for parameter reference
        if (parts[0] === 'params' || parts[0] === 'param') {
            const paramName = parts[1];
            const param = flowDoc.params.get(paramName);
            if (param) {
                return [this.locationFromFlowLocation(param.location)];
            }
        }
        
        // Check for task reference in inputs
        if (parts[0] === 'inputs' || parts[0] === 'input') {
            // Inputs come from needs, so we'd need context to resolve this
            return null;
        }
        
        return null;
    }

    private async findAnyDefinition(
        word: string,
        flowDoc: FlowDocument,
        document: vscode.TextDocument
    ): Promise<vscode.Location[] | null> {
        // Try tasks
        const task = flowDoc.tasks.get(word);
        if (task) {
            return [this.locationFromFlowLocation(task.location)];
        }
        
        // Try imports
        const importDef = flowDoc.imports.get(word);
        if (importDef && importDef.path) {
            const importPath = path.isAbsolute(importDef.path)
                ? importDef.path
                : path.join(path.dirname(document.uri.fsPath), importDef.path);
            return [new vscode.Location(
                vscode.Uri.file(importPath),
                new vscode.Position(0, 0)
            )];
        }
        
        // Try params
        const param = flowDoc.params.get(word);
        if (param) {
            return [this.locationFromFlowLocation(param.location)];
        }
        
        // Try types
        const typeDef = flowDoc.types.get(word);
        if (typeDef) {
            return [this.locationFromFlowLocation(typeDef.location)];
        }
        
        // Try global cache
        const found = this.documentCache.findTask(word);
        if (found) {
            return [this.locationFromFlowLocation(found.task.location)];
        }
        
        return null;
    }

    private async findFragmentDefinition(
        fragmentPath: string,
        document: vscode.TextDocument
    ): Promise<vscode.Location[] | null> {
        // Resolve the fragment path relative to the current document
        const resolvedPath = path.isAbsolute(fragmentPath)
            ? fragmentPath
            : path.join(path.dirname(document.uri.fsPath), fragmentPath);
        
        try {
            // Check if file exists
            await vscode.workspace.fs.stat(vscode.Uri.file(resolvedPath));
            
            // Return location pointing to the start of the file
            return [new vscode.Location(
                vscode.Uri.file(resolvedPath),
                new vscode.Position(0, 0)
            )];
        } catch {
            // File doesn't exist
            return null;
        }
    }

    private locationFromFlowLocation(loc: FlowLocation): vscode.Location {
        return new vscode.Location(
            vscode.Uri.file(loc.file),
            new vscode.Position(loc.line - 1, loc.column - 1)
        );
    }
}

/**
 * Flow References Provider
 * 
 * Provides "Find All References" functionality for tasks and parameters.
 */
export class FlowReferencesProvider implements vscode.ReferenceProvider {
    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {}

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[] | null> {
        // Parse the current document
        const flowDoc = await this.documentCache.parseFromText(document.uri, document.getText());
        
        // Get the word at the position
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_.]*/);
        if (!wordRange) {
            return null;
        }
        
        const word = document.getText(wordRange);
        const locations: vscode.Location[] = [];
        
        // Include the definition if requested
        if (context.includeDeclaration) {
            const task = flowDoc.tasks.get(word);
            if (task) {
                locations.push(this.locationFromFlowLocation(task.location));
            }
            
            const param = flowDoc.params.get(word);
            if (param) {
                locations.push(this.locationFromFlowLocation(param.location));
            }
        }
        
        // Find all references in the current document
        for (const ref of flowDoc.references) {
            if (ref.name === word || ref.name.endsWith('.' + word)) {
                locations.push(this.locationFromFlowLocation(ref.location));
            }
        }
        
        // Find references in other cached documents
        const globalRefs = this.documentCache.findReferences(word);
        for (const { ref } of globalRefs) {
            // Avoid duplicates from current document
            if (ref.location.file !== document.uri.fsPath) {
                locations.push(this.locationFromFlowLocation(ref.location));
            }
        }
        
        return locations.length > 0 ? locations : null;
    }

    private locationFromFlowLocation(loc: FlowLocation): vscode.Location {
        return new vscode.Location(
            vscode.Uri.file(loc.file),
            new vscode.Position(loc.line - 1, loc.column - 1)
        );
    }
}
