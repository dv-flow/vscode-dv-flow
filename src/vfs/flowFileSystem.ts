import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class FlowFileSystem implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;
    private _storagePath: string;

    constructor(context: vscode.ExtensionContext) {
        this._storagePath = path.join(context.globalStoragePath, 'flow-graphs');
        // Ensure storage directory exists
        if (!fs.existsSync(this._storagePath)) {
            fs.mkdirSync(this._storagePath, { recursive: true });
        }
    }

    private _getFilePath(uri: vscode.Uri): string {
        // Convert URI to a filesystem path in our storage directory
        const filename = uri.path.replace(/^\//, '');
        return path.join(this._storagePath, filename);
    }

    watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const filePath = this._getFilePath(uri);
        try {
            const stats = fs.statSync(filePath);
            return {
                type: vscode.FileType.File,
                ctime: stats.ctimeMs,
                mtime: stats.mtimeMs,
                size: stats.size
            };
        } catch (error) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        const dirPath = this._getFilePath(uri);
        try {
            return fs.readdirSync(dirPath)
                .map(entry => [entry, vscode.FileType.File] as [string, vscode.FileType]);
        } catch (error) {
            return [];
        }
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const filePath = this._getFilePath(uri);
        try {
            return fs.readFileSync(filePath);
        } catch (error) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
        const filePath = this._getFilePath(uri);
        try {
            if (!options.create && !fs.existsSync(filePath)) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            if (!options.overwrite && fs.existsSync(filePath)) {
                throw vscode.FileSystemError.FileExists(uri);
            }
            fs.writeFileSync(filePath, content);
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        } catch (error) {
            if (error instanceof vscode.FileSystemError) {
                throw error;
            }
            throw new Error(`Failed to write file: ${error}`);
        }
    }

    createDirectory(uri: vscode.Uri): void {
        // No-op since we only support files for now
    }

    delete(uri: vscode.Uri, options: { recursive: boolean }): void {
        const filePath = this._getFilePath(uri);
        try {
            fs.unlinkSync(filePath);
            this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
        } catch (error) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
        const oldPath = this._getFilePath(oldUri);
        const newPath = this._getFilePath(newUri);
        try {
            if (!options.overwrite && fs.existsSync(newPath)) {
                throw vscode.FileSystemError.FileExists(newUri);
            }
            fs.renameSync(oldPath, newPath);
            this._emitter.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri }
            ]);
        } catch (error) {
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
    }
}
