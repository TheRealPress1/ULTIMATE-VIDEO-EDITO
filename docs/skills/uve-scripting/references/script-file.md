# Writing brief.md

The script for a planned video lives in the project's `brief.md`. The full format is in [brief.md](../../../reference/brief.md). This page covers how the scripting skill writes the file.

## Rules for writing it

- **One brief per video project**, at the top of the project folder. Use `context` to find the project, or `open` to create it, before writing.
- **Start new files with** `<!-- cutroom:brief v1 -->` and a `# Title` line.
- **Touch only what you're changing.** Read the file first and rewrite only the sections you changed. The user may have edited the rest by hand.
- **Fixed headings:** `## Goal`, `## Viewer`, `## Ideas`, `## Script`, `## Shot plan`, `## Edit plan`, `## Notes`. Keep them in English, even when the script isn't, and set `language:` in Goal.
- **Script lines** are `N. [beat · emotion] words`, one sentence (two at most) per line, with an indented `> delivery: … | screen: … | sound: …` note where it helps. Number separate points (`point 1`, `point 2`).
- **Placeholders** for facts you don't have go inline: `⟦ask: …⟧`. List them in `## Notes` until the creator answers.
- **Line numbers are stable after the shoot.** Once takes exist, `script_read_compare` and the edit refer to lines by number. Change the words but don't renumber. Add new lines with the next free number and note where they go.
- **Lint after every change** with `script_lint`. A parser warning in its result means the file isn't quite in the format. Fix the file.

## Worked example

A freelance illustrator, a belief-flip of about 35 seconds:

```markdown
<!-- cutroom:brief v1 -->
# The fourth revision

## Goal
- viewer: a freelance illustrator two years in, doing a third free round of changes for a €400 job
- payoff: teach
- format: belief-flip
- target: 30-40 s
- aspect: 9:16
- platform: Instagram Reels
- language: en

## Viewer
Gets clients from Instagram DMs. Agrees prices in chat, starts sketching the same day, and treats "one more tweak?" as good service. Afraid that asking for terms will scare small clients away.

## Script
1. [opener · uneasy] You're not doing a fourth free revision because the client is difficult.
   > delivery: calm, a little tired | screen: tablet with "final_FINAL_v4.png" open, slow push in | sound: stylus taps, no music
2. [opener · curious] You're doing it because nothing you sent them said where the job ends.
3. [doubt · skeptical] And sending terms for a €400 job feels like overkill.
   > delivery: shrug, quicker
4. [turn · surprised] Small clients ask for the most rounds, because nobody told them the limit.
5. [point 1 · relieved] Before the first sketch, send four lines: what you deliver, two rounds of changes, the price, and the date.
   > screen: text card with the four lines | sound: soft music enters
6. [proof · proud] Since March, 23 clients have signed those four lines, and none asked for round three.
   > screen: phone scrolling the sent emails, client names blurred
7. [close · confident] Paste those four lines into your next quote tonight.
   > delivery: straight to lens, slower

## Shot plan
| # | Line | Point | Shot | Job | Source | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1-2 | opener | close, tablet screen | feel | film | to film | start mid-stroke |
| 2 | 3 | doubt | medium, to lens | feel | film | to film | |
| 3 | 5 | point 1 | text card | inform | graphic | to make | one line at a time |
| 4 | 6 | proof | over the shoulder, phone | inform | film | to film | blur client names |
| 5 | 7 | close | medium, to lens | feel | film | to film | |

## Edit plan
- pace: tight
- keep the pause after line 4

## Notes
- The number 23 and "since March" were confirmed by the creator on 3 November.
```

`script_lint` on this file finds no flags: 91 words, about 36 seconds at the default 150 wpm, inside the 30-40 s target. Its `opening.first4s` is "You're not doing a fourth free revision because the client", so the twist ("…is difficult") lands just after the four-second mark. That's the first thing to check in the table read. After the recording, lint again with the creator's measured rate before anyone starts cutting.
