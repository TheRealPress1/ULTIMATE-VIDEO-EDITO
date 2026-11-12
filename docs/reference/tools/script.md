# Script tools

A video's script lives in its project's [`brief.md`](../brief.md), under `## Script`. The [scripting skill](../../skills/uve-scripting/SKILL.md) writes it and these tools read it. Neither tool edits the brief. Agents change the file with their own file tools, and the user changes it in any text editor.

## script_lint

`script_lint` runs fixed checks on a short-form script and reports counts, timing and flags. It is deterministic: the same script and settings give the same result every time. It runs in the app without a window and only reads.

```json
{}
```

With no arguments it reads `brief.md` in the open project. Other inputs:

- `path`: another markdown or text file inside the open project, such as `drafts/v2.md`. The path is project-relative. Absolute paths, `..`, backslashes and symlinks that lead outside the project are refused.
- `text`: the script or a whole brief, inline, up to 20,000 characters. It works without an open project. Pass `path` or `text`, not both.
- `wpm`: the reading rate, 90-240.
- `targetSeconds`: `{ "min": 30, "max": 40 }`. Without it, the target comes from the brief's Goal (`target: 30-40 s`).
- `extraStalePhrases` and `avoidWords`: up to 50 more phrases to flag.
- `voiceSample`: up to five library paths of recordings of the creator talking, already indexed with [`footage_index`](./footage.md).
- `language`: a tag such as `en` or `fr`. Without it, the language comes from the brief's Goal, or is detected.

```json
{ "path": "brief.md", "targetSeconds": { "min": 25, "max": 35 }, "voiceSample": ["footage/interview-march.mov"] }
```

### Reading rate

Spoken length is words divided by a reading rate. The rate comes from the first of these that exists, and `wpmSource` says which one was used:

1. `argument`: the call's `wpm`.
2. `sample`: the rate measured from `voiceSample`, counting only time spent speaking (pauses over a second are left out). It needs at least 30 words and 10 seconds of speech.
3. `profile`: a rate in the creator's memory profile, written in plain words (for example "speaks at about 165 wpm on camera"). See [`memory`](./memory.md).
4. `default`: 150 wpm.

Numerals count as one word each. `⟦ask: …⟧` placeholders, `[stage directions]` and `{cues}` aren't spoken, so they aren't counted, the same way `script_read_compare` skips them. Every check below reads the spoken words only. Pauses between lines aren't counted, which matches a tight cut. If the creator holds a beat on purpose, add it to the timing yourself.

### Result

- `lines`: each line's `n`, `text`, `words`, `estSeconds`, `startEst`, `beat`, `emotion` and its flag codes.
- `totals`: `words`, `estSeconds`, the `target` and where it came from, and `withinTarget` (null without a target).
- `opening`: the lines treated as the opener (those labelled `opener` or `hook`, else line 1), their sentence count, the first sentence's words and seconds, and `first4s`, the words heard in the first four seconds. `youInFirst3Sentences` says whether the first three sentences speak to "you".
- `moodTurns`: every change of emotion label between lines, with its estimated time.
- `voice`, when samples were read: the sample's words, speaking seconds and measured wpm, and its average sentence length and contractions per 100 words next to the script's.
- `flags`: `{ line, code, message }`. `line` is null for whole-script flags.
- `skipped`: checks not run because the script isn't in English.
- `warnings`: what the brief parser had to guess (an unnumbered sentence, a short table row), and voice samples that couldn't be read, such as an unindexed recording.
- `note`: a reminder that the flags are heuristic prompts, not editorial judgments.

### Flags

| Code | Fires when |
| --- | --- |
| `no-script` | The text or brief has no script lines |
| `open-placeholder` | A line still holds a `⟦ask: …⟧` placeholder. The message quotes it. The script is a draft until the creator answers |
| `greeting-opener` | Line 1 opens with a greeting ("hey", "welcome back") |
| `series-counter-opener` | The opener starts by counting a series ("Day 12 of", "This is part 3"), or names one anywhere ("part 3 of my rent series") |
| `self-intro-opener` | The opener introduces the creator ("my name is", "I'm Sam and"). "I'm British and" doesn't count |
| `long-opener` | The opener runs past two sentences |
| `slow-opener` | The first sentence takes over five seconds to say at the rate used |
| `no-early-you` | No "you" or "your" in the first three sentences |
| `group-address` | A line addresses a crowd ("you guys", "all of you", "folks") |
| `long-sentence` | A sentence runs past 22 words |
| `no-specifics-in-beat` | A point, proof, payoff or story beat (`story 1` included) has no digit, counted amount or capitalized name. With no beat labels at all, it is checked for the whole script. A beat holding a placeholder is skipped, since its detail is on the way |
| `hedge` | Softeners such as "maybe", "kind of", "I think" |
| `jargon` | Business-speak such as "leverage" or "synergy" |
| `avoided-word` | A word from `avoidWords` or the profile's words to avoid |
| `stale-phrase` | A worn phrase from Blackout's list or `extraStalePhrases` |
| `missing-emotion` | Lines without an emotion label (one grouped flag) |
| `too-many-points` | More than four separate `point` beats. Lines with the same label in a row count as one point |
| `weak-close` | The last line is a question, trails off, ends on "and" or "so", or signs off ("thanks for watching") |
| `over-length`, `under-length` | The estimate is outside the target, with roughly how many words to cut or add |
| `duplicate-line` | A line of three or more words repeats an earlier one |
| `voice-long-sentences` | Script sentences run much longer than the creator's own (needs `voiceSample`) |
| `voice-formal` | The script uses far fewer contractions than the creator does (needs `voiceSample`) |

The word lists are English. For other languages, the checks that depend on them are listed in `skipped`, while timing, length, sentence length, labels, beats, duplicates and `avoidWords` still run. The language comes from `language`, then the brief's Goal, then a simple detection. Fix each flag, or say why it stays. A flag is a prompt to look, and the creator's choice wins.

### Errors

- No open project when reading a file. Pass `text`, or open the project.
- No `brief.md` (or the named file) in the project.
- A path outside the project, not a `.md`, `.markdown` or `.txt` file, or over 512 KB.
- `path` and `text` together, or `targetSeconds.min` above `max`.

An unreadable voice sample is a warning, not an error. The lint still runs.

## script_read_compare

`script_read_compare` lines up a recording with its script: a table read, a single take of the whole video, or a shoot where each line was said several times in whatever order the creator recorded it. It runs in the app window, because it uses the local speech engine and the project's footage index.

```json
{ "path": "footage/read-through.mov" }
```

`path` is the recording, as a library path (preferred) or an absolute local file. The script comes from `brief.md` in the open project unless `script` says otherwise. Other inputs:

- `script.path`: another markdown or text file inside the open project. The same rules as `script_lint`'s `path` apply.
- `script.text`: the script inline, as a whole brief or as bare lines (one sentence per line, numbers optional), up to 100,000 characters. It works without an open project. Pass `script.path` or `script.text`, not both.
- `start`, `end`: the part of the recording to compare. The recording itself can be up to two hours long.
- `pauseSeconds`, 0.2-2 (default 0.6): a silence at least this long inside a take is listed as a pause. Lines recorded closer together than this share one keep range.
- `minCoverage`, 0.2-1 (default 0.5): how much of a line has to be said, word for word, for a stretch of speech to count as a take. The line's rarer words have to reach the same share, so a few shared words like "the" and "it" never make a take.
- `detail`: `full` (default) lists every take. `best` lists only each line's suggested take, which keeps the reply short for long scripts.

```json
{ "path": "footage/shoot-a.mov", "script": { "path": "drafts/v2.md" }, "start": "2:00", "end": "14:30", "detail": "best" }
```

### Where the words come from

For an imported recording that the footage index already holds, the saved transcript is reused and nothing is transcribed again. An imported recording without an index entry is indexed whole first, exactly as [`footage_index`](./footage.md) would do it, so a later call is instant and the takes come back as `footage_cut` passages. A window of an unindexed recording, or a file that isn't imported, is transcribed locally for this call only. Whisper runs on this computer. The first use downloads the model, and no audio is uploaded. The speech engine handles one recording at a time, so while footage indexing is running, a recording that still needs transcribing gets a `busy` error. Call again once indexing finishes. A recording the index already holds is compared right away.

### Matching

Both the script and the transcript are reduced to plain spoken words before they are compared. Case and punctuation are dropped, and contractions are expanded ("don't" matches "do not"). Numerals are read the way people say them, so "1,000" matches "one thousand" and "a thousand", "$20" matches "twenty dollars", "$5 million" matches "five million dollars", "10k" matches "ten thousand", "1500" matches "1,500" and "fifteen hundred", "3rd" matches "third", and "1990s" matches "nineteen nineties". Stage directions in `[brackets]` and unanswered `⟦ask: …⟧` placeholders are skipped. Fillers such as "um" and "uh" are counted, never matched.

Each script line is then searched for everywhere in the recording, not only after the previous line. A line said three times has three takes, a line said out of order is still found, and a skipped line is reported as unspoken. When two script lines could claim the same words, the closer match keeps them. A line whose neighbours in the script were recorded right next to it wins a tie, which settles a repeated refrain. A misheard word at the very start or end of a take ("hi" heard for "hey") is paired with the script word only when the two sound alike. Slate talk or a "wait" next to the take stays outside it, and the script words it lacks stay in `omitted`.

### Result

- `source`: the recording's path, `assetId` and index `fingerprint` (null when it isn't imported or wasn't indexed), the compared window, and `transcript`: `footage-index` or `transcribed`.
- `script`: where the lines came from (`file` with its `path`, or `text`), whether it was a brief or bare lines, and how many lines were read.
- `lines`: each script line's `n`, `text`, spoken `words` (after normalization), `takes`, `takeCount` and `best`.
- Each take has:
  - `sourceStart` and `sourceEnd`: the first and last word, in source seconds.
  - `keep`: the take with a short handle on each side. The handle stops at the neighbouring words.
  - `coverage`: the share of the line said exactly.
  - `spoken`: the words as recognized.
  - `omitted`, `inserted`, `substituted`: what was left out, what was added (an aside, a restart inside the line) and what was said differently.
  - `pauses`, `fillers`, and `wpm`, the take's pace with pauses included. Pace counts recognized words the way `script_lint` counts script words ("don't" and "$15" are one word each), and fillers are left out.
- `best`: the most complete take, then the one with the fewest added or changed words, then the fewest pauses, then the latest. The last take doesn't win just for being last. Short lines of up to four words are weighed by where the take sits first, because their words also turn up in ordinary talk ("wrong", "here is why"). A take read on its own, or right beside a take of the line before or after, comes ahead of the same words said in passing inside other talk. When a line was only heard in passing, it is still suggested, with a warning to check it.
- `unspoken`: lines with no take.
- `readOrder`: line numbers in the order their suggested takes were recorded. A mismatch with the script order shows what was read out of order.
- `extraSpeech`, `extraSpeechTotal`: speech outside every take, such as false starts, asides, slate talk and direction from behind the camera. Up to 100 stretches are listed.
- `coverage`, `overallWpm`: the whole read at a glance. Unspoken lines count as 0.
- `keep`: the suggested takes in script order, in source seconds. Lines recorded back to back with nothing said between them share one range.
- `passages`: `keep` with the `assetId` and `fingerprint` attached, when the recording is imported and indexed.
- `savedPath`: where the full result was written, `.cutroom/script-read.json` in the project. The file always has every take, whatever `detail` was.
- `warnings`, `limitations`.

### Using the result

- **Assemble the scripted cut.** Pass `passages` to [`footage_cut`](./footage.md) as they are. The extra `lines` field is ignored. A cut takes up to 100 passages, and longer scripts get a warning to cut in parts. Then make a clean-edit pass for pauses and joins.
- **Pick a different take.** Swap in another take's `keep.sourceIn` and `keep.sourceOut` with the same `assetId` and `fingerprint`.
- **Trim an existing scene.** `keep` ranges are source seconds. They equal [`transcript_edit_apply`](./transcript-edit.md) scene time only when the scene plays this recording from 0, untrimmed, at normal speed. Otherwise, run `transcript_edit_inspect` and use its scene times.
- **Revise the script.** Words the creator keeps adding (`inserted`) or changing (`substituted`) across takes are often lines that want rewriting. Lines that needed many takes or have many pauses are the hard ones to say. `overallWpm` is a measured reading rate, counted in the same words as `script_lint`, so it can go straight into `script_lint`'s `wpm`.

### Limits

Recognized words and times are approximate. Whisper can drop stutters, tidy up halting speech, or hear words in silence, so listen around each join before a final cut. Matching is word by word: a paraphrase counts as omitted and inserted words, not as a match. Speakers aren't separated, so a prompt read from behind the camera can count as a take. The normalization rules are English. Other languages are compared on their literal words.

### Errors

- No open project and no `script.text`, or no `brief.md` (or the named file) in the project.
- A script with no lines under an exact `## Script` heading.
- A remote URL, a library asset that points to remote media, or something that isn't audio or video.
- An empty window, or a window with no recognizable speech.
- A recording over two hours, even for a short window. Local transcription and the footage index stop at two hours, so split the file into parts and compare each one.
- `busy` while footage indexing is running and the recording still needs transcribing.
