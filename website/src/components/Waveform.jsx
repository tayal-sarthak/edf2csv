import { useEffect, useMemo, useRef } from 'react';
import { motion, useAnimationFrame, useReducedMotion } from 'motion/react';

/*
  The hero visual: four biosignal traces scrolling under a fixed sampling line,
  with the values at that line printed as they would appear in signals.csv.

  It animates the one idea the whole tool rests on, which is a continuous trace
  becoming a column of numbers. The traces are generated from a seeded oscillator
  rather than being decorative noise, so the shapes stay plausible, and the readout
  reads its numbers from the same array that draws the path. Nothing here is a
  screenshot of anything.

  Frame updates write straight to the DOM through refs. Routing them through React
  state would re-render the tree sixty times a second for no benefit.
*/

const CHANNELS = [
  { label: 'FP1-F7', seed: 11, amp: 1.0 },
  { label: 'F7-T7', seed: 29, amp: 0.78 },
  { label: 'T7-P7', seed: 47, amp: 0.92 },
  { label: 'P7-O1', seed: 73, amp: 0.66 },
];

const WIDTH = 1200;
const HEIGHT = 300;
const SAMPLES = 600;
const ROW_HEIGHT = HEIGHT / CHANNELS.length;

/** Deterministic pseudo-random in [-1, 1], so every visitor sees the same trace. */
function noise(seed, i) {
  const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * A plausible EEG-ish trace: a couple of slow rhythms, a faster band, and the
 * occasional sharper transient. Values land roughly in microvolts.
 */
function buildSignal(seed, amp) {
  const values = new Float64Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    let v =
      Math.sin(t * 6 + seed) * 26 +
      Math.sin(t * 13 + seed * 1.7) * 14 +
      Math.sin(t * 27 + seed * 0.4) * 3.5 +
      noise(seed, i) * 3;
    // A slow envelope keeps the trace from looking like a flat oscillator.
    v *= 0.72 + 0.28 * Math.sin(t * 2 + seed * 0.3);
    values[i] = v * amp;
  }
  return values;
}

/** One period of the trace as an SVG path, drawn twice so the scroll loops seamlessly. */
function toPath(values, centreY) {
  let d = '';
  for (let i = 0; i < values.length; i++) {
    const x = (i / values.length) * WIDTH;
    const y = centreY - (values[i] ?? 0);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    if (i < values.length - 1) d += ' ';
  }
  return d;
}

export default function Waveform() {
  const reduced = useReducedMotion();
  const readoutRefs = useRef([]);
  const timeRef = useRef(null);

  const channels = useMemo(
    () =>
      CHANNELS.map((channel, row) => {
        const values = buildSignal(channel.seed, channel.amp);
        const centreY = row * ROW_HEIGHT + ROW_HEIGHT / 2;
        return { ...channel, values, centreY, path: toPath(values, centreY) };
      }),
    [],
  );

  // The sampling line sits at a fixed fraction across the scope.
  const SAMPLE_X = 0.66;

  const paint = (progress) => {
    const index = Math.floor(((progress + SAMPLE_X) % 1) * SAMPLES);
    for (let c = 0; c < channels.length; c++) {
      const node = readoutRefs.current[c];
      const value = channels[c]?.values[index] ?? 0;
      if (node) node.textContent = value.toFixed(3);
    }
    if (timeRef.current) timeRef.current.textContent = (progress * 60).toFixed(5);
  };

  // With motion reduced there is one frame to draw, so draw it once rather than
  // rewriting the same numbers sixty times a second.
  // `paint` is left out of the dependencies on purpose: it is rebuilt on every render, so
  // listing it would re-run this effect on every render to redraw the identical frame.
  // Nothing it closes over changes — the channel data is memoised and the refs are stable.
  useEffect(() => {
    if (reduced) paint(0);
  }, [reduced]);

  useAnimationFrame((elapsed) => {
    if (reduced) return;
    // 18 seconds for one full pass of the trace.
    paint((elapsed / 18000) % 1);
  });

  return (
    <div className="scope">
      <div className="scope__head">
        <span>signals.csv</span>
        <span>4 of 23 channels · 256 Hz</span>
      </div>

      <div className="scope__body">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          role="img"
          aria-label="Four biosignal traces scrolling beneath a sampling line"
        >
          <defs>
            <linearGradient id="fade" x1="0" x2="1">
              <stop offset="0" stopColor="var(--bg-sunken)" stopOpacity="1" />
              <stop offset="0.08" stopColor="var(--bg-sunken)" stopOpacity="0" />
              <stop offset="0.92" stopColor="var(--bg-sunken)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--bg-sunken)" stopOpacity="1" />
            </linearGradient>
          </defs>

          {/* Row separators, one per channel lane. */}
          {channels.map((channel, row) =>
            row === 0 ? null : (
              <line
                key={`sep-${channel.label}`}
                x1="0"
                x2={WIDTH}
                y1={row * ROW_HEIGHT}
                y2={row * ROW_HEIGHT}
                stroke="var(--line)"
                strokeWidth="1"
              />
            ),
          )}

          {/*
            One period of each trace, drawn once and referenced once.

            The scroll loops by drawing the same period twice, side by side, and sliding
            the pair one width to the left. Both copies used to be <path> elements with
            the same 600-point `d` attribute spelled out in full — and since 0.6.62 this
            page is server-rendered, so those eight strings shipped in the HTML: 71 kB of
            coordinates in a 92 kB document, three quarters of a page whose actual text is
            825 words. The second copy is not a second trace, it is the same trace one
            width along, which is what <use> says.
          */}
          <motion.g
            initial={{ x: 0 }}
            animate={reduced ? { x: 0 } : { x: -WIDTH }}
            transition={reduced ? { duration: 0 } : { duration: 18, ease: 'linear', repeat: Infinity }}
          >
            {channels.map((channel) => (
              <path
                key={channel.label}
                id={`trace-${channel.label}`}
                d={channel.path}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.92}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {channels.map((channel) => (
              <use
                key={`${channel.label}-repeat`}
                href={`#trace-${channel.label}`}
                transform={`translate(${WIDTH} 0)`}
              />
            ))}
          </motion.g>

          {/* Edge fade so the traces do not appear to start and stop at the border. */}
          <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="url(#fade)" />

          {/* The sampling line: everything crossing it becomes a row of numbers. */}
          <line
            x1={WIDTH * SAMPLE_X}
            x2={WIDTH * SAMPLE_X}
            y1="0"
            y2={HEIGHT}
            stroke="var(--text)"
            strokeWidth="1"
            opacity="0.42"
            strokeDasharray="3 4"
          />
        </svg>

        {channels.map((channel, row) => (
          <span
            key={channel.label}
            className="scope__label"
            style={{ top: `${(row * ROW_HEIGHT + 10) * (100 / HEIGHT)}%` }}
          >
            {channel.label}
          </span>
        ))}
      </div>

      {/*
        Decorative to assistive technology, deliberately.

        The row underneath rewrites five numbers sixty times a second. Nothing marks it
        as a live region, so a screen reader does not announce the changes — but it does
        read the row when a user lands on it, and what it reads is a snapshot of an
        animation that has already moved on. The svg above already carries the
        description of what this is; the numbers are the same idea drawn twice.
      */}
      <div className="scope__readout" aria-hidden="true">
        <div className="scope__readout-head">
          <span>time_s</span>
          {channels.map((channel) => (
            <span key={channel.label}>{channel.label}</span>
          ))}
        </div>
        <div className="scope__readout-row">
          <span ref={timeRef}>0.00000</span>
          {channels.map((channel, row) => (
            <span
              key={channel.label}
              ref={(node) => {
                readoutRefs.current[row] = node;
              }}
            >
              0.000
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
