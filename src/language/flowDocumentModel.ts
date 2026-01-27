/**
 * Flow Document Model
 * 
 * Parses and caches flow document structure for language features.
 * This provides the foundation for hover, go-to-definition, references, etc.
 */

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Represents a location in a flow document
 */
export interface FlowLocation {
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
}

/**
 * Represents a task definition in a flow document
 */
export interface FlowTaskDef {
    name: string;
    fullName: string;  // Package-qualified name
    uses?: string;
    description?: string;
    needs?: string[];
    location: FlowLocation;
    params?: Map<string, FlowParamDef>;
    withBlock?: FlowLocation;  // Location of the 'with' block
}

/**
 * Represents a parameter definition
 */
export interface FlowParamDef {
    name: string;
    type?: string;
    default?: any;
    description?: string;
    location: FlowLocation;
}

/**
 * Represents an import in a flow document
 */
export interface FlowImportDef {
    name: string;
    path?: string;
    isPlugin: boolean;
    location: FlowLocation;
}

/**
 * Represents a type definition
 */
export interface FlowTypeDef {
    name: string;
    fullName: string;
    description?: string;
    location: FlowLocation;
}

/**
 * Represents a reference to a task, type, or parameter
 */
export interface FlowReference {
    name: string;
    kind: 'task' | 'type' | 'param' | 'import' | 'expression';
    location: FlowLocation;
    targetLocation?: FlowLocation;  // Resolved target location
}

/**
 * Represents a fragment file reference
 */
export interface FlowFragmentRef {
    path: string;
    location: FlowLocation;
}

/**
 * Parsed flow document structure
 */
export interface FlowDocument {
    uri: vscode.Uri;
    packageName?: string;
    tasks: Map<string, FlowTaskDef>;
    types: Map<string, FlowTypeDef>;
    imports: Map<string, FlowImportDef>;
    params: Map<string, FlowParamDef>;
    fragments: FlowFragmentRef[];
    references: FlowReference[];
    parseErrors: vscode.Diagnostic[];
    lastModified: number;
}

/**
 * Simple YAML-like parser for extracting flow document structure.
 * This doesn't do full YAML parsing, just extracts what we need for language features.
 */
export class FlowDocumentParser {
    
    /**
     * Parse a flow document from text content
     */
    parse(uri: vscode.Uri, content: string): FlowDocument {
        const doc: FlowDocument = {
            uri,
            tasks: new Map(),
            types: new Map(),
            imports: new Map(),
            params: new Map(),
            fragments: [],
            references: [],
            parseErrors: [],
            lastModified: Date.now()
        };

        const lines = content.split('\n');
        let currentSection: string | null = null;
        let currentTask: FlowTaskDef | null = null;
        let currentIndent = 0;
        let inTaskList = false;
        let inImportList = false;
        let inParamList = false;
        let inTypeList = false;
        let inFragmentList = false;
        let inPackageBlock = false;
        let packageBlockIndent = 0;

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            const trimmed = line.trim();
            
            if (trimmed === '' || trimmed.startsWith('#')) {
                continue;
            }

            const indent = line.length - line.trimStart().length;

            // Top-level keys
            if (indent === 0) {
                // Check for package block start (package: with no value means nested structure)
                if (trimmed === 'package:') {
                    inPackageBlock = true;
                    currentSection = null;
                    continue;
                }
                
                // Check for package name (inline format: package: name)
                const packageMatch = trimmed.match(/^package:\s*(.+)$/);
                if (packageMatch) {
                    doc.packageName = packageMatch[1].trim();
                    continue;
                }

                // Check for section markers at top level
                if (trimmed === 'tasks:') {
                    currentSection = 'tasks';
                    inTaskList = true;
                    currentTask = null;
                    continue;
                }
                if (trimmed === 'imports:') {
                    currentSection = 'imports';
                    inImportList = true;
                    continue;
                }
                if (trimmed === 'params:' || trimmed === 'parameters:') {
                    currentSection = 'params';
                    inParamList = true;
                    continue;
                }
                if (trimmed === 'types:') {
                    currentSection = 'types';
                    inTypeList = true;
                    continue;
                }
                if (trimmed === 'fragments:') {
                    currentSection = 'fragments';
                    inFragmentList = true;
                    continue;
                }
                
                // Reset package block if we hit another top-level key
                inPackageBlock = false;
            }
            
            // Handle nested structure under package: block
            if (inPackageBlock && indent > 0) {
                // Check for name: under package:
                const nameMatch = trimmed.match(/^name:\s*(.+)$/);
                if (nameMatch) {
                    doc.packageName = nameMatch[1].trim().replace(/^["']|["']$/g, '');
                    continue;
                }
                
                // Check for section markers under package:
                if (trimmed === 'tasks:') {
                    currentSection = 'tasks';
                    inTaskList = true;
                    currentTask = null;
                    continue;
                }
                if (trimmed === 'imports:') {
                    currentSection = 'imports';
                    inImportList = true;
                    continue;
                }
                if (trimmed === 'params:' || trimmed === 'parameters:') {
                    currentSection = 'params';
                    inParamList = true;
                    continue;
                }
                if (trimmed === 'types:') {
                    currentSection = 'types';
                    inTypeList = true;
                    continue;
                }
                if (trimmed === 'fragments:') {
                    currentSection = 'fragments';
                    inFragmentList = true;
                    continue;
                }
            }

            // Parse based on current section
            if (currentSection === 'tasks') {
                this.parseTaskLine(doc, line, lineNum, uri.fsPath, currentTask, (task) => {
                    currentTask = task;
                });
            } else if (currentSection === 'imports') {
                this.parseImportLine(doc, line, lineNum, uri.fsPath);
            } else if (currentSection === 'params') {
                this.parseParamLine(doc, line, lineNum, uri.fsPath);
            } else if (currentSection === 'types') {
                this.parseTypeLine(doc, line, lineNum, uri.fsPath);
            } else if (currentSection === 'fragments') {
                this.parseFragmentLine(doc, line, lineNum, uri.fsPath);
            }

            // Find references in expressions
            this.findExpressionReferences(doc, line, lineNum, uri.fsPath);
        }

        return doc;
    }

    private parseTaskLine(
        doc: FlowDocument, 
        line: string, 
        lineNum: number, 
        file: string,
        currentTask: FlowTaskDef | null,
        setCurrentTask: (task: FlowTaskDef | null) => void
    ): void {
        const trimmed = line.trim();
        const indent = line.length - line.trimStart().length;

        // Task list item: "- name: task_name"
        const taskNameMatch = trimmed.match(/^-\s*name:\s*(.+)$/);
        if (taskNameMatch) {
            const taskName = taskNameMatch[1].trim().replace(/^["']|["']$/g, '');
            const task: FlowTaskDef = {
                name: taskName,
                fullName: doc.packageName ? `${doc.packageName}.${taskName}` : taskName,
                location: {
                    file,
                    line: lineNum + 1,
                    column: line.indexOf('name:') + 1
                },
                params: new Map()
            };
            doc.tasks.set(taskName, task);
            setCurrentTask(task);
            return;
        }

        // Task property within current task
        if (currentTask && indent > 0) {
            // uses: base_task
            const usesMatch = trimmed.match(/^uses:\s*(.+)$/);
            if (usesMatch) {
                currentTask.uses = usesMatch[1].trim().replace(/^["']|["']$/g, '');
                // Add reference to the used task
                doc.references.push({
                    name: currentTask.uses,
                    kind: 'task',
                    location: {
                        file,
                        line: lineNum + 1,
                        column: line.indexOf('uses:') + 6
                    }
                });
                return;
            }

            // desc: description or doc: description
            const descMatch = trimmed.match(/^(?:desc|doc):\s*(.+)$/);
            if (descMatch) {
                currentTask.description = descMatch[1].trim().replace(/^["']|["']$/g, '');
                return;
            }

            // needs: [dep1, dep2]
            const needsMatch = trimmed.match(/^needs:\s*\[([^\]]*)\]$/);
            if (needsMatch) {
                const needsContent = needsMatch[1];
                const needs = needsContent.split(',').map(n => n.trim().replace(/^["']|["']$/g, '')).filter(n => n);
                currentTask.needs = needs;
                // Add references to needed tasks with accurate column positions
                for (const need of needs) {
                    // Find the position of this need in the original line
                    // Account for quoted or unquoted names
                    let col = line.indexOf(need);
                    if (col === -1) {
                        // Try finding with quotes
                        col = line.indexOf(`"${need}"`);
                        if (col !== -1) { col += 1; } // Skip the quote
                    }
                    if (col === -1) {
                        col = line.indexOf(`'${need}'`);
                        if (col !== -1) { col += 1; } // Skip the quote
                    }
                    if (col === -1) {
                        // Fallback to finding after 'needs:'
                        col = line.indexOf('needs:') + 7;
                    }
                    doc.references.push({
                        name: need,
                        kind: 'task',
                        location: {
                            file,
                            line: lineNum + 1,
                            column: col + 1
                        }
                    });
                }
                return;
            }

            // needs: (multiline start)
            if (trimmed === 'needs:') {
                currentTask.needs = [];
                return;
            }

            // Multiline needs item: "- task_name"
            if (currentTask.needs !== undefined && trimmed.startsWith('- ')) {
                const needName = trimmed.substring(2).trim().replace(/^["']|["']$/g, '');
                currentTask.needs.push(needName);
                // Find accurate column position
                let col = line.indexOf(needName);
                if (col === -1) {
                    col = line.indexOf(`"${needName}"`);
                    if (col !== -1) { col += 1; }
                }
                if (col === -1) {
                    col = line.indexOf(`'${needName}'`);
                    if (col !== -1) { col += 1; }
                }
                if (col === -1) {
                    // Fallback to after the dash
                    col = line.indexOf('- ') + 2;
                }
                doc.references.push({
                    name: needName,
                    kind: 'task',
                    location: {
                        file,
                        line: lineNum + 1,
                        column: col + 1
                    }
                });
                return;
            }

            // with: block start
            if (trimmed === 'with:') {
                currentTask.withBlock = {
                    file,
                    line: lineNum + 1,
                    column: line.indexOf('with:') + 1
                };
                return;
            }
        }
    }

    private parseImportLine(
        doc: FlowDocument, 
        line: string, 
        lineNum: number, 
        file: string
    ): void {
        const trimmed = line.trim();

        // Import item: "- pkg_name" or "- pkg_name: path"
        const importMatch = trimmed.match(/^-\s*([^:]+)(?::\s*(.+))?$/);
        if (importMatch) {
            const importName = importMatch[1].trim();
            const importPath = importMatch[2]?.trim().replace(/^["']|["']$/g, '');
            
            const importDef: FlowImportDef = {
                name: importName,
                path: importPath,
                isPlugin: !importPath || !importPath.includes('/'),
                location: {
                    file,
                    line: lineNum + 1,
                    column: line.indexOf(importName) + 1
                }
            };
            doc.imports.set(importName, importDef);
        }
    }

    private parseParamLine(
        doc: FlowDocument, 
        line: string, 
        lineNum: number, 
        file: string
    ): void {
        const trimmed = line.trim();

        // Param: "- name: param_name" or "param_name: value"
        const paramMatch = trimmed.match(/^-?\s*name:\s*(.+)$/) || 
                          trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)?$/);
        if (paramMatch) {
            const paramName = paramMatch[1].trim().replace(/^["']|["']$/g, '');
            const paramDef: FlowParamDef = {
                name: paramName,
                location: {
                    file,
                    line: lineNum + 1,
                    column: line.indexOf(paramName) + 1
                }
            };
            doc.params.set(paramName, paramDef);
        }
    }

    private parseTypeLine(
        doc: FlowDocument, 
        line: string, 
        lineNum: number, 
        file: string
    ): void {
        const trimmed = line.trim();

        // Type: "- name: type_name"
        const typeMatch = trimmed.match(/^-\s*name:\s*(.+)$/);
        if (typeMatch) {
            const typeName = typeMatch[1].trim().replace(/^["']|["']$/g, '');
            const typeDef: FlowTypeDef = {
                name: typeName,
                fullName: doc.packageName ? `${doc.packageName}.${typeName}` : typeName,
                location: {
                    file,
                    line: lineNum + 1,
                    column: line.indexOf(typeName) + 1
                }
            };
            doc.types.set(typeName, typeDef);
        }
    }

    private parseFragmentLine(
        doc: FlowDocument, 
        line: string, 
        lineNum: number, 
        file: string
    ): void {
        const trimmed = line.trim();

        // Fragment item: "- path/to/fragment.yaml" or "- ./relative/path.dv"
        const fragmentMatch = trimmed.match(/^-\s*(.+)$/);
        if (fragmentMatch) {
            const fragmentPath = fragmentMatch[1].trim().replace(/^["']|["']$/g, '');
            const fragmentRef: FlowFragmentRef = {
                path: fragmentPath,
                location: {
                    file,
                    line: lineNum + 1,
                    column: line.indexOf(fragmentPath) + 1
                }
            };
            doc.fragments.push(fragmentRef);
        }
    }

    private findExpressionReferences(
        doc: FlowDocument, 
        line: string, 
        lineNum: number, 
        file: string
    ): void {
        // Find ${{ expression }} patterns
        const exprRegex = /\$\{\{\s*([^}]+)\s*\}\}/g;
        let match;
        while ((match = exprRegex.exec(line)) !== null) {
            const expr = match[1].trim();
            // Extract variable references from expression
            const varRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\b/g;
            let varMatch;
            while ((varMatch = varRegex.exec(expr)) !== null) {
                const varName = varMatch[1];
                // Skip common keywords/functions
                if (['true', 'false', 'null', 'and', 'or', 'not', 'in', 'if', 'else'].includes(varName)) {
                    continue;
                }
                doc.references.push({
                    name: varName,
                    kind: 'expression',
                    location: {
                        file,
                        line: lineNum + 1,
                        column: match.index + match[0].indexOf(varName) + 1
                    }
                });
            }
        }
    }
}

/**
 * Cache for parsed flow documents
 */
export class FlowDocumentCache {
    private cache: Map<string, FlowDocument> = new Map();
    private parser = new FlowDocumentParser();

    /**
     * Get or parse a flow document
     */
    async getDocument(uri: vscode.Uri): Promise<FlowDocument | undefined> {
        const key = uri.toString();
        const cached = this.cache.get(key);
        
        // Check if cached version is still valid
        if (cached) {
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.mtime <= cached.lastModified) {
                    return cached;
                }
            } catch {
                // File might have been deleted
                this.cache.delete(key);
                return undefined;
            }
        }

        // Parse the document
        try {
            const content = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(content).toString('utf-8');
            const doc = this.parser.parse(uri, text);
            this.cache.set(key, doc);
            return doc;
        } catch (error) {
            console.error(`Error parsing flow document ${uri.fsPath}:`, error);
            return undefined;
        }
    }

    /**
     * Parse a document from text (for unsaved documents)
     */
    parseFromText(uri: vscode.Uri, text: string): FlowDocument {
        const doc = this.parser.parse(uri, text);
        this.cache.set(uri.toString(), doc);
        return doc;
    }

    /**
     * Invalidate a cached document
     */
    invalidate(uri: vscode.Uri): void {
        this.cache.delete(uri.toString());
    }

    /**
     * Clear all cached documents
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * Find a task definition by name across all cached documents
     */
    findTask(name: string): { doc: FlowDocument; task: FlowTaskDef } | undefined {
        for (const doc of this.cache.values()) {
            const task = doc.tasks.get(name);
            if (task) {
                return { doc, task };
            }
            // Also check full names
            for (const [, t] of doc.tasks) {
                if (t.fullName === name) {
                    return { doc, task: t };
                }
            }
        }
        return undefined;
    }

    /**
     * Find all references to a name across all cached documents
     */
    findReferences(name: string): { doc: FlowDocument; ref: FlowReference }[] {
        const results: { doc: FlowDocument; ref: FlowReference }[] = [];
        for (const doc of this.cache.values()) {
            for (const ref of doc.references) {
                if (ref.name === name || ref.name.endsWith('.' + name)) {
                    results.push({ doc, ref });
                }
            }
        }
        return results;
    }
}
