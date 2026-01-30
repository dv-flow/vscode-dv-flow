/**
 * DFM Status Bar Item
 * 
 * Shows whether dfm (dv-flow-mgr) is discovered and available.
 * Provides quick visual feedback and click-to-test functionality.
 */

import * as vscode from 'vscode';
import { discoverDfm } from '../utils/dfmUtil';

export class DfmStatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private isAvailable: boolean = false;
    private lastCheckTime: number = 0;
    private checkInterval: number = 60000; // Check every minute

    constructor() {
        // Create status bar item (left side, priority 100)
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        
        this.statusBarItem.command = 'vscode-dv-flow.testDfmStatus';
        this.statusBarItem.tooltip = 'Click to test DFM discovery';
        
        // Initial check
        this.checkDfmStatus();
        
        // Show the item
        this.statusBarItem.show();
    }

    /**
     * Check dfm availability
     */
    async checkDfmStatus(): Promise<void> {
        try {
            const dfmPath = await discoverDfm();
            this.isAvailable = true;
            this.updateStatusBar(true, dfmPath);
        } catch (error) {
            this.isAvailable = false;
            const message = error instanceof Error ? error.message : String(error);
            this.updateStatusBar(false, message);
        }
        
        this.lastCheckTime = Date.now();
    }

    /**
     * Update status bar appearance
     */
    private updateStatusBar(available: boolean, details: string): void {
        if (available) {
            this.statusBarItem.text = '$(check) DFM';
            this.statusBarItem.tooltip = `DFM Available\nPath: ${details}\n\nClick to test`;
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.color = undefined;
        } else {
            this.statusBarItem.text = '$(alert) DFM';
            this.statusBarItem.tooltip = `DFM Not Available\nError: ${details}\n\nClick to test discovery`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        }
    }

    /**
     * Force refresh status
     */
    async refresh(): Promise<void> {
        await this.checkDfmStatus();
    }

    /**
     * Get current status
     */
    isReady(): boolean {
        return this.isAvailable;
    }

    /**
     * Show detailed status message
     */
    async showDetailedStatus(): Promise<void> {
        await this.checkDfmStatus();
        
        if (this.isAvailable) {
            const dfmPath = await discoverDfm();
            const message = `✅ DFM is available\n\nPath: ${dfmPath}\n\nTask discovery should work correctly.`;
            
            const testBtn = 'Test Query';
            const result = await vscode.window.showInformationMessage(message, testBtn, 'Show Log');
            
            if (result === testBtn) {
                // Test actual query
                await this.testDfmQuery();
            } else if (result === 'Show Log') {
                vscode.commands.executeCommand('vscode-dv-flow.showDiscoveryLog');
            }
        } else {
            const message = `❌ DFM is not available\n\n` +
                          `Task discovery will not work. Dynamic task completion is disabled.\n\n` +
                          `Solutions:\n` +
                          `1. Install dv-flow-mgr: pip install dv-flow-mgr\n` +
                          `2. Configure path: dvflow.dfmPath setting\n` +
                          `3. Ensure dfm is in your PATH\n\n` +
                          `Click "Show Log" to see detailed discovery process.`;
            
            const result = await vscode.window.showWarningMessage(message, 'Configure', 'Show Log', 'Retry');
            
            if (result === 'Configure') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'dvflow.dfmPath');
            } else if (result === 'Show Log') {
                vscode.commands.executeCommand('vscode-dv-flow.showDiscoveryLog');
            } else if (result === 'Retry') {
                await this.refresh();
                await this.showDetailedStatus();
            }
        }
    }

    /**
     * Test actual dfm query
     */
    private async testDfmQuery(): Promise<void> {
        try {
            const dfmPath = await discoverDfm();
            const child_process = require('child_process');
            const util = require('util');
            const exec = util.promisify(child_process.exec);
            
            const { stdout, stderr } = await exec(`${dfmPath} show tasks --package std --json`);
            
            const response = JSON.parse(stdout);
            const taskCount = response.results?.length || 0;
            
            vscode.window.showInformationMessage(
                `✅ DFM Query Success!\n\nDiscovered ${taskCount} tasks from std package.`,
                'Show Tasks'
            ).then(result => {
                if (result === 'Show Tasks') {
                    const taskList = response.results.map((t: any) => `  • ${t.name}`).join('\n');
                    vscode.window.showInformationMessage(
                        `Tasks from std:\n${taskList}`
                    );
                }
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(
                `❌ DFM Query Failed\n\n${message}\n\nCheck the DV Flow Discovery log for details.`,
                'Show Log'
            ).then(result => {
                if (result === 'Show Log') {
                    vscode.commands.executeCommand('vscode-dv-flow.showDiscoveryLog');
                }
            });
        }
    }

    /**
     * Auto-check periodically
     */
    startAutoCheck(): void {
        setInterval(async () => {
            const timeSinceLastCheck = Date.now() - this.lastCheckTime;
            if (timeSinceLastCheck > this.checkInterval) {
                await this.checkDfmStatus();
            }
        }, this.checkInterval);
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.statusBarItem.dispose();
    }
}
