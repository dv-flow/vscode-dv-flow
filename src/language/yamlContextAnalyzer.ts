/**
 * YAML-based Context Analyzer
 * 
 * Provides precise context detection by parsing the document structure using YAML.
 * Falls back to text-based detection if YAML parsing fails (for malformed documents).
 */

import * as vscode from 'vscode';
import * as yaml from 'yaml';

export interface YamlContext {
    kind: 'task-name' | 'task-uses' | 'task-needs' | 'task-parameter' | 'task-parameter-value' |
          'package-name' | 'package-parameter' | 'package-parameter-value' |
          'import' | 'import-path' | 'fragment' | 'type-name' | 
          'expression' | 'unknown';
    path: string[];  // Path through the YAML structure, e.g., ['package', 'tasks', 0, 'name']
    node?: yaml.Node;  // The YAML node at this position
    parentNode?: yaml.Node;  // Parent YAML node
    key?: string;  // The key name if within a mapping
    inArray?: boolean;  // True if position is within an array element
    arrayIndex?: number;  // Index in array if inArray is true
}

/**
 * Analyzes YAML document structure to determine precise context at a given position
 */
export class YamlContextAnalyzer {
    
    /**
     * Determine context at a specific position using YAML parsing
     * Returns null if parsing fails (document is malformed)
     */
    analyzeContext(document: vscode.TextDocument, position: vscode.Position): YamlContext | null {
        try {
            const text = document.getText();
            const offset = document.offsetAt(position);
            
            // Parse YAML with source tracking
            const yamlDoc = yaml.parseDocument(text, { 
                keepSourceTokens: true,
                strict: false  // More forgiving for incomplete documents
            });
            
            if (!yamlDoc || !yamlDoc.contents) {
                return null;
            }
            
            // Find the node at this position
            const result = this.findNodeAtOffset(yamlDoc.contents, offset, []);
            
            if (!result) {
                return null;
            }
            
            // Determine context based on path and node type
            return this.interpretContext(result.node, result.path, result.parent, result.key);
            
        } catch (error) {
            // YAML parsing failed - document is likely malformed
            console.debug('[YamlContextAnalyzer] YAML parsing failed:', error);
            return null;
        }
    }
    
    /**
     * Find the YAML node at a specific offset in the document
     */
    private findNodeAtOffset(
        node: yaml.Node, 
        offset: number, 
        path: string[]
    ): { node: yaml.Node; path: string[]; parent?: yaml.Node; key?: string } | null {
        
        if (!node || !node.range) {
            return null;
        }
        
        const [start, end] = node.range;
        
        // Check if offset is within this node's range
        if (offset < start || offset > end) {
            return null;
        }
        
        // Handle different node types
        if (yaml.isMap(node)) {
            for (const item of node.items) {
                const key = yaml.isScalar(item.key) ? String(item.key.value) : null;
                
                // Check if cursor is on the key
                if (item.key && (item.key as any).range) {
                    const [keyStart, keyEnd] = (item.key as any).range;
                    if (offset >= keyStart && offset <= keyEnd) {
                        return { 
                            node: item.key as yaml.Node, 
                            path: [...path, key || '?'],
                            parent: node,
                            key: key || undefined
                        };
                    }
                }
                
                // Check if cursor is on the value
                if (item.value && (item.value as any).range) {
                    const [valStart, valEnd] = (item.value as any).range;
                    if (offset >= valStart && offset <= valEnd) {
                        // Recursively search in the value
                        const result = this.findNodeAtOffset(
                            item.value as yaml.Node, 
                            offset, 
                            [...path, key || '?']
                        );
                        if (result) {
                            result.parent = node;
                            result.key = key || undefined;
                            return result;
                        }
                        return { 
                            node: item.value as yaml.Node, 
                            path: [...path, key || '?'],
                            parent: node,
                            key: key || undefined
                        };
                    }
                }
            }
        } else if (yaml.isSeq(node)) {
            for (let i = 0; i < node.items.length; i++) {
                const item = node.items[i];
                if (item && (item as any).range) {
                    const [itemStart, itemEnd] = (item as any).range;
                    if (offset >= itemStart && offset <= itemEnd) {
                        // Recursively search in the item
                        const result = this.findNodeAtOffset(
                            item as yaml.Node, 
                            offset, 
                            [...path, String(i)]
                        );
                        if (result) {
                            result.parent = node;
                            return result;
                        }
                        return { 
                            node: item as yaml.Node, 
                            path: [...path, String(i)],
                            parent: node
                        };
                    }
                }
            }
        }
        
        // Fallback: return this node
        return { node, path, parent: undefined };
    }
    
    /**
     * Interpret the YAML path to determine semantic context
     */
    private interpretContext(
        node: yaml.Node, 
        path: string[], 
        parent?: yaml.Node,
        key?: string
    ): YamlContext {
        
        // Helper to check if we're in a specific structure
        const isInPath = (pattern: string[]): boolean => {
            if (pattern.length > path.length) {
                return false;
            }
            for (let i = 0; i < pattern.length; i++) {
                if (pattern[i] !== '*' && pattern[i] !== path[i]) {
                    return false;
                }
            }
            return true;
        };
        
        // Helper to get path segments
        const pathMatches = (pattern: RegExp[]): boolean => {
            if (pattern.length !== path.length) {
                return false;
            }
            for (let i = 0; i < pattern.length; i++) {
                if (!pattern[i].test(path[i])) {
                    return false;
                }
            }
            return true;
        };
        
        // Determine context based on path
        
        // Package name: package -> name
        if (pathMatches([/^package$/, /^name$/])) {
            return { kind: 'package-name', path, node, parentNode: parent, key };
        }
        
        // Package parameters: package -> with -> <param>
        if (path.length >= 3 && path[0] === 'package' && path[1] === 'with') {
            const paramName = path[2];
            if (path.length === 3 && key === paramName) {
                // On the parameter key itself
                return { kind: 'package-parameter', path, node, parentNode: parent, key };
            } else if (path.length >= 3) {
                // On the parameter value
                return { kind: 'package-parameter-value', path, node, parentNode: parent, key: paramName };
            }
        }
        
        // Task definitions: package -> tasks -> [index] -> ...
        if (path.length >= 3 && path[0] === 'package' && path[1] === 'tasks' && /^\d+$/.test(path[2])) {
            const taskIndex = path[2];
            
            // Task name fields: name, root, export, local, override
            if (path.length === 4 && ['name', 'root', 'export', 'local', 'override'].includes(path[3])) {
                return { 
                    kind: 'task-name', 
                    path, 
                    node, 
                    parentNode: parent, 
                    key,
                    inArray: true,
                    arrayIndex: parseInt(taskIndex)
                };
            }
            
            // Task uses: package -> tasks -> [index] -> uses
            if (path.length === 4 && path[3] === 'uses') {
                return { 
                    kind: 'task-uses', 
                    path, 
                    node, 
                    parentNode: parent, 
                    key,
                    inArray: true,
                    arrayIndex: parseInt(taskIndex)
                };
            }
            
            // Task needs: package -> tasks -> [index] -> needs -> [needIndex]
            if (path.length >= 4 && path[3] === 'needs') {
                if (path.length === 5 && /^\d+$/.test(path[4])) {
                    // In needs array element
                    return { 
                        kind: 'task-needs', 
                        path, 
                        node, 
                        parentNode: parent, 
                        key,
                        inArray: true,
                        arrayIndex: parseInt(path[4])
                    };
                }
            }
            
            // Task parameters: package -> tasks -> [index] -> with -> <param>
            if (path.length >= 5 && path[3] === 'with') {
                const paramName = path[4];
                if (path.length === 5 && key === paramName) {
                    // On the parameter key
                    return { 
                        kind: 'task-parameter', 
                        path, 
                        node, 
                        parentNode: parent, 
                        key,
                        inArray: true,
                        arrayIndex: parseInt(taskIndex)
                    };
                } else if (path.length >= 5) {
                    // On the parameter value
                    return { 
                        kind: 'task-parameter-value', 
                        path, 
                        node, 
                        parentNode: parent, 
                        key: paramName,
                        inArray: true,
                        arrayIndex: parseInt(taskIndex)
                    };
                }
            }
        }
        
        // Imports: package -> imports -> [index]
        if (path.length >= 3 && path[0] === 'package' && path[1] === 'imports' && /^\d+$/.test(path[2])) {
            // Could be string or object with 'from' key
            if (yaml.isScalar(node)) {
                return { 
                    kind: 'import', 
                    path, 
                    node, 
                    parentNode: parent, 
                    key,
                    inArray: true,
                    arrayIndex: parseInt(path[2])
                };
            } else if (path.length === 4 && path[3] === 'from') {
                return { 
                    kind: 'import-path', 
                    path, 
                    node, 
                    parentNode: parent, 
                    key,
                    inArray: true,
                    arrayIndex: parseInt(path[2])
                };
            }
        }
        
        // Fragments: package -> fragments -> [index]
        if (path.length >= 3 && path[0] === 'package' && path[1] === 'fragments' && /^\d+$/.test(path[2])) {
            return { 
                kind: 'fragment', 
                path, 
                node, 
                parentNode: parent, 
                key,
                inArray: true,
                arrayIndex: parseInt(path[2])
            };
        }
        
        // Types: package -> types -> [index] -> name
        if (path.length >= 3 && path[0] === 'package' && path[1] === 'types' && /^\d+$/.test(path[2])) {
            if (path.length === 4 && path[3] === 'name') {
                return { 
                    kind: 'type-name', 
                    path, 
                    node, 
                    parentNode: parent, 
                    key,
                    inArray: true,
                    arrayIndex: parseInt(path[2])
                };
            }
        }
        
        // Check for expressions (values containing ${{}})
        if (yaml.isScalar(node) && typeof node.value === 'string') {
            if (node.value.includes('${{')) {
                return { kind: 'expression', path, node, parentNode: parent, key };
            }
        }
        
        // Fragment structure (similar to package but with 'fragment' root)
        if (path.length >= 1 && path[0] === 'fragment') {
            // Re-interpret with package logic but using 'fragment' as root
            const fragmentPath = ['package', ...path.slice(1)];
            const fragmentContext = this.interpretContext(node, fragmentPath, parent, key);
            // Adjust the path back
            return { ...fragmentContext, path };
        }
        
        // Default: unknown context
        return { kind: 'unknown', path, node, parentNode: parent, key };
    }
    
    /**
     * Get a human-readable description of the context
     */
    describeContext(context: YamlContext): string {
        const pathStr = context.path.join(' → ');
        
        switch (context.kind) {
            case 'task-name':
                return `Task name definition (${pathStr})`;
            case 'task-uses':
                return `Task type reference (${pathStr})`;
            case 'task-needs':
                return `Task dependency reference (${pathStr})`;
            case 'task-parameter':
                return `Task parameter name (${pathStr})`;
            case 'task-parameter-value':
                return `Task parameter value (${pathStr})`;
            case 'package-name':
                return `Package name (${pathStr})`;
            case 'package-parameter':
                return `Package parameter name (${pathStr})`;
            case 'package-parameter-value':
                return `Package parameter value (${pathStr})`;
            case 'import':
                return `Package import (${pathStr})`;
            case 'import-path':
                return `Import path (${pathStr})`;
            case 'fragment':
                return `Fragment reference (${pathStr})`;
            case 'type-name':
                return `Type name (${pathStr})`;
            case 'expression':
                return `Expression (${pathStr})`;
            default:
                return `Unknown (${pathStr})`;
        }
    }
}
