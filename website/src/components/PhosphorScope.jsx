import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'motion/react';

/*
  Decorative hero backdrop: a CRT oscilloscope in XY mode, tracing a harmonograph.

  Two summed oscillators drive each axis. Their frequencies sit near small integer
  ratios but drift very slowly apart, so the figure precesses and reshapes forever
  without ever repeating or snapping back to a seam.

  What sells it as a real scope is the phosphor, not the curve. Two things do that:

    - Persistence. Each frame subtracts a little alpha from the whole canvas rather
      than clearing it, so the beam leaves a decaying tail. Subtracting alpha (rather
      than painting the background colour over the top) keeps the canvas transparent,
      so the page shows through and the theme can change underneath it.
    - Velocity-dependent brightness. A real beam dwells longer where it moves slowly,
      depositing more energy, so the cusps of the figure burn brighter than the fast
      sweeps through the middle. That single detail is most of the effect.

  Nothing here is on the critical path: it is aria-hidden, it renders one static
  frame under prefers-reduced-motion, and it stops painting entirely when the hero
  scrolls out of view or the tab is hidden.
*/

/*
  Two oscillators per axis. The base ratios (2:5 horizontally, 3:7 vertically) are what
  give the figure its structure.

  The detuning is the whole trick. On exact integer ratios the curve closes after one
  2π period and then retraces itself forever — you get a single thin loop that never
  fills. Detuned by a couple of hundredths, it never closes: each pass lands slightly
  beside the last, so the figure precesses and sweeps out a surface. A full precession
  takes about 2π/0.02 ≈ 314 radians of beam travel, which is roughly eight seconds.
*/
const OSC = [
  { f: 2.0, a: 0.62, p: 0.0 },
  { f: 4.977, a: 0.3, p: 1.7 },
  { f: 3.013, a: 0.62, p: 0.9 },
  { f: 6.964, a: 0.28, p: 2.4 },
];
// A far slower wander on top, so the shape it precesses through also changes.
const DRIFT = [0.00021, -0.00029, 0.00017, -0.00023];

const SUBSTEPS = 52; // beam segments drawn per frame
const BEAM_RATE = 0.62; // radians of curve parameter per frame at 60fps
const DECAY = 0.011; // alpha removed per frame; lower = longer tail

/*
  The still has no persistence, so its arc is chosen to match what the live beam's trail
  shows at any one moment — about nine passes of the curve. Tracing a full precession
  instead (several hundred radians) overlaps so many passes that the structure collapses
  into scribble.
*/
const STILL_ARC = 96;
const STILL_STEPS = 6000;

/** `#rrggbb` (or a CSS colour the browser has already resolved) to [r,g,b]. */
function toRgb(value) {
  const hex = value.trim();
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  const n = hex.match(/[\d.]+/g);
  if (n && n.length >= 3) return [Number(n[0]), Number(n[1]), Number(n[2])];
  return [255, 176, 32]; // --accent, dark theme
}

export default function PhosphorScope() {
  const reduced = useReducedMotion();
  const hostRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;

    // Theme decides how the beam composites. Additive light only reads as glow on a
    // dark field; on the light theme the same operation washes out to nothing, so the
    // beam is painted as ordinary ink instead.
    let rgb = [255, 176, 32];
    let dark = true;
    const readTheme = () => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      rgb = toRgb(styles.getPropertyValue('--accent') || '#ffb020');
      const explicit = root.dataset.theme;
      dark = explicit
        ? explicit === 'dark'
        : !window.matchMedia('(prefers-color-scheme: light)').matches;
    };

    // Returns false when the host has not been laid out yet, so the caller knows the
    // canvas is not usable. A zero-size first measurement is normal: the effect can run
    // before layout settles. The ResizeObserver below is what recovers from it, which is
    // why it must be attached on every path, including the reduced-motion one.
    const resize = () => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      return true;
    };

    /** Curve point for parameter t, in normalised [-1, 1] space. */
    const point = (t, drift) => {
      const f = OSC.map((o, i) => o.f + drift * DRIFT[i]);
      return [
        OSC[0].a * Math.sin(f[0] * t + OSC[0].p) + OSC[1].a * Math.sin(f[1] * t + OSC[1].p),
        OSC[2].a * Math.sin(f[2] * t + OSC[2].p) + OSC[3].a * Math.sin(f[3] * t + OSC[3].p),
      ];
    };

    let t = 0;
    let drift = 0;

    /*
      Draw `steps` beam segments covering `rate` radians of curve, starting at t.

      `gain` scales stroke alpha. The live beam is dim per frame and builds brightness
      through persistence — roughly a hundred frames of trail overlap at any moment. The
      still gets all of its segments at once with no decay, so at the same per-segment
      alpha it would blow out to a solid mass; it asks for a lower gain instead.
    */
    const sweep = (steps, rate, gain = 1) => {
      const cx = width / 2;
      const cy = height * 0.46;
      // Scaled off the long axis so the figure runs past the top and bottom of the
      // hero. A figure that fits inside the section reads as a picture sitting on the
      // page; one that bleeds reads as something the page is a window onto.
      const r = Math.max(width, height) * 0.44;
      const [cr, cg, cb] = rgb;

      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const dt = rate / steps;
      let [px, py] = point(t, drift);

      for (let i = 0; i < steps; i++) {
        t += dt;
        const [nx, ny] = point(t, drift);

        const ax = cx + px * r;
        const ay = cy + py * r;
        const bx = cx + nx * r;
        const by = cy + ny * r;

        // Beam speed for this segment, normalised against a typical sweep. Slow
        // segments get a brighter, slightly fatter stroke, exactly as phosphor does.
        const speed = Math.hypot(bx - ax, by - ay) / (r * dt) || 0;
        const dwell = Math.min(1, 1.6 / (speed + 0.7));

        const alpha = (dark ? 0.1 + dwell * 0.5 : 0.05 + dwell * 0.2) * gain;
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha.toFixed(4)})`;
        ctx.lineWidth = 0.7 + dwell * 1.5;

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();

        px = nx;
        py = ny;
      }
    };

    /** The whole figure in one pass, for the reduced-motion still. */
    const drawStill = () => {
      if (!resize()) return;
      t = 0;
      sweep(STILL_STEPS, STILL_ARC, 0.55);
    };

    /*
      Paint the trail the running beam would have already left behind, so the hero opens
      with the figure present instead of an empty canvas that fills in over the first two
      seconds. The beam then carries on from where this leaves t.

      SEED_ARC is the length of the live trail: alpha decays by DECAY per frame, so a
      stroke is spent after about 1/DECAY frames, and the beam covers BEAM_RATE radians
      in each of them. The gain is the mean of that decay curve, which is what stops the
      seeded figure from sitting brighter than the animation that replaces it.
    */
    const SEED_ARC = (1 / DECAY) * BEAM_RATE;
    const seed = () => {
      if (!resize()) return;
      t = 0;
      sweep(Math.round(SEED_ARC * (SUBSTEPS / BEAM_RATE)), SEED_ARC, 0.62);
    };

    readTheme();

    let raf = 0;
    let running = false;
    let last = 0;

    const frame = (now) => {
      if (!running) return;
      raf = requestAnimationFrame(frame);

      // Normalise to 60fps so a 120Hz display does not run the figure twice as fast.
      const delta = last ? Math.min((now - last) / 16.667, 3) : 1;
      last = now;

      // Persistence: subtract alpha everywhere, leaving a decaying tail.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0, 0, 0, ${DECAY * delta})`;
      ctx.fillRect(0, 0, width, height);

      drift += delta;
      sweep(SUBSTEPS, BEAM_RATE * delta);
    };

    /*
      The figure is painted once up front and never depends on the loop having started.
      Visibility gates the animation, not the picture: a tab that opens in the background
      gets no animation frames at all, and if the paint were tied to the loop the hero
      would be an empty rectangle until the reader switched to it.
    */
    const paint = () => (reduced ? drawStill() : seed());

    const start = () => {
      if (running || reduced) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    // Paint only while the hero is actually on screen and the tab is in front.
    let onScreen = true;
    const sync = () => (onScreen && !document.hidden ? start() : stop());

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry?.isIntersecting ?? true;
        sync();
      },
      { rootMargin: '96px' },
    );
    io.observe(host);

    // Resizing throws away the persisted trail, so the still has to be redrawn. This
    // observer also fires once on observe, which is what gives the canvas its real
    // size when the first measurement above came back empty.
    // Resizing reallocates the bitmap, which throws away whatever trail was on it, so
    // the figure has to be laid down again rather than left to rebuild from black. This
    // also fires once on observe, which is what paints the figure the first time and what
    // recovers when the measurement at mount came back empty.
    const ro = new ResizeObserver(paint);
    ro.observe(host);

    // The beam colour and its compositing both depend on the theme. When it changes the
    // live trail recolours itself within a second; the still has to be repainted.
    const onTheme = () => {
      readTheme();
      paint();
    };

    const themes = new MutationObserver(onTheme);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', onTheme);
    document.addEventListener('visibilitychange', sync);

    paint();
    sync();

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      themes.disconnect();
      // onTheme, which is what was added. Removing `readTheme` removed nothing:
      // removeEventListener matches on identity, and these are two different functions.
      scheme.removeEventListener('change', onTheme);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [reduced]);

  return (
    <div className="hero__backdrop" ref={hostRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
