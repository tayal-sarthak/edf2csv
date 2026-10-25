import { Component } from 'react';

/*
  Around the three illustrations, which the page does not need in order to say anything.

  React drops the whole root on an uncaught error, prerendered markup included, so one
  decoration failing took every word of the landing page with it: a browser without
  ResizeObserver, or storage that throws, left a blank root. Inside this, the illustration
  goes and the page stays.
*/
export default class Optional extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
