# Motion craft

How to make titles, overlays and graphics look designed rather than generated. The [house style](../../../brand/README.md) supplies the defaults: type, color, timing and easing anchors. This page covers the decisions around them. The brief, the project and the user's saved style win over anything here, and the house numbers win over the rules of thumb below.

## Plan before building

1. **Brief.** Who watches, and where: the platform sets the format and length. The one thing they should remember. The tone. The assets that exist (logo, product shots, footage, music, voice). Ask for what is missing and matters. Never invent product facts, figures, quotes or logos.
2. **Sound first.** When the piece is cut to music or a voice, fix that before designing motion. Its beats and phrases set the timing of everything else. See [music](../../uve-music/SKILL.md), and time effects from the same constants that drive the animation ([sound effects](../../uve-sfx/SKILL.md)).
3. **Choreograph on paper.** For each beat, write what enters and from where, what is carried across the cut, and what holds still. Then build.
4. **Name the feeling.** Calm, urgent, playful, serious: say which, then let pace, color and motion all point at it.

## Decisions, not defaults

A piece built from defaults could belong to any subject once the words are changed. Before showing work, imagine the same piece for a different subject: if only the copy would need to change, the idea is generic. Change the idea, not the colors.

| Default to replace | The decision instead |
| --- | --- |
| Placeholder or sample copy, invented numbers, a stock look | Words, figures and colors taken from the brief, the footage and the supplied material |
| The same fade-up on every element | Direction, distance and easing chosen by the element's role |
| The whole frame zooming, shaking or flashing on every beat | Small things on the beat (a word, a mark, a line); the whole frame moves at a few cuts only |
| One thing appears, holds, leaves, while nothing else moves | A slow secondary move during holds; entrances overlapping the previous exit |
| Stock phrasing ("Introducing…", "Unleash…", a three-word slogan) | Copy a person would say out loud, and fewer words |
| Text doing the work the picture should do | Picture and motion carry the point; text names or qualifies it |
| A graphic over the speaker's face for the line that matters | Move it to the side, or hold it until the speaker pauses |
| Title, lower third and captions all on screen at once | One text layer leads; the others wait or leave |
| Emphasis on every noun | Emphasis on the one word the sentence turns on |

## Time on screen

- **Reading.** Allow about three words a second plus a second to notice, counted from when the text has stopped moving. A nine-word line needs about four seconds settled. When the beat is short, cut words rather than the hold.
- **The first frame.** A piece for Reels, TikTok or Shorts shows its subject or first line on frame 0: no fade from black, no logo sting, no blank beat. The hook lands in the first second or two ([openers](../../uve-scripting/references/openers.md)).
- **Beat lengths** for graphic-led pieces: a title 2.5-4 s, a content beat 4-8 s, an outro 2-3 s. A talking head follows the speech instead.
- **Timing.** Entrances, exits and staggers follow [house timing](../../../brand/video.md#timing). A hold of 1-3 s feels alive with something small still moving. A move slower than about a pixel a frame stutters on whole pixels, so carry slow holds with opacity, blur, color or a counter ([pixel snapping](../../../guides/motion/easings.md#pixel-snapping)).

## Choreography

Starting points. Where the house style gives a number, use it.

- One focal move at a time. Support moves less, later and shorter.
- Enter from a short distance (about 40-120 px on a 1080 short edge), with opacity finishing first so text is readable before it settles, as the house style asks. Scale up from 0.9-0.96, never from nothing. Keep rotation within a few degrees.
- Animate position, scale and opacity. Animating font size or layout re-flows the text and jitters.
- Stagger siblings by the house 100 ms; letters by 20-40 ms; words by 40-60 ms.
- Leave faster and quieter than you arrived: an exit easing, a shorter distance, or opacity alone.
- Carry an element across a cut only when it is the same object or state, and alternate the exit and entrance easings so velocity peaks at the cut ([easings](../../../guides/motion/easings.md)).
- Ambient loops are long (6-12 s) and small in amplitude.

Recipes, with times from the start of the beat and easing names from the [easing guide](../../../guides/motion/easings.md):

| Recipe | Choreography |
| --- | --- |
| Lower third | The bar enters from its edge (400 ms, `snappyOut`). The name rises 100 ms later, the detail 100 ms after the name. Hold. Everything leaves together in 200-250 ms (`snappyIn`). |
| Word-by-word title | Split into words. Each rises a short distance with opacity, 40-60 ms apart, `snappyOut`. Measure the longest line first so nothing re-wraps mid-animation. |
| Counter | The figure runs to its value over 1.2-1.8 s with `expoOut`, set in the mono face and right-aligned so digits do not shift. The label arrives once it settles. |
| Growing bar or chart | Grow from a fixed edge with `inOut`; the value label follows when the bar settles. Reveal one series at a time. |
| Underline or emphasis | A line draws from one end under the word as it is spoken (200-300 ms) and leaves with the sentence. |
| Beat accent | A small element hits the beat while the frame stays still. |
| Scene change | Prefer a hard cut or a carried element. A 300 ms dissolve suits two shots of one subject; see [cuts and transitions](../../../brand/video.md#cuts-and-transitions). |

## Review

Look at the images before saying anything looks good. Choose captures to answer a question:

- **Easing.** Capture six to eight consecutive positions across a move, two or three frames apart (`"12f"`, `"15f"`, `"18f"`…), and compare the gaps between the element's positions. Even gaps are linear, gaps that shrink toward the end are an ease-out, gaps that grow at the start of an exit are an ease-in.
- **Pops.** Capture the frame before and the frame after every cut and entrance. An element that appears, vanishes or jumps in a single frame without being meant to is a pop.
- **Detail.** Capture one position per sheet (`perSheet` 1) to judge type, alignment and contact between elements at full size. Use sheets of six to twelve for rhythm and coverage.
- **Structure.** Run `check` on the scene and `quality_review` on a substantial piece. They find flashes, borders and caption layout; they cannot judge easing, hierarchy or taste, which is what the captures above and the list below are for.

Then go through this list on the captures:

- Nothing important sits in the outer margins or, in 9:16, outside the [safe area](../../../brand/design.md#916-text-safe-area).
- Text fits its box and the frame, stays within the house copy limits (where there are none: about eight words a line and three lines a card), and stays up long enough to read.
- One thing draws the eye at a time, and entrances are staggered rather than simultaneous.
- Margins, alignment and colors are consistent from beat to beat.
- Body text reads against every background it crosses, footage and gradients included, without a shadow or plate rescuing it.
- No transition leaves an empty or flashing frame. The first frame of a social piece is not blank.
- The sound lands where the picture moves ([final review](../../uve-final-review/SKILL.md) covers the draft check).

## Matching a reference

- Measure the reference before building: size, frame rate and length. Map its cuts; duration alone does not describe the edit. `reference_analyze` does the measuring, and its frames are samples.
- Capture consecutive frames around fast effects and cuts. Sparse sheets miss a sub-second reveal and hide objects moving independently.
- Separate camera motion from the motion of individual objects. One moving layer cannot copy cards that separate at different depths.
- Reuse the real logo or vector artwork. Enlarging a small raster looks soft.
- If the reference shows a screen recording, review the range you use: stable window bounds, visible controls, and the action present throughout. Keep playback speed true to the gesture.
- Compare the reference and your build at the same instants, at full size, text and logos included. Adapt what you observe to this story; do not copy fonts, music or settings you cannot actually see.
