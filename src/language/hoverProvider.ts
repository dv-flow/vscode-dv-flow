/**
 * Flow Hover Provider
 * 
 * Provides hover information for tasks, parameters, types, and expressions
 * in flow.yaml/flow.dv files.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { FlowDocumentCache, FlowDocument, FlowTaskDef, FlowParamDef, FlowImportDef } from './flowDocumentModel';
import { WorkspaceManager } from '../workspace';
import { DfmTaskDiscovery } from './dfmTaskDiscovery';
import { YamlContextAnalyzer } from './yamlContextAnalyzer';

export class FlowHoverProvider implements vscode.HoverProvider {
    private taskDiscovery: DfmTaskDiscovery;
    private yamlAnalyzer: YamlContextAnalyzer;

    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {
        this.taskDiscovery = new DfmTaskDiscovery();
        this.yamlAnalyzer = new YamlContextAnalyzer();
    }

    dispose(): void {
        this.taskDiscovery.dispose();
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        // Parse the current document
        const flowDoc = await this.documentCache.parseFromText(document.uri, document.getText());
        
        // Get the word at the position
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_.]*/);
        if (!wordRange) {
            return null;
        }
        
        const word = document.getText(wordRange);
        const line = document.lineAt(position.line).text;
        
        // Try YAML-based context detection first (more precise)
        const yamlContext = this.yamlAnalyzer.analyzeContext(document, position);
        
        let context: string;
        if (yamlContext) {
            // Use YAML-based context
            context = this.mapYamlContextToLegacy(yamlContext.kind);
            console.log(`[HoverProvider] word="${word}", YAML context="${yamlContext.kind}" (${this.yamlAnalyzer.describeContext(yamlContext)}), line="${line.trim()}"`);
        } else {
            // Fallback to text-based detection for malformed documents
            context = this.determineContext(line, position.character, word);
            console.log(`[HoverProvider] word="${word}", text-based context="${context}", line="${line.trim()}"`);
        }
        
        switch (context) {
            case 'task-name':
                return this.getTaskHover(word, flowDoc.tasks.get(word));
            case 'task-uses':
                return this.getTaskTypeHover(word, flowDoc);
            case 'task-needs':
                return this.getTaskReferenceHover(word, flowDoc);
            case 'fragment':
                return this.getFragmentHover(word, flowDoc);
            case 'import':
                return this.getImportHover(word, flowDoc.imports.get(word));
            case 'parameter':
                return this.getParameterHover(word, flowDoc.params.get(word));
            case 'expression':
                return this.getExpressionHover(word, line, flowDoc);
            default:
                // Try to find what this word refers to
                return this.getGenericHover(word, flowDoc);
        }
    }

    /**
     * Map YAML context kinds to legacy context strings for backward compatibility
     */
    private mapYamlContextToLegacy(yamlKind: string): string {
        switch (yamlKind) {
            case 'task-name':
                return 'task-name';
            case 'task-uses':
                return 'task-uses';
            case 'task-needs':
                return 'task-needs';
            case 'task-parameter':
            case 'task-parameter-value':
            case 'package-parameter':
            case 'package-parameter-value':
                return 'parameter';
            case 'import':
            case 'import-path':
                return 'import';
            case 'fragment':
                return 'fragment';
            case 'expression':
                return 'expression';
            default:
                return 'unknown';
        }
    }

    private determineContext(line: string, column: number, word: string): string {
        const trimmed = line.trim();
        
        // Check for task name definition
        if (trimmed.match(/^-\s*name:\s*/)) {
            return 'task-name';
        }
        
        // Check for uses (base task type)
        if (trimmed.match(/^uses:\s*/) || line.match(/^\s+uses:\s*/)) {
            return 'task-uses';
        }
        
        // Check for needs - inline array format: needs: [task1, task2]
        if (trimmed.match(/^needs:\s*\[/) || line.match(/^\s+needs:\s*\[/)) {
            return 'task-needs';
        }
        
        // Check for list items - need to determine section context
        if (trimmed.match(/^-\s*/)) {
            // This is a list item - determine which section we're in
            return this.determineSectionContext(trimmed);
        }
        
        // Check for expression
        if (line.includes('${{') && line.includes('}}')) {
            const exprStart = line.indexOf('${{');
            const exprEnd = line.indexOf('}}') + 2;
            if (column >= exprStart && column <= exprEnd) {
                return 'expression';
            }
        }
        
        // Check for parameter in with block
        if (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*:\s*/)) {
            return 'parameter';
        }
        
        return 'unknown';
    }

    /**
     * Determine what section a list item belongs to by looking at context
     */
    private determineSectionContext(trimmedLine: string): string {
        // Check what the line looks like
        const isFilePath = trimmedLine.match(/^-\s*[^\s:]+\.(dv|yaml|yml)/);
        if (isFilePath) {
            return 'fragment';
        }
        
        // Check if it has a colon (could be import with path)
        if (trimmedLine.includes(':')) {
            return 'import';
        }
        
        // Simple identifier without extension - could be task reference, import, or fragment
        // Default to task-needs as it's most common
        return 'task-needs';
    }

    private getTaskHover(name: string, task?: FlowTaskDef): vscode.Hover | null {
        if (!task) {
            // Try to find in workspace
            const found = this.documentCache.findTask(name);
            if (found) {
                task = found.task;
            }
        }
        
        if (!task) {
            return null;
        }

        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        markdown.appendMarkdown(`### Task: \`${task.fullName}\`\n\n`);
        
        if (task.description) {
            markdown.appendMarkdown(`${task.description}\n\n`);
        }
        
        if (task.uses) {
            markdown.appendMarkdown(`**Base Type:** \`${task.uses}\`\n\n`);
        }
        
        if (task.needs && task.needs.length > 0) {
            markdown.appendMarkdown(`**Dependencies:** ${task.needs.map(n => `\`${n}\``).join(', ')}\n\n`);
        }
        
        markdown.appendMarkdown(`---\n`);
        markdown.appendMarkdown(`*Defined in ${task.location.file}:${task.location.line}*`);
        
        return new vscode.Hover(markdown);
    }

    private async getTaskTypeHover(typeName: string, flowDoc?: FlowDocument): Promise<vscode.Hover | null> {
        // First, check if this is a user-defined task
        const found = this.documentCache.findTask(typeName);
        if (found) {
            // It's a user-defined task, show full task hover
            return this.getTaskHover(typeName, found.task);
        }
        
        // Check dfm-discovered tasks
        if (flowDoc) {
            const dfmTasks = await this.getDfmDiscoveredTasks(flowDoc);
            const dfmTask = dfmTasks.get(typeName);
            
            if (dfmTask) {
                return this.getDfmTaskHover(dfmTask);
            }
        }
        
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        // Provide information about common task types
        const taskTypeInfo = this.getTaskTypeInfo(typeName);
        
        if (taskTypeInfo) {
            markdown.appendMarkdown(`### Task Type: \`${typeName}\`\n\n`);
            markdown.appendMarkdown(`${taskTypeInfo.description}\n\n`);
            
            if (taskTypeInfo.params && taskTypeInfo.params.length > 0) {
                markdown.appendMarkdown(`**Parameters:**\n`);
                for (const param of taskTypeInfo.params) {
                    markdown.appendMarkdown(`- \`${param.name}\` (${param.type}): ${param.description}\n`);
                }
            }
            
            if (taskTypeInfo.produces) {
                markdown.appendMarkdown(`\n**Produces:** \`${taskTypeInfo.produces}\`\n`);
            }
            
            return new vscode.Hover(markdown);
        }
        
        // Generic task type hover
        markdown.appendMarkdown(`### Task Type: \`${typeName}\`\n\n`);
        markdown.appendMarkdown(`*Task type reference*`);
        
        return new vscode.Hover(markdown);
    }

    private getTaskTypeInfo(typeName: string): TaskTypeInfo | null {
        // Built-in task type information
        const taskTypes: { [key: string]: TaskTypeInfo } = {
            'std.FileSet': {
                description: 'Creates a FileSet from file patterns.',
                params: [
                    { name: 'type', type: 'string', description: 'Filetype of the produced fileset' },
                    { name: 'include', type: 'list[string]', description: 'File patterns to include' },
                    { name: 'base', type: 'string', description: 'Base directory (default: srcdir)' },
                    { name: 'exclude', type: 'list[string]', description: 'File patterns to exclude' }
                ],
                produces: 'std.FileSet'
            },
            'std.Exec': {
                description: 'Executes a shell command.',
                params: [
                    { name: 'cmd', type: 'string', description: 'Command to execute' },
                    { name: 'shell', type: 'bool', description: 'Run in shell (default: true)' },
                    { name: 'env', type: 'dict', description: 'Environment variables' }
                ],
                produces: 'std.ExecResult'
            },
            'std.Message': {
                description: 'Outputs a message to the console.',
                params: [
                    { name: 'msg', type: 'string', description: 'Message to display' },
                    { name: 'level', type: 'string', description: 'Message level (info, warn, error)' }
                ],
                produces: null
            },
            'std.Null': {
                description: 'A no-op task that produces no output.',
                params: [],
                produces: null
            }
        };
        
        return taskTypes[typeName] || null;
    }

    private async getTaskReferenceHover(taskName: string, flowDoc?: FlowDocument): Promise<vscode.Hover | null> {
        console.log(`[HoverProvider] Looking up task reference: "${taskName}"`);
        
        // First check current document
        if (flowDoc) {
            console.log(`[HoverProvider] Document has ${flowDoc.tasks.size} tasks: [${Array.from(flowDoc.tasks.keys()).join(', ')}]`);
            const localTask = flowDoc.tasks.get(taskName);
            if (localTask) {
                console.log(`[HoverProvider] Found task "${taskName}" in current document`);
                return this.getTaskHover(taskName, localTask);
            }
        }
        
        // Then check other cached documents
        const found = this.documentCache.findTask(taskName);
        
        if (found) {
            console.log(`[HoverProvider] Found task "${taskName}" in cached document`);
            return this.getTaskHover(taskName, found.task);
        }
        
        // Finally, check dfm-discovered tasks
        console.log(`[HoverProvider] Checking dfm-discovered tasks for "${taskName}"`);
        if (flowDoc) {
            const dfmTasks = await this.getDfmDiscoveredTasks(flowDoc);
            const dfmTask = dfmTasks.get(taskName);
            
            if (dfmTask) {
                console.log(`[HoverProvider] Found task "${taskName}" in dfm tasks`);
                return this.getDfmTaskHover(dfmTask);
            }
        }
        
        console.log(`[HoverProvider] Task "${taskName}" not found in document, cache, or dfm`);
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`### Task Reference: \`${taskName}\`\n\n`);
        markdown.appendMarkdown(`*Referenced task dependency (definition not found)*`);
        
        return new vscode.Hover(markdown);
    }

    /**
     * Get dfm-discovered tasks for hover
     */
    private async getDfmDiscoveredTasks(flowDoc: FlowDocument): Promise<Map<string, any>> {
        const tasks = new Map<string, any>();
        
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
            
            // Flatten into single map with full name as key
            for (const [pkg, pkgTasks] of discoveredTasks) {
                for (const task of pkgTasks) {
                    tasks.set(task.name, task);
                }
            }
        } catch (error) {
            console.error('[HoverProvider] Failed to discover dfm tasks:', error);
        }
        
        return tasks;
    }

    /**
     * Create hover for dfm-discovered task
     */
    private getDfmTaskHover(dfmTask: any): vscode.Hover {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        markdown.appendMarkdown(`### Task: \`${dfmTask.name}\`\n\n`);
        
        if (dfmTask.desc) {
            markdown.appendMarkdown(`${dfmTask.desc}\n\n`);
        }
        
        if (dfmTask.doc) {
            markdown.appendMarkdown(`${dfmTask.doc}\n\n`);
        }
        
        if (dfmTask.uses) {
            markdown.appendMarkdown(`**Base Type:** \`${dfmTask.uses}\`\n\n`);
        }
        
        markdown.appendMarkdown(`**Package:** \`${dfmTask.package}\`\n\n`);
        
        if (dfmTask.scope && dfmTask.scope.length > 0) {
            markdown.appendMarkdown(`**Scope:** \`${dfmTask.scope.join(', ')}\`\n\n`);
        }
        
        markdown.appendMarkdown(`---\n`);
        markdown.appendMarkdown(`*Task from ${dfmTask.package} package*`);
        
        return new vscode.Hover(markdown);
    }

    private getFragmentHover(fragmentPath: string, flowDoc: FlowDocument): vscode.Hover {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        markdown.appendMarkdown(`### Fragment: \`${fragmentPath}\`\n\n`);
        markdown.appendMarkdown(`Flow file fragment that will be included in this package.\n\n`);
        
        // Check if the fragment exists in the flowDoc
        const fragment = flowDoc.fragments.find(f => f.path === fragmentPath || f.path.endsWith(fragmentPath));
        if (fragment) {
            markdown.appendMarkdown(`**Status:** File found\n\n`);
        } else {
            markdown.appendMarkdown(`**Status:** Fragment reference\n\n`);
        }
        
        markdown.appendMarkdown(`---\n`);
        markdown.appendMarkdown(`*Click to navigate to fragment file*`);
        
        return new vscode.Hover(markdown);
    }

    private getImportHover(name: string, importDef?: FlowImportDef): vscode.Hover | null {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        markdown.appendMarkdown(`### Import: \`${name}\`\n\n`);
        
        if (importDef) {
            if (importDef.isPlugin) {
                markdown.appendMarkdown(`**Type:** Plugin package\n\n`);
            } else {
                markdown.appendMarkdown(`**Type:** Local package\n\n`);
                if (importDef.path) {
                    markdown.appendMarkdown(`**Path:** \`${importDef.path}\`\n\n`);
                }
            }
        }
        
        return new vscode.Hover(markdown);
    }

    private getParameterHover(name: string, param?: FlowParamDef): vscode.Hover | null {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        markdown.appendMarkdown(`### Parameter: \`${name}\`\n\n`);
        
        if (param) {
            if (param.type) {
                markdown.appendMarkdown(`**Type:** \`${param.type}\`\n\n`);
            }
            if (param.default !== undefined) {
                markdown.appendMarkdown(`**Default:** \`${JSON.stringify(param.default)}\`\n\n`);
            }
            if (param.description) {
                markdown.appendMarkdown(`${param.description}\n\n`);
            }
        }
        
        return new vscode.Hover(markdown);
    }

    private getExpressionHover(word: string, line: string, flowDoc: any): vscode.Hover | null {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        markdown.appendMarkdown(`### Expression Variable: \`${word}\`\n\n`);
        
        // Check if it's a known parameter
        const parts = word.split('.');
        if (parts[0] === 'params' || parts[0] === 'param') {
            const paramName = parts[1];
            const param = flowDoc.params.get(paramName);
            if (param) {
                markdown.appendMarkdown(`**Package Parameter:** \`${paramName}\`\n\n`);
                if (param.type) {
                    markdown.appendMarkdown(`**Type:** \`${param.type}\`\n`);
                }
            } else {
                markdown.appendMarkdown(`*Reference to package parameter \`${paramName}\`*\n`);
            }
        } else if (parts[0] === 'inputs' || parts[0] === 'input') {
            markdown.appendMarkdown(`*Reference to task input*\n`);
        } else if (parts[0] === 'env') {
            markdown.appendMarkdown(`*Reference to environment variable \`${parts[1] || ''}\`*\n`);
        } else {
            markdown.appendMarkdown(`*Expression variable*\n`);
        }
        
        return new vscode.Hover(markdown);
    }

    private async getGenericHover(word: string, flowDoc: any): Promise<vscode.Hover | null> {
        // Try to find what this word refers to
        
        // Check tasks
        const task = flowDoc.tasks.get(word);
        if (task) {
            return this.getTaskHover(word, task);
        }
        
        // Check imports
        const importDef = flowDoc.imports.get(word);
        if (importDef) {
            return this.getImportHover(word, importDef);
        }
        
        // Check params
        const param = flowDoc.params.get(word);
        if (param) {
            return this.getParameterHover(word, param);
        }
        
        // Check in global cache
        const foundTask = this.documentCache.findTask(word);
        if (foundTask) {
            return this.getTaskHover(word, foundTask.task);
        }
        
        // Check dfm-discovered tasks
        const dfmTasks = await this.getDfmDiscoveredTasks(flowDoc);
        const dfmTask = dfmTasks.get(word);
        
        if (dfmTask) {
            return this.getDfmTaskHover(dfmTask);
        }
        
        return null;
    }
}

interface TaskTypeInfo {
    description: string;
    params: { name: string; type: string; description: string }[];
    produces: string | null;
}
