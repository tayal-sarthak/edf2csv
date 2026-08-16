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
- Anything that writes outside the output directory, including through channel labels, since
  those are attacker-controlled text that reaches filenames.

## What is not

- Wrong numbers in the CSV are correctness bugs, not security ones. Open an issue.
- The recordings themselves may hold patient identifiers, which EDF stores in the header in
  plain text. edf2csv copies what it reads into `metadata.json` and does not attempt to
  anonymise it — see the [FAQ](https://edf2csv.vercel.app/docs/faq) for what is written where.
  That is documented behaviour rather than a vulnerability, but if you handle clinical data,
  read it before sharing a conversion.

## Supported versions

The latest release on npm. This project is pre-1.0 and fixes go forward, not into older lines.
