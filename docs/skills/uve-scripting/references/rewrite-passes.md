# Rewrite passes

A first draft says the right things in the wrong voice. The passes below make it sound like the creator talking to one person. Run them in this order, since each one changes what the next one sees, and run `script_lint` after each pass.

## First: the emotion map

Give every line an emotion in its label (`[point 1 · relieved]`). One word, for what the viewer should feel, not what the creator feels.

- `script_lint` lists `moodTurns`, every change of label with its estimated time. Small shifts are fine. Keep **major turns** (worry to relief, doubt to pride) to about one per 60 seconds unless the piece is built on them.
- A run of lines with the same label is a flat stretch. Check it earns its length.
- The labels carry forward. The shot plan picks shots that serve them, and music changes land on the turns.

## The passes

1. **Outsider.** Read the script as someone who has never heard of the niche. Every term they'd stumble on gets replaced with the viewer's own words, or defined in the same breath ("a porteira, the building's caretaker"). `jargon` and `avoided-word` flags point to candidates.
2. **Specificity.** Every vague amount becomes a number, every "a client" becomes someone ("a dentist in Leeds"), every "recently" becomes a month. Only use facts the creator gave you. Anything missing is a `⟦ask: …⟧` placeholder. `no-specifics-in-beat` marks beats with nothing concrete in them, and `open-placeholder` marks every fact still waiting on the creator.
3. **Story tense.** In story beats, scenes are told as they happened: "I was carrying the boxes up when the landlord called." The simple past ("I moved in March") summarizes, and summaries skip the feeling. Turn at least the key moment of every story into a scene.
4. **Joins.** Read the lines in pairs. Each pair needs a bridge you could say out loud between them (*but*, *so*, *which means*, *until*, *and that's when*). The bridge doesn't have to be written, but it has to exist. If no bridge fits, the order is wrong or one line doesn't belong.
5. **Compression.** Try saying each line in half the words. Keep the short version whenever nothing is lost. The opening usually shrinks most: five sentences of warm-up tend to become two. `long-sentence`, `long-opener` and `over-length` flags show where to look.
6. **Ending.** The last line is one action, one line worth remembering, or the payoff. Don't recap the points, ask "what do you think?" or sign off. `weak-close` catches the common slips.
7. **Voice match.** Does it sound like them? Pass `voiceSample` (a recording of the creator talking, already indexed with `footage_index`) to `script_lint`. It compares sentence length and contractions with how they really speak (`voice-long-sentences`, `voice-formal`). Check the profile for their recurring phrases and words they avoid.

## Table read

After the creator records a read, or several takes, compare it with the script using `script_read_compare`. For each line it reports where it was said, how much of it was covered, and the words added, dropped or changed, with pauses and speaking rate.

- **Added words** show what the script is missing: the creator's natural phrasing. Adopt them when they're better.
- **Dropped or changed words** mark lines that fight the creator's mouth. Rewrite toward what they said.
- **Pauses inside a line, or several attempts**, mark hard lines. Shorten them, and move the stressed word to the end.
- **Lines never spoken** either weren't needed (cut them if the read works without them) or need a pickup. Note it under `## Edit plan`.
- **The measured rate** replaces the estimate. Lint again with `wpm` set to it, and offer to remember it in the creator's profile with `memory` (for example "speaks at about 165 wpm on camera"), but only if the user agrees.

Update `brief.md` with the changes, keeping the line numbers the takes refer to. Then hand off to [clean edit](../../uve-clean-edit/SKILL.md).

## Checklist

- [ ] Every line has a beat and an emotion
- [ ] At most one major mood turn per minute, or a reason
- [ ] The outsider would follow every line
- [ ] Every point, proof and payoff beat has a concrete detail from the creator
- [ ] The key story moment is a scene
- [ ] Every pair of lines has a bridge
- [ ] Each line is as short as it can be; the opener is two sentences at most
- [ ] The last line is an action, a line to remember, or the payoff
- [ ] `script_lint` is clean, or each flag left has a reason
- [ ] After the table read, the script matches what works in the creator's mouth
