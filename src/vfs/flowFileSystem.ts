import * as vscode from 'vscode';
import * as path from 'path';

export class FlowFileSystem implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private _files = new Map<string, Uint8Array>();

    watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        return {
            type: vscode.FileType.File,
            ctime: Date.now(),
            mtime: Date.now(),
            size: this._files.get(uri.toString())?.length || 0
        };
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        const entries: [string, vscode.FileType][] = [];
        this._files.forEach((_, key) => {
            if (path.dirname(key) === uri.toString()) {
                entries.push([path.basename(key), vscode.FileType.File]);
            }
        });
        return entries;
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const data = this._files.get(uri.toString());
        if (!data) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return data;
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
        if (!options.create && !this._files.has(uri.toString())) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (!options.overwrite && this._files.has(uri.toString())) {
            throw vscode.FileSystemError.FileExists(uri);
        }
        this._files.set(uri.toString(), content);
        this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    createDirectory(uri: vscode.Uri): void {
        // No-op since we only support files for now
    }

    delete(uri: vscode.Uri, options: { recursive: boolean }): void {
        this._files.delete(uri.toString());
        this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
        if (!options.overwrite && this._files.has(newUri.toString())) {
            throw vscode.FileSystemError.FileExists(newUri);
        }
        const data = this._files.get(oldUri.toString());
        if (!data) {
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
        this._files.set(newUri.toString(), data);
        this._files.delete(oldUri.toString());
        this._emitter.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri }
        ]);
    }
}
