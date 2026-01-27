# Change Log

All notable changes to the "vscode-dv-flow" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.3.1] - 2026-01-26

### Added

- **Improved DFM Discovery**: Enhanced executable discovery with debugging support
  
  - **Configuration Options**:
    - `dvflow.dfmPath`: Explicitly specify the path to the dfm executable
    - `dvflow.pythonPath`: Specify the Python interpreter to use
    - `dvflow.debug.logDfmDiscovery`: Enable logging of the discovery process
  
  - **Discovery Process** (in priority order):
    1. Configured `dvflow.dfmPath` setting
    2. `ivpm.yaml` deps-dir: `packages/python/bin/dfm` or `packages/python/scripts/dfm`
    3. `.envrc` with direnv: `direnv exec . which dfm`
    4. System PATH: `which dfm`
    5. Fallback: `python -m dv_flow.mgr`
  
  - **New Commands**:
    - `DV Flow: Test DFM Discovery` - Run discovery and show detailed results
    - `DV Flow: Show Discovery Log` - Open the discovery log output channel

### Fixed

- Hover over task references now correctly shows description (`desc:` or `doc:`)
- Go to Definition for task references in `needs` lists works correctly
- Context detection for `uses:` and `needs:` patterns improved

## [0.3.0] - 2026-01-26

### Added

- **Run Panel** (Phase 3): Dedicated panel for workflow execution
  
  - **Real-Time Progress**: Live progress display during task execution
    - Progress bar with percentage and task count
    - Duration tracking for the overall run
    - Task state indicators (running, completed, failed, cached)
  
  - **Task Status List**: See all tasks and their states
    - Running tasks with spinner animation
    - Completed tasks with duration
    - Failed tasks highlighted in red
    - Cached tasks marked with skip icon
  
  - **Multi-Root Support**: Root-aware execution
    - Root selector showing active package
    - Task dropdown for quick selection
    - Run and Run Clean buttons
    - Stop button to cancel execution
  
  - **Output Streaming**: Live log output
    - Last 20 lines shown in panel
    - "View Full" button to open output channel
    - Color-coded task status messages

- **Task Details Panel**: Rich task information display
  
  - **Task Information**: Comprehensive task metadata
    - Task name and full qualified name
    - Task type badge (uses)
    - Source location with click-to-navigate
    - Description if available
  
  - **Dependency Navigation**: Explore task relationships
    - List of dependencies (needs)
    - List of dependents (tasks that need this task)
    - Click any dependency to view its details
  
  - **Quick Actions**: Convenient task operations
    - Run button to execute the task
    - Debug button to start debugging
    - Graph button to open dependency graph
    - Rundir button to reveal run directory

- **New Views**: Additional panels in DV Flow activity bar
  - Run view for workflow execution
  - Task Details view for task inspection

- **New Commands**:
  - `DV Flow: Show Task Details` - Open task details panel
  - `DV Flow: Show Run Panel` - Focus the run panel

## [0.2.0] - 2026-01-26

### Added

- **Intelligent Editing Support** (Phase 2)
  
  - **Hover Information**: Rich tooltips when hovering over flow elements
    - Task definitions show description, base type, and dependencies
    - Task types (std.FileSet, std.Exec, etc.) show parameter documentation
    - Parameters show type and default values
    - Expressions show variable context information

  - **Go to Definition** (F12): Navigate to symbol definitions
    - Jump to task definitions from `needs` references
    - Navigate to imported package files
    - Go to parameter definitions from expressions

  - **Find All References** (Shift+F12): Find all usages of a symbol
    - Find all references to tasks across documents
    - Find parameter references in expressions

  - **Rename Symbol** (F2): Safely rename tasks and parameters
    - Renames task definitions and all references
    - Updates parameter references in expressions
    - Works across multiple files

  - **Enhanced Autocompletion**: Context-aware suggestions
    - Task type completion for `uses:` with documentation
    - Parameter completion based on base task type
    - Task reference completion in `needs:` lists
    - Expression variable completion (${{ }})
    - Import package suggestions

  - **Real-Time Diagnostics**: Inline error and warning reporting
    - Duplicate task name detection
    - Undefined task reference warnings
    - Invalid expression syntax errors
    - Integration with `dfm validate` command
    - Debounced validation on typing

## [0.1.0] - 2026-01-26

### Added

- **Multi-Root Workspace Support**: The extension now discovers and manages multiple flow.yaml/flow.dv files in a workspace
  - Automatic discovery of all flow roots in the workspace
  - Distinguishes between standalone roots (runnable) and imported packages
  - Active root selection via status bar or command palette
  - Per-root context for task execution

- **Enhanced Flow Explorer**: Redesigned tree view with categorized structure
  - Hierarchical view: Workspace → Flow Roots → Package Contents
  - Categories for Parameters, Imports, Tasks, Types, Configurations, and Files
  - Visual indicators for active root package
  - Icons for different node types (packages, tasks, imports, etc.)

- **New Commands**:
  - `DV Flow: Select Active Root` (Ctrl+Shift+R / Cmd+Shift+R) - Quick picker to switch roots
  - `DV Flow: Set as Active Root` - Context menu command on root packages
  - `DV Flow: Discover Flow Roots` - Rescan workspace for flow files
  - `DV Flow: Run Task` (Ctrl+Shift+T / Cmd+Shift+T) - Run a task with root awareness

- **Status Bar Integration**: Shows the currently active flow root with click-to-switch functionality

- **Configuration Options**:
  - `dvflow.discovery.include`: Glob patterns to include when discovering flow files
  - `dvflow.discovery.exclude`: Glob patterns to exclude from discovery
  - `dvflow.discovery.roots`: Explicit patterns for standalone root packages
  - `dvflow.discovery.importedOnly`: Patterns for import-only packages
  - `dvflow.execution.rundirBase`: Base directory for run directories
  - `dvflow.execution.isolateRoots`: Create separate rundirs per root
  - `dvflow.ui.showRootInStatusBar`: Show active root in status bar

### Changed

- Task execution is now root-aware, using the active root's context
- Output channel shows the root package name when running tasks

## [0.0.8] - Initial Release

- Initial release with basic workspace explorer
- Task graph visualization with d3-graphviz
- Run task command via context menu
- Debug adapter for task execution
- VSCode task integration
- Go to definition for tasks
- Basic YAML completion for flow files