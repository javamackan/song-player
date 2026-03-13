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
// playIndex anger aktuell index i timeline som spelas/visas
let playIndex = 0;
// timer används endast för count-in sekvensen
let timer = null;

// Default tidsignatur (signature) för låten. Om inte satt via CSV antas 4/4.
// Detta värde uppdateras när en låt laddas in via loadChart.
let defaultSignature = '4/4';

// scheduleTimes innehåller exakta tidpunkter (ms) för varje beat i timeline relativt start.
let scheduleTimes = [];

// startTime anger när playback började (performance.now()). Nudge och offset justeras mot denna.
let startTime = 0;

// ackumulerad offset (ms) för nudging. Positiva värden försenar highlighten, negativa värden snabbar upp.
let timeOffset = 0;

// referens till animationFrame för vår scheduler-loop. Används för att avbryta på stop.
let animationFrameId = null;

// Konstanter för nudge-storlek (ms)
const NUDGE_STEP_MS = 20;

/**
 * Justerar tiden framåt genom att minska timeOffset. Detta gör att
 * nästkommande beat triggas tidigare.
 */
function nudgeForward() {
  // minska offset med nudge-steg
  timeOffset -= NUDGE_STEP_MS;
}

/**
 * Justerar tiden bakåt genom att öka timeOffset. Detta fördröjer
 * nästa beat något.
 */
function nudgeBackward() {
  timeOffset += NUDGE_STEP_MS;
}

/**
 * Laddar nästa låt i songsList utan att starta playback. Om sista
 * låten är aktiv händer ingenting.
 */
function loadNextSong() {
  const selectEl = document.getElementById('songSelect');
  if (!selectEl || !songsList.length) return;
  const currentValue = selectEl.value;
  let currentIndex = songsList.findIndex(s => s.file === currentValue);
  if (currentIndex < songsList.length - 1) {
    currentIndex++;
    selectEl.value = songsList[currentIndex].file;
    loadSelectedSong();
  }
}

/**
 * Laddar föregående låt i songsList utan att starta playback.
 */
function loadPrevSong() {
  const selectEl = document.getElementById('songSelect');
  if (!selectEl || !songsList.length) return;
  const currentValue = selectEl.value;
  let currentIndex = songsList.findIndex(s => s.file === currentValue);
  if (currentIndex > 0) {
    currentIndex--;
    selectEl.value = songsList[currentIndex].file;
    loadSelectedSong();
  }
}

/**
 * Kör en beat: highlightar aktuell position och avancerar playIndex. Om
 * slutet nås stoppas playback.
 */
function doPlayStep() {
  if (playIndex >= timeline.length) {
    stopPlayback();
    return;
  }
  // highlight current beat
  highlightPlayback();
  playIndex++;
  if (playIndex >= timeline.length) {
    stopPlayback();
  }
}

/**
 * Scheduler-loop som körs via requestAnimationFrame. Den jämför
 * aktuell tid mot scheduleTimes och exekverar beat när tiden har
 * passerat. Efter sista beat stoppas playback.
 */
function schedulerLoop() {
  if (animationFrameId === null) return; // stop if cancelled
  const now = performance.now();
  // elapsed tid inklusive nudge-offset
  const elapsed = now - startTime + timeOffset;
  // exekvera så många beat som behövs för att komma ikapp
  while (playIndex < scheduleTimes.length && elapsed >= scheduleTimes[playIndex]) {
    doPlayStep();
  }
  // fortsätt om inte slutet nåtts
  if (playIndex < scheduleTimes.length) {
    animationFrameId = requestAnimationFrame(schedulerLoop);
  }
}

/**
 * Startar scheduler från aktuell playIndex. startTime sätts till
 * performance.now() minus scheduleTimes[playIndex] så att nästa
 * beat inträffar rätt. timeOffset nollställs.
 */
function startScheduler() {
  startTime = performance.now() - (scheduleTimes[playIndex] || 0);
  timeOffset = 0;
  animationFrameId = requestAnimationFrame(schedulerLoop);
}

/**
 * Beräknar exakta tidpunkter (ms) för varje beat i timeline baserat på BPM
 * och barernas subdivision. scheduleTimes[0] = 0, scheduleTimes[i]
 * anger tiden från start då beat i ska spelas. Vi utgår från att
 * varje takt motsvarar fyra fjärdedelar (barDuration = 4 * 60000/BPM) och
 * delar in efter subdivision.
 * @param {number} bpm slag per minut för fjärdedelar
 */
function computeScheduleTimes(bpm) {
  scheduleTimes = [];
  const quarterTime = 60000 / (bpm || 120);
  let total = 0;
  for (let i = 0; i < timeline.length; i++) {
    scheduleTimes[i] = total;
    const step = timeline[i];
    const barObj = sections[step.section].bars[step.bar];
    // subdivision (number of sub-steps) for this bar
    const subdiv = barObj.subdivision || parseSignatureToSubdivision(defaultSignature);
    // Determine the number of beats (quarter notes) this bar should span.
    // Bars with subdivision >= 4 keep a length of 4 quarter notes, while bars
    // with subdivision < 4 (e.g. 2/4, 3/4) have length equal to subdiv quarter notes.
    const barBeats = subdiv < 4 ? subdiv : 4;
    // duration for one sub-step
    const stepDuration = quarterTime * barBeats / subdiv;
    total += stepDuration;
  }
}

// Pastellfärger för sektioner. Cykla igenom vid behov
const pastelPalette = [
  '#f7f0fa', // lavender blush
  '#f0f7ff', // light blue
  '#f9f5ea', // ivory
  '#eefaf5', // mint
  '#fff7f0', // light peach
  '#f5f5e8'  // very light beige
];
// Tilldelade färger per sektion (fylls i loadChart)
let sectionColors = [];

// Mörkare kantfärger per sektion. Beräknas från sectionColors i loadChart
let sectionBorderColors = [];

// Metronom och autoscroll
let metronomeEnabled = true;
let autoScrollEnabled = false;

// Synlighet för sektionstexter och flagga om det finns sådana
// hasSectionText blir true om minst en sektion har text definierad i CSV
let hasSectionText = false;
// textVisible styr om sektionstexter visas – togglas via knappen "Text på/av"
let textVisible = true;

// Lista över låtar som kan väljas via dropdown
let songsList = [];

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
 * Beräknar en mörkare variant av en hex-färg genom att multiplicera
 * varje kanal med en faktor (<1). Om inmatningen saknas eller är
 * ogiltig returneras den ursprungliga färgen.
 * @param {string} hex färg i format #rrggbb
 * @param {number} factor multiplikationsfaktor (0–1)
 */
function getDarkerColor(hex, factor = 0.7) {
  if (!hex || !hex.startsWith('#') || hex.length !== 7) return hex;
  const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * factor)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * factor)));
  const toHex = v => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Konverterar en tidsignatur (t.ex. "4/4", "8/4", "12/8") till antal sub-steg per takt.
 * Vi använder täljaren (num) som antal subdivisioner i en 4/4-takt. Om ogiltigt,
 * returnerar 4 som standard. Detta gör att 8/4 ger 8 sub-steg (åttondelar) och
 * 12/8 ger 12 sub-steg (trioler). Användaren kan definiera andra signaturer om
 * numeratorn är >0. Exempel: 6/8 => 6 sub-steg.
 * @param {string} signature tidsignatur, t.ex. "4/4". Om null returneras 4.
 * @returns {number} antal sub-steg i denna takt
 */
function parseSignatureToSubdivision(signature) {
  if (!signature || typeof signature !== 'string') return 4;
  const parts = signature.split('/');
  if (parts.length < 2) return 4;
  const num = parseInt(parts[0], 10);
  if (!isNaN(num) && num > 0) {
    return num;
  }
  return 4;
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
  hasSectionText = false;
  const start = typeof startRow === 'number' ? startRow : 1;
  for (let r = start; r < csv.length; r++) {
    const row = csv[r];
    if (!row) continue;
    const name = (row[0] || '').trim() || `Section ${r}`;
    // trim trailing empty cells
    let lastIndex = row.length - 1;
    while (lastIndex > 0 && !(row[lastIndex] && row[lastIndex].trim())) {
      lastIndex--;
    }
    let textLines = null;
    // check if last cell contains section text in curly braces
    const lastCell = row[lastIndex] ? row[lastIndex].trim() : '';
    let barsEndIndex = lastIndex;
    if (lastCell.startsWith('{') && lastCell.endsWith('}')) {
      // extract text and split by '='
      const inner = lastCell.slice(1, -1).trim();
      if (inner) {
        textLines = inner.split('=').map(s => s.trim());
        hasSectionText = true;
      }
      barsEndIndex = lastIndex - 1;
    }
    const bars = [];
    for (let c = 1; c <= barsEndIndex; c++) {
      const cell = (row[c] || '').trim();
      if (!cell) break;
      // Bar-def: kan innehålla optional signature-prefix, cue-text i hakparanteser och själva ackorddefinitionen.
      let chordDef = cell;
      let cue = null;
      // extrahera cue i hakparanteser, t.ex. [trumrullning]
      const cueMatch = chordDef.match(/\[(.*?)\]/);
      if (cueMatch) {
        cue = cueMatch[1].trim();
        chordDef = chordDef.replace(cueMatch[0], '').trim();
      }
      // extrahera optional signature-override i början, t.ex. "8/4 " eller "12/8 "
      let subdivisionOverride = null;
      const sigMatch = chordDef.match(/^(\d+\/\d+)\s+/);
      if (sigMatch) {
        subdivisionOverride = sigMatch[1];
        chordDef = chordDef.slice(sigMatch[0].length).trim();
      }
      // beräkna subdivision (antal sub-steg) baserat på override eller global defaultSignature
      const subdivision = parseSignatureToSubdivision(subdivisionOverride || defaultSignature);
      bars.push({ chordDef: chordDef, cue, subdivision });
    }
    if (bars.length) {
      result.push({ name, bars, textLines });
    }
  }
  return result;
}

/**
 * Parsar bar-definition till dynamisk array av beats. Punkt (.)
 * behåller föregående ackord, underscore (_) är tystnad. Ingen
 * padding görs.
 */
function parseBarLegacy(barDef) {
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
 * Returnerar beats-array för en bar med hänsyn till dess subdivision och '.'-notation.
 * Om barObj har subdivision N, fördelas tokens över N sub-steg. Punkt (.)
 * behåller föregående ackord, underscore (_) är tystnad.
 * @param {object|string} barObj objekt med chordDef, cue och subdivision, eller sträng
 * @returns {string[]} lista av ackord/paus för varje sub-steg
 */
function getBeats(barObj) {
  let subdivision;
  let chordString;
  if (typeof barObj === 'string') {
    chordString = barObj;
    subdivision = 4;
  } else {
    chordString = barObj.chordDef || '';
    subdivision = barObj.subdivision || 4;
  }
  // normalisera: ersätt ".." med ". ." så att dubbla punkter tolkas som separata tokens
  const normalized = chordString.replace(/\.{2}/g, '. .');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  // om inga tokens, returnera tysta sub-steg
  if (tokens.length === 0) {
    return Array.from({ length: subdivision }, () => '');
  }
  // om antal tokens = subdivision, använd enkel logik med '.' för att hålla
  if (tokens.length === subdivision) {
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
  // annars fördela tokens jämnt över subdivision
  const beats = [];
  const base = Math.floor(subdivision / tokens.length);
  let remainder = subdivision % tokens.length;
  let last = '';
  tokens.forEach((tok) => {
    // rep = antal sub-steg för denna token
    let rep = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    for (let i = 0; i < rep; i++) {
      if (tok === '.') {
        // punkt: behåll föregående ackord
        beats.push(last);
      } else {
        last = tok;
        beats.push(tok);
      }
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
      const beats = getBeats(barObj);
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
    return sum + s.bars.reduce((bsum, barObj) => bsum + getBeats(barObj).length, 0);
  }, 0);
  sections.forEach((sec, index) => {
    const beatsInSec = sec.bars.reduce((bsum, barObj) => bsum + getBeats(barObj).length, 0);
    const widthPercent = totalBeats ? (beatsInSec / totalBeats) * 100 : 0;
    const div = document.createElement('div');
    div.className = 'macro-section';
    div.style.flexBasis = `${widthPercent}%`;
    div.textContent = sec.name;
    div.dataset.index = index;
    // definiera sektionens basfärg via CSS variabel. Aktuell markering ändras via klass .current
    const color = sectionColors[index] || pastelPalette[index % pastelPalette.length];
    div.style.setProperty('--section-color', color);
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
  // sätt kantfärg baserat på mörkare variant av sektionens pastellfärg
  const borderColor = sectionBorderColors[sectionIndex] || getDarkerColor(sectionColors[sectionIndex] || pastelPalette[sectionIndex % pastelPalette.length], 0.7);
  barDiv.style.borderColor = borderColor;
  // visa svagt bakgrundsfärg när aktiv: hanteras via CSS .bar.active men vi kan sätta border-färg ovan
  const beats = getBeats(barObj);
  const uniqueChords = [...new Set(beats.filter(ch => ch !== ''))];
  if (uniqueChords.length === 1) {
    const chordLabel = uniqueChords[0] === '_' ? '—' : uniqueChords[0];
    const sc = document.createElement('div');
    sc.className = 'single-chord';
    sc.textContent = chordLabel;
    barDiv.appendChild(sc);
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
  }
  // generera pips baserat på pulses (kvartspuls) snarare än subdivision
  const subdiv = barObj && barObj.subdivision ? barObj.subdivision : parseSignatureToSubdivision(defaultSignature);
  const pulses = subdiv < 4 ? subdiv : 4;
  const pips = document.createElement('div');
  pips.className = 'beat-pips';
  for (let i = 0; i < pulses; i++) {
    const pip = document.createElement('div');
    pip.className = 'pip';
    // beräkna vilket subbeat-index denna pip representerar (så att highlight träffar kvartspulsen)
    const pulseBeatIndex = Math.floor(i * subdiv / pulses);
    pip.dataset.pulseIndex = pulseBeatIndex;
    pips.appendChild(pip);
  }
  barDiv.appendChild(pips);
  // lägg till cue-text om definierad för bar
  if (barObj && barObj.cue) {
    const cueDiv = document.createElement('div');
    cueDiv.className = 'cue-text';
    cueDiv.textContent = barObj.cue;
    barDiv.appendChild(cueDiv);
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
  // uppdatera sektionstext
  buildSectionText(sectionIndex);
}


/**
 * Bygger eller uppdaterar textraden för sektioner. Visar texten
 * ovanför ackord och macroflow om det finns text för aktuell
 * sektion och textvisning är påslagen.
 */
function buildSectionText(sectionIndex) {
  const container = document.getElementById('sectionText');
  // om det inte finns någon sektionstext globalt eller om text är avstängd, döljs textbehållaren
  if (!hasSectionText || !textVisible) {
    container.textContent = '';
    container.style.display = 'none';
    return;
  }
  // hämta aktuella textrader för denna sektion, om några
  const sec = sections[sectionIndex];
  let currLines = [];
  if (sec && sec.textLines && sec.textLines.length > 0) {
    currLines = sec.textLines;
  }
  // förhandsvisning: ta första raden från nästa sektion om den finns och innehåller text; annars tomt
  let preview = '';
  const nextSec = sections[sectionIndex + 1];
  if (nextSec && nextSec.textLines && nextSec.textLines.length > 0) {
    preview = nextSec.textLines[0];
  }
  // om varken aktuella rader eller preview finns, visa ingenting
  if ((!currLines || currLines.length === 0) && !preview) {
    container.textContent = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = '';
  // bygg innehåll: aktuella rader och eventuell preview
  let html = '';
  if (currLines && currLines.length > 0) {
    html += currLines.map(line => line).join('<br>');
  }
  if (preview) {
    if (html) {
      html += '<br>';
    }
    html += '<span class="next-preview">' + preview + '</span>';
  }
  container.innerHTML = html;
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
      // markera pipar (kvartspuls) för denna bar
      const pips = barEl.querySelectorAll('.pip');
      pips.forEach(pip => {
        const pulseIndex = parseInt(pip.dataset.pulseIndex, 10);
        if (pulseIndex === curr.beat) {
          pip.classList.add('active');
        }
      });
      // segment
      const segContainer = barEl.querySelector('.segment-container');
      if (segContainer) {
        const beats = getBeats(sections[curr.section].bars[curr.bar]);
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
  // display cue
  const cueDisplayEl = document.getElementById('currentCue');
  let cueText = '';
  const secObj = sections[curr.section];
  if (secObj && secObj.bars && secObj.bars[curr.bar] && secObj.bars[curr.bar].cue) {
    cueText = secObj.bars[curr.bar].cue;
  }
  cueDisplayEl.textContent = cueText || '';

  // highlight cue text within bar
  document.querySelectorAll('.cue-text').forEach(el => el.classList.remove('active'));
  const activeBar = Array.from(document.querySelectorAll('#microFlow .bar')).find(el => {
    return parseInt(el.dataset.sectionIndex, 10) === curr.section && parseInt(el.dataset.barIndex, 10) === curr.bar;
  });
  if (activeBar) {
    const cueEl = activeBar.querySelector('.cue-text');
    if (cueEl) cueEl.classList.add('active');
  }

  // sektionstext markeras inte per bar
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
  // spela pip endast på kvartspuls (steg där beat är lika med pulse-index)
  const barObj = sections[curr.section].bars[curr.bar];
  const subdiv = barObj.subdivision || parseSignatureToSubdivision(defaultSignature);
  const pulses = subdiv < 4 ? subdiv : 4;
  const stepPerPulse = Math.floor(subdiv / pulses);
  // stepPerPulse kan vara 0 om pulses == subdiv, men vi vill beep varje beat i det fallet
  if (stepPerPulse === 0 || curr.beat % stepPerPulse === 0) {
    playTick();
  }
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
/**
 * Startar playback med count-in baserat på vald BPM. Vi använder
 * en exakt schemalagd sekvens av tider (scheduleTimes) för att
 * eliminera driften från setInterval. Count-in använder en enkel
 * setInterval med fyra slag innan scheduler startar.
 */
function startPlayback() {
  if (!sections.length) return;
  // stoppa eventuell tidigare uppspelning
  stopPlayback(false);
  const bpm = parseInt(document.getElementById('tempo').value, 10) || 120;
  // räkna ned från 4
  let count = 4;
  // nollställ playIndex och bygg scheduleTimes
  playIndex = 0;
  currentSectionIndex = 0;
  buildMicroRows(currentSectionIndex);
  highlightMacro(currentSectionIndex);
  highlightMicro(playIndex);
  computeScheduleTimes(bpm);
  disableStartStopButtons(true);
  timer = setInterval(() => {
    if (count > 0) {
      playTick();
      document.getElementById('currentChord').textContent = count;
      document.getElementById('currentCue').textContent = '';
      count--;
    } else {
      clearInterval(timer);
      timer = null;
      document.getElementById('currentChord').textContent = '';
      document.getElementById('currentCue').textContent = '';
      // Innan scheduler startas: highlighta aktuell sektion och bar (utan pip).
      // Highlighta makro och mikro så att användaren ser starten.
      highlightMacro(currentSectionIndex);
      highlightMicro(playIndex);
      // starta scheduler-loop; scheduler kommer spela pip vid första beat
      startScheduler();
    }
  }, (60000 / bpm));
}

/**
 * Starta playback från en specifik index utan count-in. Pip startar direkt.
 */
/**
 * Startar playback från given playIndex utan count-in. Använder
 * scheduler-loop med scheduleTimes. Spelar ett pip direkt och
 * startar highlight från aktuell position.
 * @param {number} index index i timeline att starta från
 */
function startPlaybackFrom(index) {
  if (!sections.length) return;
  const bpm = parseInt(document.getElementById('tempo').value, 10) || 120;
  // avbryt tidigare uppspelning
  stopPlayback(false);
  // sätt playIndex och uppdatera currentSectionIndex
  playIndex = index;
  const curr = timeline[playIndex];
  currentSectionIndex = curr ? curr.section : 0;
  buildMicroRows(currentSectionIndex);
  highlightMacro(currentSectionIndex);
  highlightMicro(playIndex);
  // beräkna nya scheduleTimes
  computeScheduleTimes(bpm);
  disableStartStopButtons(true);
  // highlighta bar och makro utan pip; scheduler kommer spela pip första gången
  highlightMacro(currentSectionIndex);
  highlightMicro(playIndex);
  // starta scheduler-loop
  startScheduler();
}

/**
 * Läser in songs.json och fyller dropdown-menyn. Kallas vid sidan start.
 */
async function loadSongList() {
  const selectEl = document.getElementById('songSelect');
  if (!selectEl) return;
  try {
    const res = await fetch('songs.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    songsList = Array.isArray(list) ? list : [];
    // sortera per namn för setlist-ordning
    songsList.sort((a, b) => {
      const an = a.name || a.file || '';
      const bn = b.name || b.file || '';
      return an.localeCompare(bn);
    });
    // töm befintliga alternativ utom första
    while (selectEl.options.length > 1) {
      selectEl.remove(1);
    }
    songsList.forEach((song, idx) => {
      const opt = document.createElement('option');
      opt.value = song.file;
      opt.textContent = song.name || song.file;
      selectEl.appendChild(opt);
    });
    const wrapper = document.getElementById('songSelectWrapper');
    const loadBtn = document.getElementById('loadSong');
    // Visa alltid dropdown och knapp; om inga låtar finns, inaktivera knappen
    if (wrapper) wrapper.style.display = 'flex';
    if (loadBtn) {
      loadBtn.style.display = '';
      loadBtn.disabled = songsList.length === 0;
    }
  } catch (e) {
    // misslyckades att hämta listan; visa ändå dropdown men inaktivera knapp
    console.error('Kunde inte läsa songs.json', e);
    const wrapper = document.getElementById('songSelectWrapper');
    const loadBtn = document.getElementById('loadSong');
    if (wrapper) wrapper.style.display = 'flex';
    if (loadBtn) {
      loadBtn.style.display = '';
      loadBtn.disabled = true;
    }
  }
}

/**
 * Laddar vald CSV-fil från dropdown och fyller i textarea och laddar diagrammet.
 */
async function loadSelectedSong() {
  const selectEl = document.getElementById('songSelect');
  const filename = selectEl.value;
  if (!filename) return;
  try {
    const res = await fetch(filename);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const csvText = await res.text();
    // fyll i csv-fältet
    document.getElementById('csvInput').value = csvText.trim();
    // ladda diagrammet automatiskt
    loadChart();
  } catch (e) {
    console.error('Kunde inte läsa vald låt', e);
    alert('Kunde inte läsa vald låt: ' + filename);
  }
}
/**
 * Stoppar playback och återställer knappar. Optionellt tömmer display.
 */
function stopPlayback(resetDisplay = true) {
  // avbryt eventuella setInterval countdown eller äldre timers
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // avbryt scheduler-loop
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  // nollställ tidsjustering
  timeOffset = 0;
  if (resetDisplay) {
    document.getElementById('currentChord').textContent = '';
    const cueEl = document.getElementById('currentCue');
    if (cueEl) cueEl.textContent = '';
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
  let signatureFromCsv = null;
  // meta-detektion: rad 0 kan innehålla titel, tempo och optional signature
  if (csv.length > 0 && csv[0].length > 1) {
    const maybeTempo = parseInt(csv[0][1], 10);
    // detect tempo in second cell and optional signature in third cell
    if (!isNaN(maybeTempo)) {
      title = csv[0][0] || '';
      tempoFromCsv = maybeTempo;
      if (csv[0].length > 2 && csv[0][2]) {
        signatureFromCsv = csv[0][2].trim();
      }
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
  // sätt defaultSignature baserat på metadata från CSV eller behåll tidigare. Om signatureFromCsv finns använd den.
  defaultSignature = signatureFromCsv || '4/4';
  sections = parseSections(csv, 0);
  if (!sections.length) {
    alert('Inga sektioner hittades. Kontrollera CSV-formatet.');
    return;
  }

  // tilldela pastellfärger till sektioner
  sectionColors = sections.map((_, idx) => pastelPalette[idx % pastelPalette.length]);
  // beräkna mörkare kantfärger för varje sektion
  sectionBorderColors = sectionColors.map(col => getDarkerColor(col, 0.7));

  buildTimeline();
  buildMacroFlow();
  currentSectionIndex = 0;
  playIndex = 0;
  buildMicroRows(currentSectionIndex);
  highlightMacro(currentSectionIndex);
  highlightMicro(playIndex);
  stopPlayback();

  // visa eller dölj textknapp beroende på om sektionstext finns
  const textBtn = document.getElementById('textToggle');
  if (hasSectionText) {
    // det finns text i någon sektion – visa knappen och sätt aktivt läge
    textVisible = true;
    textBtn.style.display = '';
    textBtn.textContent = 'Text på';
    textBtn.classList.add('active');
    // bygg text för första sektionen
    buildSectionText(currentSectionIndex);
  } else {
    // ingen sektionstext – dölj knappen och textcontainern
    textVisible = false;
    textBtn.style.display = 'none';
    const sectionTextEl = document.getElementById('sectionText');
    if (sectionTextEl) {
      sectionTextEl.textContent = '';
      sectionTextEl.style.display = 'none';
    }
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
  // toggla endast om sektionstexter finns
  if (!hasSectionText) return;
  textVisible = !textVisible;
  const btn = document.getElementById('textToggle');
  if (textVisible) {
    btn.textContent = 'Text på';
    btn.classList.add('active');
  } else {
    btn.textContent = 'Text av';
    btn.classList.remove('active');
  }
  // uppdatera textsektionen för aktuell sektion
  buildSectionText(currentSectionIndex);
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

  // ladda songlist och sätt upp lyssnare på laddningsknapp
  loadSongList();
  const loadSongBtn = document.getElementById('loadSong');
  if (loadSongBtn) {
    loadSongBtn.addEventListener('click', () => {
      loadSelectedSong();
    });
  }

  // Globala tangentbordslyssnare för pedal/nudge och navigering.
  document.addEventListener('keydown', (e) => {
    // ignorera tangenter när fokus är i input eller textarea
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return;
    }
    switch (e.key) {
      case 'ArrowRight':
        // nudge framåt
        nudgeForward();
        e.preventDefault();
        break;
      case 'ArrowLeft':
        // nudge bakåt
        nudgeBackward();
        e.preventDefault();
        break;
      case 'PageDown':
        // ladda nästa låt utan att starta
        loadNextSong();
        e.preventDefault();
        break;
      case 'PageUp':
        // ladda föregående låt utan att starta
        loadPrevSong();
        e.preventDefault();
        break;
      case ' ': // mellanslag
      case 'Spacebar':
      case 'Space':
        // starta aktuell låt (från början)
        startPlayback();
        e.preventDefault();
        break;
      default:
        break;
    }
  });
});