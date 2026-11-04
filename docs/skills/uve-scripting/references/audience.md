# Who the video is for

A video works best when it is written for one person you can picture at one moment of their life. "Women 25-34 interested in fitness" is a targeting setting, not a viewer. Write for someone you could describe to a friend in two sentences.

## The default viewer

Unless the user says otherwise, the viewer is **the creator six to 24 months ago**: someone standing where the creator once stood, before they learned what they now teach. The creator remembers that person's problems from the inside, so the script can use details only an insider would know.

The niche is three parts:

- **Start state:** where the viewer is now. *A night-shift nurse eating from the vending machine at 3 am.*
- **End state:** where they want to be. *A real meal on every shift without cooking on days off.*
- **Vehicle:** how the creator gets them there. *A 40-minute Sunday batch of four freezer meals.*

If you can't fill in all three, the ideas will come out generic. Ask.

## Pick the anchor moment

Ask the creator for the earliest or most painful moment they remember clearly, then rebuild it:

- What were they afraid would happen?
- What did they want so badly they'd pay for it that week?
- What were they watching, reading and searching for? Which accounts, which searches?
- What did they believe that turned out to be wrong?

Prefer evidence to memory where it exists. Their old footage may still hold their old words (`footage_search` for "when I started" or "I used to"). Old photos show the setting (`visual_search` on images in the project). Their earliest posts show what they cared about then. `instagram_posts` returns at most the 25 newest cached posts (the default `sortBy: "publishedAt"`), so on an account with more than that, ask the creator to point you to early posts or paste their captions.

## The viewer dossier

Six prompts with three to five answers each, in the viewer's language rather than the creator's:

| Prompt | Example answer (night-shift nurse) |
| --- | --- |
| What do they dread? | Being too foggy at 5 am to double-check a dose |
| Whose results do they envy? | The colleague who brings a proper lunch every shift and still has weekends |
| What do they believe that isn't true? | "Meal prep means a whole Sunday in the kitchen" |
| What haven't they tried, and why? | Freezing portions, because "frozen food tastes like hospital food" |
| What truth would they rather not hear? | The vending machine costs them more than groceries would |
| What exact phrases do they use? | "I just grab whatever", "I'm running on coffee", "who has time" |

Then add their stage (complete beginner, stuck intermediate, returning after a break), an age band only if it changes the advice, and **ten specific pains**. "The rice goes hard in the staff fridge" is a pain. "Struggles with nutrition" is not.

## Where it goes

- The dossier for this video goes in `brief.md` under `## Viewer`, or stays in chat during a brainstorm.
- A short description of the creator's usual viewer belongs in the creator's profile, one entry in plain words. Save it with `memory` only after the user confirms it, never from your own inference.
- A creator can have different viewers for different series. Name the viewer in each brief's `## Goal`.

## Using it

- Dreads and envied results feed **openers**: they are what the viewer wants.
- False beliefs and untried methods feed **theses**: they are what the viewer needs.
- Exact phrases feed the **wording** of every line.
- The ten pains become **proof** and **shots**: each one is something a camera can show.
