.. DV Flow VSCode Extension documentation master file, created by
   sphinx-quickstart on Fri May  9 15:22:25 2025.
   You can adapt this file completely to your liking, but it should at least
   contain the root `toctree` directive.
########################
DV Flow VSCode Extension
########################

DV Flow provides an extension for the `VSCode <https://code.visualstudio.com/>`_ development 
environment to assist in developing and using DV Flow descriptions.

.. contents::
    :depth: 2

Installing
==========

The extension can be installed from the `VSCode Marketplace <https://marketplace.visualstudio.com/items?itemName=matthew-ballance.vscode-dv-flow>`_.

Configuring
===========

The DV Flow extension uses `DV Flow Manager <https://dv-flow.github.io/dv-flow-mgr>`_ 
to obtain much of the data that is displayed. The VSCode extension must be have access
to a Python interpreter with access to the DV Flow Manager package.

The DV Flow extension searches for the appropriate interpreter as follows:

* Checks the 'dfmPath' setting in VSCode settings
* Checks the `python.defaultInterpreterPath` setting in the workspace settings
* Checks for the existence of an `IVPM <https://fvutils.github.io/ivpm>`_ packages directory
* Checks the PATH for the `python3` executable


.. image:: imgs/dfmPath_setting.png

You can configure the `dfmPath` settings in the VSCode settings. The path is to 
the `dfm` executable. 

Features
========

Workspace View
--------------

The DV Flow extension contributes a workspace outline view. This 
view shows information about the tasks defined in the workspace
package. 

.. image:: imgs/dv_flow_workspace_view.png

This view is always active, and can be manually-refreshed via `refresh` button.

Single-clicking (selecting) an entry in the `tasks` collection will
open an editor on the task's declaration.


Static Graph View
-----------------

A graphical representation of a task's execution graph can be opened
from the `task` entries in the workspace view.

.. image:: imgs/dv_flow_open_graphview.png

This will open a new tab containing a graphical view of the task graph.

.. image:: imgs/dv_flow_graphview.png

Hovering over nodes in the graph will show the value of the task's parameters.

.. image:: imgs/dv_flow_hover_graphview.png

flow.dv Editor
-------------- 

A simple YAML text editor is provided for editing flow.dv files. All
files named `flow.dv` are associated by default. The language `dvflow`
can be used to associate additional file extensions with the editor.


.. toctree::
   :maxdepth: 2
   :caption: Contents:

