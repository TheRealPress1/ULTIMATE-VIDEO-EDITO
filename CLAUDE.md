# Blackout: notes for AI coding agents

Blackout is a macOS-first Electron desktop video editor. A project is a folder holding a JSX composition (`index.tsx`), an `assets.yml` manifest and linked media. The editor draws and edits that composition, and a built-in assistant (the user's own Claude Code or Codex) edits it too. Direction: an editor for people who already edit well, with Premiere's vocabulary and keys. AI amplifies the editor, everything stays hand-editable, and every AI change is reviewable and undoable.

## Layout

- `apps/web`: the editor UI (Solid, Vite, Tailwind). Engine and timeline code is in `src/engine`, components in `src/components`, app state in `src/context`.
- `apps/desktop`: the Electron main process. IPC channels are typed in `src/main-channels.ts` and handled in `src/main.ts`; the web app calls them through `mainBridge` (`apps/web/src/lib/ipc.ts`).
- `apps/cli`: the `cutroom` command line.
- `packages/runtime`: headless editor runtime (traits, world, actions, systems, media decoding). `packages/assets`: the asset library and `assets.yml`. `packages/dapi`: the tool catalog agents use. `packages/agent-chat`: the agent host. `packages/jsx` and `packages/reconciler`: the composition language. `packages/encoder`: export. `packages/sam2`: segmentation.
- `docs/`: documentation that ships inside the app for the in-app agents (tools, JSX elements, skills). If you change a tool or an element, change its page.

## Commands

`npm install`, then `npm run dev:desktop -- --user-data-dir=<absolute path>`. Always give a development run a data folder of its own: without it the app shares the chats, settings and saved keys of an installed Blackout (see CONTRIBUTING.md). Then `npm run check`, `npm run test` and `npm run lint`. Run check and the tests before you commit, and eslint on the web files you changed.

## Rules

- Match the surrounding file: its quotes, its comment density, its naming. Comments say why, not what. No unrelated refactors in the same change.
- Test behavior changes. Web component tests mostly don't render components, so keep logic in plain modules (for example `*-data.ts`) and test it there. Prove a guard works by breaking it once and seeing a test fail.
- Main-process code that reaches the network or the file system takes its dependencies as parameters (`fetch`, a secure store, a directory), so tests run without either.
- Secrets live only in the main process, encrypted with `safeStorage`. They never go to the renderer, and never into a log, a test fixture or a commit.
- The user's footage and projects are theirs. Assets are linked where they are. Never write caches, sidecars or edits into the folders footage lives in, never delete a user's file, and in tests use temporary folders and synthetic media.
- Don't commit personal paths, names or project names.
- Don't bump versions, create tags, publish releases or touch signing and release workflows: those belong to the owner. `main` is protected, so work on a branch and open a pull request.

## Checking visible changes

Run the web app on a free port and drive it in a headless browser, with a stand-in for any main-process call it needs. Attach screenshots to the pull request.
