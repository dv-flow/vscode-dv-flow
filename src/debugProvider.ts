import * as vscode from 'vscode';
import * as path from 'path';
import { findPythonInterpreter, getDfmCommand } from './utils/dfmUtil';

export class DVFlowDebugConfigProvider implements vscode.DebugConfigurationProvider {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    async provideDebugConfigurations(
        folder: vscode.WorkspaceFolder | undefined
    ): Promise<vscode.DebugConfiguration[]> {
        return [
            {
                type: 'dvflow',
                request: 'launch',
                name: 'Run DV Flow Task',
                task: '${command:dvflow.pickTask}'
            }
        ];
    }

    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): Promise<vscode.DebugConfiguration | null> {
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.fileName.endsWith('.dv')) {
                config.type = 'dvflow';
                config.name = 'Launch';
                config.request = 'launch';
                config.task = '${command:dvflow.pickTask}';
            }
        }

        if (!config.task) {
            const taskName = await vscode.window.showInputBox({
                placeHolder: 'Enter the task name to run',
                prompt: 'Enter the name of the DV Flow task you want to execute'
            });
            if (!taskName) {
                return null;
            }
            config.task = taskName;
        }

        if (!folder) {
            folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                vscode.window.showErrorMessage('No workspace folder found');
                return null;
            }
        }

        try {
            const pythonPath = await findPythonInterpreter(folder.uri.fsPath);
            config.pythonPath = pythonPath;
            config.cwd = folder.uri.fsPath;
            return config;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to resolve debug configuration: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
}

export class DVFlowDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    async createDebugAdapterDescriptor(
        session: vscode.DebugSession
    ): Promise<vscode.DebugAdapterDescriptor> {
        const cwd = session.configuration.cwd;
        const taskName = session.configuration.task;

        if (!cwd || !taskName) {
            throw new Error('Invalid debug configuration');
        }

        const command = await getDfmCommand(cwd, `run "${taskName}"`);
        this.outputChannel.appendLine(`Executing: ${command}`);

        return new vscode.DebugAdapterInlineImplementation(
            new DVFlowDebugSession(command, cwd, this.outputChannel)
        );
    }
}

class DVFlowDebugSession implements vscode.DebugAdapter {
    private command: string;
    private cwd: string;
    private outputChannel: vscode.OutputChannel;
    private messageEmitter = new vscode.EventEmitter<any>();
    readonly onDidSendMessage: vscode.Event<any> = this.messageEmitter.event;

    constructor(command: string, cwd: string, outputChannel: vscode.OutputChannel) {
        this.command = command;
        this.cwd = cwd;
        this.outputChannel = outputChannel;
    }

    handleMessage(message: any): void {
        if (message.type === 'request' && message.command === 'initialize') {
            this.sendResponse({
                type: 'response',
                request_seq: message.seq,
                success: true,
                command: message.command,
body: {
    supportsConfigurationDoneRequest: false,
    supportsAnsiCodes: true
}
            });
            
            this.sendEvent({
                type: 'event',
                event: 'initialized'
            });

const { exec } = require('child_process');
exec(this.command, { cwd: this.cwd }, (error: Error | null, stdout: string, stderr: string) => {
    if (stdout) {
        this.sendEvent({
            type: 'event',
            event: 'output',
            body: {
                category: 'stdout',
                output: stdout,
                ansi: true
            }
        });
    }
    if (stderr) {
        this.sendEvent({
            type: 'event',
            event: 'output',
            body: {
                category: 'stderr',
                output: stderr,
                ansi: true
            }
        });
    }
    if (error) {
        this.sendEvent({
            type: 'event',
            event: 'output',
            body: {
                category: 'stderr',
                output: error.message
            }
        });
    }
    this.sendEvent({
        type: 'event',
        event: 'terminated'
    });
});
        } else if (message.type === 'request' && message.command === 'disconnect') {
            this.sendResponse({
                type: 'response',
                request_seq: message.seq,
                success: true,
                command: message.command
            });
        }
    }

    private sendResponse(response: any): void {
        response.seq = 1;
        this.messageEmitter.fire(response);
    }

    private sendEvent(event: any): void {
        event.seq = 1;
        this.messageEmitter.fire(event);
    }

    dispose(): void {}
}
