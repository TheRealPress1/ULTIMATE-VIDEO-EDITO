# Shot plan

The shot plan turns a finished script into what the viewer sees, line by line. Write it once the script has passed its rewrites, because a line that changes breaks its shots.

## Every shot has a job

A shot either **adds feeling** (the cold coffee, the empty chair, the hands shaking) or **informs** (the receipt, the before/after, the step being done). If it does neither, stay on the speaker. A talking head is a choice, not a gap. Confessions, the turn of a story and the last line usually play best on the face.

## How often the picture changes

A change is a cut, a punch-in, a B-roll shot, a graphic or a text card.

- **Opening:** change quickly, roughly every second for the first few seconds, so the first frames feel alive.
- **Body:** change about every two to four seconds.
- **Beat boundaries:** change at every new beat, so the viewer sees the structure.
- **Variety:** use at least three shot sizes across the piece.

## Shot vocabulary

| Shot | Good for |
| --- | --- |
| Wide | Where we are; the setting as proof ("this is the actual flat") |
| Medium | The default talking frame; gestures |
| Close | Emphasis, emotion, the line that matters |
| Extreme close or insert | One detail: a number on a screen, a hand on a key |
| Over the shoulder | Seeing what the creator sees: a screen, a document, a person |
| POV or hands | Doing the step; how-to beats |
| High or low angle | Making something feel small or large; a change of status |
| Ultra-wide selfie | Movement and energy; walking and talking |
| Filmed screen | A phone or laptop in its real context (for readability, a screen recording cropped to the part that matters) |

## Craft

- **Motion in every shot.** The camera moves or the subject does. A still frame reads as a pause.
- **Start in action.** Cut in after the movement has begun, not before it.
- **Screens.** Film the device when the context matters and record the screen when the text must be read. Plan the crop for a phone held upright.
- **Proof shots.** Show the real thing: the email, the dashboard, the receipt. Cover what's private, like other people's names, account numbers and addresses. Show other people only with their consent, and note it in the brief.
- **Match cuts.** Two shots joined by a shared shape or motion, with the subject on the same side of the frame. Give each pair an id in Notes (`mc1`) so both halves get filmed.

## The table

Write it under `## Shot plan` in `brief.md`, one row per shot:

```
| # | Line | Point | Shot | Job | Source | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | opener | insert, lease on table | feel | film | to film | hand already moving |
| 2 | 3 | point 1 | over the shoulder, porteira's door | inform | have:footage/graca-walk.mov@41 | have | |
| 3 | 4 | proof | screen recording, bank app | inform | film | to film | cover the account number |
| 4 | 4 | proof | text card "€1,400 → €1,150" | inform | graphic | to make | |
| 5 | 5 | close | medium, to lens | feel | film | to film | same push as shot 1 (mc1) |
```

- **Line** is the script line number, or a range (`4-5`). **Point** is its beat.
- **Source** comes in four forms:
  - `have:<library path>@<seconds>`: a moment the project already has, found with `visual_search` (pictures) or `footage_search` (speech).
  - `film`: the creator has to shoot it. These rows are the shoot list.
  - `web:<query>`: licensed stock or a web image ([web media](../../uve-web-media/SKILL.md)).
  - `graphic`: a native title, card or overlay ([motion graphics](../../uve-motion-graphics/SKILL.md)).
- **Status** is one of `to film`, `to make`, `have` or `placed`. Update it as shots arrive and land in the edit.

## Check it

- **No long holds by accident.** Add up each run of lines with no change of picture. Over four seconds is worth a look unless it's a deliberate hold on the face. Use the table-read times from `script_read_compare` when there is a recording. Otherwise use `script_lint`'s `startEst` and `estSeconds` (about 2.5 words a second at 150 wpm).
- **Match-cut pairs** have both halves in the table.
- **Every `film` row** is something the creator can actually shoot this week. Give them the `film` rows as a numbered shoot list.
- **Privacy** notes are present on every proof shot that needs them.
