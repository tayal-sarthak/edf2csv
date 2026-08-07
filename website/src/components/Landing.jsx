import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Waveform from './Waveform.jsx';
import RateComparison from './RateComparison.jsx';
import PhosphorScope from './PhosphorScope.jsx';
import Reveal from './Reveal.jsx';
import { pages } from '../lib/content.js';
import { highlight } from '../lib/highlight.js';

/*
  Every terminal block and CSV sample on this page is real output, captured from the
  tool running against a synthetic eight hour sleep recording. Nothing here is a
  mock-up of a product that does not exist yet.

  The recording is 28800 records of 1s: EEG Fpz-Cz, EEG Pz-Oz and EOG horizontal at
  100 Hz over -250..250 uV, Resp oro-nasal at 10 Hz over -1..1 V, Temp rectal at 1 Hz
  over 34..40 degC, plus an EDF Annotations channel, started 02.03.02 at 23.10.00.
  test/fixtures/edf-writer.mjs builds it; run `--info` on the result to regenerate the
  block below.

  It said `Recorded 2002-03-02 23:10:00 UTC` until 0.4.68. The tool prints no timezone,
  deliberately: EDF stores local wall-clock digits and no zone at all, which is why the
  metadata key is `start_datetime_local`. A suffix the format cannot support, on the page
  arguing the tool is careful about exactly that, was the worst place for it.
*/

const INFO_OUTPUT = `$ edf2csv sleep-study.edf --info

File       sleep-study.edf
Format     EDF+ (continuous)
Recorded   2002-03-02 23:10:00
Duration   8h 00m 0s  (28800 records of 1s)
Size       18.7 MB
Patient    X X X X
Recording  Startdate 02-MAR-2002 X X X

Channels   5 signals + 1 annotation channel

#  COLUMN          LABEL           UNIT  RATE    RANGE        OUTPUT
0  EEG Fpz-Cz      EEG Fpz-Cz      uV    100 Hz  -250 to 250  signals_100hz.csv
1  EEG Pz-Oz       EEG Pz-Oz       uV    100 Hz  -250 to 250  signals_100hz.csv
2  EOG horizontal  EOG horizontal  uV    100 Hz  -250 to 250  signals_100hz.csv
3  Resp oro-nasal  Resp oro-nasal  V     10 Hz   -1 to 1      signals_10hz.csv
4  Temp rectal     Temp rectal     degC  1 Hz    34 to 40     signals_1hz.csv

Sampling rates differ, so channels are written to 3 files, one per rate. No channel is resampled.
Would write 3,196,800 rows, roughly 108 MB.

warning: Channels use 3 different sampling rates (100 Hz, 10 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
warning: At least one output file will have more than 1,048,576 rows, which is more than Excel or Numbers can open.
         Use --start and --duration to convert a section, or read the file with pandas or R.`;

const FILES = [
  {
    name: 'signals_100hz.csv',
    title: 'One file per sampling rate',
    body: 'The three channels recorded at 100 Hz share a time base, so they share a table. Column names are the labels the file itself uses, spaces and all.',
    sample: `time_s,EEG Fpz-Cz,EEG Pz-Oz,EOG horizontal
0.000,0.061,0.061,0.061
0.010,1.648,1.404,0.916`,
    lang: 'text',
  },
  {
    name: 'signals_10hz.csv',
    title: 'The respiration channel, undisturbed',
    body: 'Recorded at 10 Hz, so it gets ten rows a second and not one more. Its decimal precision is derived from its own calibration rather than borrowed from a neighbour.',
    sample: `time_s,Resp oro-nasal
0.000,0.000244
0.100,0.000733`,
    lang: 'text',
  },
  {
    name: 'signals_1hz.csv',
    title: 'One reading per second, because that is what exists',
    body: 'Eight hours of recording gives 28,800 rows here, against 2,880,000 in the 100 Hz table. Merging them would mean inventing 99 percent of this column.',
    sample: `time_s,Temp rectal
0.000,37.00073
1.000,37.00220`,
    lang: 'text',
  },
  {
    name: 'channels.csv',
    title: 'Every channel, described',
    body: 'Units, sampling rate, calibration range, transducer and prefiltering, plus which output file each channel landed in. Channels you did not select are listed too, marked as not converted.',
    sample: `column,signal_index,label,unit,sampling_rate_hz,...
EEG Fpz-Cz,0,EEG Fpz-Cz,uV,100,100,-250,250,...
Resp oro-nasal,3,Resp oro-nasal,V,10,10,-1,1,...`,
    lang: 'text',
  },
  {
    name: 'annotations.csv',
    title: 'EDF+ events with their real timing',
    body: 'Onset, duration and description. An annotation that carried no duration is written as empty rather than as zero, because those are different claims.',
    sample: `onset_s,duration_s,description,record_index
0,1800,Sleep stage W,0`,
    lang: 'text',
  },
  {
    name: 'metadata.json',
    title: 'What was converted, and from what',
    body: 'Tool version, source file and size, the recording header, the exact window converted, and every warning raised. Enough to reproduce the run later.',
    sample: `{
  "tool": { "name": "edf2csv", "version": "..." },
  "source": { "path": "...", "bytes": 19670016, "sha256": null },
  "recording": {
    "format": "EDF+ (continuous)",
    "start_datetime_local": "2002-03-02T23:10:00",
    "data_records": 28800,
    ...
  },
  "conversion": { "whole_recording": true, ... }
}`,
    lang: 'json',
  },
];

const FACTS = [
  { value: '16,943', label: 'sample values verified bit-for-bit identical to pyEDFlib' },
  { value: '1.4s', label: 'to turn a 40 MB recording into a 159 MB CSV' },
  { value: '48 MB', label: 'heap cap the conversion still completes under' },
  { value: '0', label: 'runtime dependencies, network calls, or telemetry' },
];

function CommandBar({ command }) {
  const [copied, setCopied] = useState(false);
  const reduced = useReducedMotion();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="command">
      <span className="command__prompt" aria-hidden="true">
        $
      </span>
      <span className="command__text">{command}</span>
      <motion.button
        type="button"
        className="command__copy"
        onClick={copy}
        whileTap={reduced ? undefined : { scale: 0.9 }}
        aria-label={copied ? 'Copied' : 'Copy command'}
      >
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.svg
              key="done"
              width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.6, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <path d="M20 6 9 17l-5-5" />
            </motion.svg>
          ) : (
            <motion.svg
              key="copy"
              width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.8"
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.6, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <rect x="9" y="9" width="11" height="11" rx="2.5" />
              <path d="M5 15V6a2.5 2.5 0 0 1 2.5-2.5H15" strokeLinecap="round" />
            </motion.svg>
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  );
}

export default function Landing() {
  const [selected, setSelected] = useState(FILES[0].name);
  const active = FILES.find((file) => file.name === selected) ?? FILES[0];

  return (
    <main>
      <section className="hero">
        <PhosphorScope />
        <div className="shell hero__grid">
          <div>
            <motion.h1
              className="hero__title"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            >
              Your recording, <em>as numbers</em>.
            </motion.h1>

            <motion.p
              className="hero__lede"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
            >
              EDF, EDF+ and BDF biosignal files become CSV you can open in pandas, R or
              Excel. Local, streaming, and honest about what it found.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              <CommandBar command="npx edf2csv recording.edf" />

              <div className="hero__actions">
                <motion.a
                  className="btn btn--primary"
                  href="/docs/getting-started"
                  whileHover={{ y: -1 }}
                  whileTap={{ y: 0, scale: 0.985 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 26 }}
                >
                  Read the docs
                </motion.a>
                <motion.a
                  className="btn btn--ghost"
                  href="https://github.com/tayal-sarthak/edf2csv"
                  target="_blank"
                  rel="noreferrer"
                  whileHover={{ y: -1 }}
                  whileTap={{ y: 0, scale: 0.985 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 26 }}
                >
                  View source
                </motion.a>
              </div>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
          >
            <Waveform />
          </motion.div>
        </div>
      </section>

      <section className="section" id="inspect">
        <div className="shell">
          <Reveal as="h2" className="section__title">
            See what is in the file before you write 108 MB of it
          </Reveal>
          <Reveal as="p" className="section__lede" delay={0.05}>
            An eight hour sleep study at 100 Hz becomes three million rows. Run it with
            <code> --info</code> and the tool reads only the header, prints the channel
            table, estimates the output, and writes nothing.
          </Reveal>
          <Reveal delay={0.1}>
            <pre
              className="code"
              dangerouslySetInnerHTML={{ __html: highlight(INFO_OUTPUT, 'bash') }}
            />
          </Reveal>
        </div>
      </section>

      <section className="section" id="rates">
        <div className="shell">
          <Reveal as="h2" className="section__title">
            It will not invent samples that were never recorded
          </Reveal>
          <Reveal as="p" className="section__lede" delay={0.05}>
            EDF files routinely mix rates: EEG at 100 Hz next to a thermistor at 1 Hz. One
            wide table cannot hold both without making the slow channel up, so each rate
            gets its own file instead.
          </Reveal>
          <Reveal delay={0.1}>
            <RateComparison />
          </Reveal>
        </div>
      </section>

      <section className="section" id="output">
        <div className="shell">
          <Reveal as="h2" className="section__title">
            What lands on disk
          </Reveal>
          <Reveal as="p" className="section__lede" delay={0.05}>
            A directory named after the recording. Pick a file to see what is inside it.
          </Reveal>

          <div className="panels">
            <Reveal className="tree" delay={0.1}>
              <div className="tree__root">sleep-study_csv/</div>
              {FILES.map((file) => (
                <button
                  key={file.name}
                  type="button"
                  className="tree__item"
                  aria-selected={file.name === selected}
                  onClick={() => setSelected(file.name)}
                >
                  {file.name}
                </button>
              ))}
            </Reveal>

            <Reveal className="panel-detail" delay={0.16}>
              <AnimatePresence mode="wait">
                <motion.div
                  key={active.name}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                >
                  <h3>{active.title}</h3>
                  <p>{active.body}</p>
                  <pre
                    className="code"
                    dangerouslySetInnerHTML={{ __html: highlight(active.sample, active.lang) }}
                  />
                </motion.div>
              </AnimatePresence>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="section" id="correctness">
        <div className="shell">
          <Reveal as="h2" className="section__title">
            Checked against the reference reader
          </Reveal>
          <Reveal as="p" className="section__lede" delay={0.05}>
            Values are compared against pyEDFlib, the reader most of the field already
            trusts. Not close to it. Identical to it, down to the last bit of the double.
          </Reveal>
          <Reveal className="facts" delay={0.1}>
            {FACTS.map((fact) => (
              <div className="fact" key={fact.value}>
                <div className="fact__value">{fact.value}</div>
                <div className="fact__label">{fact.label}</div>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="section" id="docs">
        <div className="shell">
          <Reveal as="h2" className="section__title">
            Documentation
          </Reveal>
          <Reveal className="doc-cards" delay={0.06}>
            {pages.map((page) => (
              <a
                key={page.slug}
                className="doc-card"
                href={`/docs/${page.slug}`}
              >
                <div className="doc-card__title">
                  {page.title}
                  <span className="doc-card__arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </div>
                <div className="doc-card__desc">{page.description}</div>
              </a>
            ))}
          </Reveal>
        </div>
      </section>
    </main>
  );
}
