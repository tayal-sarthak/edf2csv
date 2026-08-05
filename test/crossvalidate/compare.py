"""Check edf2csv's physical values against pyEDFlib's, sample for sample.

The README and the correctness page both say the arithmetic is checked against an
independent implementation. This is that check, so the claim is something anyone can rerun
rather than something taken on trust.

    pip install pyedflib
    npm run crossvalidate

Why a second implementation is worth the trouble: the digital-to-physical mapping is four
numbers out of the header and one multiply, which is easy to get subtly wrong and almost
impossible to catch by reading. A test written alongside the code tends to encode the same
misunderstanding as the code. pyEDFlib was written by other people, from the same
specification, and disagrees loudly when either side is wrong.

Exits 0 when every value agrees, 1 on any mismatch, and 0 with a notice when pyEDFlib is not
installed — this is opt-in and never part of `npm test`, which stays dependency-free.
"""

from __future__ import annotations

import csv
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CLI = os.path.join(ROOT, "dist", "cli.js")
RECORDINGS = os.path.join(HERE, "generated")

# The most the tool will write, so that the CSV is not the limiting factor: the comparison
# should be between two computations of a value, not between one of them and its printed
# form. At 12 places a reading near 1e-5 carries only seven significant digits, and the
# rounding alone exceeded the tolerance below.
DECIMALS = "20"
QUANTUM = 10 ** -int(DECIMALS)


def load() -> object:
    try:
        import pyedflib  # noqa: F401
    except ImportError:
        sys.stdout.write(
            "pyEDFlib is not installed, so the cross-check did not run.\n"
            "    pip install pyedflib\n"
        )
        raise SystemExit(0)
    import pyedflib

    return pyedflib


def columns_of(path: str) -> tuple[list[str], list[list[str]]]:
    with open(path, newline="") as handle:
        rows = list(csv.reader(handle))
    return (rows[0][1:], rows[1:]) if rows else ([], [])


def compare_annotations(name: str, reader, out: str, mismatches: list[str]) -> int:
    """Compare annotations.csv against pyEDFlib's own reading of the TALs.

    The two disagree on one point by design: pyEDFlib reports a missing duration as -1.0,
    while edf2csv leaves the cell empty, because a duration that was never recorded is not
    a duration of minus one second. That difference is expected and is treated as a match.
    """
    onsets, durations, texts = reader.readAnnotations()
    theirs = list(zip(onsets, durations, texts))

    path = os.path.join(out, "annotations.csv")
    ours: list[tuple[float, str, str]] = []
    if os.path.isfile(path):
        with open(path, newline="") as handle:
            for row in csv.DictReader(handle):
                ours.append((float(row["onset_s"]), row["duration_s"], row["description"]))

    if len(theirs) != len(ours):
        mismatches.append(f"{name}: {len(ours)} annotations, pyEDFlib read {len(theirs)}")
        return 0

    for k, ((onset, duration, text), (mine_onset, mine_duration, mine_text)) in enumerate(
        zip(theirs, ours)
    ):
        # float() throughout: pyEDFlib hands back numpy scalars, which repr as
        # "np.float64(0.25)" and make a mismatch harder to read than it needs to be.
        onset, duration = float(onset), float(duration)
        if abs(onset - mine_onset) > 1e-9:
            mismatches.append(f"{name} annotation {k}: onset {onset!r} vs {mine_onset!r}")
        if str(text) != mine_text:
            mismatches.append(f"{name} annotation {k}: text {str(text)!r} vs {mine_text!r}")
        absent = duration < 0
        if absent:
            if mine_duration != "":
                mismatches.append(
                    f"{name} annotation {k}: pyEDFlib has no duration, edf2csv wrote {mine_duration!r}"
                )
        elif mine_duration == "" or abs(duration - float(mine_duration)) > 1e-9:
            mismatches.append(f"{name} annotation {k}: duration {duration!r} vs {mine_duration!r}")
    return len(ours)


def main() -> int:
    pyedflib = load()

    if not os.path.isfile(CLI):
        sys.stderr.write("dist/cli.js is missing. Run `npm run build` first.\n")
        return 1
    if not os.path.isdir(RECORDINGS):
        sys.stderr.write(f"{RECORDINGS} is missing. Run `npm run crossvalidate`.\n")
        return 1

    names = sorted(n for n in os.listdir(RECORDINGS) if n.endswith((".edf", ".bdf")))
    compared = 0
    events = 0
    files = 0
    mismatches: list[str] = []

    for name in names:
        source = os.path.join(RECORDINGS, name)
        reader = pyedflib.EdfReader(source)
        try:
            out = os.path.join(tempfile.mkdtemp(), "converted")
            run = subprocess.run(
                [
                    "node", CLI, source,
                    "--out", out, "--quiet", "--decimals", DECIMALS,
                ],
                capture_output=True,
                text=True,
            )
            if run.returncode != 0:
                mismatches.append(f"{name}: edf2csv exited {run.returncode}: {run.stderr.strip()[:200]}")
                continue

            labels = [reader.getLabel(i).strip() for i in range(reader.signals_in_file)]
            for output in sorted(f for f in os.listdir(out) if f.startswith("signals")):
                header, rows = columns_of(os.path.join(out, output))
                for position, column in enumerate(header):
                    if column not in labels:
                        continue
                    reference = reader.readSignal(labels.index(column))
                    ours = [row[position + 1] for row in rows]
                    count = min(len(reference), len(ours))
                    if count == 0:
                        continue
                    if len(reference) != len(ours):
                        mismatches.append(
                            f"{name} {output} \"{column}\": {len(ours)} samples, pyEDFlib has {len(reference)}"
                        )
                    for k in range(count):
                        if ours[k] == "":
                            continue
                        theirs, mine = float(reference[k]), float(ours[k])
                        compared += 1
                        # pyEDFlib computes in float64 from the same four header numbers.
                        # The tolerance is relative to the channel's own scale, so a
                        # microvolt channel is not judged by a volt channel's standard,
                        # plus half of the last decimal place, which is all a decimal
                        # rendering can promise.
                        tolerance = max(abs(theirs) * 1e-9, QUANTUM / 2)
                        if abs(theirs - mine) > tolerance:
                            mismatches.append(
                                f"{name} {output} \"{column}\" sample {k}: "
                                f"pyEDFlib {theirs!r}, edf2csv {mine!r}"
                            )
                            break
            events += compare_annotations(name, reader, out, mismatches)
            files += 1
        finally:
            reader.close()

    sys.stdout.write(
        f"\nCompared {compared:,} sample values and {events:,} annotations "
        f"across {files} recordings.\n"
    )
    if mismatches:
        sys.stdout.write(f"{len(mismatches)} disagreed:\n")
        for line in mismatches[:20]:
            sys.stdout.write(f"  {line}\n")
        return 1
    sys.stdout.write("Every value agreed.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
