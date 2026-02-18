/*
 * ChordFlow v10
 *
 * Den här versionen bygger vidare på v9 och lägger till ett
 * metronompip (audio) för varje beat samt möjligheten att fälla ihop
 * den övre kontrollpanelen. Funktionen för metatitel, tempo, variabla
 * takt-längder och komprimerade ackordsekvenser finns kvar.
 */

// Globala variabler
let sections = [];
let timeline = [];
let sectionOffsets = [];
let barOffsets = [];
let currentSectionIndex = 0;
let playIndex = 0;
let timer = null;

// Metronom och autoscroll
let metronomeEnabled = true;
let autoScrollEnabled = false;

// Lyrics synlighet och flagga om det finns text
let hasLyrics = false;
let lyricsVisible = true;

// Scroll-sync mellan lyrics-rad och mikro-rad för aktuell sektion
let isSyncingScroll = false;

function setupScrollSync() {
  const lyricsRow = document.getElementById('lyricsRow');
  const microCurrent = document.getElementById('microCurrent');
  if (!lyricsRow || !microCurrent) return;

  // använd onscroll för att undvika att stacka lyssnare vid rebuild
  lyricsRow.onscroll = () => {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    microCurrent.scrollLeft = lyricsRow.scrollLeft;
    isSyncingScroll = false;
  };
  microCurrent.onscroll = () => {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    lyricsRow.scrollLeft = microCurrent.scrollLeft;
    isSyncingScroll = false;
  };
}

// AudioContext för metronompip
let audioCtx = null;

/**
 * Spelar upp ett kort pip för metronomen. Skapar AudioContext vid
 * första anropet om det behövs. Använder en square-oscillator för
 * tydligt klick.
 */
function playTick() {
  // spela inte ljud om metronomen är avstängd
  if (!metronomeEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // vissa browsers kräver user gesture för resume
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = 880; // 880 Hz pip
    gainNode.gain.value = 0.2;
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.05);
  } catch (e) {
    // om audio inte stöds gör inget
  }
}

/**
 * Parsar CSV-sträng till en 2D-array. Separator autodetekteras.
 */
function parseCsv(text) {
  const rows = text.trim().split(/\r?\n/);
  if (!rows.length) return [];
  const first = rows[0];
  const sep = first.includes(';') && !first.includes(',') ? ';' : ',';
  return rows.map(row =>
    row.split(new RegExp(`${sep}(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)`)).map(cell => cell.trim())
  );
}

/**
 * Parsar sektioner från CSV-arrayen från angivet startindex.
 */
function parseSections(csv, startRow) {
  const result = [];
  hasLyrics = false;
  const start = typeof startRow === 'number' ? startRow : 1;
  for (let r = start; r < csv.length; r++) {
    const row = csv[r];
    if (!row) continue;
    const name = (row[0] || '').trim() || `Section ${r}`;
    const bars = [];
    for (let c = 1; c < row.length; c++) {
      const cell = (row[c] || '').trim();
      if (!cell) break;
      let chordPart = cell;
      let textPart = null;
      const braceStart = cell.indexOf('{');
      const braceEnd = cell.lastIndexOf('}');
      if (braceStart >= 0 && braceEnd >= 0 && braceEnd > braceStart) {
        textPart = cell.substring(braceStart + 1, braceEnd).trim();
        chordPart = cell.substring(0, braceStart).trim();
        hasLyrics = true;
      }
      bars.push({ chordDef: chordPart, text: textPart });
    }
    if (bars.length) result.push({ name, bars });
  }
  return result;
}

/**
 * Parsar bar-definition till dynamisk array av beats. Punkt (.)
 * behåller föregående ackord, underscore (_) är tystnad. Ingen
 * padding görs.
 */
function parseBar(barDef) {
  // barDef kan vara sträng eller objekt med chordDef
  const chordString = typeof barDef === 'string' ? barDef : (barDef.chordDef || '');
  const normalized = chordString.replace(/\.\./g, '. .');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const beats = [];
  let last = '';
  tokens.forEach(tok => {
    if (tok === '.') {
      beats.push(last);
    } else {
      last = tok;
      beats.push(tok);
    }
  });
  return beats;
}

/**
 * Bygger timeline, sectionOffsets och barOffsets med variabla beats.
 */
function buildTimeline() {
  timeline = [];
  sectionOffsets = [];
  barOffsets = [];
  let globalIndex = 0;
  sections.forEach((sec, si) => {
    sectionOffsets[si] = globalIndex;
    barOffsets[si] = [];
    sec.bars.forEach((barObj, bi) => {
      barOffsets[si][bi] = globalIndex;
      const beats = parseBar(barObj);
      beats.forEach((ch, beatIndex) => {
        timeline.push({ section: si, bar: bi, beat: beatIndex, chord: ch });
        globalIndex++;
      });
    });
  });
}

/**
 * Bygger makroflödet med bredd baserat på totalt antal beats i varje
 * sektion.
 */
function buildMacroFlow() {
  const container = document.getElementById('macroFlow');
  container.innerHTML = '';
  const totalBeats = sections.reduce((sum, s) => {
    return sum + s.bars.reduce((bsum, barObj) => bsum + parseBar(barObj).length, 0);
  }, 0);
  sections.forEach((sec, index) => {
    const beatsInSec = sec.bars.reduce((bsum, barObj) => bsum + parseBar(barObj).length, 0);
    const widthPercent = totalBeats ? (beatsInSec / totalBeats) * 100 : 0;
    const div = document.createElement('div');
    div.className = 'macro-section';
    div.style.flexBasis = `${widthPercent}%`;
    div.textContent = sec.name;
    div.dataset.index = index;
    div.addEventListener('click', () => {
      navigateToSection(index);
    });
    container.appendChild(div);
  });
}

/**
 * Skapar bar-element med komprimerade segment och pipar. Vid click
 * startar playback från barens start.
 */
function createBarElement(sectionIndex, barIndex, barObj) {
  const barDiv = document.createElement('div');
  barDiv.className = 'bar';
  barDiv.dataset.sectionIndex = sectionIndex;
  barDiv.dataset.barIndex = barIndex;
  const beats = parseBar(barObj);

  // Viktigt för alignment med lyrics-raden: låt barens bredd spegla
  // antal beats i takten (men behåll min-width via CSS).
  barDiv.style.flexGrow = beats.length;
  barDiv.style.flexBasis = '0';

  const uniqueChords = [...new Set(beats.filter(ch => ch !== ''))];
  if (uniqueChords.length === 1) {
    const chordLabel = uniqueChords[0] === '_' ? '—' : uniqueChords[0];
    const sc = document.createElement('div');
    sc.className = 'single-chord';
    sc.textContent = chordLabel;
    barDiv.appendChild(sc);
    const pips = document.createElement('div');
    pips.className = 'beat-pips';
    for (let i = 0; i < beats.length; i++) {
      const pip = document.createElement('div');
      pip.className = 'pip';
      pip.dataset.beatIndex = i;
      pips.appendChild(pip);
    }
    barDiv.appendChild(pips);
  } else {
    // komprimera sekvenser
    const segments = [];
    let current = beats[0];
    let len = 1;
    for (let i = 1; i < beats.length; i++) {
      if (beats[i] === current) {
        len++;
      } else {
        segments.push({ chord: current, length: len });
        current = beats[i];
        len = 1;
      }
    }
    segments.push({ chord: current, length: len });
    const segContainer = document.createElement('div');
    segContainer.className = 'segment-container';
    segments.forEach((seg, segIndex) => {
      const segDiv = document.createElement('div');
      segDiv.className = 'segment';
      segDiv.textContent = seg.chord === '_' ? '—' : seg.chord;
      segDiv.style.flexGrow = seg.length;
      segDiv.style.flexBasis = '0';
      segDiv.dataset.segmentIndex = segIndex;
      segContainer.appendChild(segDiv);
    });
    barDiv.appendChild(segContainer);
    const pips = document.createElement('div');
    pips.className = 'beat-pips';
    for (let i = 0; i < beats.length; i++) {
      const pip = document.createElement('div');
      pip.className = 'pip';
      pip.dataset.beatIndex = i;
      pips.appendChild(pip);
    }
    barDiv.appendChild(pips);
  }
  barDiv.addEventListener('click', () => {
    const index = barOffsets[sectionIndex][barIndex];
    startPlaybackFrom(index);
  });
  return barDiv;
}

/**
 * Bygger de två mikroraderna för aktuell och nästa sektion.
 */
function buildMicroRows(sectionIndex) {
  const currentRow = document.getElementById('microCurrent');
  const nextRow = document.getElementById('microNext');
  currentRow.innerHTML = '';
  nextRow.innerHTML = '';
  const sec = sections[sectionIndex];
  if (sec) {
    sec.bars.forEach((barObj, bi) => {
      const barEl = createBarElement(sectionIndex, bi, barObj);
      currentRow.appendChild(barEl);
    });
  }
  const nextSecIndex = sectionIndex + 1;
  const secNext = sections[nextSecIndex];
  if (secNext) {
    secNext.bars.forEach((barObj, bi) => {
      const barEl = createBarElement(nextSecIndex, bi, barObj);
      nextRow.appendChild(barEl);
    });
  }
  // bygg lyrics-rad om det finns text
  buildLyricsRow(sectionIndex);

  // se till att lyrics-raden och microCurrent skrollar ihop
  setupScrollSync();
}

/**
 * Bygger lyrics-raden för aktuell sektion. Varje bar representeras
 * med en cell vars bredd baseras på antalet beats. Visas endast
 * om det finns lyrics i någon bar och om lyssynk är på.
 */
function buildLyricsRow(sectionIndex) {
  const row = document.getElementById('lyricsRow');
  // om inga lyrics finns i hela chart, göm rad och returnera
  if (!hasLyrics) {
    row.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  // om lyrics är avstängda
  if (!lyricsVisible) {
    row.classList.add('hidden');
    return;
  } else {
    row.classList.remove('hidden');
  }
  row.innerHTML = '';
  const sec = sections[sectionIndex];
  if (!sec) return;
  sec.bars.forEach((barObj, bi) => {
    const beats = parseBar(barObj);
    const cell = document.createElement('div');
    cell.className = 'lyrics-cell';
    cell.dataset.sectionIndex = sectionIndex;
    cell.dataset.barIndex = bi;
    // sätt flex-grow baserat på antal beats
    cell.style.flexGrow = beats.length;
    cell.style.flexBasis = '0';
    cell.textContent = barObj.text || '';
    row.appendChild(cell);
  });
}

/**
 * Navigerar till vald sektion från makro-rad.
 */
function navigateToSection(sectionIndex) {
  stopPlayback(false);
  currentSectionIndex = sectionIndex;
  playIndex = sectionOffsets[sectionIndex] || 0;
  buildMicroRows(currentSectionIndex);
  highlightMacro(currentSectionIndex);
  highlightMicro(playIndex);
}

/**
 * Highlightar makroflödet.
 */
function highlightMacro(sectionIndex) {
  document.querySelectorAll('.macro-section').forEach(el => {
    el.classList.remove('current');
    const idx = parseInt(el.dataset.index, 10);
    if (idx === sectionIndex) {
      el.classList.add('current');
    }
  });
}

/**
 * Rensar pip-highlight.
 */
function clearPips() {
  document.querySelectorAll('.pip').forEach(p => p.classList.remove('active'));
}

/**
 * Highlightar mikro-bar, segment och pip baserat på global playIndex.
 */
function highlightMicro(index) {
  document.querySelectorAll('.bar').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.segment').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.chord-beat').forEach(el => el.classList.remove('active'));
  clearPips();
  const curr = timeline[index];
  if (!curr) return;
  const barEls = document.querySelectorAll('#microFlow .bar');
  barEls.forEach(barEl => {
    const si = parseInt(barEl.dataset.sectionIndex, 10);
    const bi = parseInt(barEl.dataset.barIndex, 10);
    if (si === curr.section && bi === curr.bar) {
      barEl.classList.add('active');
      // pips
      const pips = barEl.querySelectorAll('.pip');
      pips.forEach(pip => {
        if (parseInt(pip.dataset.beatIndex, 10) === curr.beat) {
          pip.classList.add('active');
        }
      });
      // segment
      const segContainer = barEl.querySelector('.segment-container');
      if (segContainer) {
        const beats = parseBar(sections[curr.section].bars[curr.bar]);
        const segs = [];
        let c = beats[0];
        let len = 1;
        for (let i = 1; i < beats.length; i++) {
          if (beats[i] === c) {
            len++;
          } else {
            segs.push({ chord: c, length: len });
            c = beats[i];
            len = 1;
          }
        }
        segs.push({ chord: c, length: len });
        let acc = 0;
        let activeSeg = 0;
        for (let i = 0; i < segs.length; i++) {
          if (curr.beat < acc + segs[i].length) {
            activeSeg = i;
            break;
          }
          acc += segs[i].length;
        }
        const segEls = segContainer.querySelectorAll('.segment');
        if (segEls[activeSeg]) segEls[activeSeg].classList.add('active');
      }
      // fallback for chord-beat cells
      const beatsEls = barEl.querySelectorAll('.chord-beat');
      beatsEls.forEach(el => {
        if (parseInt(el.dataset.beatIndex, 10) === curr.beat) {
          el.classList.add('active');
        }
      });
    }
  });
  // display chord (empty for rest)
  const displayChord = curr.chord === '_' ? '' : (curr.chord || '');
  document.getElementById('currentChord').textContent = displayChord;

  // highlight lyrics cell
  document.querySelectorAll('.lyrics-cell').forEach(el => el.classList.remove('active'));
  const lyricsCells = document.querySelectorAll(
    `.lyrics-cell[data-sectionIndex="${curr.section}"][data-barIndex="${curr.bar}"]`
  );
  lyricsCells.forEach(cell => cell.classList.add('active'));
}

/**
 * HighlightPlayback varje beat. Spelar även pip.
 */
function highlightPlayback() {
  const curr = timeline[playIndex];
  if (!curr) {
    stopPlayback();
    return;
  }
  // spela pip först
  playTick();
  if (curr.section !== currentSectionIndex) {
    currentSectionIndex = curr.section;
    buildMicroRows(currentSectionIndex);
  }
  highlightMacro(curr.section);
  highlightMicro(playIndex);

  // autoscroll
  if (autoScrollEnabled) {
    autoScrollToCurrent();
  }
}

/**
 * Starta playback med count-in. Pip på varje slag.
 */
function startPlayback() {
  if (!sections.length) return;
  const bpm = parseInt(document.getElementById('tempo').value, 10) || 120;
  const beatInterval = 60000 / bpm;
  let count = 4;
  disableStartStopButtons(true);
  const countdown = setInterval(() => {
    if (count > 0) {
      playTick();
      document.getElementById('currentChord').textContent = count;
      count--;
    } else {
      clearInterval(countdown);
      document.getElementById('currentChord').textContent = '';
      playTick();
      highlightPlayback();
      timer = setInterval(() => {
        playIndex++;
        highlightPlayback();
      }, beatInterval);
    }
  }, beatInterval);
}

/**
 * Starta playback från en specifik index utan count-in. Pip startar direkt.
 */
function startPlaybackFrom(index) {
  if (!sections.length) return;
  const bpm = parseInt(document.getElementById('tempo').value, 10) || 120;
  const beatInterval = 60000 / bpm;
  stopPlayback(false);
  playIndex = index;
  currentSectionIndex = timeline[index] ? timeline[index].section : 0;
  buildMicroRows(currentSectionIndex);
  highlightMacro(currentSectionIndex);
  highlightMicro(playIndex);
  disableStartStopButtons(true);
  // spela pip omedelbart
  playTick();
  timer = setInterval(() => {
    playIndex++;
    highlightPlayback();
  }, beatInterval);
}

/**
 * Stoppar playback och återställer knappar. Optionellt tömmer display.
 */
function stopPlayback(resetDisplay = true) {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (resetDisplay) {
    document.getElementById('currentChord').textContent = '';
  }
  disableStartStopButtons(false);
}

/**
 * Toggla start/stop-knappar beroende på spelstatus.
 */
function disableStartStopButtons(playing) {
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  if (playing) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

/**
 * Laddar chart, extraherar metadata, bygger allt. Samma som i v9.
 */
function loadChart() {
  const raw = document.getElementById('csvInput').value.trim();
  if (!raw) {
    alert('Klistra in CSV-data.');
    return;
  }
  let csv = parseCsv(raw);
  let title = '';
  let tempoFromCsv = null;
  // meta-detektion
  if (csv.length > 0 && csv[0].length > 1) {
    const maybeTempo = parseInt(csv[0][1], 10);
    if (!isNaN(maybeTempo)) {
      title = csv[0][0] || '';
      tempoFromCsv = maybeTempo;
      csv.shift();
    }
  }
  // header detection
  if (csv.length > 0) {
    const cell0 = (csv[0][0] || '').trim().toLowerCase();
    if (cell0 === 'section' || cell0 === 'sektion') {
      csv.shift();
    }
  }
  // sätt titel eller placeholder "Titel" om ingen hittades
  document.getElementById('songTitle').textContent = title || 'Titel';
  if (tempoFromCsv) {
    document.getElementById('tempo').value = tempoFromCsv;
  }
  sections = parseSections(csv, 0);
  if (!sections.length) {
    alert('Inga sektioner hittades. Kontrollera CSV-formatet.');
    return;
  }
  buildTimeline();
  buildMacroFlow();
  currentSectionIndex = 0;
  playIndex = 0;
  buildMicroRows(currentSectionIndex);
  highlightMacro(currentSectionIndex);
  highlightMicro(playIndex);
  stopPlayback();

  // visa eller dölj textknapp beroende på om lyrics finns
  const textBtn = document.getElementById('textToggle');
  if (hasLyrics) {
    lyricsVisible = true;
    textBtn.style.display = '';
    textBtn.textContent = 'Text på';
    textBtn.classList.add('active');
    buildLyricsRow(currentSectionIndex);
  } else {
    lyricsVisible = false;
    const lyricsRow = document.getElementById('lyricsRow');
    lyricsRow.classList.add('hidden');
    textBtn.style.display = 'none';
  }
}

/**
 * Toggla kollapsning av kontrollpanelen.
 */
function toggleControls() {
  const controls = document.querySelector('.controls');
  controls.classList.toggle('collapsed');
  const toggleBtn = document.getElementById('toggleControls');
  if (controls.classList.contains('collapsed')) {
    toggleBtn.textContent = 'Visa panel ▼';
  } else {
    toggleBtn.textContent = 'Fäll ihop ▲';
  }
}

/**
 * Toggla metronom. Uppdaterar knappens text och active-klass.
 */
function toggleMetronome() {
  metronomeEnabled = !metronomeEnabled;
  const btn = document.getElementById('metronomeToggle');
  if (metronomeEnabled) {
    btn.textContent = 'Metronom på';
    btn.classList.add('active');
  } else {
    btn.textContent = 'Metronom av';
    btn.classList.remove('active');
  }
}

/**
 * Toggla autoscroll. Uppdaterar knappens text och active-klass.
 */
function toggleAutoScroll() {
  autoScrollEnabled = !autoScrollEnabled;
  const btn = document.getElementById('scrollToggle');
  if (autoScrollEnabled) {
    btn.textContent = 'Autoscroll på';
    btn.classList.add('active');
  } else {
    btn.textContent = 'Autoscroll av';
    btn.classList.remove('active');
  }
}

/**
 * Togglar visning av lyrics. Om inga lyrics finns så görs inget.
 */
function toggleText() {
  if (!hasLyrics) return;
  lyricsVisible = !lyricsVisible;
  const btn = document.getElementById('textToggle');
  if (lyricsVisible) {
    btn.textContent = 'Text på';
    btn.classList.add('active');
  } else {
    btn.textContent = 'Text av';
    btn.classList.remove('active');
  }
  // rebuild lyrics row for current section to reflect toggle
  buildLyricsRow(currentSectionIndex);
}

/**
 * Scrollar makro- och mikrorader så att aktuell bar/sektion syns.
 * Kallas varje beat om autoscroll är aktiverat.
 */
function autoScrollToCurrent() {
  const curr = timeline[playIndex];
  if (!curr) return;
  // scrolla mikroflow: hitta aktuellt bar-element i microCurrent
  const currentRow = document.getElementById('microCurrent');
  const barEls = currentRow.querySelectorAll('.bar');
  let targetBar = null;
  barEls.forEach(barEl => {
    const si = parseInt(barEl.dataset.sectionIndex, 10);
    const bi = parseInt(barEl.dataset.barIndex, 10);
    if (si === curr.section && bi === curr.bar) {
      targetBar = barEl;
    }
  });
  if (targetBar) {
    // scroll element into view, but allow some smoothness
    targetBar.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  }
  // scrolla makroflow så att aktuell sektion är synlig
  const macroContainer = document.getElementById('macroFlow');
  const currentMacro = macroContainer.querySelector('.macro-section.current');
  if (currentMacro) {
    currentMacro.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  }
}

// Eventlyssnare
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('load').addEventListener('click', loadChart);
  document.getElementById('start').addEventListener('click', () => {
    startPlayback();
  });
  document.getElementById('stop').addEventListener('click', () => {
    stopPlayback();
  });
  document.getElementById('toggleControls').addEventListener('click', toggleControls);

  // metronom- och autoscroll-lyssnare
  document.getElementById('metronomeToggle').addEventListener('click', toggleMetronome);
  document.getElementById('scrollToggle').addEventListener('click', toggleAutoScroll);
  document.getElementById('textToggle').addEventListener('click', toggleText);
});