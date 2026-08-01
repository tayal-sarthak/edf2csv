import { motion, useReducedMotion } from 'motion/react';

/*
  Scroll reveal.

  The job here is hierarchy: content arrives in reading order so the eye is led down
  the page rather than met with everything at once. It fires once, never on the way
  back up, because re-animating content the reader has already seen is noise.
*/
export default function Reveal({ children, delay = 0, y = 20, as = 'div', ...rest }) {
  const reduced = useReducedMotion();
  const Component = motion[as] ?? motion.div;

  return (
    <Component
      initial={reduced ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
      {...rest}
    >
      {children}
    </Component>
  );
}
