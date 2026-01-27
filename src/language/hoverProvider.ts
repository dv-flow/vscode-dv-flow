/**
 * Flow Hover Provider
 * 
 * Provides hover information for tasks, parameters, types, and expressions
 * in flow.yaml/flow.dv files.
 */

import * as vscode from 'vscode';
import { FlowDocumentCache, FlowDocument, FlowTaskDef, FlowParamDef, FlowImportDef } from './flowDocumentModel';
import { WorkspaceManager } from '../workspace';

export class FlowHoverProvider implements vscode.HoverProvider {
    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        // Parse the current document
        const flowDoc = this.documentCache.parseFromText(document.uri, document.getText());
        
        // Get the word at the position
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_.]*/);
        if (!wordRange) {
            return null;
        }
        
        const word = document.getText(wordRange);
        const line = document.lineAt(position.line).text;
        
        // Determine context based on line content
        const context = this.determineContext(line, position.character, word);
        
        console.log(`[HoverProvider] word="${word}", context="${context}", line="${line.trim()}"`);
        
        switch (context) {
            case 'task-name':
                return this.getTaskHover(word, flowDoc.tasks.get(word));
            case 'task-uses':
                return this.getTaskTypeHover(word);
            case 'task-needs':
                return this.getTaskReferenceHover(word, flowDoc);
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
        
        // Check for needs list item: "  - task_name"
        // This matches list items that look like task references (simple identifiers)
        if (trimmed.match(/^-\s*["']?[a-zA-Z_][a-zA-Z0-9_]*["']?\s*$/)) {
            return 'task-needs';
        }
        
        // Check for imports section - list items without colon that aren't task-like
        if (trimmed.match(/^-\s*[a-zA-Z_]/) && !trimmed.includes(':')) {
            // Could be either import or needs - default to task-needs as it's more common
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
        
        // Check for parameter in with block
        if (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*:\s*/)) {
            return 'parameter';
        }
        
        return 'unknown';
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

    private getTaskTypeHover(typeName: string): vscode.Hover | null {
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

    private getTaskReferenceHover(taskName: string, flowDoc?: FlowDocument): vscode.Hover | null {
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
        
        console.log(`[HoverProvider] Task "${taskName}" not found in document or cache`);
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`### Task Reference: \`${taskName}\`\n\n`);
        markdown.appendMarkdown(`*Referenced task dependency (definition not found)*`);
        
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

    private getGenericHover(word: string, flowDoc: any): vscode.Hover | null {
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
        
        return null;
    }
}

interface TaskTypeInfo {
    description: string;
    params: { name: string; type: string; description: string }[];
    produces: string | null;
}
