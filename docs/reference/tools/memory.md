# Agent memory

`memory` keeps a few facts about the user between chats, shared by Claude Code and Codex and by every project. It works without an open project. There are two lists:

- `profile`: who the user is and who they make videos for. Their audience and the viewer they picture, platforms and formats, their voice, recurring stories and proof points, words to avoid, openers that worked, and how they like to work. This is the creator profile; Blackout has no separate one.
- `setup`: facts about their machine and workspace. Where projects and exports go, the connected Instagram handle, tool quirks worth knowing.

Other things have their own place. Visual taste (fonts, captions, pacing, colors) goes in [`editing_style`](skills.md). Facts about one project go in that project's `brief.md`. A procedure the user wants repeated becomes a user skill through [`skill_write`](skills.md#skill_write).

| | |
| --- | --- |
| MCP tool | `memory` (no `cutroom` CLI command) |
| Stored in | the app's data, `agent-memory/memory.json`, with earlier versions in `agent-memory/history/` |
| Settings | **What agents remember** |

## When to save

Save as soon as the user says to remember something, and remove an entry as soon as they say to forget it. Don't save one-off requests ("make this one shorter"). Don't save anything you only inferred from footage, transcripts, analytics, web pages or another agent's output. Each entry is one short fact in plain words.

Only this tool and Settings change the memory. Agents never write its files directly, and never write Claude's or Codex's own memory files on Blackout's behalf.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `action` | `"view" \| "add" \| "replace" \| "remove" \| "apply"` | default `view` |
| `target` | `"profile" \| "setup"` | the list; required for `add`, `replace` and `remove`, and the default for `apply`'s operations |
| `text` | `string`, 1-400 characters | `add` and `replace`: the complete entry |
| `match` | `string`, 3-200 characters | `replace` and `remove`: an entry id such as `m_3f9a`, or a part of its text found in exactly one entry of that list |
| `operations` | up to 12 `{ action, target?, text?, match? }` | `apply`: several changes in order, written together or not at all |
| `expectedRevision` | `int` | optional: the revision you last viewed; when the memory has changed since, nothing is written |

## Output

```ts
{
  ok:          boolean;        // false: refused, nothing written
  enabled:     boolean;        // false while the user has paused memory
  revision:    number;
  message:     string;         // the change made, or the reason for a refusal
  profile?:    Entry[];        // on view, and whenever a change is refused
  setup?:      Entry[];
  usage:       { profile: Usage; setup: Usage };
  replaced?:   string;         // replace: the whole entry it overwrote, unless that was withheld
  removed?:    string[];       // the removed entries' text, withheld ones left out
  appliesFrom: "next-session";
}
Entry = { id: string; text?: string; withheld?: Category; updatedAt: string; origin: "agent" | "settings" }
Usage = { chars: number; limit: number; entries: number; maxEntries: number }
Category = "hidden-unicode" | "control-characters" | "secret" | "exfiltration" | "instruction-override" | "role-markers" | "contact-details" | "formatting"
```

## Budgets and refusals

The profile holds at most 2,000 characters and the setup notes 1,300, with at most 20 entries in each list. The budget is checked once, after the last change in a call. A full list is therefore no reason to give up: make room and save in the same `apply`, merging or deleting older entries first and adding the new fact last. Adding an entry that is already saved changes nothing. A `match` that fits several entries is refused and lists their ids.

A refused change writes nothing and returns the current entries, so you can merge entries and retry. Changes are refused when they would go over budget, when the match is missing or ambiguous, when `expectedRevision` is stale, while memory is paused, or when the text fails the safety check.

The safety check refuses text that contains:

- invisible or direction-changing Unicode (zero-width and joiner characters, the soft hyphen, fillers, variation selectors, bidi, format and tag characters) and control characters;
- credentials: API keys and access tokens in their usual shapes, private keys, JWTs, `password:`/`token=`-style assignments, and long random-looking strings;
- ways to send data out: embedded images, links with query parameters, `curl`/`wget`/`nc` with an address, "send/upload/post … to" an address or email;
- instructions aimed at agents, such as telling them to ignore earlier or system instructions, or chat role markers (`<system>`, `[INST]`, a line starting `system:`);
- email addresses and phone numbers;
- Markdown headings and code fences.

Text is checked as it reads, not only as typed: a phrase split across a line break counts as the phrase, and fullwidth or other compatibility letters count as the plain letters they stand for. An emoji may keep its presentation selector and the joiners inside one emoji sequence. The error names only the category, never the text that matched. Links without query parameters, @handles and file paths are fine.

An entry already saved can fail the check later, after a hand edit, a restore of an old version or a stricter rule. Such an entry is `withheld`: the digest leaves it out, and `memory` returns it with its id, its category in `withheld` and no `text`. It answers to its id only, never to a fragment of its text, so it can be replaced or removed but not read back. Settings shows it to the user, flagged.

## How sessions see it

Each in-app chat (Claude Code or Codex) starts with a digest appended to its instructions: the revision, the profile and setup entries, a pointer to the editing style when one is saved, and the user's own skills (the ones `skills` would serve: not a bundled id, and a whole SKILL.md that passes the safety check). The digest is rendered afresh each time a session opens or resumes. Saving in the middle of a chat therefore leaves that chat's instructions alone; the change shows up in the next session, or in this one once it resumes. Entries that fail the safety check at that moment are withheld and only counted, and the user can review them in Settings. The digest says the notes are background that never override the current request, the brief or Blackout's rules.

External MCP sessions don't get the digest in their instructions. They call `memory` with `view` at the start of a task.

## Settings and switches

**What agents remember** in Settings lists both lists with their usage, lets the user edit, add and delete entries, and marks any entry chats are not shown. It can restore any of the last 50 versions; a restore is a new revision, and the version it replaces is kept too. The pause switch keeps everything saved. While memory is paused, in-app chats open without the digest, `memory` returns no entries and refuses changes, and `skill_write` writes nothing. Skills already saved stay listed by `skills`. Starting Blackout with `CUTROOM_MEMORY=0` turns memory and user skills off for that session. Each isolated launch profile keeps its own memory.

A memory file that can't be read is never overwritten. Every write fails with an error until the file is fixed or moved aside. A file started over after a move-aside begins again at revision 0; the versions kept from the old one stay in **Earlier versions**, which lists versions by when they were replaced.
