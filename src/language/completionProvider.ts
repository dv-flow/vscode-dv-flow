/**
 * Flow Completion Provider
 * 
 * Enhanced completion provider with schema-aware suggestions for:
 * - Task types (uses:)
 * - Parameter names based on base task
 * - Task references in needs
 * - Expression variables
 */

import * as vscode from 'vscode';
import { FlowDocumentCache, FlowDocument } from './flowDocumentModel';
import { WorkspaceManager } from '../workspace';

/**
 * Task type definitions for completion suggestions
 */
const TASK_TYPE_COMPLETIONS: vscode.CompletionItem[] = [
    createTaskTypeCompletion('std.FileSet', 'Creates a FileSet from file patterns'),
    createTaskTypeCompletion('std.Exec', 'Executes a shell command'),
    createTaskTypeCompletion('std.Message', 'Outputs a message to the console'),
    createTaskTypeCompletion('std.Null', 'A no-op task that produces no output'),
    createTaskTypeCompletion('std.PyClass', 'Executes a Python class'),
    createTaskTypeCompletion('std.PyFunc', 'Executes a Python function'),
    createTaskTypeCompletion('std.Prompt', 'AI-assisted task with LLM prompt'),
];

function createTaskTypeCompletion(name: string, description: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
    item.detail = description;
    item.documentation = new vscode.MarkdownString(`**${name}**\n\n${description}`);
    item.insertText = name;
    return item;
}

/**
 * Parameter completions based on task type
 */
const TASK_PARAMS: { [taskType: string]: { name: string; type: string; description: string; required?: boolean }[] } = {
    'std.FileSet': [
        { name: 'type', type: 'string', description: 'Filetype of the produced fileset', required: true },
        { name: 'include', type: 'list', description: 'File patterns to include', required: true },
        { name: 'base', type: 'string', description: 'Base directory (default: srcdir)' },
        { name: 'exclude', type: 'list', description: 'File patterns to exclude' },
    ],
    'std.Exec': [
        { name: 'cmd', type: 'string', description: 'Command to execute', required: true },
        { name: 'shell', type: 'bool', description: 'Run in shell (default: true)' },
        { name: 'env', type: 'dict', description: 'Environment variables' },
        { name: 'cwd', type: 'string', description: 'Working directory' },
    ],
    'std.Message': [
        { name: 'msg', type: 'string', description: 'Message to display', required: true },
        { name: 'level', type: 'string', description: 'Message level (info, warn, error)' },
    ],
    'std.PyClass': [
        { name: 'module', type: 'string', description: 'Python module name', required: true },
        { name: 'class', type: 'string', description: 'Python class name', required: true },
    ],
    'std.PyFunc': [
        { name: 'module', type: 'string', description: 'Python module name', required: true },
        { name: 'func', type: 'string', description: 'Python function name', required: true },
    ],
};

export class FlowCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | null> {
        const line = document.lineAt(position.line).text;
        const linePrefix = line.substring(0, position.character);
        const flowDoc = this.documentCache.parseFromText(document.uri, document.getText());

        // Determine completion context
        const completionContext = this.determineContext(linePrefix, line, document, position);

        switch (completionContext.type) {
            case 'top-level':
                return this.getTopLevelCompletions();
            case 'task-property':
                return this.getTaskPropertyCompletions(completionContext.taskType);
            case 'uses':
                return this.getTaskTypeCompletions(flowDoc);
            case 'needs':
                return this.getTaskReferenceCompletions(flowDoc);
            case 'with-param':
                return this.getWithParameterCompletions(completionContext.taskType);
            case 'expression':
                return this.getExpressionCompletions(flowDoc);
            case 'import':
                return this.getImportCompletions();
            default:
                return null;
        }
    }

    private determineContext(
        linePrefix: string,
        fullLine: string,
        document: vscode.TextDocument,
        position: vscode.Position
    ): { type: string; taskType?: string } {
        const trimmed = linePrefix.trim();

        // Top-level completions
        if (position.character === 0 || linePrefix.match(/^\s*$/)) {
            return { type: 'top-level' };
        }

        // uses: completion
        if (trimmed.match(/^uses:\s*$/)) {
            return { type: 'uses' };
        }

        // needs: completion
        if (trimmed.match(/^needs:\s*\[?\s*$/) || trimmed.match(/^-\s*$/)) {
            // Check if we're in a needs context
            const prevLines = this.getPreviousLines(document, position.line, 5);
            if (prevLines.some(l => l.includes('needs:'))) {
                return { type: 'needs' };
            }
        }

        // Expression completion
        if (linePrefix.includes('${{') && !linePrefix.includes('}}')) {
            return { type: 'expression' };
        }

        // With block parameter completion
        if (trimmed.match(/^\s*[a-zA-Z_]*:?\s*$/)) {
            const taskType = this.findCurrentTaskType(document, position.line);
            if (taskType) {
                return { type: 'with-param', taskType };
            }
        }

        // Task property completion (inside a task definition)
        if (trimmed === '' || trimmed.match(/^[a-z]/)) {
            const taskType = this.findCurrentTaskType(document, position.line);
            return { type: 'task-property', taskType };
        }

        // Import completion
        if (trimmed.match(/^-\s*$/)) {
            const prevLines = this.getPreviousLines(document, position.line, 10);
            if (prevLines.some(l => l.match(/^imports:\s*$/))) {
                return { type: 'import' };
            }
        }

        return { type: 'unknown' };
    }

    private getPreviousLines(document: vscode.TextDocument, currentLine: number, count: number): string[] {
        const lines: string[] = [];
        for (let i = currentLine - 1; i >= 0 && i >= currentLine - count; i--) {
            lines.push(document.lineAt(i).text);
        }
        return lines;
    }

    private findCurrentTaskType(document: vscode.TextDocument, currentLine: number): string | undefined {
        // Look backwards for uses: line
        for (let i = currentLine - 1; i >= 0; i--) {
            const line = document.lineAt(i).text;
            
            // Stop if we hit another task definition
            if (line.match(/^\s*-\s*name:/)) {
                break;
            }
            
            const usesMatch = line.match(/^\s*uses:\s*(.+)$/);
            if (usesMatch) {
                return usesMatch[1].trim().replace(/^["']|["']$/g, '');
            }
        }
        return undefined;
    }

    private getTopLevelCompletions(): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        // Package definition
        const packageItem = new vscode.CompletionItem('package', vscode.CompletionItemKind.Keyword);
        packageItem.insertText = new vscode.SnippetString('package: ${1:my_package}');
        packageItem.detail = 'Define the package name';
        items.push(packageItem);

        // Tasks section
        const tasksItem = new vscode.CompletionItem('tasks', vscode.CompletionItemKind.Keyword);
        tasksItem.insertText = new vscode.SnippetString('tasks:\n  - name: ${1:task_name}\n    uses: ${2:std.Null}');
        tasksItem.detail = 'Define tasks';
        items.push(tasksItem);

        // Imports section
        const importsItem = new vscode.CompletionItem('imports', vscode.CompletionItemKind.Keyword);
        importsItem.insertText = new vscode.SnippetString('imports:\n  - ${1:package_name}');
        importsItem.detail = 'Import packages';
        items.push(importsItem);

        // Params section
        const paramsItem = new vscode.CompletionItem('params', vscode.CompletionItemKind.Keyword);
        paramsItem.insertText = new vscode.SnippetString('params:\n  - name: ${1:param_name}\n    type: ${2:str}');
        paramsItem.detail = 'Define package parameters';
        items.push(paramsItem);

        // Types section
        const typesItem = new vscode.CompletionItem('types', vscode.CompletionItemKind.Keyword);
        typesItem.insertText = new vscode.SnippetString('types:\n  - name: ${1:type_name}');
        typesItem.detail = 'Define custom types';
        items.push(typesItem);

        return items;
    }

    private getTaskPropertyCompletions(taskType?: string): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        // Common task properties
        const nameItem = new vscode.CompletionItem('name', vscode.CompletionItemKind.Property);
        nameItem.insertText = new vscode.SnippetString('name: ${1:task_name}');
        nameItem.detail = 'Task name';
        items.push(nameItem);

        const usesItem = new vscode.CompletionItem('uses', vscode.CompletionItemKind.Property);
        usesItem.insertText = new vscode.SnippetString('uses: ${1|std.FileSet,std.Exec,std.Message,std.Null|}');
        usesItem.detail = 'Base task type';
        items.push(usesItem);

        const descItem = new vscode.CompletionItem('desc', vscode.CompletionItemKind.Property);
        descItem.insertText = new vscode.SnippetString('desc: ${1:Description of the task}');
        descItem.detail = 'Task description';
        items.push(descItem);

        const needsItem = new vscode.CompletionItem('needs', vscode.CompletionItemKind.Property);
        needsItem.insertText = new vscode.SnippetString('needs: [${1:dependency}]');
        needsItem.detail = 'Task dependencies';
        items.push(needsItem);

        const withItem = new vscode.CompletionItem('with', vscode.CompletionItemKind.Property);
        withItem.insertText = new vscode.SnippetString('with:\n      ${1:param}: ${2:value}');
        withItem.detail = 'Task parameters';
        items.push(withItem);

        return items;
    }

    private getTaskTypeCompletions(flowDoc: FlowDocument): vscode.CompletionItem[] {
        const items = [...TASK_TYPE_COMPLETIONS];

        // Add task types from imports
        for (const [importName, importDef] of flowDoc.imports) {
            if (importDef.isPlugin) {
                // Add common task types from the plugin
                const pluginItem = new vscode.CompletionItem(importName, vscode.CompletionItemKind.Module);
                pluginItem.detail = `Tasks from ${importName} plugin`;
                items.push(pluginItem);
            }
        }

        // Add local tasks that could be extended
        for (const [taskName] of flowDoc.tasks) {
            const item = new vscode.CompletionItem(taskName, vscode.CompletionItemKind.Reference);
            item.detail = 'Local task (extend)';
            items.push(item);
        }

        return items;
    }

    private getTaskReferenceCompletions(flowDoc: FlowDocument): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        // Add all tasks from the document
        for (const [taskName, task] of flowDoc.tasks) {
            const item = new vscode.CompletionItem(taskName, vscode.CompletionItemKind.Reference);
            item.detail = task.uses || 'Task';
            if (task.description) {
                item.documentation = task.description;
            }
            items.push(item);
        }

        // Add tasks from imports (with package prefix)
        for (const [importName] of flowDoc.imports) {
            const item = new vscode.CompletionItem(`${importName}.`, vscode.CompletionItemKind.Module);
            item.detail = `Tasks from ${importName}`;
            item.command = { command: 'editor.action.triggerSuggest', title: 'Trigger Suggest' };
            items.push(item);
        }

        return items;
    }

    private getWithParameterCompletions(taskType?: string): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        if (taskType && TASK_PARAMS[taskType]) {
            for (const param of TASK_PARAMS[taskType]) {
                const item = new vscode.CompletionItem(param.name, vscode.CompletionItemKind.Property);
                item.detail = `${param.type}${param.required ? ' (required)' : ''}`;
                item.documentation = param.description;
                
                // Create appropriate snippet based on type
                if (param.type === 'list') {
                    item.insertText = new vscode.SnippetString(`${param.name}:\n        - \${1}`);
                } else if (param.type === 'dict') {
                    item.insertText = new vscode.SnippetString(`${param.name}:\n        \${1:key}: \${2:value}`);
                } else if (param.type === 'bool') {
                    item.insertText = new vscode.SnippetString(`${param.name}: \${1|true,false|}`);
                } else {
                    item.insertText = new vscode.SnippetString(`${param.name}: \${1}`);
                }
                
                items.push(item);
            }
        }

        return items;
    }

    private getExpressionCompletions(flowDoc: FlowDocument): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        // params.xxx
        const paramsItem = new vscode.CompletionItem('params', vscode.CompletionItemKind.Variable);
        paramsItem.detail = 'Package parameters';
        paramsItem.insertText = 'params.';
        paramsItem.command = { command: 'editor.action.triggerSuggest', title: 'Trigger Suggest' };
        items.push(paramsItem);

        // Add specific parameters
        for (const [paramName] of flowDoc.params) {
            const item = new vscode.CompletionItem(`params.${paramName}`, vscode.CompletionItemKind.Variable);
            item.detail = 'Package parameter';
            items.push(item);
        }

        // inputs.xxx
        const inputsItem = new vscode.CompletionItem('inputs', vscode.CompletionItemKind.Variable);
        inputsItem.detail = 'Task inputs (from needs)';
        inputsItem.insertText = 'inputs[0]';
        items.push(inputsItem);

        // env.xxx
        const envItem = new vscode.CompletionItem('env', vscode.CompletionItemKind.Variable);
        envItem.detail = 'Environment variables';
        envItem.insertText = 'env.';
        items.push(envItem);

        // srcdir
        const srcdirItem = new vscode.CompletionItem('srcdir', vscode.CompletionItemKind.Variable);
        srcdirItem.detail = 'Source directory path';
        items.push(srcdirItem);

        // rundir
        const rundirItem = new vscode.CompletionItem('rundir', vscode.CompletionItemKind.Variable);
        rundirItem.detail = 'Run directory path';
        items.push(rundirItem);

        return items;
    }

    private getImportCompletions(): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        // Common plugins
        const plugins = ['std', 'hdlsim', 'hdlsim.vlt', 'hdlsim.vcs', 'cocotb'];
        
        for (const plugin of plugins) {
            const item = new vscode.CompletionItem(plugin, vscode.CompletionItemKind.Module);
            item.detail = 'Plugin package';
            items.push(item);
        }

        return items;
    }
}
