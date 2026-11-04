# Openers

The opener is the first one or two sentences, and the whole first impression around them: the **words**, the **delivery**, the **first frame** and the **sound** at zero seconds. A scrolling viewer decides in a few seconds whether to stay, so this is where a rewrite pays off most.

## Generate wide, then judge

Write at least ten candidates before picking one. Vary one choice at a time: the family (below), the angle, the number, the first word, or what's on screen. Don't judge while writing. Judge all of them afterwards with the gate.

Draw each candidate from the viewer's **want** (see [idea bank](idea-bank.md)). The need is what the body delivers.

## The five-second gate

Score every candidate on five questions. A candidate that fails one is rewritten or dropped.

- **Readable.** Does it parse on the first hearing? Read it to someone outside the niche, or imagine that person. If they need a second pass or a definition, simplify.
- **Open.** Can you write, in one sentence, the question it leaves the viewer wanting answered? If you can't, neither can they.
- **Angle.** Why this creator, and what's new here? If a hundred accounts could say the same line, add what only this creator has: their number, their story, their setting.
- **Proof.** Is there a credential, a number or a demonstration within the first few seconds? Showing beats claiming.
- **Pulse.** Name the feeling it's built to cause, such as curiosity, recognition, worry or delight. If you can't name it, it's flat.

## Families

Each family is a shape with a placeholder template. The examples only show the move. Write new ones from the creator's material.

| Family | Template | Example |
| --- | --- | --- |
| Result first | [specific result], and it started with [small move]. | "I cleared €9,000 of card debt on a teacher's salary, and it started with one phone call." |
| Cost of not knowing | If you [common action], you're [losing something specific]. | "If you sign your lease through an agency, you're paying a month's rent for a phone call." |
| Contradiction | [thing the viewer trusts] is why [the problem they have]. | "Your budgeting app is the reason you're broke by the 20th." |
| Proof, then method | [shown result]. [How, in one clause]. | *A finished loaf on the board:* "This took eleven minutes of actual work." |
| Countdown | [N] [things] that [result], and the last one [twist]. | "Three emails that doubled my illustration rate, and the third is two words long." |
| Insider view | I've [done the thing, with a number]. Here's what [viewer] never sees. | "I've inspected 400 rental flats. Here's what landlords check first." |
| Before/after snapshot | [before, with a number]. [after, shown]. | "March: fourteen seconds to change one chord. *Cut to June, playing.*" |
| Their own question | "[the question, in their exact words]?" [the answer, at once]. | "'Do I need a contract for a €200 job?' Yes, and it fits on four lines." |
| Visual cold open | The picture hooks first, and the words come second. | *A full laundry basket tipped onto the bed:* "Twenty minutes of folding. Watch it take four." |

## Sharpen the last clause

The end of the opener's sentence carries the most weight. Write it as a ladder from vague to exact, and keep the sharpest rung that's still true:

1. "…and it changed everything."
2. "…and it saved me money."
3. "…and it saved me €250 a month."
4. "…and it took €250 a month off the same flat."

If the sharp rung needs a fact you don't have, use a placeholder and ask (see the creator-facts rule in the [skill](../SKILL.md)).

## Tests

- **The first four seconds.** `script_lint` returns `opening.first4s`, the words heard before a viewer decides. The promise should land inside them. `slow-opener` means the first sentence alone runs past five seconds.
- **Specificity.** Count the numbers, names, places and visible things in the opener. Zero means sharpen.
- **Stale phrases.** `stale-phrase` and `avoided-word` flags in the opener are worth a rewrite even when the body keeps them.
- **One open question.** Two questions stacked in the opener split attention. Keep the one the body answers.
- **Result, not method.** The opener can give away the result. If it gives away the method, there's nothing left to watch.
- **Tone match.** The delivery and the first frame should carry the same feeling as the words. A deadpan read of a joke works only on purpose.
- **Openers to avoid.** Greetings, series counters and self-introductions are flagged by `script_lint` (`greeting-opener`, `series-counter-opener`, `self-intro-opener`).

## Show it, too

Write the opener's note line in `brief.md` with all three parts:

```
1. [opener · curious] If you sign your lease through an agency, you're paying a month's rent for a phone call.
   > delivery: dry, quick, lean on "phone call" | screen: hand sliding a lease across a table, already moving | sound: paper on wood, no music yet
```

- The first frame is mid-action, never a still face waiting to talk.
- On-screen text, if any, says the promise in six words or fewer and doesn't repeat the line word for word.
- The sound at zero seconds is something specific (a click, a voice, a room). Music can come in on the first turn.

## Checklist

- [ ] At least ten candidates, from at least three families
- [ ] The chosen one passes all five gate questions
- [ ] One or two sentences; the promise lands in `first4s`
- [ ] A number, a name, a place or a demonstration within the first few seconds
- [ ] It sells the want; the body delivers the need
- [ ] The delivery, screen and sound notes are written
- [ ] No lint flags left in the opener, or each one has a reason
