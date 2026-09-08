(() => {
  const CLIENT_ID = new URLSearchParams(location.search).get('client') || 'colin';

  const screens = {
    intro: document.getElementById('screen-intro'),
    history: document.getElementById('screen-history'),
    session: document.getElementById('screen-session'),
    report: document.getElementById('screen-report'),
  };
  function show(name) {
    Object.values(screens).forEach((s) => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
  }

  let cfg = { silenceMs: 1800, finishPhrases: [], undoPhrases: [], voiceEnabled: true };
  let state = {
    sessionId: null,
    blockIndex: 1,
    listening: false,   // true while we intend to be capturing speech
    manualStop: false,
  };
  let buffer = '';
  let silenceTimer = null;

  // ---------- speech recognition setup ----------
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let usingFallback = false;

  function buildRecognition() {
    if (!SpeechRecognitionCtor) { usingFallback = true; return; }
    recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) buffer += t + ' ';
        else interim += t;
      }
      renderLiveTranscript(buffer + interim);
      resetSilenceTimer();
    };
    recognition.onerror = (e) => {
      console.warn('speech recognition error', e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        usingFallback = true;
        renderMicUI();
      }
    };
    recognition.onend = () => {
      // Browsers sometimes stop recognition on their own (network blip, internal
      // timeout). If we still intend to be listening, just restart quietly —
      // Colin never sees this, the orb keeps showing "listening".
      if (state.listening) {
        try { recognition.start(); } catch (e) { /* already running */ }
      }
    };
  }
  buildRecognition();

  function speakAndWait(text) {
    return new Promise((resolve) => {
      if (!cfg.voiceEnabled || !window.speechSynthesis || !text) { resolve(); return; }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.onend = resolve;
      u.onerror = resolve;
      window.speechSynthesis.speak(u);
    });
  }

  // ---------- DOM refs ----------
  const el = {
    btnStart: document.getElementById('btn-start'),
    btnHistory: document.getElementById('btn-history'),
    btnHistoryBack: document.getElementById('btn-history-back'),
    historyList: document.getElementById('history-list'),
    blockCounter: document.getElementById('block-counter'),
    stateLabel: document.getElementById('state-label'),
    btnFinish: document.getElementById('btn-finish'),
    promptText: document.getElementById('prompt-text'),
    micArea: document.querySelector('.mic-area'),
    orb: document.getElementById('orb'),
    micStatus: document.getElementById('mic-status'),
    transcriptLive: document.getElementById('transcript-live'),
    blocksLogged: document.getElementById('blocks-logged'),
    reportSummary: document.getElementById('report-summary'),
    reportBars: document.getElementById('report-bars'),
    reportDrain: document.getElementById('report-drain'),
    reportCandidates: document.getElementById('report-candidates'),
    btnNewAudit: document.getElementById('btn-new-audit'),
  };

  function renderLiveTranscript(text) {
    el.transcriptLive.textContent = text;
  }

  function setUiState(phase, statusText) {
    // phase: 'listening' | 'thinking' | 'speaking'
    el.orb.className = 'orb ' + phase;
    el.stateLabel.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
    if (statusText) el.micStatus.textContent = statusText;
  }

  // ---------- mic UI (with text-fallback if speech API unavailable) ----------
  function renderMicUI() {
    if (!usingFallback) {
      setUiState('listening', 'Just start talking');
      return;
    }
    el.micArea.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.width = '100%';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Type what you would have said…';
    ta.style.width = '100%';
    ta.style.minHeight = '90px';
    ta.style.fontFamily = "'Fraunces', serif";
    ta.style.fontSize = '1.05rem';
    ta.style.padding = '0.8rem';
    ta.style.border = '1px solid var(--line)';
    ta.style.borderRadius = '3px';
    ta.style.background = '#fff';
    const btn = document.createElement('button');
    btn.className = 'btn-primary small';
    btn.textContent = 'Send';
    btn.style.marginTop = '0.7rem';
    btn.onclick = () => {
      const val = ta.value.trim();
      if (!val) return;
      ta.value = '';
      handleUtterance(val);
    };
    wrap.appendChild(ta);
    wrap.appendChild(btn);
    el.micArea.appendChild(wrap);
    const note = document.createElement('p');
    note.className = 'mic-status';
    note.textContent = 'Voice capture isn\u2019t available in this browser — try Chrome, or just type each activity.';
    el.micArea.appendChild(note);
  }

  // ---------- listening control ----------
  function clearSilenceTimer() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }
  function resetSilenceTimer() {
    if (!state.listening) return;
    clearSilenceTimer();
    silenceTimer = setTimeout(onSilenceTimeout, cfg.silenceMs);
  }

  function startListening() {
    if (usingFallback) { renderLiveTranscript(''); return; }
    buffer = '';
    renderLiveTranscript('');
    state.listening = true;
    setUiState('listening', 'Just start talking');
    try { recognition.start(); } catch (e) { /* already running is fine */ }
    resetSilenceTimer();
  }

  function stopListeningForProcessing() {
    state.listening = false;
    clearSilenceTimer();
    try { recognition.stop(); } catch (e) { /* noop */ }
  }

  async function onSilenceTimeout() {
    const text = buffer.trim();
    stopListeningForProcessing();
    if (!text) { startListening(); return; } // nothing said — keep waiting
    await handleUtterance(text);
  }

  // ---------- utterance routing ----------
  function matchesPhrase(text, phrases) {
    const lower = text.toLowerCase();
    return phrases.some((p) => lower.includes(p));
  }

  async function handleUtterance(text) {
    if (matchesPhrase(text, cfg.finishPhrases)) {
      await finishAudit();
      return;
    }
    if (matchesPhrase(text, cfg.undoPhrases) && el.blocksLogged.children.length > 0) {
      setUiState('thinking', 'One sec');
      const ok = await undoLastBlock();
      setUiState('speaking', 'Scratched');
      await speakAndWait(ok ? "Scratched that. Go ahead." : "Nothing to undo there.");
      startListening();
      return;
    }
    await submitSegment(text);
  }

  async function submitSegment(transcript) {
    setUiState('thinking', 'One sec');
    try {
      const res = await fetch(`/api/session/${state.sessionId}/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json();
      if (!res.ok) {
        setUiState('speaking', 'Hit a snag');
        await speakAndWait("Something went wrong on my end — go ahead and repeat that.");
        startListening();
        return;
      }

      if (data.status === 'needs_clarification') {
        setUiState('speaking', data.question);
        await speakAndWait(data.question);
        startListening(); // capture the answer as a fresh utterance for this same block
      } else {
        await autoFinalizeBlock(data.preview);
      }
    } catch (err) {
      setUiState('speaking', 'Connection issue');
      await speakAndWait("I lost connection there for a second — say that again.");
      startListening();
    }
  }

  async function autoFinalizeBlock(preview) {
    const res = await fetch(`/api/session/${state.sessionId}/finalize-block`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      setUiState('speaking', 'Hit a snag');
      await speakAndWait("Couldn't log that one — let's try again.");
      startListening();
      return;
    }

    const last = data.blocks[data.blocks.length - 1];
    const chip = document.createElement('div');
    chip.className = 'block-chip';
    chip.innerHTML = `<span class="bc-activity">${escapeHtml(last.activity)}</span><span class="bc-duration">${last.durationMinutes != null ? last.durationMinutes + ' min' : '—'}</span>`;
    el.blocksLogged.prepend(chip);

    state.blockIndex += 1;
    el.blockCounter.textContent = `Block ${state.blockIndex}`;
    el.promptText.textContent = 'Go ahead — what came next?';

    const confirmation = buildConfirmationLine(preview);
    setUiState('speaking', confirmation);
    await speakAndWait(confirmation);
    startListening();
  }

  function buildConfirmationLine(preview) {
    const activity = preview.activity || 'that one';
    if (preview.durationMinutes != null) {
      return `Got it — ${activity}, about ${preview.durationMinutes} minutes. What's next?`;
    }
    return `Got it — ${activity}. What's next?`;
  }

  async function undoLastBlock() {
    const res = await fetch(`/api/session/${state.sessionId}/undo-last-block`, { method: 'POST' });
    if (!res.ok) return false;
    if (el.blocksLogged.firstChild) el.blocksLogged.removeChild(el.blocksLogged.firstChild);
    state.blockIndex = Math.max(1, state.blockIndex - 1);
    el.blockCounter.textContent = `Block ${state.blockIndex}`;
    return true;
  }

  async function finishAudit() {
    stopListeningForProcessing();
    if (el.blocksLogged.children.length === 0) {
      await speakAndWait("I don't have anything logged yet — talk me through at least one activity first.");
      startListening();
      return;
    }
    setUiState('thinking', 'Pulling it together');
    const res = await fetch(`/api/session/${state.sessionId}/finish`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      setUiState('speaking', 'Hit a snag');
      await speakAndWait("Couldn't put the report together — give it another shot.");
      startListening();
      return;
    }
    renderReport(data.report);
    show('report');
  }

  el.btnFinish.addEventListener('click', finishAudit);

  function renderReport(report) {
    el.reportSummary.textContent = report.summary || '';

    el.reportBars.innerHTML = '';
    const maxMin = Math.max(...report.categoryTotals.map((c) => c.minutes), 1);
    report.categoryTotals
      .slice()
      .sort((a, b) => b.minutes - a.minutes)
      .forEach((c) => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = `
          <div class="bar-row-top"><span>${escapeHtml(c.category)}</span><span class="bar-minutes">${c.minutes} min</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, (c.minutes / maxMin) * 100)}%"></div></div>
        `;
        el.reportBars.appendChild(row);
      });

    el.reportDrain.innerHTML = `<span class="drain-label">${escapeHtml(report.biggestDrain.label)}</span>${escapeHtml(report.biggestDrain.rationale)}`;

    el.reportCandidates.innerHTML = '';
    report.candidates.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'candidate-item';
      item.innerHTML = `
        <div class="candidate-top"><span class="candidate-title">${escapeHtml(c.title)}</span><span class="candidate-type">${c.type}</span></div>
        <div class="candidate-mins">~${c.estimatedMinutesPerWeek} min/week</div>
        <div class="candidate-reason">${escapeHtml(c.reason)}</div>
      `;
      el.reportCandidates.appendChild(item);
    });
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  // ---------- navigation ----------
  el.btnStart.addEventListener('click', async () => {
    const res = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Could not start session'); return; }

    state.sessionId = data.sessionId;
    state.blockIndex = 1;
    cfg.voiceEnabled = data.voice ? data.voice.enabled : true;
    cfg.silenceMs = data.silenceMs || 1800;
    cfg.finishPhrases = data.finishPhrases || [];
    cfg.undoPhrases = data.undoPhrases || [];

    el.blockCounter.textContent = 'Block 1';
    el.promptText.textContent = data.openingPrompt;
    el.blocksLogged.innerHTML = '';
    renderMicUI();
    show('session');

    setUiState('speaking', 'Getting started');
    await speakAndWait(data.openingPrompt);
    startListening();
  });

  el.btnHistory.addEventListener('click', async () => {
    const res = await fetch(`/api/sessions?clientId=${CLIENT_ID}`);
    const data = await res.json();
    el.historyList.innerHTML = '';
    if (data.sessions.length === 0) {
      el.historyList.innerHTML = '<p style="color:var(--ink-muted)">No audits yet.</p>';
    }
    data.sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const date = new Date(s.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      item.innerHTML = `<span class="hi-date">${date}</span><span class="hi-meta">${s.blockCount} blocks · ${s.finished ? 'complete' : 'in progress'}</span>`;
      item.addEventListener('click', async () => {
        const r = await fetch(`/api/session/${s.id}`);
        const full = await r.json();
        if (full.report) {
          renderReport(full.report);
          show('report');
        }
      });
      el.historyList.appendChild(item);
    });
    show('history');
  });

  el.btnHistoryBack.addEventListener('click', () => show('intro'));
  el.btnNewAudit.addEventListener('click', () => show('intro'));

  renderMicUI();
})();
