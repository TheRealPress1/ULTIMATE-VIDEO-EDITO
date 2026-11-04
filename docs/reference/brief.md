# brief.md: the project brief

Each video project can keep its plan in one plain markdown file, `brief.md`, at the top of the project folder. The [scripting skill](../skills/uve-scripting/SKILL.md) writes it and [`script_lint`](./tools/script.md) reads it by default. The other editing skills read it to learn the goal, the viewer and the edit plan. Agents write it with their own file tools, which are allowed inside the open project without asking. The user can change it in any text editor. Cutroom has no Script panel yet, so the file is the only copy.

The format is loose on purpose. Every section is optional and sections can come in any order. A file the parser can't fully read still works: the parser never fails, and anything it had to guess comes back as a warning.

## Sections

Sections are level-2 headings (`## `). Keep the headings in English, even when the script is in another language, so tools can find them.

| Heading | Holds | Read by |
| --- | --- | --- |
| `## Goal` | `key: value` lines: viewer, payoff, format, target, aspect, platform, language | `script_lint` (target length, language), every skill |
| `## Viewer` | Who the video is for, in prose | scripting, final review |
| `## Ideas` | Idea records while the video is still being chosen | scripting |
| `## Script` | The spoken lines, numbered, with beat and emotion labels and optional notes | `script_lint`, `script_read_compare`, clean edit, captions |
| `## Shot plan` | A table with one row per shot | B-roll and graphics passes |
| `## Edit plan` | Source ranges, pace profile, anything the cut must respect | clean edit, editor |
| `## Notes` | Anything else: open questions, approvals, rights | everyone |

Other headings are kept and ignored. If a heading appears twice, only the first one is read. Only a heading that says exactly `## Script` holds the script. `## Script draft` or `### Script` won't be read as the script, and the parser warns about them. You can put the marker comment `<!-- cutroom:brief v1 -->` anywhere in the file to record the format version.

## Goal

One `key: value` per line. Bullets and bold keys are fine. Keys are case-insensitive:

- `viewer` (or `audience`): one specific person, not a demographic.
- `payoff`: what the viewer gets: `teach`, `amuse` or `move`.
- `format`: the structure, such as `how-to`, `list`, `belief-flip` or `story` (see the [formats reference](../skills/uve-scripting/references/formats.md)).
- `target` (or `length`): the spoken length. `30-40 s`, `0:45`, `1-2 min` and `under 60 s` all work. A single number like `45 s` means 15% either side of it.
- `aspect`, `platform`: for example `9:16` and `Instagram Reels`.
- `language`: a tag such as `en` or `fr`. `script_lint` runs its English word lists only for English.

## Script

One spoken line per numbered item, usually one sentence and never more than two:

```
N. [beat · emotion] The words exactly as they will be said.
   > delivery: … | screen: … | sound: …
```

- **Number.** Lines are numbered from 1, and later tools refer to them by number. Renumbering is fine while drafting. After the shoot, keep the numbers stable so takes and shots still match.
- **Beat.** What the line does: `opener`, `doubt` (the viewer's objection, answered), `point`, `proof`, `turn`, `payoff` or `close`, or a word of your own such as `story`. Consecutive lines with the same label count as one beat, so number separate points (`point 1`, `point 2`) to keep them apart. `hook` is read as `opener` and `cta` as `close`.
- **Emotion.** One word for what the viewer should feel on that line, like `curious`, `relieved` or `proud`. The labels feed the shot plan and the music.
- **Notes.** An indented `>` line under a script line carries `delivery:` (tone, pace, emphasis), `screen:` (shot, on-screen text) and `sound:` (music change, effect, silence), separated by ` | `. A pipe inside a field is kept, as long as it isn't followed by one of those three keys. A note without a key is kept as plain text, and is written back first so it stays separate from the keyed fields.
- **Not spoken.** `⟦ask: …⟧` marks a fact still to come from the creator. `[stage directions]` and `{cues}` inside a line are read but not said. `script_lint` and `script_read_compare` leave all three out of word counts and timing, and `script_lint` flags each open placeholder.

The separator between beat and emotion can be `·`, `|`, `/`, `;` or `,`. The parser also takes lines it has to guess at, and warns each time: unnumbered sentences, bullets and whole paragraphs are split into sentences and numbered after the highest number written anywhere in the script, so the numbers you wrote never move. Indented text under a numbered line continues that line. A repeated number is renumbered the same way.

## Shot plan

A markdown table with these columns:

```
| # | Line | Point | Shot | Job | Source | Status | Notes |
```

- `#` is the shot number and `Line` the script line it covers (`4` or `4-5`). `Point` is the beat it belongs to.
- `Shot` is the size and angle (`wide`, `medium`, `close`, `insert`, `over-shoulder`, `POV hands`, `screen recording`…).
- `Job` is `feel` or `inform`, and a shot needs at least one of them.
- `Source` says where the picture comes from. `have:<library path>@<seconds>` is a frame found in the project (`visual_search`, `footage_search`). `film` means the creator still has to shoot it. `web:<query>` is a licensed search ([web media](../skills/uve-web-media/SKILL.md)). `graphic` is a native title or overlay ([motion graphics](../skills/uve-motion-graphics/SKILL.md)).
- `Status` is `to film`, `to make`, `have` or `placed`. `Notes` is free text, such as a match-cut pair id like `mc1`.

Missing cells read as empty, with a warning. Write `\|` for a pipe inside a cell.

## Edit plan, Viewer, Ideas, Notes

These are free markdown. Common lines in an edit plan are `pace: tight` or `pace: natural` (see the clean-edit skill), the takes or source ranges to use, and what must not be cut.

## Example

```markdown
<!-- cutroom:brief v1 -->
# Eight minutes a day

## Goal
- viewer: an adult who bought a guitar last spring and hasn't played it since
- payoff: teach
- format: belief-flip
- target: 30-40 s
- aspect: 9:16
- platform: Instagram Reels
- language: en

## Viewer
Started at 34 after a friend's wedding. Learned from hour-long lessons on a laptop and gave up when the F chord buzzed for three weeks. Thinks practice only counts in half-hour blocks.

## Script
1. [opener · curious] Your guitar isn't in the corner because you're lazy.
   > delivery: dry, half a smile | screen: guitar leaning in a corner, slow push in | sound: room tone only
2. [opener · curious] It's there because every lesson you tried wanted thirty minutes a day.
3. [doubt · skeptical] And eight minutes sounds too small to count.
   > delivery: raise an eyebrow, quicker
4. [point 1 · relieved] Keep it on a $15 stand next to the kettle, out of its case.
   > screen: hands lift the guitar off the stand | sound: kettle click
5. [point 2 · focused] While the water boils, switch between G and C until the kettle clicks off.
   > screen: text "G → C" over the fretboard
6. [proof · proud] My student Dana did that for 41 mornings and played her sister's birthday in June.
   > screen: Dana's phone clip from the party | sound: party chatter under the voice
7. [payoff · warm] Eight minutes every morning beats an hour every Sunday.
8. [close · warm] Put yours on a stand tonight.
   > delivery: straight to lens, slower

## Shot plan
| # | Line | Point | Shot | Job | Source | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1-2 | opener | wide, slow push in | feel | film | to film | start already moving |
| 2 | 4 | point 1 | close, hands | inform | have:footage/stand-morning.mov@12.5 | have | |
| 3 | 5 | point 2 | insert, fretboard | inform | graphic | to make | chord names track the fingers |
| 4 | 6 | proof | phone clip, vertical | feel | have:footage/dana-party.mp4@3 | have | Dana approved, see notes |
| 5 | 8 | close | medium, to lens | feel | film | to film | match the push from shot 1 (mc1) |

## Edit plan
- pace: tight
- A-roll: the best full read of lines 1-8; pickups for line 6

## Notes
- Dana agreed by text on 2 November to be named and shown.
```

## For tools

`@diffusionstudio/dapi` exports the parser so every tool reads the file the same way:

- `parseBrief(text)` returns `{ version, goal, viewer, ideas, script, hasScript, shotPlan, editPlan, notes, sections, warnings }`. Each script line is `{ n, beat?, emotion?, text, notes?: { delivery?, screen?, sound?, other? } }`. Shot plan rows are keyed by lowercased header, so a row's source is `row.source`. The parser is pure, never throws, and accepts CRLF files and a byte-order mark.
- `parseScript(text)` reads bare lines with no sections, the same way the Script section is read.
- `formatScriptLine(line)` and `formatScriptLines(lines)` write lines back in the form above.
- `replaceScript(markdown, lines)` rewrites only the body of the Script section. It leaves every other byte alone, line endings included, and adds the section at the end if the file has none.
