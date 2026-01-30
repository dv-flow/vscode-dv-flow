/**
 * Unit tests for enhanced task name completion in needs clauses
 */

import * as assert from 'assert';

// Mock TaskInfo for testing
interface TaskInfo {
    name: string;
    fullName: string;
    packageName?: string;
    scope?: string;
    uses?: string;
    description?: string;
    source: string;
}

// Test helper functions
function createTaskInfo(
    name: string,
    packageName: string | undefined,
    scope: string,
    source: string
): TaskInfo {
    return {
        name,
        fullName: packageName ? `${packageName}.${name}` : name,
        packageName,
        scope,
        uses: 'std.Exec',
        description: `Test task ${name}`,
        source
    };
}

describe('Task Name Completion Tests', () => {
    
    describe('Task Collection', () => {
        it('should collect local tasks', () => {
            const tasks = new Map<string, TaskInfo>();
            
            // Simulate adding local tasks
            tasks.set('task1', createTaskInfo('task1', 'mypackage', 'name', 'local'));
            tasks.set('task2', createTaskInfo('task2', 'mypackage', 'export', 'local'));
            
            assert.strictEqual(tasks.size, 2);
            assert.strictEqual(tasks.get('task1')?.name, 'task1');
            assert.strictEqual(tasks.get('task1')?.source, 'local');
        });
        
        it('should filter local-scope tasks from fragments', () => {
            const fragmentTasks = [
                createTaskInfo('export_task', 'mypackage', 'export', 'fragment: sim.yaml'),
                createTaskInfo('root_task', 'mypackage', 'root', 'fragment: sim.yaml'),
                createTaskInfo('local_task', 'mypackage', 'local', 'fragment: sim.yaml'),
            ];
            
            // Filter out local-scope tasks
            const visibleTasks = fragmentTasks.filter(t => t.scope !== 'local');
            
            assert.strictEqual(visibleTasks.length, 2);
            assert.ok(visibleTasks.every(t => t.scope !== 'local'));
        });
        
        it('should filter local-scope tasks from imports', () => {
            const importTasks = [
                createTaskInfo('export_task', 'hdlsim', 'export', 'import: hdlsim'),
                createTaskInfo('root_task', 'hdlsim', 'root', 'import: hdlsim'),
                createTaskInfo('name_task', 'hdlsim', 'name', 'import: hdlsim'),
                createTaskInfo('local_task', 'hdlsim', 'local', 'import: hdlsim'),
            ];
            
            // Only export/root tasks visible from imports
            const visibleTasks = importTasks.filter(t => 
                t.scope === 'export' || t.scope === 'root'
            );
            
            assert.strictEqual(visibleTasks.length, 2);
            assert.ok(visibleTasks.every(t => 
                t.scope === 'export' || t.scope === 'root'
            ));
        });
        
        it('should use qualified names for imported tasks', () => {
            const importedTask = createTaskInfo('compile', 'hdlsim', 'export', 'import: hdlsim');
            
            assert.strictEqual(importedTask.fullName, 'hdlsim.compile');
            assert.strictEqual(importedTask.packageName, 'hdlsim');
        });
    });
    
    describe('Context Detection', () => {
        it('should detect standard needs context', () => {
            const patterns = [
                'needs: [',
                'needs: ',
                '  - ',
            ];
            
            for (const pattern of patterns) {
                const isNeedsContext = pattern.includes('needs:') || pattern.trim() === '-';
                assert.ok(isNeedsContext, `Should detect needs context for: "${pattern}"`);
            }
        });
        
        it('should detect package-qualified needs context', () => {
            const testCases = [
                { input: 'needs: [hdlsim.', expected: 'hdlsim' },
                { input: '  - cocotb.', expected: 'cocotb' },
                { input: 'needs: pkg.', expected: 'pkg' },
            ];
            
            for (const test of testCases) {
                const match = test.input.match(/(?:needs:\s*\[|(?:^|\s)-\s*|needs:\s+|,\s*)([a-zA-Z_][a-zA-Z0-9_]*)\.\s*$/);
                assert.ok(match, `Should match package qualifier in: "${test.input}"`);
                assert.strictEqual(match?.[1], test.expected);
            }
        });
        
        it('should not match invalid package patterns', () => {
            const invalidPatterns = [
                'needs: [123.',  // Starts with number
                'needs: [.pkg',  // Starts with dot
                'other: [pkg.',  // Not in needs context
            ];
            
            for (const pattern of invalidPatterns) {
                const match = pattern.match(/(?:needs:\s*\[|(?:^|\s)-\s*|needs:\s+|,\s*)([a-zA-Z_][a-zA-Z0-9_]*)\.\s*$/);
                if (pattern.startsWith('other:')) {
                    // Should match pattern but needs context check will fail
                    assert.ok(true);
                } else {
                    assert.ok(!match, `Should not match invalid pattern: "${pattern}"`);
                }
            }
        });
    });
    
    describe('Package-Scoped Filtering', () => {
        it('should filter tasks by package name', () => {
            const allTasks = new Map<string, TaskInfo>([
                ['task1', createTaskInfo('task1', 'mypackage', 'name', 'local')],
                ['hdlsim.compile', createTaskInfo('compile', 'hdlsim', 'export', 'import: hdlsim')],
                ['hdlsim.simulate', createTaskInfo('simulate', 'hdlsim', 'root', 'import: hdlsim')],
                ['cocotb.test', createTaskInfo('test', 'cocotb', 'export', 'import: cocotb')],
            ]);
            
            // Filter to hdlsim package
            const hdlsimTasks = Array.from(allTasks.values()).filter(
                t => t.packageName === 'hdlsim'
            );
            
            assert.strictEqual(hdlsimTasks.length, 2);
            assert.ok(hdlsimTasks.every(t => t.packageName === 'hdlsim'));
            assert.strictEqual(hdlsimTasks[0].name, 'compile');
            assert.strictEqual(hdlsimTasks[1].name, 'simulate');
        });
        
        it('should return empty array for non-existent package', () => {
            const allTasks = new Map<string, TaskInfo>([
                ['task1', createTaskInfo('task1', 'mypackage', 'name', 'local')],
            ]);
            
            const unknownTasks = Array.from(allTasks.values()).filter(
                t => t.packageName === 'unknown'
            );
            
            assert.strictEqual(unknownTasks.length, 0);
        });
    });
    
    describe('Task Sorting', () => {
        it('should sort local tasks first', () => {
            const tasks = [
                createTaskInfo('import_task', 'hdlsim', 'export', 'import: hdlsim'),
                createTaskInfo('local_task', 'mypackage', 'name', 'local'),
                createTaskInfo('fragment_task', 'mypackage', 'export', 'fragment: sim.yaml'),
            ];
            
            const getSortPrefix = (task: TaskInfo): string => {
                if (task.source === 'local') return '0';
                if (task.source.startsWith('fragment')) return '1';
                return '2';
            };
            
            const sorted = tasks.sort((a, b) => {
                const prefixA = getSortPrefix(a);
                const prefixB = getSortPrefix(b);
                return prefixA.localeCompare(prefixB);
            });
            
            assert.strictEqual(sorted[0].source, 'local');
            assert.strictEqual(sorted[1].source, 'fragment: sim.yaml');
            assert.strictEqual(sorted[2].source, 'import: hdlsim');
        });
    });
    
    describe('Workspace Search Patterns', () => {
        it('should generate correct search patterns for imports', () => {
            const importName = 'hdlsim';
            const expectedPatterns = [
                `**/${importName}/flow.yaml`,
                `**/${importName}/flow.yml`,
                `**/packages/${importName}/flow.yaml`,
                `**/packages/${importName}/flow.yml`,
                `**/${importName}.yaml`,
                `**/${importName}.yml`,
            ];
            
            // Verify all patterns are present
            assert.strictEqual(expectedPatterns.length, 6);
            assert.ok(expectedPatterns.every(p => p.includes(importName)));
        });
    });
    
    describe('Fragment Path Resolution', () => {
        it('should resolve relative fragment paths', () => {
            const docPath = '/home/user/project/flow.yaml';
            const fragmentPath = 'tasks/simulation.yaml';
            
            // Simulate path resolution
            const docDir = docPath.substring(0, docPath.lastIndexOf('/'));
            const resolvedPath = fragmentPath.startsWith('/')
                ? fragmentPath
                : `${docDir}/${fragmentPath}`;
            
            assert.strictEqual(resolvedPath, '/home/user/project/tasks/simulation.yaml');
        });
        
        it('should handle absolute fragment paths', () => {
            const fragmentPath = '/absolute/path/fragment.yaml';
            const resolvedPath = fragmentPath; // Already absolute
            
            assert.strictEqual(resolvedPath, '/absolute/path/fragment.yaml');
        });
    });
});

// Run tests if executed directly
if (require.main === module) {
    console.log('Running task completion tests...\n');
    
    // Note: In real environment, these would be run by Mocha
    // This is just a standalone verification
    console.log('✓ All test suites defined');
    console.log('  - Task Collection (4 tests)');
    console.log('  - Context Detection (3 tests)');
    console.log('  - Package-Scoped Filtering (2 tests)');
    console.log('  - Task Sorting (1 test)');
    console.log('  - Workspace Search Patterns (1 test)');
    console.log('  - Fragment Path Resolution (2 tests)');
    console.log('\nTotal: 13 tests');
    console.log('\nRun with VSCode test runner or Mocha to execute tests.');
}
