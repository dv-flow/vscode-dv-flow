import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { findPythonInterpreter, expandPath } from './extension';

export class DVFlowTaskProvider implements vscode.TaskProvider {
    static taskType = 'dvflow';
    private taskProvider?: vscode.Disposable;
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('DV Flow');
    }

    public registerTaskProvider(): vscode.Disposable {
        if (!this.taskProvider) {
            this.taskProvider = vscode.tasks.registerTaskProvider(DVFlowTaskProvider.taskType, this);
        }
        return this.taskProvider;
    }

    private async discoverTasks(workspaceRoot: string): Promise<vscode.Task[]> {
        const tasks: vscode.Task[] = [];
        try {
            const config = vscode.workspace.getConfiguration('dvflow');
            const rawDfmPath = config.get<string>('dfmPath');
            
            let command: string;
            if (rawDfmPath) {
                const dfmPath = expandPath(rawDfmPath);
                if (fs.existsSync(dfmPath)) {
                    command = `"${dfmPath}" util list`;
                } else {
                    const pythonPath = await findPythonInterpreter(workspaceRoot);
                    command = `"${pythonPath}" -m dv_flow.mgr list`;
                }
            } else {
                const pythonPath = await findPythonInterpreter(workspaceRoot);
                command = `"${pythonPath}" -m dv_flow.mgr list`;
            }
            
            const output = await new Promise<string>((resolve, reject) => {
                child_process.exec(command, { cwd: workspaceRoot }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(stdout);
                });
            });

            // Parse task names from output
            const taskNames = output.trim().split('\n').map(line => line.trim()).filter(line => line);
            
            // Create a task for each discovered task name
            for (const taskName of taskNames) {
                const task = new vscode.Task(
                    { type: DVFlowTaskProvider.taskType, task: taskName },
                    vscode.TaskScope.Workspace,
                    taskName,
                    DVFlowTaskProvider.taskType,
                    new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
                        return new DVFlowTaskTerminal(taskName, workspaceRoot, this.outputChannel);
                    })
                );
                tasks.push(task);
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error discovering tasks: ${error instanceof Error ? error.message : String(error)}`);
        }
        return tasks;
    }

    async provideTasks(): Promise<vscode.Task[]> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) {
            return [];
        }
        return this.discoverTasks(workspaceRoot);
    }

    async resolveTask(task: vscode.Task): Promise<vscode.Task> {
        const taskName = task.definition.task;
        const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        
        if (!rootPath) {
            throw new Error('No workspace folder found');
        }

        const execution = new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
            return new DVFlowTaskTerminal(taskName, rootPath, this.outputChannel);
        });

        return new vscode.Task(
            task.definition,
            task.scope ?? vscode.TaskScope.Workspace,
            taskName,
            DVFlowTaskProvider.taskType,
            execution
        );
    }
}

class DVFlowTaskTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number>();

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;

    constructor(
        private readonly taskName: string,
        private readonly rootPath: string,
        private readonly outputChannel: vscode.OutputChannel
    ) {}

    async open(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('dvflow');
            const rawDfmPath = config.get<string>('dfmPath');
            
            let command: string;
            if (rawDfmPath) {
                const dfmPath = expandPath(rawDfmPath);
                if (fs.existsSync(dfmPath)) {
                    command = `"${dfmPath}" util run "${this.taskName}"`;
                } else {
                    const pythonPath = await findPythonInterpreter(this.rootPath);
                    command = `"${pythonPath}" -m dv_flow.mgr run "${this.taskName}"`;
                }
            } else {
                const pythonPath = await findPythonInterpreter(this.rootPath);
                command = `"${pythonPath}" -m dv_flow.mgr run "${this.taskName}"`;
            }
            
            this.outputChannel.clear();
            this.outputChannel.show(true);
            this.outputChannel.appendLine(`Running task: ${this.taskName}`);
            
            const process = child_process.exec(command, { cwd: this.rootPath });
            
            process.stdout?.on('data', (data: string) => {
                this.outputChannel.append(data);
                this.processOutput(data);
            });

            process.stderr?.on('data', (data: string) => {
                this.outputChannel.append(data);
                this.processOutput(data);
            });

            process.on('close', (code) => {
                const exitMessage = `\nTask ${this.taskName} completed with exit code ${code}`;
                this.outputChannel.appendLine(exitMessage);
                this.writeEmitter.fire(exitMessage + '\r\n');
                this.closeEmitter.fire(code ?? 0);
            });

        } catch (error) {
            const errorMessage = `Error running task: ${error instanceof Error ? error.message : String(error)}`;
            this.outputChannel.appendLine(errorMessage);
            this.writeEmitter.fire(errorMessage + '\r\n');
            this.closeEmitter.fire(1);
        }
    }

    close(): void {
        // Terminal closed
    }

    private processOutput(data: string): void {
        // Match error patterns and create diagnostic entries
        const errorRegex = /Error in (.+):(\d+)(?::(\d+))?: (.+)/;
        const matches = data.match(errorRegex);

        if (matches) {
            const [, file, line, column, message] = matches;
            const diagnosticCollection = vscode.languages.createDiagnosticCollection('dvflow');
            
            const lineNum = parseInt(line) - 1;
            const colNum = column ? parseInt(column) - 1 : 0;
            
            const range = new vscode.Range(
                new vscode.Position(lineNum, colNum),
                new vscode.Position(lineNum, Number.MAX_SAFE_INTEGER)
            );

            const diagnostic = new vscode.Diagnostic(
                range,
                message,
                vscode.DiagnosticSeverity.Error
            );

            const uri = vscode.Uri.file(file);
            diagnosticCollection.set(uri, [diagnostic]);
        }

        this.writeEmitter.fire(data);
    }
}
