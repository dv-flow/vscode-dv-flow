/**
 * Active Root Status Bar
 * 
 * Shows the currently active flow root in the status bar and allows
 * quick switching between roots via a picker.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceManager, FlowRoot } from '../workspace';

export class ActiveRootStatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private workspaceManager: WorkspaceManager;

    constructor(workspaceManager: WorkspaceManager) {
        this.workspaceManager = workspaceManager;
        
        // Create status bar item (aligned to the left, after other items)
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        
        this.statusBarItem.command = 'vscode-dv-flow.selectActiveRoot';
        this.statusBarItem.tooltip = 'Click to switch DV Flow root';
        
        // Subscribe to active root changes
        this.workspaceManager.onDidChangeActiveRoot(() => {
            this.update();
        });
        
        this.workspaceManager.onDidDiscoverRoots(() => {
            this.update();
        });
        
        this.update();
    }

    /**
     * Update the status bar display
     */
    update(): void {
        const activeRoot = this.workspaceManager.getActiveRoot();
        const allRoots = this.workspaceManager.getAllRoots();
        
        if (activeRoot) {
            this.statusBarItem.text = `$(package) ${activeRoot.packageName}`;
            this.statusBarItem.tooltip = `Active DV Flow Root: ${activeRoot.packageName}\nPath: ${activeRoot.relativePath}\n\nClick to switch (${allRoots.length} root(s) available)`;
            this.statusBarItem.show();
        } else if (allRoots.length > 0) {
            this.statusBarItem.text = `$(package) Select Root`;
            this.statusBarItem.tooltip = `No active root selected\nClick to select from ${allRoots.length} available root(s)`;
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    /**
     * Show picker to select a root
     */
    async showRootPicker(): Promise<FlowRoot | undefined> {
        const standaloneRoots = this.workspaceManager.getStandaloneRoots();
        const importedPackages = this.workspaceManager.getImportedPackages();
        const activeRoot = this.workspaceManager.getActiveRoot();
        
        if (standaloneRoots.length === 0 && importedPackages.length === 0) {
            vscode.window.showInformationMessage('No DV Flow roots found in workspace');
            return undefined;
        }

        interface RootQuickPickItem extends vscode.QuickPickItem {
            root: FlowRoot;
        }

        const items: RootQuickPickItem[] = [];

        // Add standalone roots
        if (standaloneRoots.length > 0) {
            items.push({
                label: 'Standalone Roots',
                kind: vscode.QuickPickItemKind.Separator,
                root: undefined as any
            });
            
            for (const root of standaloneRoots) {
                const isActive = activeRoot?.path === root.path;
                items.push({
                    label: `${isActive ? '$(check) ' : ''}${root.packageName}`,
                    description: root.relativePath,
                    detail: isActive ? 'Currently active' : undefined,
                    root
                });
            }
        }

        // Add imported packages
        if (importedPackages.length > 0) {
            items.push({
                label: 'Imported Packages',
                kind: vscode.QuickPickItemKind.Separator,
                root: undefined as any
            });
            
            for (const pkg of importedPackages) {
                const isActive = activeRoot?.path === pkg.path;
                items.push({
                    label: `${isActive ? '$(check) ' : ''}${pkg.packageName}`,
                    description: pkg.relativePath,
                    detail: `Imported by: ${pkg.importedBy.length} root(s)`,
                    root: pkg
                });
            }
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select DV Flow Root',
            matchOnDescription: true
        });

        if (selected && selected.root) {
            this.workspaceManager.setActiveRoot(selected.root.path);
            return selected.root;
        }

        return undefined;
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
