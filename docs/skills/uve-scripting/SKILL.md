---
name: uve-scripting
description: Take an idea, a topic or a rough draft to a short-form vertical script (Reels, Shorts, TikTok) the creator can read on camera, plus a shot plan, written to the project's brief.md. Covers choosing the viewer and thesis, picking a format, writing and auditing openers, laying out beats, rewrite passes, script_lint, and a table read against the recording. Use it for hooks, post ideas, scripts and B-roll or shot lists, even if the user never says "script". It stops before cutting; uve-clean-edit and the editor guide take over from there.
metadata:
  version: "1.0.0"
---

# Scripting short-form video

This skill covers everything from "I want to post about this" to lines the creator can say on camera and a plan for what the viewer sees under each one. Cutting the footage belongs to [clean edit](../uve-clean-edit/SKILL.md) and the [editor guide](../editor.md).

## Read first

- Call `memory` with `action: "view"` to see the creator's profile: who they are, who they make videos for, how they talk, the stories and proof they reuse, words they avoid, and openers that worked. Don't ask again for anything it already answers. If memory is empty or paused, use the brief's `## Viewer` and ask the user.
- Call `editing_style` with `action: "get"` for on-screen taste the shot plan has to respect, such as caption look and pacing.
- Read the project's `brief.md` if there is one (`context` names the open project). The format is in [brief.md](../../reference/brief.md).
- For a creator with a connected account, look at their own posts: `instagram_posts` with `sortBy: "views"`, plus [performance insights](../uve-performance-insights/SKILL.md) for what is worth testing. Treat the numbers as hints. They don't prove what caused anything.

To read a reference below, call `skills` with `action: "read"`, `id: "uve-scripting"` and `file: "references/openers.md"`, or open the link relative to the skill's `baseDir`.

## Stages

| Stage | What comes out | Reference |
| --- | --- | --- |
| 1. Viewer | One person at one moment, not a demographic | [audience](references/audience.md) |
| 2. Thesis | One sentence: what this viewer needs to believe or do | [idea bank](references/idea-bank.md) |
| 3. Format | One format and its beat sheet | [formats](references/formats.md) |
| 4. Opener | Ten or more candidates, audited, one chosen | [openers](references/openers.md) |
| 5. Beats | The body: the doubt answered early, the strongest point last | [formats](references/formats.md) |
| 6. Rewrite | Fixed passes until it sounds like the creator talking | [rewrite passes](references/rewrite-passes.md) |
| 7. Shot plan | One row per shot, each with a job | [shot plan](references/shot-plan.md) |
| 8. Table read | The recording checked against the script; the script and timing updated | [rewrite passes](references/rewrite-passes.md) |

Start where the user is. A topic or "what should I post?" starts at stage 1, a finished draft at stage 6, and a recording of a read at stage 8. Each stage limits the next. When a script won't come together, go back a stage instead of polishing lines.

## The creator's facts

Never invent numbers, names, stories, results, credentials or quotes. When a line needs one, write a placeholder like `⟦ask: how many students finished the course?⟧` and keep drafting. Then gather every placeholder into one message, ask one precise question per fact with a word on why it matters, and ask only once. A script with open placeholders is still a draft, so say that it is. `script_lint` flags each one as `open-placeholder` and leaves it out of the timing.

## Standing rules

- Talk to one viewer as "you". Never "you guys", "everyone" or "y'all".
- The thesis serves what the viewer needs, and the opener sells what they already want. Lead with the want.
- Answer the viewer's doubt straight after the opener, before they can raise it.
- Put the strongest point last. Keep to one takeaway per video, and spin extra points off into their own videos.
- End on one thing: an action they can take today, one line to remember, or the payoff of the joke. Never trail off, and never close with "thanks for watching".
- Use the viewer's words, not the creator's jargon. Use concrete numbers, names and places instead of adjectives.
- Tell story beats in the past progressive ("I was standing at the counter when…") so the viewer lives them in order.
- Keep the opener to two sentences at most, and land the first one within about four seconds.
- Never open with a greeting, a series counter ("Day 12 of…") or a self-introduction. If the creator's credibility matters, use a descriptor that earns attention instead, such as "a teacher who has marked 9,000 essays".

`script_lint` checks the mechanical rules. The rest is your judgment.

## Output

- **A specific video:** make sure a project is open (`open` an existing one or create one), then write or update `brief.md` in it with your file tools, following the format. Leave sections you didn't change exactly as they were. Brainstorms, such as ideas for many videos, opener lists or audience work, stay in chat unless the user wants them kept. Ideas can go under `## Ideas`.
- **Lint:** after every script change, run `script_lint`, which reads `brief.md` by default. Fix each flag, or say in one line why it stays. Set the target in `## Goal` or pass `targetSeconds`. Pass `voiceSample` with an indexed recording of the creator talking to compare the script against how they really speak.
- **Presenting:** show the spoken lines one per line with the opener marked. Under them, give the opener's delivery note, what's on screen, what the sound does, and the estimated length from the lint.
- **Revisions:** show the new script, then three to six bullets on what changed and why. Don't give a line-by-line diff.
- **Shot plan:** add it when the user asks or is about to film.
- **Memory:** save only facts the user states or confirms about themselves, such as their viewer, their voice, words to avoid or a measured wpm, with `memory` (`target: "profile"`). Facts about one video stay in its brief, and taste goes to `editing_style`.

## Table read and hand-off

Once a recording of the read exists, compare it with the script using `script_read_compare`. It finds each line's spoken occurrences, across several takes too. Words the creator added on camera become rewrites if they're better. Stumbles mark lines to simplify. The measured wpm replaces the estimate; offer to remember it in the profile. If that tool isn't in the tool list, index the recording (`footage_index`), find each line with `footage_search` and compare by hand.

Update `brief.md`, then hand off. [Clean edit](../uve-clean-edit/SKILL.md) cuts the best takes at the pace in `## Edit plan`. The shot plan's Source column drives the B-roll pass ([web media](../uve-web-media/SKILL.md), [motion graphics](../uve-motion-graphics/SKILL.md)). The whole path is the [script-to-reel walkthrough](../../guides/walkthroughs/script-to-reel.md).

## Tools

| Tool | Use it to |
| --- | --- |
| `context`, `open` | Find or create the video's project |
| `memory` | Read the creator's profile; save facts they confirm |
| `editing_style` | Read on-screen taste for the shot plan |
| `script_lint` | Count words, estimate timing, check the opener, flag the rules |
| `script_read_compare` | Check a recorded read or several takes against the script |
| `instagram_posts` | Find the creator's own outliers and openers that worked |
| `footage_index`, `footage_search` | Find the creator's own words in past footage: recurring questions, stories, their voice |
| `visual_search` | Find existing shots for the shot plan's Source column |
| `web_media_search` | Find licensed stock for shots the creator can't film |
