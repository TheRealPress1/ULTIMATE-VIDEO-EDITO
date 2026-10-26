# Saving, versions and portable projects

The desktop editor saves composition edits, the asset library and project settings automatically. The header shows **Saving**, **Saved**, or **Save failed**. A failure keeps the pending changes available: correct the disk or file problem and choose **Retry** (or press Cmd+S). Export, project moves, navigation and normal Quit wait for outstanding saves. Finish or cancel an active export before quitting.

Pending changes are journaled locally before the save request. Source writes also keep exact file plans and operation receipts inside `.cutroom/writes`, so an interrupted multi-file save can finish without inserting a clip twice. On reopening a project, recovery runs before compilation. A conflicting external source change is preserved and reported instead of silently overwritten. The app offers to reload after a renderer crash.

Retry also checks recovery records again after a temporary storage failure. Unreadable records remain intact. An unreadable or malformed `package.json` blocks settings writes, renaming and opening that would replace it; repair the record or restore a backup before retrying. A failed settings reload keeps the last displayed values and requires a successful read before new settings can be saved.

## Versions

Choose **Versions** in the editor header. Save a named version before an important edit, or restore one of the automatic checkpoints. Each restore creates a **Recovery checkpoint** of the current project first. Restore that checkpoint to reverse the restore.

New named versions can include a PNG preview of the active scene at its current playback time, with the editor canvas as a fallback. The preview is tied to the source fingerprint: if editing data changes while the picture is captured, saving that preview fails instead of attaching a misleading image. Earlier versions and automatic checkpoints may have no image. Previews capture one view and moment, not every frame of every scene.

Open a version's comparison to inspect saved and current previews, changed files, and recoverable layers. **Restore layer** replaces that layer or brings a missing layer back under its surviving parent, while preserving unrelated current edits. A missing caption can therefore return without undoing newer footage trims or title changes. Saved caption words are compared as well as the layer's JSX. If an older transcript would overwrite words used by another current layer, restoration creates a separate recovered caption asset; identical existing transcripts are reused.

Selective recovery supports static built-in layers with unambiguous IDs directly within an authored stage. Calculated content, spread properties, custom rendering, ambiguous IDs, missing parents and layers containing more than 2,000 elements require restoring the containing supported scene or the whole version. Caption files linked outside the project do not have saved historical words and cannot be selectively recovered. Media links are restored, but original footage is never copied or overwritten. A stale comparison must be refreshed before restoring.

Every selective restore uses the same durable recovery journal as a whole-version restore. Its merged target state and a before-restore checkpoint are saved first, so an interrupted multi-file change can be rolled back after restart. Recovery refuses to overwrite a conflicting external edit. The recovered target state also appears in history as an automatic version.

History includes composition source, the asset manifest, caption JSON files inside the project, and editing/export settings. It preserves the project's identity, name and other package metadata. Original footage and captions linked outside the project are not duplicated or overwritten by version restoration.

History travels with the folder in `.cutroom/versions`. It keeps the latest 50 versions within a 100 MB budget; an individual snapshot, including its preview, is limited to 20 MB. A preview must be a complete PNG below 1,000,000 data-URL characters, at most 2048 pixels on either side and 2,073,600 pixels total. Comparison displays are limited to 500 layers and 512,000 source characters, with at most 8,000 characters per snippet; restoration always uses the complete saved data. Automatic checkpoints occur on project compilation or source saving, at least 30 seconds apart. Versions share the project's disk, so keep a separate backup of footage and project folders.

## AI edits and interrupted sessions

Sending a prompt and choosing **Undo edit** or **Redo edit** wait for outstanding project saves. If saving fails, the agent does not start and the checkpoint stays unchanged. An unsent prompt returns to the composer alongside any follow-up text typed while waiting.

An interrupted agent session keeps its pre-edit checkpoint. On restart, the app recovers a review of the changes present then. **Recovered interrupted edit** can include manual or external changes made before reopening, so inspect **View changes** before undoing. Recovery does not undo the edit automatically.

The app also saves the conversation ID as soon as Claude Code or Codex confirms it, including during the first reply. Open the same chat after restarting and send your next instruction to resume that provider conversation. The original prompt is not resubmitted automatically. A startup interrupted before confirmation has no confirmed conversation to resume; retry starts a new one. If the provider's saved conversation was deleted or is unavailable, retaining its ID cannot restore its contents.

Conversation IDs and chat metadata are synced to disk before the app acknowledges saving them. A failed save stops session startup or the active query and reports the problem; retry after fixing storage. Reconnecting also retains messages that arrive while the chat history is loading, without replaying messages already included in that history.

The provider acknowledgments follow the [Claude Agent SDK session initialization](https://code.claude.com/docs/en/agent-sdk/sessions#capture-the-session-id) and [Codex thread start/resume](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread) protocols.

Undo and redo keep a durable restore record before replacing source files. If the app stops partway through, recovery completes or reverses that operation before another edit can start. Files changed outside that operation are preserved and a conflict is reported. Review errors are visible in the chat panel with **Retry review**; a conflicting file still needs to be resolved before restoration can proceed.

Chat history preserves incomplete log fragments and retries failed writes without joining a new message to a damaged line. A failed final history save reports an error and releases the running state, so the conversation can recover once storage is available again. Connection failures release pending requests promptly.

## Collect and relink

Choose **Media → Choose destination & collect** to make a new project copy with its local media. The copy has a new identity and fresh version history. The original project remains unchanged. Collection reports missing, remote or unsupported dynamic source references before publishing a copy; it does not claim that unresolved links are portable.

Choose **Media → Choose folder to search** to find missing manifest-linked media in a folder and its subfolders. Review matches and choose **Relink matched files**. If the library, matches or candidate files change after the preview, search again before applying. Duplicate matches remain unresolved. Size and the existing sampled content hash help prevent a different same-named file being substituted; older assets without a content hash require individual relinking. Relinking saves before/after versions.

## Export failures

Export checks required media from its current disk location, even when a preview was previously cached. Missing or undecodable contributing footage, audio, images and sequence frames fail with an error. Hidden, muted-only and out-of-workarea media do not block an export when they cannot contribute to it.

A destination is replaced only after encoding finishes successfully. Cancelling or failing an export discards the temporary output and keeps an existing finished file. This is independent of normal project saving and version history.
