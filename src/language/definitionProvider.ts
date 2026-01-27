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

export class FlowDefinitionProvider implements vscode.DefinitionProvider {
    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | vscode.LocationLink[] | null> {
        // Parse the current document
        const flowDoc = this.documentCache.parseFromText(document.uri, document.getText());
        
        // Get the word at the position
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_.]*/);
        if (!wordRange) {
            return null;
        }
        
        const word = document.getText(wordRange);
        const line = document.lineAt(position.line).text;
        
        // Determine what kind of reference this is
        const context = this.determineContext(line, position.character, word);
        
        switch (context) {
            case 'task-uses':
                return this.findTaskTypeDefinition(word);
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
        
        // Check for needs list item format: "  - task_name"
        if (trimmed.match(/^-\s*["']?[a-zA-Z_][a-zA-Z0-9_]*["']?\s*$/)) {
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
        if (word.includes('.') && !trimmed.startsWith('uses:')) {
            return 'import';
        }
        
        return 'unknown';
    }

    private async findTaskTypeDefinition(typeName: string): Promise<vscode.Location[] | null> {
        // For task types like std.FileSet, try to find the definition
        // This would ideally come from plugin metadata
        
        // Check if it's a reference to a task in the current workspace
        const found = this.documentCache.findTask(typeName);
        if (found) {
            return [this.locationFromFlowLocation(found.task.location)];
        }
        
        // For plugin tasks, we can't go to definition (they're in Python)
        // But we could potentially show the plugin file
        
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
        
        // Try to find in imports
        const parts = taskName.split('.');
        if (parts.length > 1) {
            const packageName = parts[0];
            const taskOnlyName = parts.slice(1).join('.');
            
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
        const flowDoc = this.documentCache.parseFromText(document.uri, document.getText());
        
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
