# open

Open a folder as a project in the running app, creating the project files if the folder is not one yet, and show it in the editor. Returns the project's id, display name, and folder. Run this once before tools that need an open project (capture, check, export, context, and library paths in media tools).

| | |
| --- | --- |
| MCP tool | `open` |
| CLI | `cutroom open [path] [options]` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `dir` | `string`, required | `[path]` | absolute path of the project folder to open or create |
| — | | `-b, --background` | launch or keep the app in the background, without raising a window (CLI only) |

## What opening writes

The folder does not have to be a project yet; opening is what makes it one. Because an open project is where tools may write freely, `open` accepts only: an existing Cutroom project anywhere on disk (its `package.json` has a `projectId`), the current project or a folder inside it, a folder inside a temporary directory, or a new or empty folder where a new file could be created (the project, temporary folders, Desktop, Documents, Downloads, Movies, Music, Pictures). An existing folder that isn't a Cutroom project — a folder of footage, your home folder, Desktop itself — is refused; open it from the app's dashboard, which makes it a project, or copy its files into a new folder and open that. These rules hold for every client, the CLI included. Opening writes as little as it takes:

- a missing folder is created;
- a folder with no entry file (package.json `main`, or `index.tsx` and friends) gains an `index.tsx` holding an empty stage;
- a folder with no project record gains one in `package.json` — `projectId`, `displayName`, `main`, and the cutroom commands as `scripts` — which is what the app remembers the folder by. A package.json that is already there keeps everything it has and only gains the fields it lacks.

Nothing else is written — no tsconfig, README, or .gitignore. Those come with a project created from the app's dashboard; a folder opened from anywhere on disk stays the user's. A folder that is already a project is opened untouched, wherever it lives. A JavaScript project (an entry ending in `.js` or `.jsx`) is left entirely alone, record included.

The app remembers the folder, so the project reopens across app relaunches and stays addressable by folder name or project id. Tools write into the folder that was opened: if it is later moved, renamed, or replaced by a link, they stop treating it as the project (`The open project's folder changed on disk; reopen the project.`) until it is opened again.

Keep the folder out of cloud-synced locations: iCloud Drive (including a synced Desktop or Documents), Dropbox, OneDrive, and Google Drive. Sync clients evict media to placeholders, upload half-written renders, and leave conflict copies. Open a local folder outside the synced tree instead.

## From a shell

`cutroom open` is also how the app starts: it launches Cutroom (macOS and Windows) or surfaces the running instance, then, given a path, calls the tool. With no path it only makes sure the app is up, printing nothing and exiting `0` once the app answers. Relative paths resolve against the shell's working directory. `--background` launches or keeps the app without raising a window — the way to drive the editor headless.

Over MCP the app is already running, since that is what the connection is to; the tool only opens the folder, and `dir` must be absolute.

## Output

The opened project:

```ts
{
  id:   string;   // package.json `projectId`; "" only for a JavaScript project, which gets no record
  name: string;   // display name (falls back to the folder name)
  dir:  string;   // absolute project folder, as opened
}
```

## Errors

- The path is not absolute (`The project folder must be an absolute path`).
- The folder is not one `open` may make the project: an existing folder that isn't a Cutroom project, or a new folder outside the places listed above (see [What opening writes](#what-opening-writes)).
- The path exists but is not a folder.
- From a shell on Linux, or from a `cutroom` that is not the one the app ships (a workspace build on Windows), the app cannot be launched; the command then requires it to already be running.
