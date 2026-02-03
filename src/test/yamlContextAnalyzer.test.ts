/**
 * Tests for YAML Context Analyzer
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { YamlContextAnalyzer } from '../language/yamlContextAnalyzer';

suite('YAML Context Analyzer Test Suite', () => {
    const analyzer = new YamlContextAnalyzer();

    test('Should detect task name context', async () => {
        const content = `package:
  name: test_package
  tasks:
  - name: MyTask
    uses: std.Message`;

        const doc = await createTestDocument(content);
        
        // Position on "MyTask" (line 3, after "name: ")
        const position = new vscode.Position(3, 12);
        const context = analyzer.analyzeContext(doc, position);
        
        assert.ok(context, 'Context should be detected');
        assert.strictEqual(context?.kind, 'task-name', 'Should detect task-name context');
        assert.ok(context?.path.includes('tasks'), 'Path should include tasks');
    });

    test('Should detect task uses context', async () => {
        const content = `package:
  name: test_package
  tasks:
  - name: MyTask
    uses: std.Message`;

        const doc = await createTestDocument(content);
        
        // Position on "std.Message" (line 4, after "uses: ")
        const position = new vscode.Position(4, 15);
        const context = analyzer.analyzeContext(doc, position);
        
        assert.ok(context, 'Context should be detected');
        assert.strictEqual(context?.kind, 'task-uses', 'Should detect task-uses context');
    });

    test('Should detect task needs context', async () => {
        const content = `package:
  name: test_package
  tasks:
  - name: MyTask
    needs:
    - OtherTask`;

        const doc = await createTestDocument(content);
        
        // Position on "OtherTask" (line 5)
        const position = new vscode.Position(5, 10);
        const context = analyzer.analyzeContext(doc, position);
        
        assert.ok(context, 'Context should be detected');
        assert.strictEqual(context?.kind, 'task-needs', 'Should detect task-needs context');
    });

    test('Should detect task parameter context', async () => {
        const content = `package:
  name: test_package
  tasks:
  - name: MyTask
    uses: std.Message
    with:
      msg: "Hello"`;

        const doc = await createTestDocument(content);
        
        // Position on "msg" key (line 6)
        const position = new vscode.Position(6, 8);
        const context = analyzer.analyzeContext(doc, position);
        
        assert.ok(context, 'Context should be detected');
        assert.strictEqual(context?.kind, 'task-parameter', 'Should detect task-parameter context');
    });

    test('Should detect package parameter context', async () => {
        const content = `package:
  name: test_package
  with:
    my_param: value`;

        const doc = await createTestDocument(content);
        
        // Position on "my_param" key (line 3)
        const position = new vscode.Position(3, 8);
        const context = analyzer.analyzeContext(doc, position);
        
        assert.ok(context, 'Context should be detected');
        assert.strictEqual(context?.kind, 'package-parameter', 'Should detect package-parameter context');
    });

    test('Should detect import context', async () => {
        const content = `package:
  name: test_package
  imports:
  - std`;

        const doc = await createTestDocument(content);
        
        // Position on "std" (line 3)
        const position = new vscode.Position(3, 6);
        const context = analyzer.analyzeContext(doc, position);
        
        assert.ok(context, 'Context should be detected');
        assert.strictEqual(context?.kind, 'import', 'Should detect import context');
    });

    test('Should detect fragment context', async () => {
        const content = `package:
  name: test_package
  fragments:
  - subdir/flow.yaml`;

        const doc = await createTestDocument(content);
        
        // Position on fragment path (line 3)
        const position = new vscode.Position(3, 10);
        const context = analyzer.analyzeContext(doc, position);
        
        assert.ok(context, 'Context should be detected');
        assert.strictEqual(context?.kind, 'fragment', 'Should detect fragment context');
    });

    test('Should handle malformed YAML gracefully', async () => {
        const content = `package:
  name: test_package
  tasks:
  - name: MyTask
    uses: std.Message
    with
      msg: incomplete`;

        const doc = await createTestDocument(content);
        
        // Position anywhere in the document
        const position = new vscode.Position(5, 8);
        const context = analyzer.analyzeContext(doc, position);
        
        // Should return null for malformed YAML, allowing fallback to text-based detection
        assert.strictEqual(context, null, 'Should return null for malformed YAML');
    });

    test('Should detect fragment structure', async () => {
        const content = `fragment:
  name: my_fragment
  tasks:
  - name: FragmentTask
    uses: std.Null`;

        const doc = await createTestDocument(content);
        
        // Position on "FragmentTask" (line 3)
        const position = new vscode.Position(3, 12);
        const context = analyzer.analyzeContext(doc, position);
        
        assert.ok(context, 'Context should be detected');
        assert.strictEqual(context?.kind, 'task-name', 'Should detect task-name in fragment');
        assert.strictEqual(context?.path[0], 'fragment', 'Path should start with fragment');
    });
});

/**
 * Helper to create a test document
 */
async function createTestDocument(content: string): Promise<vscode.TextDocument> {
    const uri = vscode.Uri.parse('untitled:test.yaml');
    const doc = await vscode.workspace.openTextDocument({ 
        language: 'yaml', 
        content 
    });
    return doc;
}
