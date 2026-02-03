/**
 * Flow Diagnostics Provider
 * 
 * Provides real-time validation and diagnostics for flow.yaml/flow.dv files.
 * Integrates with dfm validate command and provides inline error reporting.
 */

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { FlowDocumentCache, FlowDocument } from './flowDocumentModel';
import { WorkspaceManager } from '../workspace';
import { getDfmCommand } from '../utils/dfmUtil';
import { DfmTaskDiscovery } from './dfmTaskDiscovery';

/**
 * Diagnostic codes for DV Flow validation errors
 */
export const DiagnosticCodes = {
    UNDEFINED_TASK: 'DFM001',
    UNDEFINED_TYPE: 'DFM002',
    CIRCULAR_DEPENDENCY: 'DFM003',
    MISSING_REQUIRED_PARAM: 'DFM004',
    TYPE_MISMATCH: 'DFM005',
    INVALID_EXPRESSION: 'DFM006',
    DUPLICATE_TASK_NAME: 'DFM007',
    VISIBILITY_VIOLATION: 'DFM008',
    INVALID_YAML: 'DFM009',
    UNKNOWN_IMPORT: 'DFM010',
    PARSE_ERROR: 'DFM011',
    MISSING_FRAGMENT: 'DFM012'
};

/**
 * Provides diagnostics for flow documents
 */
export class FlowDiagnosticsProvider {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private pendingValidations: Map<string, NodeJS.Timeout> = new Map();
    private debounceMs = 500;
    private taskDiscovery: DfmTaskDiscovery;

    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('dvflow');
        this.taskDiscovery = new DfmTaskDiscovery();
    }

    /**
     * Register document change listeners
     */
    register(context: vscode.ExtensionContext): void {
        // Validate on document open
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (this.isFlowDocument(doc)) {
                    this.validateDocument(doc);
                }
            })
        );

        // Validate on document change (debounced)
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (this.isFlowDocument(event.document)) {
                    this.scheduleValidation(event.document);
                }
            })
        );

        // Validate on document save
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (this.isFlowDocument(doc)) {
                    this.validateDocument(doc);
                }
            })
        );

        // Clear diagnostics when document closes
        context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.diagnosticCollection.delete(doc.uri);
            })
        );

        // Validate all open flow documents
        for (const doc of vscode.workspace.textDocuments) {
            if (this.isFlowDocument(doc)) {
                this.validateDocument(doc);
            }
        }

        context.subscriptions.push(this.diagnosticCollection);
    }

    private isFlowDocument(document: vscode.TextDocument): boolean {
        return document.languageId === 'dvflow' ||
               document.fileName.endsWith('.dv') ||
               document.fileName.endsWith('flow.yaml') ||
               document.fileName.endsWith('flow.yml');
    }

    private scheduleValidation(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        
        // Clear any pending validation
        const existing = this.pendingValidations.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        // Schedule new validation
        const timeout = setTimeout(() => {
            this.pendingValidations.delete(key);
            this.validateDocument(document);
        }, this.debounceMs);

        this.pendingValidations.set(key, timeout);
    }

    /**
     * Validate a flow document
     */
    async validateDocument(document: vscode.TextDocument): Promise<void> {
        const diagnostics: vscode.Diagnostic[] = [];
        
        // Parse the document for context
        const flowDoc = await this.documentCache.parseFromText(document.uri, document.getText());

        // First, do local validation (fast)
        const localDiagnostics = await this.validateLocally(document);
        diagnostics.push(...localDiagnostics);

        // Then, run dfm validate for deeper validation (if document is saved)
        if (!document.isDirty) {
            const dfmDiagnostics = await this.validateWithDfm(document, flowDoc);
            diagnostics.push(...dfmDiagnostics);
        }

        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    /**
     * Perform local validation without invoking dfm
     */
    private async validateLocally(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const flowDoc = await this.documentCache.parseFromText(document.uri, text);

        // Check for duplicate task names
        const taskNames = new Map<string, number>();
        for (const [name, task] of flowDoc.tasks) {
            if (taskNames.has(name)) {
                const line = task.location.line - 1;
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(line, 0, line, 100),
                    `Duplicate task name: '${name}'`,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.code = DiagnosticCodes.DUPLICATE_TASK_NAME;
                diagnostic.source = 'dvflow';
                diagnostics.push(diagnostic);
            } else {
                taskNames.set(name, task.location.line);
            }
        }

        // Check for undefined task references in needs
        // Get dfm-discovered tasks for validation
        const dfmTasks = await this.getDfmDiscoveredTasks(flowDoc);
        
        for (const [, task] of flowDoc.tasks) {
            if (task.needs) {
                for (const need of task.needs) {
                    // Check if the referenced task exists
                    const existsLocally = flowDoc.tasks.has(need) || this.documentCache.findTask(need);
                    const existsInDfm = dfmTasks.has(need);
                    
                    if (!existsLocally && !existsInDfm) {
                        // Check if it might be a qualified name from a fragment
                        const parts = need.split('.');
                        let shouldReport = false;
                        let warningMessage = '';
                        
                        if (parts.length > 1) {
                            const firstPart = parts[0];
                            
                            // Check if it might be a fragment-qualified reference
                            let isFragmentReference = false;
                            for (const cachedDoc of this.documentCache.getAllDocuments()) {
                                if (cachedDoc.fragmentName === firstPart && 
                                    cachedDoc.packageName === flowDoc.packageName) {
                                    isFragmentReference = true;
                                    break;
                                }
                            }
                            
                            if (!isFragmentReference) {
                                // Not a fragment reference and not found in dfm tasks
                                shouldReport = true;
                                warningMessage = `Unknown task: '${need}'. Task not found in local definitions or available packages.`;
                            }
                        } else {
                            // Simple (unqualified) name not found
                            shouldReport = true;
                            warningMessage = `Unknown task: '${need}'. Did you forget to define it or import a package?`;
                        }
                        
                        if (shouldReport) {
                            // Try to find the reference location
                            const ref = flowDoc.references.find(r => r.name === need);
                            let range: vscode.Range;
                            
                            if (ref && ref.location.column > 0) {
                                range = new vscode.Range(
                                    ref.location.line - 1, ref.location.column - 1, 
                                    ref.location.line - 1, ref.location.column + need.length - 1
                                );
                            } else {
                                // Fallback: search the document text for the need name
                                range = this.findTextInDocument(document, need) || 
                                        new vscode.Range(0, 0, 0, 1);
                            }
                            
                            const diagnostic = new vscode.Diagnostic(
                                range,
                                warningMessage,
                                vscode.DiagnosticSeverity.Warning
                            );
                            diagnostic.code = DiagnosticCodes.UNDEFINED_TASK;
                            diagnostic.source = 'dvflow';
                            diagnostics.push(diagnostic);
                        }
                    }
                }
            }
        }

        // Check for fragment files that don't exist
        const docDir = path.dirname(document.uri.fsPath);
        for (const fragment of flowDoc.fragments) {
            const fragmentPath = path.isAbsolute(fragment.path) 
                ? fragment.path 
                : path.resolve(docDir, fragment.path);
            
            if (!fs.existsSync(fragmentPath)) {
                const line = fragment.location.line - 1;
                const col = fragment.location.column - 1;
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(line, col, line, col + fragment.path.length),
                    `Fragment file not found: '${fragment.path}'`,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.code = DiagnosticCodes.MISSING_FRAGMENT;
                diagnostic.source = 'dvflow';
                diagnostics.push(diagnostic);
            }
        }

        // Check for invalid expression syntax
        const exprRegex = /\$\{\{([^}]*)\}\}/g;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let match;
            while ((match = exprRegex.exec(line)) !== null) {
                const expr = match[1];
                // Check for unbalanced braces, etc.
                if (expr.includes('{{') || expr.includes('}}')) {
                    const diagnostic = new vscode.Diagnostic(
                        new vscode.Range(i, match.index, i, match.index + match[0].length),
                        'Invalid expression: nested braces detected',
                        vscode.DiagnosticSeverity.Error
                    );
                    diagnostic.code = DiagnosticCodes.INVALID_EXPRESSION;
                    diagnostic.source = 'dvflow';
                    diagnostics.push(diagnostic);
                }
                // Check for empty expression
                if (expr.trim() === '') {
                    const diagnostic = new vscode.Diagnostic(
                        new vscode.Range(i, match.index, i, match.index + match[0].length),
                        'Empty expression',
                        vscode.DiagnosticSeverity.Warning
                    );
                    diagnostic.code = DiagnosticCodes.INVALID_EXPRESSION;
                    diagnostic.source = 'dvflow';
                    diagnostics.push(diagnostic);
                }
            }
        }

        // Check for unclosed expression
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const openCount = (line.match(/\$\{\{/g) || []).length;
            const closeCount = (line.match(/\}\}/g) || []).length;
            if (openCount !== closeCount) {
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(i, 0, i, line.length),
                    'Unclosed expression: mismatched ${{ and }}',
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.code = DiagnosticCodes.INVALID_EXPRESSION;
                diagnostic.source = 'dvflow';
                diagnostics.push(diagnostic);
            }
        }

        return diagnostics;
    }

    /**
     * Get dfm-discovered tasks for validation
     */
    private async getDfmDiscoveredTasks(flowDoc: FlowDocument): Promise<Map<string, boolean>> {
        const tasks = new Map<string, boolean>();
        
        try {
            // Get list of imported packages
            const imports = Array.from(flowDoc.imports.keys());
            
            // Get workspace root for context
            const rootDir = path.dirname(flowDoc.uri.fsPath);
            
            // Discover tasks from all imported packages
            const discoveredTasks = await this.taskDiscovery.discoverAllTasks(
                imports,
                rootDir
            );
            
            // Add all discovered tasks to the map
            for (const [packageName, pkgTasks] of discoveredTasks) {
                for (const task of pkgTasks) {
                    tasks.set(task.name, true);
                }
            }
        } catch (error) {
            // If discovery fails, return empty map (don't block validation)
            console.error('[DV Flow Diagnostics] Failed to discover dfm tasks:', error);
        }
        
        return tasks;
    }

    /**
     * Validate using dfm validate command
     */
    private async validateWithDfm(document: vscode.TextDocument, flowDoc: FlowDocument): Promise<vscode.Diagnostic[]> {
        const diagnostics: vscode.Diagnostic[] = [];
        
        // Get dfm-discovered tasks to filter false positives
        const dfmTasks = await this.getDfmDiscoveredTasks(flowDoc);
        
        try {
            const workspaceRoot = path.dirname(document.uri.fsPath);
            const command = await getDfmCommand(workspaceRoot, 'validate --json');
            
            const output = await new Promise<string>((resolve, reject) => {
                child_process.exec(command, { cwd: workspaceRoot, timeout: 10000 }, (error, stdout, stderr) => {
                    // dfm validate may return non-zero on validation errors, but we still want the output
                    resolve(stdout + stderr);
                });
            });

            // Try to parse JSON output
            try {
                // Look for JSON in the output
                const jsonMatch = output.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const result = JSON.parse(jsonMatch[0]);
                    
                    if (result.errors) {
                        for (const error of result.errors) {
                            // Filter out UndefinedTaskReference errors if task exists in dfm
                            if (error.type === 'UndefinedTaskReference' && error.reference) {
                                if (dfmTasks.has(error.reference)) {
                                    console.log(`[DV Flow Diagnostics] Suppressing false positive: ${error.reference} exists in dfm`);
                                    continue; // Skip this error - it's a false positive
                                }
                            }
                            
                            const diagnostic = await this.createDiagnosticFromDfm(error, document);
                            if (diagnostic) {
                                diagnostics.push(diagnostic);
                            }
                        }
                    }
                    
                    if (result.warnings) {
                        for (const warning of result.warnings) {
                            const diagnostic = await this.createDiagnosticFromDfm(warning, document, vscode.DiagnosticSeverity.Warning);
                            if (diagnostic) {
                                diagnostics.push(diagnostic);
                            }
                        }
                    }
                    
                    if (result.markers) {
                        for (const marker of result.markers) {
                            const severity = marker.severity === 'error' 
                                ? vscode.DiagnosticSeverity.Error 
                                : marker.severity === 'warning'
                                    ? vscode.DiagnosticSeverity.Warning
                                    : vscode.DiagnosticSeverity.Information;
                            const diagnostic = await this.createDiagnosticFromDfm(marker, document, severity);
                            if (diagnostic) {
                                diagnostics.push(diagnostic);
                            }
                        }
                    }
                }
            } catch (parseError) {
                // If JSON parsing fails, try to extract error messages from text output
                const errorLines = output.split('\n').filter(line => 
                    line.includes('Error') || line.includes('error') || line.includes('Warning')
                );
                
                for (const errorLine of errorLines) {
                    // Try to parse location from error message
                    const locationMatch = errorLine.match(/([^:]+):(\d+)(?::(\d+))?[:\s]+(.+)/);
                    if (locationMatch) {
                        const [, file, lineStr, colStr, message] = locationMatch;
                        const line = parseInt(lineStr) - 1;
                        const col = colStr ? parseInt(colStr) - 1 : 0;
                        
                        // Only add if it's for the current file
                        if (file.includes(path.basename(document.uri.fsPath))) {
                            const diagnostic = new vscode.Diagnostic(
                                new vscode.Range(line, col, line, col + 50),
                                message.trim(),
                                errorLine.toLowerCase().includes('warning') 
                                    ? vscode.DiagnosticSeverity.Warning 
                                    : vscode.DiagnosticSeverity.Error
                            );
                            diagnostic.source = 'dfm';
                            diagnostics.push(diagnostic);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error running dfm validate:', error);
        }

        return diagnostics;
    }

    private async createDiagnosticFromDfm(
        error: any, 
        document: vscode.TextDocument,
        defaultSeverity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Error
    ): Promise<vscode.Diagnostic | null> {
        let line = 0;
        let col = 0;
        let message = '';

        if (typeof error === 'string') {
            message = error;
        } else if (error.msg || error.message) {
            message = error.msg || error.message;
            if (error.line) {
                line = error.line - 1;
            }
            if (error.column || error.col) {
                col = (error.column || error.col) - 1;
            }
            if (error.srcinfo) {
                const parts = error.srcinfo.split(':');
                if (parts.length >= 2) {
                    line = parseInt(parts[1]) - 1;
                }
                if (parts.length >= 3) {
                    col = parseInt(parts[2]) - 1;
                }
            }
        } else {
            return null;
        }

        // Handle UnusedTask warnings - find the task location and update message
        if (error.type === 'UnusedTask' && error.task) {
            const flowDoc = await this.documentCache.getDocument(document.uri);
            if (flowDoc) {
                // Try to find the task in the document
                // Note: error.task is the fully qualified name (e.g., "my_package.Other")
                // but tasks are keyed by local name, so we need to search by fullName
                let foundTask: any = null;
                for (const [, task] of flowDoc.tasks) {
                    if (task.fullName === error.task) {
                        foundTask = task;
                        break;
                    }
                }
                
                if (foundTask) {
                    line = foundTask.location.line - 1;
                    col = foundTask.location.column - 1;
                    
                    // Different messages based on scope
                    if (foundTask.scope === 'local') {
                        message = `Task '${error.task}' is defined but never referenced within this file.`;
                    } else {
                        message = `Task '${error.task}' is defined but never referenced. Consider marking it as 'export' or 'root' if it should be callable from outside.`;
                    }
                } else {
                    // Task not found in this document - it's defined in another file (parent or fragment)
                    // Don't show this warning in the current document
                    return null;
                }
            }
        }

        // Ensure line is within document bounds
        line = Math.max(0, Math.min(line, document.lineCount - 1));
        
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(line, col, line, col + 50),
            message,
            defaultSeverity
        );
        diagnostic.source = 'dfm';
        
        return diagnostic;
    }

    /**
     * Find text in document and return its range
     */
    private findTextInDocument(document: vscode.TextDocument, text: string): vscode.Range | null {
        const docText = document.getText();
        
        // Look for the text, possibly quoted
        const patterns = [
            text,
            `"${text}"`,
            `'${text}'`
        ];
        
        for (const pattern of patterns) {
            let index = docText.indexOf(pattern);
            while (index !== -1) {
                const pos = document.positionAt(index);
                const line = document.lineAt(pos.line).text;
                
                // Check if this is in a needs context (not a task definition)
                // First, check if we're NOT in a section that uses file paths (like fragments)
                if (!this.isInFilePathSection(document, pos.line)) {
                    if (line.includes('needs') || (line.trim().startsWith('-') && !line.includes('name:'))) {
                        // Adjust for quotes if needed
                        const startCol = pattern.startsWith('"') || pattern.startsWith("'") 
                            ? pos.character + 1 
                            : pos.character;
                        const endCol = startCol + text.length;
                        return new vscode.Range(pos.line, startCol, pos.line, endCol);
                    }
                }
                
                // Look for next occurrence
                index = docText.indexOf(pattern, index + 1);
            }
        }
        
        return null;
    }

    /**
     * Check if a line is within a section that uses file paths (not task references)
     */
    private isInFilePathSection(document: vscode.TextDocument, lineNumber: number): boolean {
        // Sections that contain file paths, not task references
        const filePathSections = ['fragments:', 'include:', 'exclude:'];
        
        // Look backwards to find the section header
        for (let i = lineNumber; i >= 0; i--) {
            const line = document.lineAt(i).text;
            const trimmed = line.trim();
            
            // Check if we hit a file-path section header
            for (const section of filePathSections) {
                if (trimmed === section || trimmed.startsWith(section + ' ')) {
                    return true;
                }
            }
            
            // Check if we hit a different section header (tasks:, imports:, etc.)
            // This means we're not in a fragments section
            if (trimmed === 'tasks:' || trimmed === 'imports:' || 
                trimmed === 'params:' || trimmed === 'parameters:' ||
                trimmed === 'types:' || trimmed === 'needs:') {
                return false;
            }
            
            // If we hit a top-level key (no indent), we've left any nested section
            if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t' && trimmed.endsWith(':')) {
                // Top-level key - check if it's a file-path section
                for (const section of filePathSections) {
                    if (trimmed === section) {
                        return true;
                    }
                }
                return false;
            }
        }
        
        return false;
    }

    /**
     * Clear all diagnostics
     */
    clear(): void {
        this.diagnosticCollection.clear();
    }

    dispose(): void {
        this.diagnosticCollection.dispose();
        this.taskDiscovery.dispose();
        for (const timeout of this.pendingValidations.values()) {
            clearTimeout(timeout);
        }
    }
}
