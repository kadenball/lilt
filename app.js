(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('score');
  const ctx = canvas.getContext('2d');
  const instrument = LiltMusic.createInstrument({bpm: 84, beats: 8, scale: 'pentatonic', voice: 'glass', volume: .6});
  const colors = ['#8580b7', '#cd927f', '#85a895', '#bcad73', '#809ab2', '#b88eac'];
  const maxStrokes = 12;
  const history = [];
  let strokes = [];
  let nextId = 0;
  let draft = null;
  let activePointer = null;
  let box = {width: 1200, height: 400, dpr: 1};
  let area = {x: 24, y: 42, width: 1152, height: 312};
  let noticeTimer;
  let frameId;
  let lastPlaying = false;
  let lastPhase = 0;
  let demoIndex = 0;
  let exportInFlight = false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function notice(message) {
    $('notice').textContent = message;
    $('notice').classList.add('visible');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => $('notice').classList.remove('visible'), 3600);
  }

  function saveUndo() {
    history.push(strokes.map((stroke) => ({id: stroke.id, points: stroke.points.map((p) => ({...p}))})));
    if (history.length > 30) history.shift();
  }

  function sync() {
    instrument.setStrokes(strokes);
    $('stroke-count').textContent = `${strokes.length} / ${maxStrokes} LINES`;
    $('empty-state').hidden = strokes.length > 0 || draft !== null;
    $('undo').disabled = !history.length;
    $('clear').disabled = !strokes.length;
    $('download').disabled = !strokes.length || exportInFlight;
    $('add-note').disabled = strokes.length >= maxStrokes;
    $('loop-length').textContent = `${instrument.duration.toFixed(1)} SECOND LOOP`;
    updatePlayback();
    render();
  }

  function updatePlayback() {
    const playing = instrument.isPlaying;
    $('play').setAttribute('aria-pressed', String(playing));
    $('play-label').textContent = playing ? 'Pause' : 'Listen';
    $('play-symbol').textContent = playing ? 'Ⅱ' : '▶';
    $('status-label').textContent = playing ? 'A LITTLE MUSIC, GOING AROUND' : 'READY WHEN YOU ARE';
    $('status-dot').classList.toggle('playing', playing);
    lastPlaying = playing;
  }

  function position(event) {
    const rect = canvas.getBoundingClientRect();
    return {x: Math.max(0, Math.min(1, (event.clientX - rect.left - area.x) / area.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top - area.y) / area.height))};
  }

  function pointOnCanvas(p) {return {x: area.x + p.x * area.width, y: area.y + p.y * area.height};}

  function strokePath(points) {
    if (!points.length) return;
    ctx.beginPath();
    const start = pointOnCanvas(points[0]);
    ctx.moveTo(start.x, start.y);
    if (points.length === 1) {ctx.lineTo(start.x + 1, start.y); return;}
    for (let i = 1; i < points.length - 1; i++) {
      const point = pointOnCanvas(points[i]);
      const next = pointOnCanvas(points[i + 1]);
      ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    }
    const end = pointOnCanvas(points[points.length - 1]);
    ctx.lineTo(end.x, end.y);
  }

  function render() {
    ctx.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    const bands = $('scale').value === 'pentatonic' ? 11 : 15;
    for (let row = 0; row < bands; row++) {
      const y = area.y + row / (bands - 1) * area.height;
      ctx.beginPath(); ctx.moveTo(area.x, y); ctx.lineTo(area.x + area.width, y);
      ctx.strokeStyle = row === Math.floor(bands / 2) ? '#e2e3d5' : '#edede3';
      ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'center';
    for (let beat = 0; beat <= 8; beat++) {
      const x = area.x + beat / 8 * area.width;
      ctx.strokeStyle = '#e5e6db'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, area.y - 8); ctx.lineTo(x, area.y + area.height + 8); ctx.stroke();
      if (beat < 8) {ctx.fillStyle = '#afb3a4'; ctx.fillText(String(beat + 1), x + 9, area.y + area.height + 23);}
    }
    const phase = instrument.phase;
    const playing = instrument.isPlaying;
    const all = draft ? [...strokes, draft] : strokes;
    for (const stroke of all) {
      const color = colors[stroke.id % colors.length];
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      strokePath(stroke.points); ctx.strokeStyle = `${color}15`; ctx.lineWidth = 15; ctx.stroke();
      strokePath(stroke.points); ctx.strokeStyle = color; ctx.lineWidth = stroke === draft ? 2.5 : 3; ctx.stroke();
      if (stroke.points.length) {
        const start = pointOnCanvas(stroke.points[0]);
        ctx.beginPath(); ctx.arc(start.x, start.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      }
      if (playing) {
        // The glow follows the drawn line; sound is quantized to the selected scale.
        let near = null;
        for (let i = 1; i < stroke.points.length; i++) {
          const a = stroke.points[i - 1]; const b = stroke.points[i];
          if (Math.min(a.x, b.x) <= phase && phase <= Math.max(a.x, b.x)) {
            const fraction = a.x === b.x ? 0 : (phase - a.x) / (b.x - a.x);
            near = {x: phase, y: a.y + (b.y - a.y) * fraction}; break;
          }
        }
        if (near) {
          const p = pointOnCanvas(near);
          ctx.beginPath(); ctx.arc(p.x, p.y, reducedMotion ? 5 : 10, 0, Math.PI * 2); ctx.fillStyle = `${color}30`; ctx.fill();
          ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
          ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx.fillStyle = '#fffdf6'; ctx.fill();
        }
      }
    }
    if (playing) {
      const x = area.x + phase * area.width;
      if (!reducedMotion) {
        const gradient = ctx.createLinearGradient(x - 26, 0, x, 0); gradient.addColorStop(0, '#6d806500'); gradient.addColorStop(1, '#6d806508');
        ctx.fillStyle = gradient; ctx.fillRect(x - 26, area.y - 8, 26, area.height + 16);
      }
      ctx.beginPath(); ctx.moveTo(x, area.y - 8); ctx.lineTo(x, area.y + area.height + 8); ctx.strokeStyle = '#536e5870'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, area.y - 12, 3, 0, Math.PI * 2); ctx.fillStyle = '#536e58'; ctx.fill();
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    box = {width: rect.width, height: rect.height, dpr: Math.min(devicePixelRatio || 1, 2)};
    canvas.width = Math.round(box.width * box.dpr); canvas.height = Math.round(box.height * box.dpr);
    const margin = box.width < 600 ? 16 : 26;
    area = {x: margin, y: 45, width: box.width - margin * 2, height: box.height - 99};
    render();
  }

  function drawDemo(index = 0) {
    const shapes = [
      [{from: .025, to: .96, y: .28, amp: .13, waves: 1.2, phase: .4}, {from: .055, to: .74, y: .54, amp: .1, waves: 1.4, phase: 1.3}, {from: .26, to: .94, y: .79, amp: .07, waves: 1.1, phase: 2.4}],
      [{from: .03, to: .93, y: .42, amp: .23, waves: 1.3, phase: 0}, {from: .12, to: .87, y: .69, amp: .10, waves: 2, phase: 2}, {from: .4, to: .95, y: .2, amp: .07, waves: .9, phase: .8}],
      [{from: .02, to: .96, y: .51, amp: .25, waves: 1, phase: 2}, {from: .09, to: .92, y: .68, amp: .1, waves: 2, phase: 1}, {from: .18, to: .88, y: .2, amp: .08, waves: 2.3, phase: 0}],
    ];
    strokes = shapes[index % shapes.length].map((shape) => ({id: nextId++, points: Array.from({length: 90}, (_, i) => {
      const t = i / 89;
      return {x: shape.from + (shape.to - shape.from) * t, y: shape.y + Math.sin(t * Math.PI * 2 * shape.waves + shape.phase) * shape.amp};
    })}));
  }

  function rebuildPitchOptions() {
    const count = $('scale').value === 'pentatonic' ? 11 : 15;
    $('note-pitch').replaceChildren(...Array.from({length: count}, (_, i) => {
      const y = i / (count - 1);
      const option = document.createElement('option'); option.value = String(y); option.textContent = instrument.noteAt(y).name;
      if (i === Math.floor(count / 2)) option.selected = true;
      return option;
    }));
  }

  async function togglePlay() {
    try {
      if (instrument.isPlaying) instrument.pause();
      else {await instrument.play(); if (!strokes.length) notice('Draw a line while the loop plays, or add a note below.');}
      updatePlayback(); render();
    } catch (error) {notice(`Sound could not start: ${error.message}`);}
  }
  $('play').addEventListener('click', togglePlay);

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || activePointer !== null) return;
    if (strokes.length >= maxStrokes) {notice('Twelve lines fill this page. Undo or clear to make room.'); return;}
    event.preventDefault();
    activePointer = event.pointerId; canvas.setPointerCapture(event.pointerId);
    draft = {id: nextId++, points: [position(event)]};
    $('empty-state').hidden = true;
    const initialY = draft.points[0].y;
    instrument.audition(initialY).catch((error) => notice(`Sound could not start: ${error.message}`));
    render();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!draft || event.pointerId !== activePointer) return;
    const p = position(event); const last = draft.points[draft.points.length - 1];
    if (Math.hypot((p.x - last.x) * area.width, (p.y - last.y) * area.height) < 2) return;
    if (draft.points.length < 1200) draft.points.push(p);
    render();
  });
  function finishDrawing(event) {
    if (!draft || event.pointerId !== activePointer) return;
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') {draft = null; activePointer = null; sync(); return;}
    if (strokes.length >= maxStrokes) {draft = null; activePointer = null; sync(); notice('The page already has twelve lines. Undo to make room.'); return;}
    const endpoint = position(event);
    if (draft.points.length >= 1200) draft.points[draft.points.length - 1] = endpoint;
    else draft.points.push(endpoint);
    saveUndo(); strokes.push(draft); draft = null; activePointer = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    sync();
    if (!instrument.isPlaying) {instrument.play().then(updatePlayback).catch((error) => notice(`Press Listen to start sound: ${error.message}`));}
  }
  canvas.addEventListener('pointerup', finishDrawing);
  canvas.addEventListener('pointercancel', finishDrawing);
  canvas.addEventListener('lostpointercapture', finishDrawing);
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {event.preventDefault(); togglePlay();}
    if (event.key === 'Backspace' || (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey))) {event.preventDefault(); $('undo').click();}
  });
  $('undo').addEventListener('click', () => {if (history.length) {strokes = history.pop(); sync(); notice('Last change undone.');}});
  $('clear').addEventListener('click', () => {if (strokes.length) {saveUndo(); strokes = []; sync(); notice('A fresh page. Undo brings your sketch back.');}});
  $('demo').addEventListener('click', () => {saveUndo(); drawDemo(++demoIndex); sync(); notice('A new starting melody. Add a line of your own.');});
  document.querySelectorAll('[data-voice]').forEach((button) => button.addEventListener('click', () => {
    instrument.setVoice(button.dataset.voice);
    document.querySelectorAll('[data-voice]').forEach((b) => {b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button));});
  }));
  $('scale').addEventListener('change', () => {instrument.setScale($('scale').value); rebuildPitchOptions(); render();});
  $('tempo').addEventListener('input', () => {
    instrument.setTempo(Number($('tempo').value));
    $('tempo-value').replaceChildren(document.createTextNode(`${$('tempo').value} `), Object.assign(document.createElement('span'), {textContent: 'BPM'}));
    $('loop-length').textContent = `${instrument.duration.toFixed(1)} SECOND LOOP`;
  });
  $('volume').addEventListener('input', () => {instrument.setVolume(Number($('volume').value) / 100); $('volume-value').value = `${$('volume').value}%`;});
  $('guide-toggle').addEventListener('click', () => {const show = $('guide').hidden; $('guide').hidden = !show; $('guide-toggle').setAttribute('aria-expanded', String(show));});
  $('add-note').addEventListener('click', () => {
    if (strokes.length >= maxStrokes) return;
    const x = Number($('note-beat').value) / 8; const y = Number($('note-pitch').value);
    const end = Math.min(1, x + Number($('note-length').value) / 8) - 1e-6;
    saveUndo(); strokes.push({id: nextId++, points: [{x, y}, {x: end, y}]}); sync();
    notice(`${instrument.noteAt(y).name} added at beat ${Number($('note-beat').value) + 1}.`);
  });
  $('download').addEventListener('click', async () => {
    if (!strokes.length || exportInFlight) return;
    exportInFlight = true;
    const filename = `lilt-${$('scale').value}-${$('tempo').value}bpm.wav`;
    const button = $('download'); button.disabled = true; button.textContent = 'Making your sound…';
    try {
      const wav = await instrument.renderWav({cycles: 2});
      const url = URL.createObjectURL(wav); const link = document.createElement('a');
      link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000); notice('Two loops of your sketch, saved as a WAV file.');
    } catch (error) {notice(`The sound could not be saved: ${error.message}`);}
    finally {exportInFlight = false; button.innerHTML = 'Save a sound <span aria-hidden="true">↓</span>'; button.disabled = !strokes.length;}
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {instrument.pause(); updatePlayback();}
  });
  window.addEventListener('pagehide', () => {instrument.pause(); cancelAnimationFrame(frameId);});
  window.addEventListener('pageshow', () => {cancelAnimationFrame(frameId); frameId = requestAnimationFrame(animate);});
  function animate() {
    const phase = instrument.phase;
    if (instrument.isPlaying || lastPlaying || phase !== lastPhase) render();
    if (lastPlaying !== instrument.isPlaying) updatePlayback();
    lastPhase = phase;
    frameId = requestAnimationFrame(animate);
  }
  drawDemo(); rebuildPitchOptions(); sync();
  new ResizeObserver(resize).observe($('drawing-area'));
  resize(); frameId = requestAnimationFrame(animate);
})();
