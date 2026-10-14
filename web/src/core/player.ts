/**
 * Plays a recording back against a clock that the page drives.
 *
 * The recording is the list of messages the pit wall sent, each stamped with the pit wall's
 * time (rx_ms). The player's job is only to say which messages are due. It has no timers and
 * no screen, so it can be tested by calling tick() with made-up time steps.
 */

import type { Message } from './messages';

export const SPEEDS = [1, 2, 4, 8] as const;

export class Player {
  readonly messages: Message[];
  position = 0; // ms of pit-wall time played so far
  playing = false;
  speed = 1;
  private next = 0; // index of the first message not yet handed out

  constructor(messages: Message[]) {
    this.messages = messages;
  }

  /** Time of the last message: where the recording ends. */
  get duration(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && m.type !== 'hello') return m.rx_ms;
    }
    return 0;
  }

  get done(): boolean {
    return this.next >= this.messages.length;
  }

  setSpeed(speed: number): void {
    if (Number.isFinite(speed) && speed > 0) this.speed = speed;
  }

  /** Messages that became due after `dtMs` of real time. Empty while paused. */
  tick(dtMs: number): Message[] {
    if (!this.playing || !Number.isFinite(dtMs) || dtMs <= 0) return [];
    // A tab that was asleep for a minute should not play a minute of the recording in one go.
    const step = Math.min(dtMs, 250) * this.speed;
    const out = this.takeUntil(this.position + step);
    if (this.done) this.playing = false;
    return out;
  }

  /** Jump to `ms`. Returns every message up to there, from the start; the caller starts a fresh store. */
  seek(ms: number): Message[] {
    this.next = 0;
    this.position = 0;
    return this.takeUntil(Number.isFinite(ms) ? Math.max(0, ms) : 0);
  }

  private takeUntil(ms: number): Message[] {
    const out: Message[] = [];
    this.position = ms;
    while (this.next < this.messages.length) {
      const m = this.messages[this.next];
      if (!m) break;
      const due = m.type === 'hello' ? 0 : m.rx_ms;
      if (due > ms) break;
      out.push(m);
      this.next++;
    }
    return out;
  }
}
