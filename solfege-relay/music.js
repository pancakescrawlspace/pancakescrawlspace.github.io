// Notes, the keyboard's layout and the tone, as pure functions: nothing here knows of the
// page, the network or the exercise.
export const RATE = 44100;
const TAIL = 1;                      // seconds a note sounds on after its end
const PEAK = 0.25;
const REACH = 12;                    // the keyboard goes an octave either side of the start note
const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export const START_NOTES = Array.from({length: 25}, (_, i) => 48 + i);    // C3 to C5

const isBlack = pitch => [1, 3, 6, 8, 10].includes(pitch % 12);

export function noteName(pitch) {
  const octave = Math.floor(pitch / 12) - 1, names = [SHARPS[pitch % 12], FLATS[pitch % 12]];
  return [...new Set(names)].map(name => `${name}${octave}`).join(" / ");
}

// The keys for a start note, with black keys placed in percentages of the keyboard's width.
export function keyboardKeys(start) {
  let low = start - REACH, high = start + REACH;
  if (isBlack(low)) low--;
  if (isBlack(high)) high++;
  const pitches = Array.from({length: high - low + 1}, (_, i) => low + i);
  const whites = pitches.filter(pitch => !isBlack(pitch)).length;
  const width = 100 / whites;
  let seen = 0;
  const keys = pitches.map(pitch => {
    const key = {pitch, black: isBlack(pitch), start: pitch === start, label: null};
    if (key.black) {
      key.left = seen * width - width * .31;
      key.width = width * .62;
    } else {
      seen++;
      if (pitch % 12 === 0 || key.start) key.label = noteName(pitch);
    }
    return key;
  });
  return {keys, whites};
}

// How an answer compares with the note: "right", "octave" (the right note, in another
// octave) or "wrong".
export function compareAnswer(pitch, note) {
  if (pitch === note) return "right";
  return pitch % 12 === note % 12 ? "octave" : "wrong";
}

// The sound of notes given as [pitch, start, duration], in seconds.
export function tone(notes) {
  const total = Math.max(...notes.map(([, start, duration]) => start + duration + TAIL));
  const samples = new Float32Array(Math.floor(total * RATE) + 1);
  for (const [pitch, start, duration] of notes) {
    const frequency = 440 * 2 ** ((pitch - 69) / 12);
    const harmonics = [];
    for (let k = 1; k <= 8; k++) {
      if (frequency * k < RATE / 2.2) {
        harmonics.push([2 * Math.PI * frequency * k * (1 + 0.0004 * k * k) / RATE, 0.6 / k ** 1.3, 1.5 + 0.9 * k]);
      }
    }
    const first = Math.floor(start * RATE), length = Math.floor((duration + TAIL) * RATE);
    for (let i = 0; i < length; i++) {
      const t = i / RATE;
      let envelope = Math.min(1, t * 400);
      if (t > duration) envelope *= Math.exp(-(t - duration) * 10);
      let sum = 0;
      for (const [step, level, decay] of harmonics) sum += level * Math.exp(-t * decay) * Math.sin(step * i);
      samples[first + i] += envelope * sum;
    }
  }
  let peak = 1e-9;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i] / peak * PEAK;
  return samples;
}
