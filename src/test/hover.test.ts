/**
 * Unit tests for hover functionality on task references
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { FlowDocumentParser, FlowDocumentCache } from '../language/flowDocumentModel';
import { FlowHoverProvider } from '../language/hoverProvider';
import { WorkspaceManager } from '../workspace';

suite('Hover Provider Test Suite', () => {
    let documentCache: FlowDocumentCache;
    
    setup(() => {
        documentCache = new FlowDocumentCache();
    });
    
    test('Parser finds task definitions', () => {
        const parser = new FlowDocumentParser();
        const content = `
package: test_pkg
tasks:
  - name: task_a
    desc: First task
  - name: task_b
    uses: std.Exec
    needs: [task_a]
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        const doc = parser.parse(uri, content);
        
        // Verify both tasks are found
        assert.strictEqual(doc.tasks.size, 2, 'Should find 2 tasks');
        assert.ok(doc.tasks.has('task_a'), 'Should find task_a');
        assert.ok(doc.tasks.has('task_b'), 'Should find task_b');
        
        // Verify task_a has the description
        const taskA = doc.tasks.get('task_a');
        assert.strictEqual(taskA?.description, 'First task');
        
        // Verify task_b has the needs reference
        const taskB = doc.tasks.get('task_b');
        assert.deepStrictEqual(taskB?.needs, ['task_a']);
    });
    
    test('Parser finds task reference in needs (inline array)', () => {
        const parser = new FlowDocumentParser();
        const content = `
package: test_pkg
tasks:
  - name: task_a
    desc: First task
  - name: task_b
    needs: [task_a]
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        const doc = parser.parse(uri, content);
        
        // Check that the reference to task_a is recorded
        const taskRefs = doc.references.filter(r => r.name === 'task_a' && r.kind === 'task');
        assert.ok(taskRefs.length > 0, 'Should have reference to task_a');
    });
    
    test('Parser finds task reference in needs (multiline list)', () => {
        const parser = new FlowDocumentParser();
        const content = `
package: test_pkg
tasks:
  - name: task_a
    desc: First task
  - name: task_b
    needs:
      - task_a
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        const doc = parser.parse(uri, content);
        
        // Verify task_b has the needs reference
        const taskB = doc.tasks.get('task_b');
        assert.deepStrictEqual(taskB?.needs, ['task_a']);
        
        // Check that the reference to task_a is recorded
        const taskRefs = doc.references.filter(r => r.name === 'task_a' && r.kind === 'task');
        assert.ok(taskRefs.length > 0, 'Should have reference to task_a in multiline needs');
    });
    
    test('findTask finds task in same document', () => {
        const content = `
package: test_pkg
tasks:
  - name: task_a
    desc: First task
  - name: task_b
    needs: [task_a]
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        documentCache.parseFromText(uri, content);
        
        // Find task_a through the cache
        const found = documentCache.findTask('task_a');
        assert.ok(found, 'Should find task_a in cache');
        assert.strictEqual(found?.task.name, 'task_a');
        assert.strictEqual(found?.task.description, 'First task');
    });
    
    test('findTask finds task by full name', () => {
        const content = `
package: my_pkg
tasks:
  - name: task_a
    desc: First task
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        documentCache.parseFromText(uri, content);
        
        // Find task by full name
        const found = documentCache.findTask('my_pkg.task_a');
        assert.ok(found, 'Should find task by full name my_pkg.task_a');
        assert.strictEqual(found?.task.name, 'task_a');
    });
    
    test('Parser records accurate column for inline needs reference', () => {
        const parser = new FlowDocumentParser();
        const content = `tasks:
  - name: task_b
    needs: [task_a, task_c]`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        const doc = parser.parse(uri, content);
        
        // Find references to task_a and task_c
        const refA = doc.references.find(r => r.name === 'task_a');
        const refC = doc.references.find(r => r.name === 'task_c');
        
        assert.ok(refA, 'Should have reference to task_a');
        assert.ok(refC, 'Should have reference to task_c');
        
        // Verify they are on line 3 (1-indexed)
        assert.strictEqual(refA?.location.line, 3, 'task_a reference should be on line 3');
        assert.strictEqual(refC?.location.line, 3, 'task_c reference should be on line 3');
        
        // Verify columns are different (task_c should be after task_a)
        if (refA && refC) {
            assert.ok(refC.location.column > refA.location.column, 
                'task_c column should be greater than task_a column');
        }
    });
    
    test('Task description and doc fields are captured', () => {
        const parser = new FlowDocumentParser();
        
        // Test with 'desc:'
        const content1 = `tasks:
  - name: task_a
    desc: Description via desc`;
        const doc1 = parser.parse(vscode.Uri.parse('file:///test1.dv'), content1);
        assert.strictEqual(doc1.tasks.get('task_a')?.description, 'Description via desc');
        
        // Test with 'doc:'
        const content2 = `tasks:
  - name: task_b
    doc: Description via doc`;
        const doc2 = parser.parse(vscode.Uri.parse('file:///test2.dv'), content2);
        assert.strictEqual(doc2.tasks.get('task_b')?.description, 'Description via doc');
    });
    
    test('Hover should find task in needs reference from same document', () => {
        // Simulate what the hover provider does:
        // 1. Parse the document
        // 2. Get the task from flowDoc.tasks.get(taskName)
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
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        const flowDoc = documentCache.parseFromText(uri, content);
        
        // This is exactly what getTaskReferenceHover does
        const taskName = 'build_rtl';
        const localTask = flowDoc.tasks.get(taskName);
        
        assert.ok(localTask, `Should find task '${taskName}' in flowDoc.tasks`);
        assert.strictEqual(localTask?.name, 'build_rtl');
        assert.strictEqual(localTask?.description, 'Build RTL sources');
        
        // Verify the full name is set
        assert.strictEqual(localTask?.fullName, 'test_pkg.build_rtl');
    });
    
    test('Hover should find task with dotted reference', () => {
        // Test pkg.task_name style references
        const content = `
package: my_pkg
tasks:
  - name: task_a
    desc: First task
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        const flowDoc = documentCache.parseFromText(uri, content);
        
        // Try to find by short name
        const byShortName = flowDoc.tasks.get('task_a');
        assert.ok(byShortName, 'Should find task by short name');
        
        // The task map uses short name as key, full name is a property
        assert.strictEqual(byShortName?.fullName, 'my_pkg.task_a');
    });
    
    // Tests for nested package format (as used in actual flow.yaml files)
    test('Parser handles nested package format with name under package block', () => {
        const parser = new FlowDocumentParser();
        // This is the format actually used in flow.yaml files
        const content = `package:
  name: my_package

  tasks:
  - name: MyTask
    uses: std.Message
    desc: Task that prints a message
`;
        const uri = vscode.Uri.parse('file:///test/flow.yaml');
        const doc = parser.parse(uri, content);
        
        assert.strictEqual(doc.packageName, 'my_package', 'Should extract package name from nested format');
        assert.strictEqual(doc.tasks.size, 1, 'Should find 1 task');
        assert.ok(doc.tasks.has('MyTask'), 'Should find MyTask');
        
        const task = doc.tasks.get('MyTask');
        assert.strictEqual(task?.fullName, 'my_package.MyTask', 'Task fullName should include package');
        assert.strictEqual(task?.uses, 'std.Message', 'Task should have uses');
        assert.strictEqual(task?.description, 'Task that prints a message', 'Task should have description');
    });
    
    test('Parser handles nested package format with multiple tasks and needs', () => {
        const parser = new FlowDocumentParser();
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
        const uri = vscode.Uri.parse('file:///test/flow.yaml');
        const doc = parser.parse(uri, content);
        
        assert.strictEqual(doc.packageName, 'my_package', 'Should extract package name');
        assert.strictEqual(doc.tasks.size, 3, 'Should find 3 tasks');
        assert.ok(doc.tasks.has('MyTask'), 'Should find MyTask');
        assert.ok(doc.tasks.has('MyTask2'), 'Should find MyTask2');
        assert.ok(doc.tasks.has('DoIt'), 'Should find DoIt');
        
        const doIt = doc.tasks.get('DoIt');
        assert.deepStrictEqual(doIt?.needs, ['MyTask', 'MyTask2'], 'DoIt should need MyTask and MyTask2');
    });
    
    test('Hover finds task in needs when using nested package format', () => {
        // This is the core test that was failing - hover should find tasks in needs references
        const content = `package:
  name: my_package

  tasks:
  - name: MyTask
    uses: std.Message
    desc: Task that prints a message

  - name: DoIt
    needs: 
    - MyTask
`;
        const uri = vscode.Uri.parse('file:///test/flow.yaml');
        const flowDoc = documentCache.parseFromText(uri, content);
        
        // This is exactly what getTaskReferenceHover does
        const taskName = 'MyTask';
        const localTask = flowDoc.tasks.get(taskName);
        
        assert.ok(localTask, `Should find task '${taskName}' in flowDoc.tasks`);
        assert.strictEqual(localTask?.name, 'MyTask');
        assert.strictEqual(localTask?.description, 'Task that prints a message');
        assert.strictEqual(localTask?.fullName, 'my_package.MyTask');
    });
});

