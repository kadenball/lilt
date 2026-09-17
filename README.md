# Lilt

A little musical instrument: draw a line and let it sing. Horizontal position is time; vertical position is pitch. Draw several lines to make harmonies around an eight-beat loop.

Open `index.html` directly in a modern browser, or run `npm start` and open <http://localhost:8766>. No installation, accounts, external requests, or build step. Press **Listen** to start the example melody, or draw a line to start your own.

Choose Glass, Warm, or Pluck, change the scale and tempo, and use **Save a sound** to export two loops as a WAV audio file. **Clear** starts a blank page; **Undo** restores your previous edit. **New melody** cycles through three starting sketches. Up to twelve lines can play together.

The **Add a note** controls allow composition without drawing. When the canvas is focused, Space plays or pauses; Backspace undoes. Mouse, pen, and touch drawing are supported. Changing tabs pauses playback. Your sketch and its voice, scale, tempo and volume are kept in this browser's local storage and come back when you reopen the page; nothing is sent anywhere. **Clear** starts a fresh page. Save audio if you want to keep a sound outside this browser.

Notes entered near the end of the loop stop at the loop boundary. A two-beat note starting on beat eight therefore lasts one beat.

Lines are quantized to 32 positions around the loop and notes in the chosen scale. Sound is synthesized on this computer with Web Audio. The playback line follows audio time. There are no samples to download.

`music.js` contains the synth and sequencer. `app.js` handles drawing and controls; `index.html` and `style.css` define the page. `music.js` also exports its pure score compiler and WAV encoder for use in Node.

## License

MIT. See [LICENSE](LICENSE).
