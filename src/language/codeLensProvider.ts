/**
 * CodeLens Provider for Flow Documents
 * 
 * Provides inline commands for task declarations
 */

import * as vscode from 'vscode';
import { FlowDocumentCache } from './flowDocumentModel';
import { WorkspaceManager } from '../workspace';

export class FlowCodeLensProvider implements vscode.CodeLensProvider {
    constructor(
        private documentCache: FlowDocumentCache,
        private workspaceManager: WorkspaceManager
    ) {}

    async provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];

        try {
            const flowDoc = await this.documentCache.getDocument(document.uri);
            
            if (!flowDoc) {
                return codeLenses;
            }
            
            // Add CodeLens for each task declaration
            for (const [taskName, task] of flowDoc.tasks) {
                const range = new vscode.Range(
                    task.location.line - 1,
                    task.location.column,
                    task.location.endLine !== undefined ? task.location.endLine - 1 : task.location.line - 1,
                    task.location.endColumn !== undefined ? task.location.endColumn : task.location.column + taskName.length
                );

                // Create CodeLens for opening graph view
                const graphLens = new vscode.CodeLens(range, {
                    title: '$(type-hierarchy) Open Graph',
                    tooltip: 'Open task dependency graph',
                    command: 'vscode-dv-flow.openFlowGraphFromEditor',
                    arguments: [taskName, document.uri]
                });

                codeLenses.push(graphLens);
            }
        } catch (error) {
            // Silently ignore errors - document may not be a valid flow file
            console.log('CodeLens provider error:', error);
        }

        return codeLenses;
    }
}
