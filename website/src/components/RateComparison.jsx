import { useRef } from 'react';
import { motion, useInView, useReducedMotion } from 'motion/react';

/*
  The argument the whole tool exists to make, drawn to scale.

  A three second recording holds three samples of a 1 Hz temperature channel. Read
  through mne.io.read_raw_edf the same channel comes back with 768 values, because
  MNE needs one uniform array for its analysis pipeline and upsamples everything to
  the fastest rate in the file. Those 765 extra values were never measured.

  Showing the two counts side by side as dots makes the difference physical in a way
  the numbers alone do not. The 765 fabricated dots animate in one after another, so
  the reader watches them appear out of nowhere.
*/

const REAL = 3;
const FABRICATED = 765;

export default function RateComparison() {
  const ref = useRef(null);
  const reduced = useReducedMotion();
  // amount 0.4 so the count-up starts once the block is properly on screen.
  const inView = useInView(ref, { once: true, amount: 0.4 });

  return (
    <div className="rates" ref={ref}>
      <div className="rate-row">
        <div className="rate-row__head">
          <span className="rate-row__name">What the sensor recorded</span>
          <span className="rate-row__count">
            <b>3</b> samples · 1 Hz · 3 seconds
          </span>
        </div>
        <div className="dots">
          {Array.from({ length: REAL }, (_, i) => (
            <motion.span
              key={i}
              className="dot"
              initial={reduced ? false : { scale: 0, opacity: 0 }}
              animate={inView ? { scale: 1, opacity: 1 } : undefined}
              transition={{
                type: 'spring',
                stiffness: 320,
                damping: 22,
                delay: 0.1 + i * 0.09,
              }}
            />
          ))}
        </div>
        <p className="rate-note">
          edf2csv writes exactly these three rows to <code>signals_1hz.csv</code>.
        </p>
      </div>

      <div className="rate-row" data-tone="wrong">
        <div className="rate-row__head">
          <span className="rate-row__name">What a resampling reader reports</span>
          <span className="rate-row__count">
            <b>768</b> values · 765 of them interpolated
          </span>
        </div>
        <div className="dots">
          {Array.from({ length: REAL }, (_, i) => (
            <motion.span
              key={`real-${i}`}
              className="dot"
              initial={reduced ? false : { scale: 0, opacity: 0 }}
              animate={inView ? { scale: 1, opacity: 1 } : undefined}
              transition={{ type: 'spring', stiffness: 320, damping: 22, delay: 0.1 + i * 0.09 }}
            />
          ))}
          {Array.from({ length: FABRICATED }, (_, i) => (
            <motion.span
              key={`ghost-${i}`}
              className="dot dot--ghost"
              initial={reduced ? false : { scale: 0, opacity: 0 }}
              animate={inView ? { scale: 1, opacity: 0.85 } : undefined}
              // Spread the fill across roughly a second so it reads as accumulation,
              // not as a grid that was always there.
              transition={{ duration: 0.25, delay: reduced ? 0 : 0.45 + (i / FABRICATED) * 1.1 }}
            />
          ))}
        </div>
        <p className="rate-note">
          Average that column, count its samples, or plot it, and the numbers are not the
          ones the thermistor produced. No warning is issued.
        </p>
      </div>
    </div>
  );
}
