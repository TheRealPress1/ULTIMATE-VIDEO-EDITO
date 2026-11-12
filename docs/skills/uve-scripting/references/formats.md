# Formats and beats

A format promises the viewer a shape. Once they recognize it ("this is a list", "this is a story"), they know roughly how long they're in for and what they get at the end. Pick the format after the thesis and before the opener, because the opener has to promise what the format delivers.

## Pick one payoff

Decide what the viewer leaves with: they **learn** something, they **laugh**, or they **feel** something. A video can touch two, but it is built for one. Write it in `## Goal` as `payoff: teach`, `amuse` or `move`.

## Beat sheets

The beat names are the ones `brief.md` uses (`opener`, `doubt`, `point 1`, `proof`, `turn`, `payoff`, `close`). Each sheet ends with how it usually fails.

- **How-to.** opener (the result) → doubt → point 1…3 (steps, in order) → proof (it working) → close (do step 1 today). *Fails when* the steps are generic enough to find anywhere, or step one needs something the viewer doesn't have.
- **List.** opener (the count and the prize) → doubt → point 1…N, strongest last → close. *Fails when* the items aren't parallel, or the best item comes first and the rest are filler.
- **Belief-flip.** opener (the belief, stated as the viewer holds it) → turn (why it's wrong) → proof → point (what to do instead) → close. *Fails when* nobody actually holds the belief, or the flip is a quibble about wording.
- **Story.** opener (the moment it went wrong, mid-action) → point (what was at stake) → turn → payoff (what changed) → close (the one lesson). *Fails when* it's told in summary instead of moments, or the lesson isn't earned by the events.
- **Before/after.** opener (the after, shown) → proof (the before, with a number) → point 1…3 (what changed) → close. *Fails when* the gap is too small to see, or the method is hidden.
- **Hot take.** opener (the claim, plainly) → doubt (the best counter-argument, fairly) → proof → close (where the line is). *Fails when* it's contrarian for its own sake, or the creator wouldn't defend it in the comments.
- **Versus.** opener (the choice the viewer faces) → point 1 (option A, honestly) → point 2 (option B, honestly) → payoff (who should pick which) → close. *Fails when* the verdict is "it depends" with no rule for deciding.
- **Day in the life.** opener (the most surprising moment of the day) → point 1…N (time stamps, each with one detail) → payoff (what the day adds up to) → close. *Fails when* nothing in the day surprises the viewer, or the details are a routine anyone has.

Formats that come from the material Blackout usually has:

- **Interview pull.** opener (the question, as an on-screen card) → the answer (one passage from `footage_search`, uncut in meaning) → close (a card or the guest's last line). *Fails when* the answer needs context the clip leaves out. Keep the question that was really asked.
- **Narrated essay.** A voice-over over B-roll or licensed web media, built like a belief-flip or a list. *Fails when* the pictures only illustrate the words instead of adding to them. Plan the shots first.
- **Screen walkthrough.** opener (the finished result on screen) → point 1…3 (clicks, zoomed) → close. *Fails when* the screen is unreadable at phone size. Plan crops in the shot plan.
- **Reaction to a reference.** opener (the reference's claim, on screen) → turn (the creator's view) → proof → close. *Fails when* the reference does all the work. Show only as much as the point needs, and credit it.

## Choosing

| The idea came from | Usually becomes |
| --- | --- |
| A turning point in the creator's life | Story, before/after |
| A false belief | Belief-flip, hot take |
| A recurring question | How-to, interview pull |
| An outlier post | The same format with one variable changed |
| A choice viewers face | Versus |
| Footage the project already has | Interview pull, narrated essay, day in the life |

**Text-only pieces** (on-screen text over one shot, no speech) use the same beats, one beat per text card, with each card readable in under two seconds. Lint the card text the same way.

## Body rules for every format

- Answer the doubt in the line right after the opener.
- One point per beat. If a beat needs "and also", it's two beats or two videos.
- Number separate points in the labels (`point 1`, `point 2`) so `script_lint` counts them apart. More than four points is a flag.
- Every point, proof and payoff beat gets something concrete: a number, a name, a place or a thing the camera can see.
- The strongest point goes last, and the close follows straight after it with no recap.
- Length comes from the words, not a guess. `script_lint` reports estimated seconds at the creator's rate against the Goal target. Most talking-head pieces land between 20 and 60 seconds. Cut words before cutting points.
