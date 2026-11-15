# Contributing to Blackout

Blackout is an open-source desktop video editor for people who already edit well: Premiere-style tools and vocabulary, with AI that amplifies the editor instead of driving. Thanks for building on it.

## How work flows

- We work in this repository, on branches, rather than in forks.
- `main` is protected: no direct pushes and no force-pushes. Every change goes in through a pull request. The owner is asked to review each one; if the owner asks you to hold a pull request, wait until it is settled before merging it.
- Branch from `main` and name the branch `<your-name>/<topic>`, for example `yourname/media-browser`.
- Keep pull requests small: one idea that works end to end.
- Releases are the owner's. Don't bump the version, create tags, or touch the signing and release workflows.

## Set up

You need a Mac (Apple silicon is the main target), Node.js 22.12 or newer, and npm.

```sh
git clone https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO.git
cd ULTIMATE-VIDEO-EDITO
npm install
npm run dev:desktop -- --user-data-dir="$HOME/blackout-dev-profile"
```

`--user-data-dir` gives the development app a data folder of its own. Without it the app uses the same folder as an installed Blackout (`~/Library/Application Support/Cutroom`), and a work-in-progress build would read and write your real chats, settings and saved keys. The path must be absolute and separate from that folder.

No `.env`, account or API key is needed for editing. The in-app assistant uses your own Claude Code or Codex sign-in. `npm run dev:web` starts only the web app in a browser, which is enough for most interface work but has no desktop features.

## Check your work

```sh
npm run check   # type-check every workspace
npm run test    # every test suite
npm run lint    # eslint (the web app)
```

Add or update tests for the behavior you change. A test is only worth keeping if it fails when the code is wrong, so break the code on purpose once and watch the test fail. For a visible change, put a screenshot or a short recording in the pull request.

## Commit messages

One short sentence in the imperative that says what changes ("Add a snap switch to the timeline"), then a paragraph on why and how you checked it. No prefixes.

## Don't commit

Secrets, tokens, personal file paths, real names, or the names of someone's projects. Test fixtures are synthetic: generate media, don't copy someone's footage.

## License

Blackout is licensed under the Mozilla Public License 2.0, and contributions are accepted under it.
