"""Check edf2csv's physical values against pyEDFlib's, bit for bit.

The README and the correctness page both say the arithmetic is checked against an
independent implementation, to the last bit. This is that check, so the claim is something
anyone can rerun rather than something taken on trust.

    pip install pyedflib
    npm run crossvalidate

Why a second implementation is worth the trouble: the digital-to-physical mapping is four
numbers out of the header and one multiply, which is easy to get subtly wrong and almost
impossible to catch by reading. A test written alongside the code tends to encode the same
misunderstanding as the code. pyEDFlib was written by other people, from the same
specification, and disagrees loudly when either side is wrong.

The comparison is on doubles, not on CSV text. This used to convert with `--decimals 20` and
parse the cells back, which cannot be exact whatever the tolerance: a cell is a rounded
decimal rendering, so reading it gives the nearest double to the printed digits rather than
the double that was computed. The check then accepted anything within `abs(reference) * 1e-9`
and skipped empty cells without counting them, while the correctness page said "zero
differing bits ... not equal to within a tolerance". The page described a method the checker
did not use. It now dumps the doubles through the public API — the recipe the page prints,
checked in as dump-doubles.mjs — and compares the 64 bits of each value.

Exits 0 when every value agrees, 1 on any mismatch, and 0 with a notice when pyEDFlib is not
installed — this is opt-in and never part of `npm test`, which stays dependency-free.
"""

from __future__ import annotations

import csv
import json
import os
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CLI = os.path.join(ROOT, "dist", "cli.js")
RECORDINGS = os.path.join(HERE, "generated")

DUMPER = os.path.join(HERE, "dump-doubles.mjs")


def bits(value: float) -> str:
    """The 64 bits of a double, as hex. What "bit-for-bit identical" is checked on.

    Comparing the numbers directly would make every NaN unequal to itself and -0.0 equal to
    0.0, neither of which is the question being asked.
    """
    return struct.pack("<d", float(value)).hex()


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


def dump_doubles(source: str, into: str, mismatches: list[str], name: str) -> list[dict] | None:
    """Run the documented dumper and read back what it wrote, or report why it could not."""
    run = subprocess.run(
        ["node", DUMPER, source, into], capture_output=True, text=True
    )
    if run.returncode != 0:
        mismatches.append(
            f"{name}: dump-doubles.mjs exited {run.returncode}: {run.stderr.strip()[:200]}"
        )
        return None

    with open(os.path.join(into, "channels.json")) as handle:
        channels = json.load(handle)

    for channel in channels:
        with open(os.path.join(into, channel["file"]), "rb") as handle:
            raw = handle.read()
        if len(raw) != channel["samples"] * 8:
            mismatches.append(
                f"{name} \"{channel['label']}\": dumped {len(raw)} bytes for "
                f"{channel['samples']} samples"
            )
            return None
        channel["values"] = struct.unpack(f"<{channel['samples']}d", raw)
    return channels


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
            scratch = tempfile.mkdtemp()
            channels = dump_doubles(source, os.path.join(scratch, "doubles"), mismatches, name)
            if channels is None:
                continue

            for channel in channels:
                # Addressed by the signal's own position in the file, not by its label:
                # labels are free text and need not be unique, and matching on them let a
                # duplicated label compare one channel against another's samples.
                reference = reader.readSignal(channel["index"])
                ours = channel["values"]
                if len(reference) != len(ours):
                    mismatches.append(
                        f"{name} \"{channel['label']}\": {len(ours)} samples, "
                        f"pyEDFlib has {len(reference)}"
                    )
                    continue

                for k, (theirs, mine) in enumerate(zip(reference, ours)):
                    compared += 1
                    if bits(theirs) != bits(mine):
                        mismatches.append(
                            f"{name} \"{channel['label']}\" sample {k}: "
                            f"pyEDFlib {float(theirs)!r} ({bits(theirs)}), "
                            f"edf2csv {mine!r} ({bits(mine)})"
                        )
                        break

            # Annotations still come from the CSV, which is where they are published; the
            # values in it are decimal by nature rather than rounded from a double.
            out = os.path.join(scratch, "converted")
            run = subprocess.run(
                ["node", CLI, source, "--out", out, "--quiet"],
                capture_output=True,
                text=True,
            )
            if run.returncode != 0:
                mismatches.append(
                    f"{name}: edf2csv exited {run.returncode}: {run.stderr.strip()[:200]}"
                )
                continue
            events += compare_annotations(name, reader, out, mismatches)
            files += 1
        finally:
            reader.close()

    sys.stdout.write(
        f"\nCompared {compared:,} sample values bit for bit, and {events:,} annotations, "
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
