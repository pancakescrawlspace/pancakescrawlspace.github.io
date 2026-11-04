// Plays notes. Browsers only let a page make sound after a click or tap, and a new round
// arrives without one, so the page asks locked() before playing by itself.
import {RATE, tone} from "./music.js";

export class Sound {
  context = null;
  source = null;
  buffers = new Map();

  // On any click: from then on, sound may play.
  unlock() {
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") this.context.resume();
  }

  locked() {
    return this.context?.state !== "running";
  }

  // Notes are [pitch, start, duration], in seconds. They replace whatever is sounding.
  play(notes) {
    this.unlock();
    const key = JSON.stringify(notes);
    if (!this.buffers.has(key)) {
      const samples = tone(notes);
      const buffer = this.context.createBuffer(1, samples.length, RATE);
      buffer.copyToChannel(samples, 0);
      this.buffers.set(key, buffer);
    }
    this.source?.stop();
    this.source = this.context.createBufferSource();
    this.source.buffer = this.buffers.get(key);
    this.source.connect(this.context.destination);
    this.source.start();
  }
}
