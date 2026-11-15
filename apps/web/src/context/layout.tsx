/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, type Accessor, type JSX } from 'solid-js';
import { assert } from '@/utils';
import { createStoredSignal } from '@/lib/store';
import { store } from '@/init';

/** Where the toolbar sits over the canvas: one of six slots it snaps to when dragged, along the top and bottom edges. */
export const TOOLBAR_SLOTS = ['bottom', 'top', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

export type ToolbarSlot = (typeof TOOLBAR_SLOTS)[number];

/**
 * What the stage is for. Edit is the program monitor: one scene, fitted to
 * its frame, with the transport under it. Board is the canvas of scenes with
 * the drawing tools.
 */
export const WORKSPACES = ['edit', 'board'] as const;

export type Workspace = (typeof WORKSPACES)[number];

type LayoutContextValue = {
  uiVisible: Accessor<boolean>;
  timelineMinimized: Accessor<boolean>;
  timelineHeight: Accessor<number>;
  setTimelineHeight(height: number): void;
  toolbarSlot: Accessor<ToolbarSlot>;
  setToolbarSlot(slot: ToolbarSlot): void;
  projectPanelHeight: Accessor<number>;
  setProjectPanelHeight(height: number): void;
  workspace: Accessor<Workspace>;
  setWorkspace(workspace: Workspace): void;
  toggleUI(): void;
  toggleTimeline(): void;
};

const LayoutContext = createContext<LayoutContextValue>();

/** The panel under the agent: its height, clamped to what the column can hold when it is used. */
export const MIN_PROJECT_PANEL_HEIGHT = 120;
export const DEFAULT_PROJECT_PANEL_HEIGHT = 300;

export const MIN_TIMELINE_HEIGHT = 120;
export const DEFAULT_TIMELINE_HEIGHT = 234;

export function LayoutProvider(props: { children: JSX.Element }) {
  const [uiVisible, setUiVisible] = createStoredSignal(
    store.define<boolean>('layout.uiVisible', true),
  );

  const [timelineHeight, setTimelineHeight] = createStoredSignal(
    store.define<number>('layout.timelineHeight', DEFAULT_TIMELINE_HEIGHT),
  );
  const [timelineMinimized, setTimelineMinimized] = createStoredSignal(
    store.define<boolean>('layout.timelineMinimized', false),
  );

  const [toolbarSlot, setToolbarSlot] = createStoredSignal(
    store.define<ToolbarSlot>('layout.toolbarSlot', 'bottom', (value) =>
      TOOLBAR_SLOTS.includes(value) ? value : 'bottom',
    ),
  );

  const [projectPanelHeight, setProjectPanelHeight] = createStoredSignal(
    store.define<number>('layout.projectPanelHeight', DEFAULT_PROJECT_PANEL_HEIGHT, (value) =>
      Number.isFinite(value) && value >= MIN_PROJECT_PANEL_HEIGHT ? value : DEFAULT_PROJECT_PANEL_HEIGHT,
    ),
  );

  const [workspace, setWorkspace] = createStoredSignal(
    store.define<Workspace>('layout.workspace', 'edit', (value) => (WORKSPACES.includes(value) ? value : 'edit')),
  );

  const toggleUI = () => setUiVisible(!uiVisible());
  const toggleTimeline = () => setTimelineMinimized(!timelineMinimized());

  return (
    <LayoutContext.Provider
      value={{
        uiVisible,
        timelineMinimized,
        timelineHeight,
        setTimelineHeight,
        toolbarSlot,
        setToolbarSlot,
        projectPanelHeight,
        setProjectPanelHeight,
        workspace,
        setWorkspace,
        toggleUI,
        toggleTimeline,
      }}>
      {props.children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const ctx = useContext(LayoutContext);
  assert(ctx, 'useLayout must be used within LayoutProvider');
  return ctx;
}
