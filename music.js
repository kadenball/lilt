/* Lilt's audio engine. No audio context is created until unlock/play/audition.
 * Coordinates are normalized: x is loop time, y=0 is the highest note.
 * pause() resets the playhead. Tempo and score edits preserve the current phase.
 * The same voice builder powers live playback and offline WAV exports.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiltMusic = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const SCALES = Object.freeze({
    pentatonic: Object.freeze([0, 2, 4, 7, 9]),
    major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
    minor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  });
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const MAX_STROKES = 12;
  const COLUMNS = 32;
  const LOOKAHEAD = 0.12;
  const TAIL = 0.4;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const scaleName = value => Object.hasOwn(SCALES, value) ? value : 'pentatonic';

  function describeNote(midi) {
    return {
      midi,
      name: NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1),
      frequency: 440 * Math.pow(2, (midi - 69) / 12),
    };
  }

  // Ascending C3–C5 inclusive; noteAt maps screen y in the opposite direction.
  function getScaleNotes(scale = 'pentatonic') {
    const intervals = SCALES[scaleName(scale)];
    const notes = [];
    for (let octave = 0; octave < 2; octave++) {
      for (const interval of intervals) notes.push(describeNote(48 + octave * 12 + interval));
    }
    notes.push(describeNote(72));
    return notes;
  }

  function noteAt(y, scale = 'pentatonic') {
    const notes = getScaleNotes(scale);
    return notes[Math.round((1 - clamp(finite(y, 0.5), 0, 1)) * (notes.length - 1))];
  }

  function copyStrokes(strokes) {
    if (!Array.isArray(strokes)) return [];
    return strokes.slice(0, MAX_STROKES).map((stroke, index) => ({
      id: stroke && stroke.id != null ? stroke.id : index,
      points: Array.isArray(stroke && stroke.points) ? stroke.points
        .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))
        .slice(0, 4096)
        .map(point => ({ x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) })) : [],
    }));
  }

  // start/duration are fractions of one loop. A column contains at most one
  // pitch per stroke; touching equal pitches join into a single sustained note.
  function compileScore(strokes, options = {}) {
    const columns = clamp(Math.round(finite(options.columns, COLUMNS)), 4, 128);
    const scale = scaleName(options.scale);
    const score = [];
    for (const stroke of copyStrokes(strokes)) {
      const cells = new Map();
      const put = (x, y) => cells.set(Math.min(columns - 1, Math.floor(x * columns)), y);
      for (let index = 0; index < stroke.points.length; index++) {
        const point = stroke.points[index];
        if (index > 0) {
          const previous = stroke.points[index - 1];
          const span = point.x - previous.x;
          if (Math.abs(span) > 1e-9) {
            const first = Math.min(columns - 1, Math.floor(Math.min(point.x, previous.x) * columns));
            const last = Math.min(columns - 1, Math.floor(Math.max(point.x, previous.x) * columns));
            for (let column = first; column <= last; column++) {
              const x = clamp((column + 0.5) / columns, Math.min(point.x, previous.x), Math.max(point.x, previous.x));
              const y = previous.y + (point.y - previous.y) * ((x - previous.x) / span);
              cells.set(column, clamp(y, 0, 1));
            }
          }
        }
        put(point.x, point.y);
      }
      let active = null;
      for (const [column, y] of [...cells].sort((a, b) => a[0] - b[0])) {
        const note = noteAt(y, scale);
        if (active && active.midi === note.midi && active.column + active.columns === column) {
          active.columns++;
          active.duration = active.columns / columns;
        } else {
          active = {
            strokeId: stroke.id, column, columns: 1,
            start: column / columns, duration: 1 / columns,
            ...note,
          };
          score.push(active);
        }
      }
    }
    return score.sort((a, b) => a.start - b.start || a.midi - b.midi);
  }

  function createBus(context, volume) {
    const master = context.createGain();
    master.gain.value = volume * 0.78;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 12;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.14;
    master.connect(compressor);
    compressor.connect(context.destination);
    return { master, compressor };
  }

  function createVoice(context, destination, note, start, hold, voice, onEnded) {
    const presets = {
      glass: { type: 'sine', harmonic: 2.002, mix: 0.14, attack: 0.014, release: 0.19, sustain: 0.52 },
      warm: { type: 'triangle', harmonic: 0.5, mix: 0.21, attack: 0.032, release: 0.16, sustain: 0.72 },
      pluck: { type: 'triangle', harmonic: 2, mix: 0.1, attack: 0.004, release: 0.1, sustain: 0.08 },
    };
    const preset = presets[voice] || presets.glass;
    hold = Math.max(0.025, hold);
    const envelope = context.createGain();
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = voice === 'warm' ? 2600 : 6200;
    lowpass.Q.value = 0.5;
    envelope.connect(lowpass);
    lowpass.connect(destination);

    const peak = 0.057;
    const attackEnd = start + Math.min(preset.attack, hold * 0.3);
    const decayEnd = attackEnd + Math.min(voice === 'pluck' ? 0.42 : 0.16, hold * 0.6);
    const sustain = peak * preset.sustain;
    const releaseStart = start + hold;
    const end = releaseStart + preset.release;
    envelope.gain.setValueAtTime(0.00001, start);
    envelope.gain.exponentialRampToValueAtTime(peak, attackEnd);
    envelope.gain.exponentialRampToValueAtTime(sustain, decayEnd);
    envelope.gain.setValueAtTime(sustain, releaseStart);
    envelope.gain.exponentialRampToValueAtTime(0.00001, end);

    const oscillators = [];
    const mixes = [];
    for (const [ratio, mix, type] of [[1, 0.82, preset.type], [preset.harmonic, preset.mix, 'sine']]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.value = note.frequency * ratio;
      gain.gain.value = mix;
      oscillator.connect(gain);
      gain.connect(envelope);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
      oscillators.push(oscillator);
      mixes.push(gain);
    }
    let stopped = false;
    const handle = {
      strokeId: note.strokeId,
      start, end,
      stop(at = context.currentTime) {
        if (stopped) return;
        stopped = true;
        const release = Math.max(at, context.currentTime);
        if (typeof envelope.gain.cancelAndHoldAtTime === 'function') {
          envelope.gain.cancelAndHoldAtTime(release);
        } else {
          envelope.gain.cancelScheduledValues(release);
          envelope.gain.setValueAtTime(release < start ? 0 : sustain, release);
        }
        envelope.gain.linearRampToValueAtTime(0, release + 0.018);
        for (const oscillator of oscillators) oscillator.stop(release + 0.025);
      },
    };
    oscillators[0].onended = () => {
      for (const oscillator of oscillators) oscillator.disconnect();
      for (const gain of mixes) gain.disconnect();
      envelope.disconnect();
      lowpass.disconnect();
      if (onEnded) onEnded(handle);
    };
    return handle;
  }

  // Encode planar float samples (or an AudioBuffer) as a PCM16 little-endian WAV.
  // Returns an ArrayBuffer, and has no browser or Web Audio dependency.
  function encodeWav(input, sampleRate = 48000) {
    let channels = input;
    if (input && typeof input.getChannelData === 'function') {
      sampleRate = input.sampleRate;
      channels = Array.from({ length: input.numberOfChannels }, (_, channel) => input.getChannelData(channel));
    }
    if (!Array.isArray(channels) || channels.length < 1 || channels.length > 8) {
      throw new TypeError('WAV samples must be an array of one to eight channels.');
    }
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
      throw new RangeError('WAV sample rate must be between 8000 and 192000 Hz.');
    }
    const frames = channels[0].length;
    if (!channels.every(channel => channel && channel.length === frames)) {
      throw new RangeError('WAV channels must contain the same number of samples.');
    }
    const bytes = frames * channels.length * 2;
    const buffer = new ArrayBuffer(44 + bytes);
    const view = new DataView(buffer);
    const writeText = (offset, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + bytes, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels.length, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels.length * 2, true);
    view.setUint16(32, channels.length * 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, bytes, true);
    let offset = 44;
    for (let frame = 0; frame < frames; frame++) {
      for (const channel of channels) {
        const sample = clamp(finite(channel[frame], 0), -1, 1);
        view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
        offset += 2;
      }
    }
    return buffer;
  }

  function createInstrument(options = {}) {
    let bpm = clamp(finite(options.bpm, 84), 40, 180);
    const beats = options.beats === 4 ? 4 : 8;
    let scale = scaleName(options.scale);
    let voice = ['glass', 'warm', 'pluck'].includes(options.voice) ? options.voice : 'glass';
    let volume = clamp(finite(options.volume, 0.75), 0, 1);
    let strokes = [];
    let score = [];
    let context = null;
    let bus = null;
    let running = false;
    let destroyed = false;
    let timer = null;
    let origin = 0;
    let nextCycle = 0;
    let nextIndex = 0;
    let transportRequest = 0;
    const voices = new Set();
    const duration = () => (60 / bpm) * beats;
    const phase = () => !running || !context ? 0 : (Math.max(0, context.currentTime - origin) / duration()) % 1;

    async function unlock() {
      if (destroyed) throw new Error('This instrument has been closed.');
      if (!context) {
        const AudioContext = root.AudioContext || root.webkitAudioContext;
        if (!AudioContext) throw new Error('This browser does not support Web Audio.');
        context = new AudioContext();
        bus = createBus(context, volume);
      }
      if (context.state === 'suspended') await context.resume();
    }

    function silence() {
      if (!context) return;
      for (const handle of voices) handle.stop();
      voices.clear();
    }

    function scheduleVoice(note, start, hold) {
      // Include release tails and the lookahead window in the bound: even at
      // 180 BPM with four beats, all twelve strokes fit without voice stealing.
      if (voices.size >= 128) {
        const oldest = voices.values().next().value;
        oldest.stop();
        voices.delete(oldest);
      }
      const handle = createVoice(context, bus.master, note, start, hold, voice, ended => voices.delete(ended));
      voices.add(handle);
    }

    function advanceCursor() {
      nextIndex++;
      if (nextIndex >= score.length) {
        nextIndex = 0;
        nextCycle++;
      }
    }

    function seekCursor(time) {
      const loopDuration = duration();
      nextCycle = Math.max(0, Math.floor((time - origin) / loopDuration));
      nextIndex = 0;
      if (!score.length) return;
      while (origin + (nextCycle + score[nextIndex].start) * loopDuration < time - 0.000001) advanceCursor();
    }

    function tick() {
      if (!running || !context || !score.length) return;
      const now = context.currentTime;
      const loopDuration = duration();
      // A throttled tab skips stale events; it never plays an accumulated burst.
      if (origin + (nextCycle + score[nextIndex].start) * loopDuration < now - 0.035) seekCursor(now + 0.008);
      for (let count = 0; count < 512; count++) {
        const note = score[nextIndex];
        const start = origin + (nextCycle + note.start) * loopDuration;
        if (start > now + LOOKAHEAD) break;
        scheduleVoice(note, Math.max(now, start), note.duration * loopDuration * 0.93);
        advanceCursor();
      }
    }

    function rebuildSchedule() {
      if (!running || !context) return;
      silence();
      const now = context.currentTime;
      const loopDuration = duration();
      const elapsed = Math.max(0, now - origin);
      const cycle = Math.floor(elapsed / loopDuration);
      const position = (elapsed / loopDuration) % 1;
      const restart = now + 0.022;
      // Resume a long note crossing the edit point, so edits to a different
      // stroke do not leave a sustained line silent until its next loop.
      for (const note of score) {
        const noteStart = origin + (cycle + note.start) * loopDuration;
        const noteEnd = noteStart + note.duration * loopDuration * 0.93;
        if (note.start <= position && noteStart < now && noteEnd > restart + 0.025) {
          scheduleVoice(note, restart, noteEnd - restart);
        }
      }
      seekCursor(now);
      tick();
    }

    const instrument = {
      unlock,
      async play() {
        if (running) return;
        const request = ++transportRequest;
        await unlock();
        if (request !== transportRequest || destroyed || running) return;
        running = true;
        origin = context.currentTime + 0.035;
        nextCycle = 0;
        nextIndex = 0;
        tick();
        timer = root.setInterval(tick, 25);
      },
      pause() {
        transportRequest++;
        running = false;
        if (timer !== null) root.clearInterval(timer);
        timer = null;
        silence();
      },
      get isPlaying() { return running; },
      get phase() { return phase(); },
      get duration() { return duration(); },
      setTempo(value) {
        const position = phase();
        bpm = clamp(finite(value, bpm), 40, 180);
        if (running) {
          origin = context.currentTime - position * duration();
          rebuildSchedule();
        }
      },
      setScale(value) {
        scale = scaleName(value);
        score = compileScore(strokes, { scale });
        rebuildSchedule();
      },
      setVoice(value) {
        if (['glass', 'warm', 'pluck'].includes(value)) voice = value;
        rebuildSchedule();
      },
      setVolume(value) {
        volume = clamp(finite(value, volume), 0, 1);
        if (context && bus) bus.master.gain.setTargetAtTime(volume * 0.78, context.currentTime, 0.015);
      },
      setStrokes(value) {
        strokes = copyStrokes(value);
        score = compileScore(strokes, { scale });
        rebuildSchedule();
      },
      noteAt(y) { return noteAt(y, scale); },
      async audition(y) {
        await unlock();
        if (!destroyed) scheduleVoice(noteAt(y, scale), context.currentTime + 0.004, 0.22);
      },
      async renderWav({ cycles = 2 } = {}) {
        if (destroyed) throw new Error('This instrument has been closed.');
        const OfflineAudioContext = root.OfflineAudioContext || root.webkitOfflineAudioContext;
        if (!OfflineAudioContext) throw new Error('This browser cannot export audio. Try a current desktop browser.');
        const count = clamp(Math.round(finite(cycles, 2)), 1, 8);
        const loopDuration = duration();
        const snapshot = score.map(note => ({ ...note }));
        const exportVoice = voice;
        const sampleRate = 48000;
        const offline = new OfflineAudioContext(2, Math.ceil((loopDuration * count + TAIL) * sampleRate), sampleRate);
        const output = createBus(offline, volume);
        for (let cycle = 0; cycle < count; cycle++) {
          for (const note of snapshot) {
            createVoice(offline, output.master, note, (cycle + note.start) * loopDuration,
              note.duration * loopDuration * 0.93, exportVoice);
          }
        }
        const rendered = await offline.startRendering();
        return new root.Blob([encodeWav(rendered)], { type: 'audio/wav' });
      },
      destroy() {
        instrument.pause();
        destroyed = true;
        if (context && context.state !== 'closed') context.close().catch(() => {});
      },
    };
    return instrument;
  }

  return Object.freeze({ createInstrument, compileScore, noteAt, getScaleNotes, encodeWav, COLUMNS, MAX_STROKES });
});
