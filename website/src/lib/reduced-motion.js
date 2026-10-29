import { useSyncExternalStore } from 'react';

/*
  Whether the reader has asked for less motion, kept current for as long as the page is open.

  motion's own `useReducedMotion` reads the setting once, when a component mounts, and keeps that
  answer: its docstring says it "will actively respond to changes", and the line under it is a
  TODO saying it does not. The stylesheet does respond, so a reader who switched Reduce Motion on
  with the page open had the pause button taken away while the waveform, its numbers and the beam
  behind the headline all went on moving.

  The first answer on the client is the one motion's hook gave, read during hydration as it read
  it, so nothing that renders from it changes; only a change made afterwards is new. The server
  has no reader to ask.
*/
const QUERY = '(prefers-reduced-motion: reduce)';

const subscribe = (onChange) => {
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
};

const current = () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches;

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, current, current);
}
