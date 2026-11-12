# Example: script to reel

This walkthrough takes one 9:16 reel from a written script to a reviewed edit: write the script into `brief.md`, check it, plan the shots, record, compare the read with the script, assemble the best takes, tighten, add B-roll and captions, and review. The writing rules come from [scripting](../../skills/uve-scripting/SKILL.md) and the cutting rules from [clean edit](../../skills/uve-clean-edit/SKILL.md). The values below are illustrative.

The creator here makes houseplant videos. They paste a rough draft about watering a monstera by the weight of its pot instead of by the calendar.

## 1. Project and context

Open or create the video's project with `open`. Read what Blackout already knows: `memory` with `action: "view"` for the creator's profile (their viewer, voice, words they avoid, a measured reading rate) and `editing_style` with `action: "get"` for caption look and pacing. Read the scripting skill and its references with `skills`.

A pasted draft starts at the rewrite stage. Fill in `## Goal` from the request and the profile, and ask only for what's missing.

## 2. The draft in brief.md

Write the draft into the project's `brief.md` in the [brief format](../../reference/brief.md), labelled line by line:

```markdown
<!-- cutroom:brief v1 -->
# Water by weight

## Goal
- viewer: someone three months into their first big houseplant, a €60 monstera with yellowing leaves
- payoff: teach
- format: belief-flip
- target: 20-30 s
- aspect: 9:16

## Script
1. [opener · worried] Hey, your monstera's yellow leaves aren't asking for more water.
2. [opener · curious] They're asking you to stop watering on Sundays.
3. [doubt · skeptical] But the label said once a week.
4. [point 1 · focused] Lift the pot right after you water it, then again on day five, and feel how much lighter it is.
5. [proof · relieved] Honestly, this was a game changer for my plants.
6. [close · confident] Lift yours tonight and remember the weight.
```

## 3. Lint

`script_lint` reads `brief.md` by default:

```json
{}
```

It returns 61 words, about 24.4 s at the default 150 wpm (inside the target), `opening.first4s` = "Hey, your monstera's yellow leaves aren't asking for more water.", and three flags:

```json
[
  { "line": 1, "code": "greeting-opener", "message": "Opens with a greeting. A stranger owes the video nothing yet; start on the viewer's problem or the result." },
  { "line": 5, "code": "no-specifics-in-beat", "message": "The proof beat has no number, name or place; add one the creator gave you, or a ⟦ask: …⟧ placeholder for one." },
  { "line": 5, "code": "stale-phrase", "message": "Worn phrase \"game changer\"; say the specific thing instead." }
]
```

The greeting goes. The proof line needs a fact only the creator has, so don't invent one. Ask a single question: "What changed for your own plant, and by when?" The answer, "three yellow leaves a week, none by October", becomes line 5. The compression pass also turns "how much lighter it is" into the number the creator weighs: "feel the 600 grams it lost". Lint again: no flags, 63 words, about 25.2 s. Present the script with the opener's delivery, screen and sound notes, and a few bullets on what changed.

## 4. Shot plan

When the creator is about to film, add `## Shot plan` ([shot plan reference](../../skills/uve-scripting/references/shot-plan.md)). Look for what the project already has before planning a shoot. `visual_search` with `query: "watering can"` finds an earlier clip, which becomes `have:footage/sunday-watering.mov@14.2`. Root rot is easier to show than to film, so it becomes `web:monstera root rot close up` for [web media](../../skills/uve-web-media/SKILL.md). The weight becomes a `graphic`. Everything else is `film`, and those rows are the shoot list you give the creator.

## 5. Record and index

The creator records the read, as many takes as they like, in one file or several, and imports it into the project's library. Index it so its words are searchable:

```json
{ "paths": ["footage/monstera-read.mov"] }
```

That's `footage_index`. The first run on a new file transcribes it locally.

## 6. Table read

Compare the recording with the script using `script_read_compare`:

```json
{ "path": "footage/monstera-read.mov" }
```

Each line comes back with every take found for it, each take's coverage, its added, dropped and changed words and its pauses, the suggested `best` take, the lines never said (`unspoken`), the `overallWpm`, and `passages` ready for `footage_cut`. Use it to finish the script:

- Say the creator ad-libbed "every single Sunday" on line 2 and it plays better. Adopt it in `brief.md` and keep the line number.
- A line with long pauses inside every take is a hard line. Simplify it for a pickup, or keep the best take as it is.
- An unspoken line either wasn't needed or needs a pickup. Note it under `## Edit plan`.
- Lint again with `wpm` set to the measured rate, say 172 (the script is now about 22 s), and offer to remember the rate in the creator's profile with `memory`.

If `script_read_compare` isn't available, find each line with `footage_search` and compare by hand.

## 7. Assemble the scripted cut

Pass the compare result's `passages` to `footage_cut`, in script order, to build a new scene from the best takes:

```json
{
  "name": "Water by weight v1",
  "width": 1080,
  "height": 1920,
  "passages": [
    { "assetId": "<from the compare result>", "fingerprint": "<from the compare result>", "sourceIn": 3.62, "sourceOut": 9.15 },
    { "assetId": "<from the compare result>", "fingerprint": "<from the compare result>", "sourceIn": 47.8, "sourceOut": 51.06 }
  ]
}
```

It returns the new `sceneId`. The originals and every other scene stay as they were.

## 8. Tight pass

Short vertical talking heads get the `tight` pace unless the brief or `editing_style` says otherwise. Write `pace: tight` under `## Edit plan`. Inspect the new scene with `transcript_edit_inspect` using the tight profile and retake suggestions, remove what's left of the dead air and repeated attempts, and apply with `transcript_edit_apply`, as in the [talking head walkthrough](./talking-head.md). Keep a pause the brief asks for. Check every join.

## 9. B-roll from the shot plan

Work down the Source column:

- `have:` rows go in at their source time, with an explicit `start` on the timeline at the script line's time in the edit.
- `web:` rows: `web_media_search` with the query, look at the previews, then `web_media_download` the chosen one, which lands in the library and is credited in `CREDITS.md`.
- `graphic` rows become native titles or overlays ([motion graphics](../../skills/uve-motion-graphics/SKILL.md)).

Mark each row `placed` as it lands. The script's emotion labels decide where music changes, if the brief asks for music ([music](../../skills/uve-music/SKILL.md)).

## 10. Captions and review

Caption the edited scene with `captions`, then correct the wording against the script and check placement inside the 9:16 safe area ([caption finishing](../../skills/uve-caption-finishing/SKILL.md)). Review against the brief with [final review](../../skills/uve-final-review/SKILL.md): `check`, `capture` at the opener, at every join and at each B-roll entry, and a temporary draft export to hear the joins. Export the delivery file when the user asks for it.
