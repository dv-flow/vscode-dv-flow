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
    
    test('findTask finds task in same document', async () => {
        const content = `
package: test_pkg
tasks:
  - name: task_a
    desc: First task
  - name: task_b
    needs: [task_a]
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        await documentCache.parseFromText(uri, content);
        
        // Find task_a through the cache
        const found = documentCache.findTask('task_a');
        assert.ok(found, 'Should find task_a in cache');
        assert.strictEqual(found?.task.name, 'task_a');
        assert.strictEqual(found?.task.description, 'First task');
    });
    
    test('findTask finds task by full name', async () => {
        const content = `
package: my_pkg
tasks:
  - name: task_a
    desc: First task
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        await documentCache.parseFromText(uri, content);
        
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
    
    test('Hover should find task in needs reference from same document', async () => {
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
        const flowDoc = await documentCache.parseFromText(uri, content);
        
        // This is exactly what getTaskReferenceHover does
        const taskName = 'build_rtl';
        const localTask = flowDoc.tasks.get(taskName);
        
        assert.ok(localTask, `Should find task '${taskName}' in flowDoc.tasks`);
        assert.strictEqual(localTask?.name, 'build_rtl');
        assert.strictEqual(localTask?.description, 'Build RTL sources');
        
        // Verify the full name is set
        assert.strictEqual(localTask?.fullName, 'test_pkg.build_rtl');
    });
    
    test('Hover should find task with dotted reference', async () => {
        // Test pkg.task_name style references
        const content = `
package: my_pkg
tasks:
  - name: task_a
    desc: First task
`;
        const uri = vscode.Uri.parse('file:///test/flow.dv');
        const flowDoc = await documentCache.parseFromText(uri, content);
        
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
    
    test('Hover finds task in needs when using nested package format', async () => {
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
        const flowDoc = await documentCache.parseFromText(uri, content);
        
        // This is exactly what getTaskReferenceHover does
        const taskName = 'MyTask';
        const localTask = flowDoc.tasks.get(taskName);
        
        assert.ok(localTask, `Should find task '${taskName}' in flowDoc.tasks`);
        assert.strictEqual(localTask?.name, 'MyTask');
        assert.strictEqual(localTask?.description, 'Task that prints a message');
        assert.strictEqual(localTask?.fullName, 'my_package.MyTask');
    });
    
    // Tests for cross-file task references (fragment files)
    test('Parser parses fragment task reference', async () => {
        // First parse a fragment file with task definitions
        const fragmentContent = `tasks:
  - name: shared_task
    desc: Task defined in fragment
    uses: std.Exec
`;
        const fragmentUri = vscode.Uri.parse('file:///test/fragments/common.dv');
        const fragmentDoc = await documentCache.parseFromText(fragmentUri, fragmentContent);
        
        // Verify the fragment has the task
        assert.strictEqual(fragmentDoc.tasks.size, 1, 'Fragment should have 1 task');
        assert.ok(fragmentDoc.tasks.has('shared_task'), 'Fragment should have shared_task');
        
        // Now parse main file that references the fragment
        const mainContent = `package:
  name: main_pkg
  
  fragments:
    - ./fragments/common.dv
    
  tasks:
  - name: main_task
    needs: [shared_task]
`;
        const mainUri = vscode.Uri.parse('file:///test/flow.dv');
        const mainDoc = await documentCache.parseFromText(mainUri, mainContent);
        
        // Verify fragment reference is captured
        assert.strictEqual(mainDoc.fragments.length, 1, 'Main doc should have 1 fragment');
        assert.strictEqual(mainDoc.fragments[0].path, './fragments/common.dv');
    });
    
    test('findTask finds task in fragment file', async () => {
        // Parse fragment file
        const fragmentContent = `tasks:
  - name: shared_task
    desc: Task from fragment
`;
        const fragmentUri = vscode.Uri.parse('file:///test/fragments/common.dv');
        await documentCache.parseFromText(fragmentUri, fragmentContent);
        
        // Parse main file
        const mainContent = `package:
  name: main_pkg
  
  fragments:
    - ./fragments/common.dv
    
  tasks:
  - name: main_task
    needs: [shared_task]
`;
        const mainUri = vscode.Uri.parse('file:///test/flow.dv');
        await documentCache.parseFromText(mainUri, mainContent);
        
        // Should be able to find shared_task in cache
        const found = documentCache.findTask('shared_task');
        assert.ok(found, 'Should find shared_task in cache');
        assert.strictEqual(found?.task.name, 'shared_task');
        assert.strictEqual(found?.task.description, 'Task from fragment');
    });
    
    test('Hover should find task from fragment file', async () => {
        // Parse fragment file with a task
        const fragmentContent = `tasks:
  - name: build_rtl
    desc: Build RTL from fragment file
    uses: std.Exec
`;
        const fragmentUri = vscode.Uri.parse('file:///test/fragments/build.dv');
        await documentCache.parseFromText(fragmentUri, fragmentContent);
        
        // Parse main file that references the task
        const mainContent = `package:
  name: main_pkg
  
  fragments:
    - ./fragments/build.dv
    
  tasks:
  - name: run_sim
    needs: [build_rtl]
`;
        const mainUri = vscode.Uri.parse('file:///test/flow.dv');
        const mainDoc = await documentCache.parseFromText(mainUri, mainContent);
        
        // Try to find the task reference - should find it in cache
        const taskName = 'build_rtl';
        
        // First check local document (won't be there)
        const localTask = mainDoc.tasks.get(taskName);
        assert.ok(!localTask, 'Should NOT find task in local document');
        
        // Check cache (should find it there)
        const found = documentCache.findTask(taskName);
        assert.ok(found, 'Should find task in cache from fragment file');
        assert.strictEqual(found?.task.name, 'build_rtl');
        assert.strictEqual(found?.task.description, 'Build RTL from fragment file');
    });
    
    test('Hover should find task with package prefix from fragment', async () => {
        // Fragment file in a package
        const fragmentContent = `package:
  name: shared_pkg
  
  tasks:
  - name: shared_task
    desc: Shared task from fragment
`;
        const fragmentUri = vscode.Uri.parse('file:///test/shared/tasks.dv');
        await documentCache.parseFromText(fragmentUri, fragmentContent);
        
        // Main file using the fragment
        const mainContent = `package:
  name: main_pkg
  
  fragments:
    - ../shared/tasks.dv
    
  tasks:
  - name: main_task
    needs: [shared_pkg.shared_task]
`;
        const mainUri = vscode.Uri.parse('file:///test/main/flow.dv');
        await documentCache.parseFromText(mainUri, mainContent);
        
        // Should find by full name
        const found = documentCache.findTask('shared_pkg.shared_task');
        assert.ok(found, 'Should find task by full package name');
        assert.strictEqual(found?.task.fullName, 'shared_pkg.shared_task');
    });
    
    // Tests for fragment: top-level key and export: task marker
    test('Parser handles fragment: top-level key', async () => {
        const fragmentContent = `fragment:

  tasks:
  - export: MyTask3
    uses: std.Message
    desc: Task that prints a message
`;
        const fragmentUri = vscode.Uri.parse('file:///test/subdir/flow.yaml');
        const fragmentDoc = await documentCache.parseFromText(fragmentUri, fragmentContent);
        
        // Verify the task is found with export: marker
        assert.strictEqual(fragmentDoc.tasks.size, 1, 'Fragment should have 1 task');
        assert.ok(fragmentDoc.tasks.has('MyTask3'), 'Fragment should have MyTask3');
        
        const task = fragmentDoc.tasks.get('MyTask3');
        assert.strictEqual(task?.name, 'MyTask3');
        assert.strictEqual(task?.description, 'Task that prints a message');
    });
    
    test('Parser handles all task name variants (name, export, root, local, override)', async () => {
        const content = `package:
  name: test_pkg
  
  tasks:
  - name: regular_task
    desc: Regular task
    
  - export: exported_task
    desc: Exported task
    
  - root: root_task
    desc: Root task
    
  - local: local_task
    desc: Local task
    
  - override: base_task
    desc: Override task
`;
        const uri = vscode.Uri.parse('file:///test/flow.yaml');
        const doc = await documentCache.parseFromText(uri, content);
        
        assert.strictEqual(doc.tasks.size, 5, 'Should find all 5 tasks');
        assert.ok(doc.tasks.has('regular_task'), 'Should have regular_task');
        assert.ok(doc.tasks.has('exported_task'), 'Should have exported_task');
        assert.ok(doc.tasks.has('root_task'), 'Should have root_task');
        assert.ok(doc.tasks.has('local_task'), 'Should have local_task');
        assert.ok(doc.tasks.has('base_task'), 'Should have base_task (from override)');
    });
    
    test('Hover finds task defined with export: in fragment', async () => {
        // Fragment with export: marker
        const fragmentContent = `fragment:

  tasks:
  - export: MyTask3
    uses: std.Message
    desc: Task from fragment with export marker
`;
        const fragmentUri = vscode.Uri.parse('file:///test/subdir/flow.yaml');
        await documentCache.parseFromText(fragmentUri, fragmentContent);
        
        // Main file referencing the exported task
        const mainContent = `package:
  name: my_package
  
  fragments:
    - subdir/flow.yaml
    
  tasks:
  - root: DoIt
    needs: [MyTask3]
`;
        const mainUri = vscode.Uri.parse('file:///test/flow.yaml');
        await documentCache.parseFromText(mainUri, mainContent);
        
        // Should find MyTask3 in cache
        const found = documentCache.findTask('MyTask3');
        assert.ok(found, 'Should find MyTask3 from fragment');
        assert.strictEqual(found?.task.name, 'MyTask3');
        assert.strictEqual(found?.task.description, 'Task from fragment with export marker');
    });
    
    // Tests for hover on 'uses:' references
    test('Hover on uses reference to task in same file', async () => {
        const content = `package:
  name: test_pkg
  
  tasks:
  - name: BaseTask
    desc: Base task type
    
  - name: DerivedTask
    uses: BaseTask
    desc: Derived from BaseTask
`;
        const uri = vscode.Uri.parse('file:///test/flow.yaml');
        const flowDoc = await documentCache.parseFromText(uri, content);
        
        // This simulates hovering over "BaseTask" in "uses: BaseTask"
        const taskName = 'BaseTask';
        
        // The hover provider calls getTaskTypeHover which now checks cache
        const found = documentCache.findTask(taskName);
        assert.ok(found, 'Should find BaseTask in cache');
        assert.strictEqual(found?.task.name, 'BaseTask');
        assert.strictEqual(found?.task.description, 'Base task type');
    });
    
    test('Hover on uses reference with qualified name', async () => {
        const content = `package:
  name: test_pkg
  
  tasks:
  - name: BaseTask
    desc: Base task type
    
  - name: DerivedTask
    uses: test_pkg.BaseTask
    desc: Uses qualified name
`;
        const uri = vscode.Uri.parse('file:///test/flow.yaml');
        await documentCache.parseFromText(uri, content);
        
        // Hover on "test_pkg.BaseTask"
        const found = documentCache.findTask('test_pkg.BaseTask');
        assert.ok(found, 'Should find task by qualified name');
        assert.strictEqual(found?.task.fullName, 'test_pkg.BaseTask');
    });
    
    test('Hover on uses reference to task in fragment', async () => {
        // Fragment with base task
        const fragmentContent = `tasks:
  - name: BaseTask
    desc: Base task from fragment
    uses: std.Message
`;
        const fragmentUri = vscode.Uri.parse('file:///test/fragments/base.dv');
        await documentCache.parseFromText(fragmentUri, fragmentContent);
        
        // Main file using the base task
        const mainContent = `package:
  name: main_pkg
  
  fragments:
    - ./fragments/base.dv
    
  tasks:
  - name: DerivedTask
    uses: BaseTask
    desc: Derived from fragment task
`;
        const mainUri = vscode.Uri.parse('file:///test/flow.yaml');
        await documentCache.parseFromText(mainUri, mainContent);
        
        // Hover on "BaseTask" in uses line
        const found = documentCache.findTask('BaseTask');
        assert.ok(found, 'Should find BaseTask from fragment');
        assert.strictEqual(found?.task.name, 'BaseTask');
        assert.strictEqual(found?.task.description, 'Base task from fragment');
        assert.ok(found?.task.location.file.includes('base.dv'), 'Should be from fragment file');
    });
    
    test('Hover on uses with built-in type shows type info', async () => {
        // Built-in types like std.Message should show static info
        // (not from cache since they're Python plugins)
        const content = `tasks:
  - name: MyTask
    uses: std.Message
    desc: Uses built-in type
`;
        const uri = vscode.Uri.parse('file:///test/flow.yaml');
        await documentCache.parseFromText(uri, content);
        
        // Try to find std.Message - should not be in cache
        const found = documentCache.findTask('std.Message');
        assert.ok(!found, 'Built-in types should not be in cache');
        
        // The hover provider will fall back to static task type info
        // This is the expected behavior for built-in types
    });
});

