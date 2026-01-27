/**
 * Flow Rename Provider
 * 
 * Provides rename refactoring for tasks and parameters in flow documents.
 */

import * as vscode from 'vscode';
import { FlowDocumentCache, FlowDocument, FlowLocation } from './flowDocumentModel';
import { WorkspaceManager } from '../workspace';

export class FlowRenameProvider implements vscode.RenameProvider {
    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {}

    async prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Range | { range: vscode.Range; placeholder: string } | null> {
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        const flowDoc = await this.documentCache.parseFromText(document.uri, document.getText());
        const line = document.lineAt(position.line).text;

        // Check if this is a renameable symbol
        const canRename = this.canRename(word, line, flowDoc);
        if (!canRename) {
            throw new Error('This symbol cannot be renamed. Only task names and parameters can be renamed.');
        }

        return {
            range: wordRange,
            placeholder: word
        };
    }

    async provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        token: vscode.CancellationToken
    ): Promise<vscode.WorkspaceEdit | null> {
        // Validate new name
        if (!this.isValidIdentifier(newName)) {
            throw new Error(`'${newName}' is not a valid identifier. Use letters, numbers, and underscores, starting with a letter or underscore.`);
        }

        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        if (!wordRange) {
            return null;
        }

        const oldName = document.getText(wordRange);
        const flowDoc = await this.documentCache.parseFromText(document.uri, document.getText());

        const workspaceEdit = new vscode.WorkspaceEdit();

        // Determine what kind of symbol we're renaming
        const line = document.lineAt(position.line).text;
        const symbolType = this.determineSymbolType(oldName, line, flowDoc);

        switch (symbolType) {
            case 'task':
                await this.renameTask(document, flowDoc, oldName, newName, workspaceEdit);
                break;
            case 'parameter':
                await this.renameParameter(document, flowDoc, oldName, newName, workspaceEdit);
                break;
            default:
                return null;
        }

        return workspaceEdit;
    }

    private canRename(word: string, line: string, flowDoc: FlowDocument): boolean {
        // Check if it's a task name
        if (flowDoc.tasks.has(word)) {
            return true;
        }

        // Check if it's a parameter name
        if (flowDoc.params.has(word)) {
            return true;
        }

        // Check if it's a task name definition
        if (line.match(/^\s*-\s*name:\s*["']?/) && line.includes(word)) {
            return true;
        }

        // Check if it's in a needs list (reference to a local task)
        if ((line.includes('needs:') || line.match(/^\s*-\s*["']?[a-zA-Z]/)) && flowDoc.tasks.has(word)) {
            return true;
        }

        return false;
    }

    private determineSymbolType(word: string, line: string, flowDoc: FlowDocument): 'task' | 'parameter' | null {
        if (flowDoc.tasks.has(word)) {
            return 'task';
        }

        if (flowDoc.params.has(word)) {
            return 'parameter';
        }

        // Check if it's being defined as a task
        if (line.match(/^\s*-\s*name:\s*/)) {
            return 'task';
        }

        return null;
    }

    private isValidIdentifier(name: string): boolean {
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
    }

    private async renameTask(
        document: vscode.TextDocument,
        flowDoc: FlowDocument,
        oldName: string,
        newName: string,
        workspaceEdit: vscode.WorkspaceEdit
    ): Promise<void> {
        const text = document.getText();
        const lines = text.split('\n');

        // Find and replace the task definition
        const task = flowDoc.tasks.get(oldName);
        if (task) {
            const defLine = task.location.line - 1;
            const lineText = lines[defLine];
            
            // Replace in the name: line
            const nameMatch = lineText.match(/^(\s*-\s*name:\s*["']?)([^"'\s]+)(["']?\s*)$/);
            if (nameMatch && nameMatch[2] === oldName) {
                const startCol = nameMatch[1].length;
                const endCol = startCol + oldName.length;
                workspaceEdit.replace(
                    document.uri,
                    new vscode.Range(defLine, startCol, defLine, endCol),
                    newName
                );
            }
        }

        // Find and replace all references in needs
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Check for needs: [task1, task2] format
            const needsArrayMatch = line.match(/^(\s*needs:\s*\[)(.*)(\]\s*)$/);
            if (needsArrayMatch) {
                const prefix = needsArrayMatch[1];
                const tasks = needsArrayMatch[2];
                const suffix = needsArrayMatch[3];
                
                // Replace task names in the array
                const newTasks = tasks.replace(
                    new RegExp(`\\b${this.escapeRegex(oldName)}\\b`, 'g'),
                    newName
                );
                
                if (newTasks !== tasks) {
                    workspaceEdit.replace(
                        document.uri,
                        new vscode.Range(i, prefix.length, i, prefix.length + tasks.length),
                        newTasks
                    );
                }
            }

            // Check for needs list items: - task_name
            const needsItemMatch = line.match(/^(\s*-\s*["']?)([a-zA-Z_][a-zA-Z0-9_]*)(["']?\s*)$/);
            if (needsItemMatch && needsItemMatch[2] === oldName) {
                const startCol = needsItemMatch[1].length;
                const endCol = startCol + oldName.length;
                workspaceEdit.replace(
                    document.uri,
                    new vscode.Range(i, startCol, i, endCol),
                    newName
                );
            }
        }

        // Find and replace in expressions
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const exprRegex = /\$\{\{([^}]+)\}\}/g;
            let match;
            
            while ((match = exprRegex.exec(line)) !== null) {
                const expr = match[1];
                const newExpr = expr.replace(
                    new RegExp(`\\b${this.escapeRegex(oldName)}\\b`, 'g'),
                    newName
                );
                
                if (newExpr !== expr) {
                    const startCol = match.index + 3; // After ${{
                    const endCol = startCol + expr.length;
                    workspaceEdit.replace(
                        document.uri,
                        new vscode.Range(i, startCol, i, endCol),
                        newExpr
                    );
                }
            }
        }

        // Also check other documents in the workspace for references
        await this.renameInOtherDocuments(oldName, newName, document.uri, workspaceEdit);
    }

    private async renameParameter(
        document: vscode.TextDocument,
        flowDoc: FlowDocument,
        oldName: string,
        newName: string,
        workspaceEdit: vscode.WorkspaceEdit
    ): Promise<void> {
        const text = document.getText();
        const lines = text.split('\n');

        // Find and replace the parameter definition
        const param = flowDoc.params.get(oldName);
        if (param) {
            const defLine = param.location.line - 1;
            const lineText = lines[defLine];
            
            // Replace the parameter name
            const paramMatch = lineText.match(/^(\s*(?:-\s*)?(?:name:\s*)?["']?)([a-zA-Z_][a-zA-Z0-9_]*)(["']?:?\s*)/);
            if (paramMatch && paramMatch[2] === oldName) {
                const startCol = paramMatch[1].length;
                const endCol = startCol + oldName.length;
                workspaceEdit.replace(
                    document.uri,
                    new vscode.Range(defLine, startCol, defLine, endCol),
                    newName
                );
            }
        }

        // Find and replace in expressions (params.oldName -> params.newName)
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const exprRegex = /\$\{\{([^}]+)\}\}/g;
            let match;
            
            while ((match = exprRegex.exec(line)) !== null) {
                const expr = match[1];
                // Replace params.oldName or param.oldName
                const newExpr = expr.replace(
                    new RegExp(`\\b(params?\\.)${this.escapeRegex(oldName)}\\b`, 'g'),
                    `$1${newName}`
                );
                
                if (newExpr !== expr) {
                    const startCol = match.index + 3; // After ${{
                    const endCol = startCol + expr.length;
                    workspaceEdit.replace(
                        document.uri,
                        new vscode.Range(i, startCol, i, endCol),
                        newExpr
                    );
                }
            }
        }
    }

    private async renameInOtherDocuments(
        oldName: string,
        newName: string,
        currentUri: vscode.Uri,
        workspaceEdit: vscode.WorkspaceEdit
    ): Promise<void> {
        // Find references in other cached documents
        const refs = this.documentCache.findReferences(oldName);
        
        for (const { doc, ref } of refs) {
            if (doc.uri.toString() === currentUri.toString()) {
                continue; // Skip current document
            }

            try {
                const otherDoc = await vscode.workspace.openTextDocument(doc.uri);
                const line = ref.location.line - 1;
                const lineText = otherDoc.lineAt(line).text;
                
                // Find the exact position of the reference
                const idx = lineText.indexOf(oldName, ref.location.column - 1);
                if (idx >= 0) {
                    workspaceEdit.replace(
                        doc.uri,
                        new vscode.Range(line, idx, line, idx + oldName.length),
                        newName
                    );
                }
            } catch (error) {
                console.error(`Error processing reference in ${doc.uri.fsPath}:`, error);
            }
        }
    }

    private escapeRegex(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
