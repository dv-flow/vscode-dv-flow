/**
 * Flow Completion Provider
 * 
 * Enhanced completion provider with schema-aware suggestions for:
 * - Task types (uses:)
 * - Parameter names based on base task
 * - Task references in needs
 * - Expression variables
 * - Dynamic task discovery via dfm
 */

import * as vscode from 'vscode';
import { FlowDocumentCache, FlowDocument, FlowTaskDef } from './flowDocumentModel';
import { DfmTaskDiscovery, DfmTask } from './dfmTaskDiscovery';
import { WorkspaceManager } from '../workspace';
import * as path from 'path';

/**
 * Enhanced task information for completion
 */
interface TaskInfo {
    name: string;              // Short name: "compile"
    fullName: string;          // Qualified: "hdlsim.compile"
    packageName?: string;      // Package: "hdlsim"
    scope?: string;            // Scope: "export", "root", "name", "local", "override"
    uses?: string;             // Base type: "std.Exec"
    description?: string;      // Task description
    source: string;            // Display: "local", "fragment: tasks/sim.yaml", "import: hdlsim"
}

/**
 * Enhanced completion context with package-qualified support
 */
interface CompletionContext {
    type: string;
    taskType?: string;
    packageName?: string;      // For package-scoped completion
    isPackageQualified?: boolean;
}

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
    private taskDiscovery: DfmTaskDiscovery;

    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {
        this.taskDiscovery = new DfmTaskDiscovery();
    }

    /**
     * Invalidate dfm task cache
     */
    invalidateDfmCache(packageName?: string): void {
        this.taskDiscovery.invalidateCache(packageName);
    }

    /**
     * Show task discovery log
     */
    showTaskDiscoveryLog(): void {
        this.taskDiscovery.showLog();
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.taskDiscovery.dispose();
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | null> {
        const line = document.lineAt(position.line).text;
        const linePrefix = line.substring(0, position.character);
        console.log(`[DV Flow Completion] provideCompletionItems called at line ${position.line}, char ${position.character}`);
        console.log(`[DV Flow Completion] Line: "${line}"`);
        console.log(`[DV Flow Completion] Line prefix: "${linePrefix}"`);
        
        const flowDoc = await this.documentCache.parseFromText(document.uri, document.getText());

        // Determine completion context
        const completionContext = this.determineContext(linePrefix, line, document, position);
        console.log(`[DV Flow Completion] Determined context type: ${completionContext.type}`);

        switch (completionContext.type) {
            case 'top-level':
                return this.getTopLevelCompletions();
            case 'task-property':
                return this.getTaskPropertyCompletions(completionContext.taskType);
            case 'uses':
            case 'uses-package-qualified':
                return this.getTaskTypeCompletions(flowDoc, completionContext);
            case 'needs':
            case 'needs-package-qualified':
                console.log('[DV Flow Completion] Handling needs completion...');
                return this.getTaskReferenceCompletions(flowDoc, completionContext);
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
    ): CompletionContext {
        const trimmed = linePrefix.trim();

        // Top-level completions
        if (position.character === 0 || linePrefix.match(/^\s*$/)) {
            return { type: 'top-level' };
        }

        // Check for package-qualified reference in uses context
        // Matches: "uses: pkg."
        const usesPkgMatch = linePrefix.match(/^uses:\s*([a-zA-Z_][a-zA-Z0-9_]*)\.\s*$/);
        if (usesPkgMatch) {
            return { 
                type: 'uses-package-qualified', 
                packageName: usesPkgMatch[1],
                isPackageQualified: true
            };
        }

        // uses: completion (unqualified)
        if (trimmed.match(/^uses:\s*$/)) {
            return { type: 'uses' };
        }

        // Check for package-qualified reference in needs context
        // Matches: "needs: [pkg.", "- pkg.", "needs: pkg."
        const pkgQualifiedMatch = linePrefix.match(/(?:needs:\s*\[|(?:^|\s)-\s*|needs:\s+|,\s*)([a-zA-Z_][a-zA-Z0-9_]*)\.\s*$/);
        if (pkgQualifiedMatch) {
            const prevLines = this.getPreviousLines(document, position.line, 5);
            if (prevLines.some(l => l.match(/^\s*needs:/))) {
                return { 
                    type: 'needs-package-qualified', 
                    packageName: pkgQualifiedMatch[1],
                    isPackageQualified: true
                };
            }
        }

        // needs: completion (unqualified)
        if (trimmed.match(/^needs:\s*\[?\s*$/) || trimmed.match(/^-\s*$/)) {
            // Check if we're in a needs context
            const prevLines = this.getPreviousLines(document, position.line, 5);
            console.log(`[DV Flow Completion] Checking needs context for: "${trimmed}"`);
            console.log(`[DV Flow Completion] Previous lines:`, prevLines);
            const hasNeeds = prevLines.some(l => l.includes('needs:'));
            console.log(`[DV Flow Completion] Has needs in previous lines: ${hasNeeds}`);
            if (hasNeeds) {
                console.log('[DV Flow Completion] Detected needs context');
                return { type: 'needs' };
            } else {
                console.log('[DV Flow Completion] Not in needs context');
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
            console.log(`[DV Flow Completion] Checking task-property for: "${trimmed}"`);
            const taskType = this.findCurrentTaskType(document, position.line);
            console.log(`[DV Flow Completion] Found task type: ${taskType}`);
            return { type: 'task-property', taskType };
        }

        // Import completion
        if (trimmed.match(/^-\s*$/)) {
            const prevLines = this.getPreviousLines(document, position.line, 10);
            console.log(`[DV Flow Completion] Checking import context for: "${trimmed}"`);
            if (prevLines.some(l => l.match(/^imports:\s*$/))) {
                console.log('[DV Flow Completion] Detected import context');
                return { type: 'import' };
            }
        }

        console.log(`[DV Flow Completion] No context matched, returning unknown`);
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

    private async getTaskTypeCompletions(
        flowDoc: FlowDocument,
        context?: CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        console.log('[DV Flow Completion] getTaskTypeCompletions called');
        console.log('[DV Flow Completion] Context:', context);
        
        // Get dfm-discovered tasks
        const dfmTasks = await this.getDfmDiscoveredTasks(flowDoc);
        console.log(`[DV Flow Completion] dfmTasks available: ${dfmTasks.size}`);
        
        // If package-qualified, filter to that package
        if (context?.isPackageQualified && context.packageName) {
            console.log(`[DV Flow Completion] Package-qualified context: ${context.packageName}`);
            const items: vscode.CompletionItem[] = [];
            
            // Filter dfm tasks to the specified package
            for (const [key, dfmTask] of dfmTasks) {
                if (dfmTask.package === context.packageName) {
                    console.log(`[DV Flow Completion] Adding task: ${dfmTask.short_name} (from ${dfmTask.package})`);
                    // Create completion item for package-qualified context
                    // User typed: "uses: std." so we insert just "FileSet"
                    const item = new vscode.CompletionItem(
                        dfmTask.short_name, // Display: "FileSet"
                        vscode.CompletionItemKind.Class
                    );
                    item.detail = dfmTask.desc || dfmTask.doc.split('\n')[0] || `${dfmTask.package} task`;
                    item.documentation = this.createDfmTaskDocumentation(dfmTask);
                    item.insertText = dfmTask.short_name; // Insert: "FileSet" (std. already typed)
                    item.filterText = dfmTask.short_name; // Filter by: "FileSet"
                    item.sortText = `0_${dfmTask.short_name}`;
                    
                    console.log(`[DV Flow Completion]   label: "${item.label}"`);
                    console.log(`[DV Flow Completion]   insertText: "${item.insertText}"`);
                    console.log(`[DV Flow Completion]   filterText: "${item.filterText}"`);
                    console.log(`[DV Flow Completion]   sortText: "${item.sortText}"`);
                    
                    items.push(item);
                }
            }
            
            console.log(`[DV Flow Completion] Returning ${items.length} package-qualified items`);
            
            if (items.length === 0) {
                const errorItem = new vscode.CompletionItem(
                    `No tasks in package '${context.packageName}'`,
                    vscode.CompletionItemKind.Text
                );
                items.push(errorItem);
            }
            
            return items;
        }
        
        // Unqualified context - show hardcoded + dfm tasks with FULL names
        console.log('[DV Flow Completion] Unqualified context - adding all tasks');
        const items = [...TASK_TYPE_COMPLETIONS];
        console.log(`[DV Flow Completion] Started with ${items.length} hardcoded tasks`);

        // Add dfm-discovered tasks (all packages) with full names
        console.log(`[DV Flow Completion] Adding ${dfmTasks.size} dfm tasks`);
        for (const [key, dfmTask] of dfmTasks) {
            console.log(`[DV Flow Completion] Adding dfm task: ${dfmTask.name}`);
            const item = new vscode.CompletionItem(
                dfmTask.name, // Display full name: "std.FileSet"
                vscode.CompletionItemKind.Class
            );
            item.detail = dfmTask.desc || dfmTask.doc.split('\n')[0] || `${dfmTask.package} task`;
            item.documentation = this.createDfmTaskDocumentation(dfmTask);
            item.insertText = dfmTask.name; // Insert full name: "std.FileSet"
            item.filterText = dfmTask.name; // Filter by full name
            item.sortText = `1_${dfmTask.name}`;
            
            console.log(`[DV Flow Completion]   label: "${item.label}"`);
            console.log(`[DV Flow Completion]   insertText: "${item.insertText}"`);
            console.log(`[DV Flow Completion]   filterText: "${item.filterText}"`);
            
            items.push(item);
        }

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

        console.log(`[DV Flow Completion] Returning ${items.length} total items for uses completion`);
        return items;
    }

    private async getTaskReferenceCompletions(
        flowDoc: FlowDocument,
        context?: CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        console.log('[DV Flow Completion] getTaskReferenceCompletions called');
        console.log('[DV Flow Completion] Context:', context);
        
        const items: vscode.CompletionItem[] = [];
        const allTasks = await this.getAllAvailableTasks(flowDoc);
        console.log(`[DV Flow Completion] Workspace tasks collected: ${allTasks.size}`);
        
        // Add dfm-discovered tasks
        const dfmTasks = await this.getDfmDiscoveredTasks(flowDoc);
        console.log(`[DV Flow Completion] DFM tasks discovered: ${dfmTasks.size}`);
        for (const [key, task] of dfmTasks) {
            console.log(`[DV Flow Completion]   - ${task.name} (${task.package})`);
        }
        
        // If package-qualified context, filter to that package only
        if (context?.isPackageQualified && context.packageName) {
            console.log(`[DV Flow Completion] Package-qualified context: ${context.packageName}`);
            return this.getPackageScopedTaskCompletions(
                flowDoc, 
                allTasks,
                dfmTasks, 
                context.packageName
            );
        }
        
        // Otherwise, show all available tasks (unqualified)
        console.log('[DV Flow Completion] Unqualified needs context - adding all tasks');
        
        // Add workspace tasks
        for (const [key, taskInfo] of allTasks) {
            const item = this.createTaskCompletionItem(key, taskInfo);
            items.push(item);
        }
        console.log(`[DV Flow Completion] Added ${allTasks.size} workspace tasks`);
        
        // Add dfm-discovered tasks with FULL names (std.FileSet)
        console.log(`[DV Flow Completion] Adding ${dfmTasks.size} dfm tasks with full names`);
        for (const [key, dfmTask] of dfmTasks) {
            const item = new vscode.CompletionItem(
                dfmTask.name, // Full name: "std.FileSet"
                vscode.CompletionItemKind.Class
            );
            item.detail = dfmTask.desc || dfmTask.doc.split('\n')[0] || `${dfmTask.package} task`;
            item.documentation = this.createDfmTaskDocumentation(dfmTask);
            item.insertText = dfmTask.name; // Insert full name: "std.FileSet"
            item.filterText = dfmTask.name; // Filter by full name
            item.sortText = `3_dfm_${dfmTask.name}`;
            
            console.log(`[DV Flow Completion]   Adding: ${dfmTask.name}`);
            console.log(`[DV Flow Completion]     insertText: "${item.insertText}"`);
            console.log(`[DV Flow Completion]     filterText: "${item.filterText}"`);
            
            items.push(item);
        }
        console.log(`[DV Flow Completion] Added ${dfmTasks.size} dfm tasks`);
        
        // Add package prefix triggers (e.g., "std." → shows std tasks)
        items.push(...this.createPackagePrefixItems(flowDoc));
        
        console.log(`[DV Flow Completion] Total completion items: ${items.length}`);
        return items;
    }

    /**
     * Collect all available tasks from local file, fragments, and imports
     */
    private async getAllAvailableTasks(flowDoc: FlowDocument): Promise<Map<string, TaskInfo>> {
        const tasks = new Map<string, TaskInfo>();
        
        // Add local tasks (from current package)
        for (const [name, task] of flowDoc.tasks) {
            const taskInfo: TaskInfo = {
                name,
                fullName: task.fullName,
                packageName: flowDoc.packageName,
                scope: task.scope,
                uses: task.uses,
                description: task.description,
                source: 'local'
            };
            tasks.set(name, taskInfo);
        }
        
        // Add fragment tasks (inherit package name from parent)
        await this.addFragmentTasks(flowDoc, tasks);
        
        // Add imported package tasks
        await this.addImportedTasks(flowDoc, tasks);
        
        return tasks;
    }

    /**
     * Add tasks from fragment files
     */
    private async addFragmentTasks(
        flowDoc: FlowDocument, 
        tasks: Map<string, TaskInfo>
    ): Promise<void> {
        for (const fragment of flowDoc.fragments) {
            try {
                // Resolve fragment path relative to current document
                const docDir = path.dirname(flowDoc.uri.fsPath);
                const fragmentPath = path.isAbsolute(fragment.path)
                    ? fragment.path
                    : path.resolve(docDir, fragment.path);
                const fragmentUri = vscode.Uri.file(fragmentPath);
                
                const fragmentDoc = await this.documentCache.getDocument(fragmentUri);
                if (fragmentDoc) {
                    for (const [name, task] of fragmentDoc.tasks) {
                        // Skip local-scope tasks from fragments (not visible)
                        if (task.scope === 'local') {
                            continue;
                        }
                        
                        const taskInfo: TaskInfo = {
                            name,
                            fullName: task.fullName,
                            packageName: flowDoc.packageName, // Inherit from parent
                            scope: task.scope,
                            uses: task.uses,
                            description: task.description,
                            source: `fragment: ${path.basename(fragment.path)}`
                        };
                        
                        // For named fragments, use qualified name as key (e.g., "sub.MyTask3")
                        // For unnamed fragments, use simple name as key for backward compatibility
                        if (fragmentDoc.fragmentName) {
                            const qualifiedName = `${fragmentDoc.fragmentName}.${name}`;
                            tasks.set(qualifiedName, taskInfo);
                        } else {
                            tasks.set(name, taskInfo);
                        }
                    }
                }
            } catch (error) {
                console.debug(`Could not load fragment ${fragment.path}:`, error);
            }
        }
    }

    /**
     * Add tasks from imported packages
     */
    private async addImportedTasks(
        flowDoc: FlowDocument, 
        tasks: Map<string, TaskInfo>
    ): Promise<void> {
        for (const [importName, importDef] of flowDoc.imports) {
            try {
                const importDoc = await this.loadImportedPackage(importName, importDef, flowDoc);
                if (importDoc) {
                    for (const [name, task] of importDoc.tasks) {
                        // Only export/root tasks from imports are visible
                        if (task.scope !== 'export' && task.scope !== 'root') {
                            continue;
                        }
                        
                        // Use package-qualified name as key to avoid collisions
                        const fullName = `${importDoc.packageName || importName}.${name}`;
                        const taskInfo: TaskInfo = {
                            name,
                            fullName,
                            packageName: importDoc.packageName || importName,
                            scope: task.scope,
                            uses: task.uses,
                            description: task.description,
                            source: `import: ${importName}`
                        };
                        
                        tasks.set(fullName, taskInfo);
                    }
                }
            } catch (error) {
                console.debug(`Could not load imported package ${importName}:`, error);
            }
        }
    }

    /**
     * Load an imported package definition
     */
    private async loadImportedPackage(
        importName: string,
        importDef: any,
        flowDoc: FlowDocument
    ): Promise<FlowDocument | undefined> {
        // If import has an explicit path, use it
        if (importDef.path) {
            const docDir = path.dirname(flowDoc.uri.fsPath);
            const importPath = path.isAbsolute(importDef.path)
                ? importDef.path
                : path.resolve(docDir, importDef.path);
            const importUri = vscode.Uri.file(importPath);
            return await this.documentCache.getDocument(importUri);
        }
        
        // Otherwise, search workspace for package
        return await this.findImportedPackageInWorkspace(importName);
    }

    /**
     * Search workspace for an imported package
     */
    private async findImportedPackageInWorkspace(
        importName: string
    ): Promise<FlowDocument | undefined> {
        const patterns = [
            `**/${importName}/flow.yaml`,
            `**/${importName}/flow.yml`,
            `**/packages/${importName}/flow.yaml`,
            `**/packages/${importName}/flow.yml`,
            `**/${importName}.yaml`,
            `**/${importName}.yml`,
        ];
        
        for (const pattern of patterns) {
            try {
                const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1);
                if (files.length > 0) {
                    return await this.documentCache.getDocument(files[0]);
                }
            } catch (error) {
                console.debug(`Error searching for ${pattern}:`, error);
            }
        }
        
        return undefined;
    }

    /**
     * Get completions for a specific package (when user types "pkg.")
     */
    private getPackageScopedTaskCompletions(
        flowDoc: FlowDocument,
        allTasks: Map<string, TaskInfo>,
        dfmTasks: Map<string, DfmTask>,
        packageName: string
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        
        // Check if package is std (always available) or imported
        const isStd = packageName === 'std';
        const importDef = flowDoc.imports.get(packageName);
        
        if (!isStd && !importDef) {
            // Package not imported - show error item
            const errorItem = new vscode.CompletionItem(
                `Package '${packageName}' not imported`,
                vscode.CompletionItemKind.Text
            );
            errorItem.detail = 'Add to imports section';
            errorItem.documentation = new vscode.MarkdownString(
                `The package \`${packageName}\` is not in the imports list.\n\n` +
                `Add it to the imports section:\n\`\`\`yaml\nimports:\n  - ${packageName}\n\`\`\``
            );
            return [errorItem];
        }
        
        // Filter workspace tasks to this package
        for (const [key, taskInfo] of allTasks) {
            if (taskInfo.packageName === packageName) {
                const item = new vscode.CompletionItem(
                    taskInfo.name,
                    vscode.CompletionItemKind.Reference
                );
                item.detail = `${taskInfo.uses || 'Task'} (${packageName})`;
                item.documentation = this.createTaskDocumentation(taskInfo);
                item.filterText = taskInfo.name;
                item.insertText = taskInfo.name;
                item.sortText = `0_${taskInfo.name}`;
                items.push(item);
            }
        }
        
        // Filter dfm tasks to this package
        for (const [key, dfmTask] of dfmTasks) {
            if (dfmTask.package === packageName) {
                const item = new vscode.CompletionItem(
                    dfmTask.short_name, // Display: "FileSet"
                    vscode.CompletionItemKind.Class
                );
                item.detail = dfmTask.desc || dfmTask.doc.split('\n')[0] || `${packageName} task`;
                item.documentation = this.createDfmTaskDocumentation(dfmTask);
                item.filterText = dfmTask.short_name; // Filter by: "FileSet"
                item.insertText = dfmTask.short_name; // Insert: "FileSet" (package. already typed)
                item.sortText = `1_${dfmTask.short_name}`; // dfm tasks after workspace tasks
                items.push(item);
            }
        }
        
        if (items.length === 0) {
            const noTasksItem = new vscode.CompletionItem(
                `No tasks in '${packageName}'`,
                vscode.CompletionItemKind.Text
            );
            noTasksItem.detail = 'Package has no exported tasks';
            items.push(noTasksItem);
        }
        
        return items;
    }

    /**
     * Create a completion item for a task
     */
    private createTaskCompletionItem(displayName: string, taskInfo: TaskInfo): vscode.CompletionItem {
        // Use displayName for label (could be qualified like "sub.MyTask3")
        const item = new vscode.CompletionItem(
            displayName,
            vscode.CompletionItemKind.Reference
        );
        
        // Detail shows type and source
        item.detail = `${taskInfo.uses || 'Task'} (${taskInfo.source})`;
        
        // Documentation with rich information
        item.documentation = this.createTaskDocumentation(taskInfo);
        
        // Sort text for intelligent ordering (local > fragment > import)
        item.sortText = this.getTaskSortText(taskInfo);
        
        return item;
    }

    /**
     * Create documentation for a task
     */
    private createTaskDocumentation(taskInfo: TaskInfo): vscode.MarkdownString {
        const docs = new vscode.MarkdownString();
        
        if (taskInfo.description) {
            docs.appendMarkdown(`${taskInfo.description}\n\n`);
        }
        
        docs.appendMarkdown(`**Type:** \`${taskInfo.uses || 'N/A'}\`\n`);
        docs.appendMarkdown(`**Package:** \`${taskInfo.packageName || 'local'}\`\n`);
        
        if (taskInfo.scope) {
            docs.appendMarkdown(`**Scope:** \`${taskInfo.scope}\`\n`);
        }
        
        if (taskInfo.fullName !== taskInfo.name) {
            docs.appendMarkdown(`**Full Name:** \`${taskInfo.fullName}\`\n`);
        }
        
        docs.appendMarkdown(`\n**Source:** ${taskInfo.source}`);
        
        return docs;
    }

    /**
     * Get sort text for intelligent task ordering
     */
    private getTaskSortText(taskInfo: TaskInfo): string {
        // Prioritize: local (0) > fragment (1) > import (2)
        let prefix: string;
        if (taskInfo.source === 'local') {
            prefix = '0';
        } else if (taskInfo.source.startsWith('fragment')) {
            prefix = '1';
        } else {
            prefix = '2';
        }
        return `${prefix}_${taskInfo.name}`;
    }

    /**
     * Create package prefix trigger items
     */
    private createPackagePrefixItems(flowDoc: FlowDocument): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        
        for (const [importName, importDef] of flowDoc.imports) {
            const prefixItem = new vscode.CompletionItem(
                `${importName}.`,
                vscode.CompletionItemKind.Module
            );
            prefixItem.detail = `Browse tasks in ${importName} package`;
            prefixItem.documentation = new vscode.MarkdownString(
                `Type \`${importName}.\` to see all tasks from the **${importName}** package.`
            );
            prefixItem.insertText = `${importName}.`;
            prefixItem.command = {
                command: 'editor.action.triggerSuggest',
                title: 'Show Package Tasks'
            };
            // Sort package prefixes at the bottom
            prefixItem.sortText = `9_${importName}`;
            items.push(prefixItem);
        }
        
        return items;
    }

    /**
     * Get tasks discovered by dfm
     */
    private async getDfmDiscoveredTasks(
        flowDoc: FlowDocument
    ): Promise<Map<string, DfmTask>> {
        console.log('[DV Flow Completion] getDfmDiscoveredTasks called');
        const tasks = new Map<string, DfmTask>();
        
        // Get list of imported packages (including std)
        const imports = Array.from(flowDoc.imports.keys());
        console.log(`[DV Flow Completion] Imports from document: ${imports.join(', ') || '(none)'}`);
        
        // Get workspace root for context
        const rootDir = path.dirname(flowDoc.uri.fsPath);
        console.log(`[DV Flow Completion] Root directory: ${rootDir}`);
        
        try {
            // Discover tasks from all imported packages (including std)
            console.log('[DV Flow Completion] Calling taskDiscovery.discoverAllTasks...');
            const discoveredTasks = await this.taskDiscovery.discoverAllTasks(
                imports,
                rootDir
            );
            console.log(`[DV Flow Completion] Discovered tasks from ${discoveredTasks.size} packages`);
            
            // Flatten into single map with full name as key
            for (const [pkg, pkgTasks] of discoveredTasks) {
                console.log(`[DV Flow Completion] Package ${pkg}: ${pkgTasks.length} tasks`);
                for (const task of pkgTasks) {
                    tasks.set(task.name, task);
                }
            }
            
            console.log(`[DV Flow Completion] Total dfm tasks collected: ${tasks.size}`);
        } catch (error) {
            console.error('[DV Flow Completion] Error discovering dfm tasks:', error);
        }
        
        return tasks;
    }

    /**
     * Create completion item from dfm task
     */
    private createDfmTaskCompletionItem(task: DfmTask): vscode.CompletionItem {
        const item = new vscode.CompletionItem(
            task.short_name,
            vscode.CompletionItemKind.Class
        );
        
        // Use desc for detail, fall back to first line of doc
        item.detail = task.desc || task.doc.split('\n')[0] || `${task.package} task`;
        
        // Create rich documentation
        item.documentation = this.createDfmTaskDocumentation(task);
        
        // Sort dfm tasks after workspace tasks but before package prefixes
        item.sortText = `3_dfm_${task.short_name}`;
        
        return item;
    }

    /**
     * Create documentation for dfm task
     */
    private createDfmTaskDocumentation(task: DfmTask): vscode.MarkdownString {
        const docs = new vscode.MarkdownString();
        
        docs.appendMarkdown(`**${task.name}**\n\n`);
        
        if (task.desc) {
            docs.appendMarkdown(`${task.desc}\n\n`);
        }
        
        if (task.doc) {
            docs.appendMarkdown(`${task.doc}\n\n`);
        }
        
        docs.appendMarkdown(`**Package:** \`${task.package}\`\n`);
        
        if (task.uses) {
            docs.appendMarkdown(`**Uses:** \`${task.uses}\`\n`);
        }
        
        if (task.scope && task.scope.length > 0) {
            docs.appendMarkdown(`**Scope:** \`${task.scope.join(', ')}\`\n`);
        }
        
        docs.appendMarkdown(`\n**Source:** dfm-discovered`);
        
        return docs;
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
