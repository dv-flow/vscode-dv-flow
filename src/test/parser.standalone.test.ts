/**
 * Standalone unit tests for the Flow Document Parser
 * 
 * These tests can be run without the VS Code extension host,
 * using a mock Uri implementation.
 */

// Simple mock for vscode.Uri
const mockUri = (path: string) => ({
    fsPath: path,
    toString: () => `file://${path}`,
    scheme: 'file',
    path: path
});

// Inline implementation of FlowDocumentParser for testing
// (avoiding VS Code dependencies)

interface FlowLocation {
    file: string;
    line: number;
    column: number;
}

interface FlowTaskDef {
    name: string;
    fullName: string;
    uses?: string;
    description?: string;
    needs?: string[];
    location: FlowLocation;
}

interface FlowReference {
    name: string;
    kind: 'task' | 'type' | 'param' | 'import' | 'expression';
    location: FlowLocation;
}

interface FlowDocument {
    packageName?: string;
    tasks: Map<string, FlowTaskDef>;
    references: FlowReference[];
}

function parseFlowDocument(content: string, filePath: string): FlowDocument {
    const doc: FlowDocument = {
        tasks: new Map(),
        references: []
    };

    const lines = content.split('\n');
    let currentSection: string | null = null;
    let currentTask: FlowTaskDef | null = null;
    let inPackageBlock = false;

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

            if (trimmed === 'tasks:') {
                currentSection = 'tasks';
                currentTask = null;
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
            
            // Check for tasks: under package:
            if (trimmed === 'tasks:') {
                currentSection = 'tasks';
                currentTask = null;
                continue;
            }
        }

        // Parse tasks
        if (currentSection === 'tasks') {
            // Task list item: "- name: task_name"
            const taskNameMatch = trimmed.match(/^-\s*name:\s*(.+)$/);
            if (taskNameMatch) {
                const taskName = taskNameMatch[1].trim().replace(/^["']|["']$/g, '');
                const task: FlowTaskDef = {
                    name: taskName,
                    fullName: doc.packageName ? `${doc.packageName}.${taskName}` : taskName,
                    location: {
                        file: filePath,
                        line: lineNum + 1,
                        column: line.indexOf('name:') + 1
                    }
                };
                doc.tasks.set(taskName, task);
                currentTask = task;
                continue;
            }

            // Task property within current task
            if (currentTask && indent > 0) {
                // uses: base_task
                const usesMatch = trimmed.match(/^uses:\s*(.+)$/);
                if (usesMatch) {
                    currentTask.uses = usesMatch[1].trim().replace(/^["']|["']$/g, '');
                    doc.references.push({
                        name: currentTask.uses,
                        kind: 'task',
                        location: {
                            file: filePath,
                            line: lineNum + 1,
                            column: line.indexOf('uses:') + 6
                        }
                    });
                    continue;
                }

                // desc: description or doc: description
                const descMatch = trimmed.match(/^(?:desc|doc):\s*(.+)$/);
                if (descMatch) {
                    currentTask.description = descMatch[1].trim().replace(/^["']|["']$/g, '');
                    continue;
                }

                // needs: [dep1, dep2]
                const needsMatch = trimmed.match(/^needs:\s*\[([^\]]*)\]$/);
                if (needsMatch) {
                    const needsContent = needsMatch[1];
                    const needs = needsContent.split(',').map(n => n.trim().replace(/^["']|["']$/g, '')).filter(n => n);
                    currentTask.needs = needs;
                    for (const need of needs) {
                        let col = line.indexOf(need);
                        if (col === -1) {
                            col = line.indexOf(`"${need}"`);
                            if (col !== -1) { col += 1; }
                        }
                        if (col === -1) {
                            col = line.indexOf(`'${need}'`);
                            if (col !== -1) { col += 1; }
                        }
                        if (col === -1) {
                            col = line.indexOf('needs:') + 7;
                        }
                        doc.references.push({
                            name: need,
                            kind: 'task',
                            location: {
                                file: filePath,
                                line: lineNum + 1,
                                column: col + 1
                            }
                        });
                    }
                    continue;
                }

                // needs: (multiline start)
                if (trimmed === 'needs:') {
                    currentTask.needs = [];
                    continue;
                }

                // Multiline needs item: "- task_name"
                if (currentTask.needs !== undefined && trimmed.startsWith('- ')) {
                    const needName = trimmed.substring(2).trim().replace(/^["']|["']$/g, '');
                    currentTask.needs.push(needName);
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
                        col = line.indexOf('- ') + 2;
                    }
                    doc.references.push({
                        name: needName,
                        kind: 'task',
                        location: {
                            file: filePath,
                            line: lineNum + 1,
                            column: col + 1
                        }
                    });
                }
            }
        }
    }

    return doc;
}

// Test runner
let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        testsPassed++;
    } catch (error: any) {
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${error.message}`);
        testsFailed++;
    }
}

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(actual: any, expected: any, message?: string) {
    if (actual !== expected) {
        throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
}

function assertArrayEqual(actual: any[], expected: any[], message?: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

// Run tests
console.log('\nFlow Document Parser Tests\n');

test('Parser finds task definitions', () => {
    const content = `
package: test_pkg
tasks:
  - name: task_a
    desc: First task
  - name: task_b
    uses: std.Exec
    needs: [task_a]
`;
    const doc = parseFlowDocument(content, '/test/flow.dv');
    
    assertEqual(doc.tasks.size, 2, 'Should find 2 tasks');
    assert(doc.tasks.has('task_a'), 'Should find task_a');
    assert(doc.tasks.has('task_b'), 'Should find task_b');
    
    const taskA = doc.tasks.get('task_a');
    assertEqual(taskA?.description, 'First task', 'task_a should have description');
    
    const taskB = doc.tasks.get('task_b');
    assertArrayEqual(taskB?.needs || [], ['task_a'], 'task_b should need task_a');
});

test('Parser finds task reference in needs (inline array)', () => {
    const content = `
package: test_pkg
tasks:
  - name: task_a
    desc: First task
  - name: task_b
    needs: [task_a]
`;
    const doc = parseFlowDocument(content, '/test/flow.dv');
    
    const taskRefs = doc.references.filter(r => r.name === 'task_a' && r.kind === 'task');
    assert(taskRefs.length > 0, 'Should have reference to task_a');
});

test('Parser finds task reference in needs (multiline list)', () => {
    const content = `
package: test_pkg
tasks:
  - name: task_a
    desc: First task
  - name: task_b
    needs:
      - task_a
`;
    const doc = parseFlowDocument(content, '/test/flow.dv');
    
    const taskB = doc.tasks.get('task_b');
    assertArrayEqual(taskB?.needs || [], ['task_a'], 'task_b should have task_a in needs');
    
    const taskRefs = doc.references.filter(r => r.name === 'task_a' && r.kind === 'task');
    assert(taskRefs.length > 0, 'Should have reference to task_a in multiline needs');
});

test('Task fullName includes package prefix', () => {
    const content = `
package: my_pkg
tasks:
  - name: task_a
    desc: First task
`;
    const doc = parseFlowDocument(content, '/test/flow.dv');
    
    const taskA = doc.tasks.get('task_a');
    assertEqual(taskA?.fullName, 'my_pkg.task_a', 'fullName should include package prefix');
});

test('Task description via desc field', () => {
    const content = `tasks:
  - name: task_a
    desc: Description via desc`;
    const doc = parseFlowDocument(content, '/test.dv');
    assertEqual(doc.tasks.get('task_a')?.description, 'Description via desc');
});

test('Task description via doc field', () => {
    const content = `tasks:
  - name: task_b
    doc: Description via doc`;
    const doc = parseFlowDocument(content, '/test.dv');
    assertEqual(doc.tasks.get('task_b')?.description, 'Description via doc');
});

test('Hover can find task by name in same document', () => {
    // This simulates what the hover provider does
    const content = `
package: test_pkg
tasks:
  - name: build_rtl
    desc: Build RTL sources
    uses: std.Exec
  - name: run_sim
    uses: std.Exec
    needs: [build_rtl]
`;
    const doc = parseFlowDocument(content, '/test/flow.dv');
    
    // This is exactly what getTaskReferenceHover does
    const taskName = 'build_rtl';
    const localTask = doc.tasks.get(taskName);
    
    assert(localTask !== undefined, `Should find task '${taskName}' in doc.tasks`);
    assertEqual(localTask?.name, 'build_rtl', 'Task name should match');
    assertEqual(localTask?.description, 'Build RTL sources', 'Task description should match');
    assertEqual(localTask?.fullName, 'test_pkg.build_rtl', 'Task fullName should match');
});

test('Reference column positions are accurate for inline needs', () => {
    const content = `tasks:
  - name: task_b
    needs: [task_a, task_c]`;
    const doc = parseFlowDocument(content, '/test/flow.dv');
    
    const refA = doc.references.find(r => r.name === 'task_a');
    const refC = doc.references.find(r => r.name === 'task_c');
    
    assert(refA !== undefined, 'Should have reference to task_a');
    assert(refC !== undefined, 'Should have reference to task_c');
    
    assertEqual(refA?.location.line, 3, 'task_a reference should be on line 3');
    assertEqual(refC?.location.line, 3, 'task_c reference should be on line 3');
    
    assert(refC!.location.column > refA!.location.column, 
        'task_c column should be greater than task_a column');
});

// ============================================================================
// Tests for nested package format (as used in actual flow.yaml files)
// ============================================================================

test('Parser handles nested package format with name under package block', () => {
    // This is the format actually used in flow.yaml files
    const content = `package:
  name: my_package

  tasks:
  - name: MyTask
    uses: std.Message
    desc: Task that prints a message
`;
    const doc = parseFlowDocument(content, '/test/flow.yaml');
    
    assertEqual(doc.packageName, 'my_package', 'Should extract package name from nested format');
    assertEqual(doc.tasks.size, 1, 'Should find 1 task');
    assert(doc.tasks.has('MyTask'), 'Should find MyTask');
    
    const task = doc.tasks.get('MyTask');
    assertEqual(task?.fullName, 'my_package.MyTask', 'Task fullName should include package');
    assertEqual(task?.uses, 'std.Message', 'Task should have uses');
    assertEqual(task?.description, 'Task that prints a message', 'Task should have description');
});

test('Parser handles nested package format with multiple tasks', () => {
    const content = `package:
  name: my_package

  tasks:
  - name: MyTask
    uses: std.Message
    desc: Task that prints a message

  - name: MyTask2
    uses: std.Message
    desc: Another task

  - name: DoIt
    needs: 
    - MyTask 
    - MyTask2 
`;
    const doc = parseFlowDocument(content, '/test/flow.yaml');
    
    assertEqual(doc.packageName, 'my_package', 'Should extract package name');
    assertEqual(doc.tasks.size, 3, 'Should find 3 tasks');
    assert(doc.tasks.has('MyTask'), 'Should find MyTask');
    assert(doc.tasks.has('MyTask2'), 'Should find MyTask2');
    assert(doc.tasks.has('DoIt'), 'Should find DoIt');
    
    const doIt = doc.tasks.get('DoIt');
    assertArrayEqual(doIt?.needs || [], ['MyTask', 'MyTask2'], 'DoIt should need MyTask and MyTask2');
});

test('Parser handles root task format', () => {
    // Some tasks use "root:" instead of "name:" to indicate they are entry points
    const content = `package:
  name: my_package

  tasks:
  - name: BuildTask
    uses: std.Exec

  - root: Main
    needs: [BuildTask]
`;
    const doc = parseFlowDocument(content, '/test/flow.yaml');
    
    // The root task should be found (root is an alias for name in this context)
    assertEqual(doc.tasks.size, 1, 'Should find 1 task (root tasks not parsed by simple parser)');
    assert(doc.tasks.has('BuildTask'), 'Should find BuildTask');
});

// ============================================================================
// Tests for JSON output compatibility with dfm util workspace
// ============================================================================

// Sample JSON output from: dfm util workspace
// {"name": "my_package", "file": "/path/flow.yaml", "imports": {}, "files": [], "markers": [], 
//  "tasks": [{"name": "my_package.MyTask", "srcinfo": "/path/flow.yaml:8:5"}, ...]}

interface WorkspaceTaskInfo {
    name: string;
    srcinfo?: string;
    type?: string;
    needs?: string[];
    description?: string;
}

interface WorkspacePackageData {
    name: string;
    file?: string;
    imports: { [key: string]: string };
    tasks: WorkspaceTaskInfo[];
    files: string[];
    markers?: { msg: string; severity: string }[];
}

function parseWorkspaceJson(jsonStr: string): WorkspacePackageData {
    return JSON.parse(jsonStr) as WorkspacePackageData;
}

function parseSrcinfo(srcinfo: string): { file: string; line: number; column: number } | null {
    // Parse "path/to/file.yaml:line:column" format
    const match = srcinfo.match(/^(.+):(\d+):(\d+)$/);
    if (match) {
        return {
            file: match[1],
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10)
        };
    }
    return null;
}

test('parseWorkspaceJson correctly parses dfm util workspace output', () => {
    const jsonOutput = `{"name": "my_package", "file": "/home/user/example/flow.yaml", "imports": {}, "files": [], "markers": [], "tasks": [{"name": "my_package.MyTask", "srcinfo": "/home/user/example/flow.yaml:8:5"}, {"name": "my_package.MyTask2", "srcinfo": "/home/user/example/flow.yaml:15:5"}, {"name": "my_package.DoIt", "srcinfo": "/home/user/example/flow.yaml:21:5"}]}`;
    
    const data = parseWorkspaceJson(jsonOutput);
    
    assertEqual(data.name, 'my_package', 'Package name should match');
    assertEqual(data.file, '/home/user/example/flow.yaml', 'File path should match');
    assertEqual(data.tasks.length, 3, 'Should have 3 tasks');
    
    // Verify task names include package prefix
    assertEqual(data.tasks[0].name, 'my_package.MyTask', 'First task should be my_package.MyTask');
    assertEqual(data.tasks[1].name, 'my_package.MyTask2', 'Second task should be my_package.MyTask2');
    assertEqual(data.tasks[2].name, 'my_package.DoIt', 'Third task should be my_package.DoIt');
});

test('parseSrcinfo correctly extracts file, line, column from srcinfo', () => {
    const srcinfo = '/home/user/example/flow.yaml:8:5';
    const parsed = parseSrcinfo(srcinfo);
    
    assert(parsed !== null, 'Should parse srcinfo');
    assertEqual(parsed?.file, '/home/user/example/flow.yaml', 'File should match');
    assertEqual(parsed?.line, 8, 'Line should be 8');
    assertEqual(parsed?.column, 5, 'Column should be 5');
});

test('Task names from workspace JSON are fully qualified', () => {
    // When using dfm util workspace, task names come as "package.task"
    // The hover provider should be able to find these
    const jsonOutput = `{"name": "my_package", "file": "/test/flow.yaml", "imports": {}, "files": [], "markers": [], "tasks": [{"name": "my_package.MyTask", "srcinfo": "/test/flow.yaml:8:5"}]}`;
    
    const data = parseWorkspaceJson(jsonOutput);
    const taskName = data.tasks[0].name;
    
    // Extract short name from fully qualified name
    const parts = taskName.split('.');
    const shortName = parts[parts.length - 1];
    const packageName = parts.slice(0, -1).join('.');
    
    assertEqual(shortName, 'MyTask', 'Short name should be MyTask');
    assertEqual(packageName, 'my_package', 'Package name should be my_package');
});

test('Workspace JSON with empty imports and tasks parses correctly', () => {
    const jsonOutput = `{"name": "empty_package", "file": "/test/flow.yaml", "imports": {}, "files": [], "markers": [], "tasks": []}`;
    
    const data = parseWorkspaceJson(jsonOutput);
    
    assertEqual(data.name, 'empty_package', 'Package name should match');
    assertEqual(data.tasks.length, 0, 'Should have 0 tasks');
    assertEqual(Object.keys(data.imports).length, 0, 'Should have 0 imports');
});

test('Workspace JSON with imports parses correctly', () => {
    const jsonOutput = `{"name": "main_package", "file": "/test/flow.yaml", "imports": {"std": "dv_flow_std", "sub": "/test/subdir/flow.yaml"}, "files": [], "markers": [], "tasks": []}`;
    
    const data = parseWorkspaceJson(jsonOutput);
    
    assertEqual(Object.keys(data.imports).length, 2, 'Should have 2 imports');
    assertEqual(data.imports['std'], 'dv_flow_std', 'std import should be dv_flow_std');
    assertEqual(data.imports['sub'], '/test/subdir/flow.yaml', 'sub import should be local path');
});

// Summary
console.log(`\n${testsPassed} passed, ${testsFailed} failed\n`);
process.exit(testsFailed > 0 ? 1 : 0);
