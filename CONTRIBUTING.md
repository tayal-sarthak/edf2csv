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
npm run estimate     # --info predicts the rows exactly and never fewer bytes than get written
npm run layouts      # wide and long hold the same samples
npm run roundtrip    # the digital code can be recovered from the CSV
npm run narrowing    # --channels and --start return exactly the part they name
npm run fuzz         # a damaged file is reported, never a crash
npm run fuzz:batch   # a batch converts each recording as converting it alone would
npm run stream       # --stdout writes the file it replaces, byte for byte
npm run terminal     # every error:, warning: and interrupted ( begins its own line
npm run crossvalidate  # values are bit-identical to pyEDFlib (needs `pip install pyedflib`;
                       # exits 2 without it, since a check that did not run has not passed)
```

CI runs the first eight on every push, at their default seed. A weekly job runs the two that
generate their own inputs at a seed taken from the date, which is where a genuinely new
input comes from — and those same two are the only ones that take `<seed> <count>`:

```bash
npm run fuzz -- 42 2000        # 2,000 corrupted recordings from seed 42
npm run fuzz:batch -- 42 40    # 40 folder trees from seed 42
```

The rest convert the fixture set, so there is no seed to give them and no count to raise.
Six ignore extra arguments entirely. `npm run estimate` is the one that does not: its single
argument is a name filter, so `npm run estimate -- biosemi` narrows the sweep to the three
BioSemi recordings — and `npm run estimate -- 42 2000`, on the reading that it takes a seed,
matches no fixture at all and exits 1 saying that nothing was checked.

## The website

`website/` is the documentation and the site that serves it. The pages are Markdown in
`website/content/`; adding one is a matter of dropping in a file with the frontmatter the
others have.

```bash
cd website && npm install && npm run build && npm run preview
```

The build refuses to emit a page that is quietly wrong — one that rendered with almost no
text, an internal link pointing at a file the build did not write, an id used twice, an
`href="#..."` matching no element, or a `url(#...)` matching no element, which is how an SVG
reaches a gradient or a mask. See `website/README.md` for why each of those exists.

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
