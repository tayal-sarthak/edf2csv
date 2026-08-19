# Contributing

```bash
npm install     # builds, because `prepare` does
npm test        # builds, generates the recordings, runs the suite
```

That is the whole setup. There are no runtime dependencies and the two devDependencies are
TypeScript and its Node types.

## What the suite is, and what it is not

`npm test` runs the unit tests and one thing people are usually surprised by: a file of
tests that reads this repository's own documentation and checks it against the source.
Diagnostic codes, flag names, exit codes, the columns of every output file, the numbers
quoted on the correctness page, the test count on it — all compared against what the code
actually does.

So a change to behaviour frequently fails a test in `test/docs.test.js` naming a page you
did not touch. That is the test working. Update the page.

The nine sweeps are separate, because they take minutes rather than seconds:

```bash
npm run estimate     # --info never predicts fewer rows or bytes than get written
npm run layouts      # wide and long hold the same samples
npm run roundtrip    # the digital code can be recovered from the CSV
npm run narrowing    # --channels and --start return exactly the part they name
npm run fuzz         # a damaged file is reported, never a crash
npm run fuzz:batch   # a batch converts each recording as converting it alone would
npm run stream       # --stdout writes the file it replaces, byte for byte
npm run terminal     # every error: and warning: begins its own line on a terminal
npm run crossvalidate  # values are bit-identical to pyEDFlib (needs `pip install pyedflib`)
```

CI runs the first eight on every push, at their default seed. A weekly job runs the two that
generate their own inputs at a seed taken from the date, which is where a genuinely new
input comes from. Every one of them takes `<seed> <count>` if you want more:
`npm run fuzz -- 42 2000`.

## The website

`website/` is the documentation and the site that serves it. The pages are Markdown in
`website/content/`; adding one is a matter of dropping in a file with the frontmatter the
others have.

```bash
cd website && npm install && npm run build && npm run preview
```

The build refuses to emit a page that is quietly wrong — one that rendered with almost no
text, an internal link pointing at a file the build did not write, an id used twice, an
`href="#..."` matching no element. See `website/README.md` for why each of those exists.

## Changes that are welcome

A recording this tool reads wrongly is the most valuable thing you can bring, and
`test/fixtures/generate.mjs` builds every test recording byte by byte, so a new failing case
is usually a dozen lines there.

The one thing this project will not do is invent data. Channels at different sampling rates
are not resampled onto a common grid, units are not converted, gaps are not closed, and a
header that contradicts itself is reported rather than guessed at. A change that makes the
output more convenient by making it less true is the change that gets declined.

## Releases

Not something a pull request needs to do — but if you are the one cutting one: the version
appears in `package.json`, `package-lock.json` and `CITATION.cff`, and `docs/CHANGELOG.md`
needs an entry headed with it. The suite checks all four agree, so a partial bump fails
before it can be published.
