# Security

## Reporting a vulnerability

Report privately through GitHub's [security advisory
form](https://github.com/tayal-sarthak/edf2csv/security/advisories/new), which is visible only
to the maintainer until a fix is published. Please do not open a public issue for anything you
believe is exploitable.

Include the recording that triggers it if you can share one, or the header fields that matter if
you cannot — most parser bugs here are reproducible from a handful of header bytes, and a
synthetic file built to match is usually enough. `test/fixtures/generate.mjs` shows how the test
recordings are constructed byte by byte, if you want to attach one that carries no patient data.

Expect an acknowledgement within a week.

## What is in scope

edf2csv reads a file and writes files. It makes no network calls, runs no code from the
recordings it reads, and has no runtime dependencies, so the surface is the parser and the
filesystem work around it:

- A crafted recording that makes the tool read or write outside the files it was given.
- A crafted recording that causes a crash rather than a reported error. The tool's contract is
  that a damaged file is always reported: `npm run fuzz` asserts every corrupted input exits 0, 1
  or 2 with something to say, and an input that produces a stack trace instead is a bug worth
  reporting even when it is not exploitable.
- Unbounded memory or disk use from header fields that claim more than the file contains.
- Anything that writes outside the output directory. In a batch a destination is the input's
  path relative to the folder that was named, joined onto `--out`, so the attacker-controlled
  text that reaches a path is the recording's own name and the shape of the tree it sits in —
  a symlink leading out of it, a name that normalises oddly. Channel labels are not that text:
  they reach the column headers of every signal file and the cells of `channels.csv`, while a
  filename comes from the input's name and the channel's sampling rate. A label of `../escape`
  is a column called `../escape`.
- A way for text out of the recording to reach something that executes it. The label, unit,
  transducer and prefiltering fields are free text and are written into the CSV verbatim, which
  is deliberate; so is an EDF+ annotation's description, which since 0.8.0 is held to the same
  two warnings — it is the one field of the output that can carry a character above U+00FF, and
  the one most often typed by a person rather than written by a recorder;
  what is not acceptable is the tool being silent about where that lands. The known case — a
  field a spreadsheet evaluates rather than displays — raises
  [`FORMULA_LABEL`](https://edf2csv.vercel.app/docs/warnings-and-errors#formula_label) rather
  than being rewritten, since rewriting it would mean the CSV no longer says what the recording
  says. `=` and `@` always; `+` and `-` only when what follows them is not simply a number,
  since Lotus compatibility is what makes those two a formula and `-100` opens as -100, which
  is what the header says. A lone `-` is the conventional way to write "no unit" and is not
  flagged. Another program these fields reach that treats them as instructions rather than as
  text is worth reporting.

## What is not

- Wrong numbers in the CSV are correctness bugs, not security ones. Open an issue.
- The recordings themselves may hold patient identifiers, which EDF stores in the header in
  plain text. edf2csv copies what it reads into `metadata.json` and does not attempt to
  anonymise it — see the [FAQ](https://edf2csv.vercel.app/docs/faq) for what is written where.
  That is documented behaviour rather than a vulnerability, but if you handle clinical data,
  read it before sharing a conversion.

## Supported versions

The latest release on npm. This project is pre-1.0 and fixes go forward, not into older lines.
