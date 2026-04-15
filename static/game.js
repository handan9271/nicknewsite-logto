/* ==========================================================================
   IELTS COURT — Ace Attorney Style Game Engine
   State machine, dialogue system, timers, AI integration, random Nick events
   ========================================================================== */

(function () {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────
  const PART1_TIME = 60;    // Part 1: 1 minute per question
  const PART2_PREP = 60;    // Part 2: 1 minute prep
  const PART2_SPEAK = 120;  // Part 2: 2 minutes speaking
  const PART3_TIME = 90;    // Part 3: 1.5 minutes per question

  // Question bank (loaded from JSON)
  let QUESTION_BANK = null;
  let selectedBand = 'band7'; // default
  let _qbLoaded = false;
  let _qbPromise = null;

  // Fallback questions (used if bank not loaded)
  const FALLBACK_PART1 = [
    "Let's talk about your hometown. What do you like most about it?",
    "Do you work or are you a student? Tell me about it.",
    "What do you usually do in your free time?",
    "How often do you use the internet? What for?",
    "Do you like cooking? Why or why not?",
    "Tell me about a festival that is important in your country.",
    "What kind of music do you enjoy listening to?",
    "Do you prefer reading books or watching movies?",
  ];
  const FALLBACK_PART2 = [
    { topic: 'Describe a time when you had to speak in front of a group of people.', points: ['When it was', 'Who you were speaking to', 'What you spoke about', 'How you felt about it'] },
    { topic: 'Describe a place you have visited that you found particularly beautiful.', points: ['Where it was', 'When you went there', 'What it looked like', 'Why you found it beautiful'] },
  ];
  const FALLBACK_PART3 = [
    "Why do you think this topic is important to society?",
    "How has this changed compared to the past?",
    "What do you think will happen in the future regarding this?",
  ];

  // Load question bank
  async function loadQuestionBank() {
    try {
      const res = await fetch('/static/question_bank.json');
      if (res.ok) {
        QUESTION_BANK = await res.json();
        _qbLoaded = true;
        console.log('Question bank loaded:', QUESTION_BANK.themes.length, 'themes');
      }
    } catch (e) {
      console.warn('Failed to load question bank, using fallback:', e);
      _qbLoaded = true; // mark as done even on failure
    }
  }

  // Generate context-aware cue card bullet points for Part 2
  function generateCueCardPoints(topic) {
    const t = topic.toLowerCase();
    if (t.includes('person') || t.includes('teacher') || t.includes('friend') || t.includes('student') || t.includes('someone'))
      return ['Who this person is', 'How you know this person', 'What this person does', 'Why this person is special to you'];
    if (t.includes('place') || t.includes('city') || t.includes('country') || t.includes('area'))
      return ['Where this place is', 'When you went there', 'What you did there', 'Why you liked this place'];
    if (t.includes('trip') || t.includes('journey') || t.includes('travel') || t.includes('holiday'))
      return ['Where you went', 'When you went there', 'Who you went with', 'Why it was memorable'];
    if (t.includes('time when') || t.includes('experience') || t.includes('occasion'))
      return ['When it happened', 'Where it happened', 'What happened', 'How you felt about it'];
    if (t.includes('book') || t.includes('film') || t.includes('movie') || t.includes('programme') || t.includes('video'))
      return ['What it is', 'When you read/watched it', 'What it is about', 'Why you liked it'];
    if (t.includes('job') || t.includes('career') || t.includes('work'))
      return ['What the job is', 'What skills it needs', 'Why it is important', 'How you feel about it'];
    if (t.includes('subject') || t.includes('lesson') || t.includes('course'))
      return ['What the subject is', 'How you learned it', 'What makes it interesting', 'Why it is useful'];
    if (t.includes('change') || t.includes('trend') || t.includes('future'))
      return ['What the change is', 'When it started', 'How it affects people', 'What you think about it'];
    if (t.includes('food') || t.includes('meal') || t.includes('dish'))
      return ['What the food is', 'Where you had it', 'What it tastes like', 'Why you like it'];
    if (t.includes('skill') || t.includes('hobby') || t.includes('activity') || t.includes('sport'))
      return ['What the activity is', 'When you started', 'How often you do it', 'Why you enjoy it'];
    // Default
    return ['What it is', 'When it happened or when you experienced it', 'Why it is important or meaningful', 'How you felt about it'];
  }

  // Pick questions from bank for a solo game
  function pickQuestionsFromBank() {
    if (!QUESTION_BANK || !QUESTION_BANK.themes.length) {
      return {
        themeName: 'General',
        part1: [...FALLBACK_PART1].sort(() => Math.random() - 0.5).slice(0, 4),
        part2Topic: FALLBACK_PART2[Math.floor(Math.random() * FALLBACK_PART2.length)],
        part3: [...FALLBACK_PART3],
      };
    }

    // Shuffle themes and find one with enough questions
    const shuffled = [...QUESTION_BANK.themes].sort(() => Math.random() - 0.5);
    let theme = null;
    for (const t of shuffled) {
      const p1 = t.part1[selectedBand] || [];
      const p2 = t.part2[selectedBand] || [];
      const p3 = t.part3[selectedBand] || [];
      if (p1.length >= 4 && p2.length >= 1 && p3.length >= 3) {
        theme = t;
        break;
      }
    }
    // Fallback: use first theme with any questions
    if (!theme) {
      theme = shuffled[0];
    }

    const p1Pool = [...(theme.part1[selectedBand] || [])].sort(() => Math.random() - 0.5);
    const p2Pool = [...(theme.part2[selectedBand] || [])].sort(() => Math.random() - 0.5);
    const p3Pool = [...(theme.part3[selectedBand] || [])].sort(() => Math.random() - 0.5);

    // Part 2: convert string to topic object with smart cue card points
    const p2Text = p2Pool[0] || 'Describe something interesting.';
    const p2Topic = {
      topic: p2Text,
      points: generateCueCardPoints(p2Text),
    };

    return {
      themeName: theme.name,
      part1: p1Pool.slice(0, 4),
      part2Topic: p2Topic,
      part3: p3Pool.slice(0, 3),
    };
  }

  // ─── STATE ──────────────────────────────────────────────────────
  const S = {
    phase: 'title',
    inputMode: 'type',
    currentPart: 1,
    qIndex: 0,
    questions: [],
    answers: [],
    part2Topic: null,
    timerInterval: null,
    timerRemaining: 0,
    isTyping: false,
    nickRandomTimer: null,
    isRecording: false,
    recognition: null,
    dialogueCb: null,
    currentQuestion: '',
    paused: false,
    // Multiplayer state
    multiplayer: false,
    roomCode: '',
    ws: null,
    players: [],
    isHost: false,
    wsReady: false,
  };

  // ─── DOM ────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  let D = {};

  function cacheDom() {
    const ids = [
      'title-screen', 'game-screen', 'verdict-screen', 'screen-flash',
      'lobby-screen', 'waiting-overlay',
      'part-badge', 'question-counter', 'hud-timer-bar', 'hud-timer-text', 'player-count-badge',
      'courtroom', 'nick-sprite', 'nick-expression',
      'gavel-overlay', 'objection-banner', 'objection-reason',
      'evidence-card', 'evidence-topic', 'evidence-points', 'evidence-close-btn',
      'dialogue-box', 'speaker-name', 'dialogue-text', 'continue-indicator',
      'input-area', 'input-timer-bar', 'user-input', 'mic-btn', 'pause-btn', 'submit-btn', 'input-hint',
      'current-question',
      'score-fc', 'score-lr', 'score-gra', 'score-pron',
      'overall-value', 'verdict-text', 'verdict-comment',
      'lobby-join-panel', 'lobby-room-panel', 'lobby-room-code',
      'lobby-player-list', 'lobby-wait-msg',
      'leaderboard', 'leaderboard-entries',
    ];
    ids.forEach((id) => {
      D[id.replace(/-/g, '_')] = $(id);
    });
  }

  // ─── SOUND FX (Web Audio API) ────────────────────────────────────
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function sfx(type, freq, dur, vol, wave) {
    try {
      const c = ctx(), t = c.currentTime;
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = wave || 'square';
      osc.frequency.setValueAtTime(freq, t);
      if (type === 'drop') osc.frequency.exponentialRampToValueAtTime(freq * 0.3, t + dur);
      if (type === 'rise') osc.frequency.linearRampToValueAtTime(freq * 3, t + dur * 0.5);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g).connect(c.destination);
      osc.start(); osc.stop(t + dur);
    } catch (e) { /* silent */ }
  }

  const playGavel = () => sfx('drop', 150, 0.2, 0.6, 'square');
  const playTick = () => sfx('flat', 800 + Math.random() * 200, 0.03, 0.05, 'square');
  const playObjection = () => sfx('rise', 200, 0.6, 0.4, 'sawtooth');
  const playDrum = () => sfx('drop', 100, 0.5, 0.5, 'triangle');

  // ─── SCREENS ────────────────────────────────────────────────────
  function showScreen(name) {
    ['title_screen', 'game_screen', 'verdict_screen', 'lobby_screen'].forEach((k) => {
      D[k].classList.toggle('hidden', k !== name + '_screen');
    });
    if (D.waiting_overlay) D.waiting_overlay.classList.add('hidden');
  }

  function flash() {
    D.screen_flash.classList.add('active');
    setTimeout(() => D.screen_flash.classList.remove('active'), 200);
  }

  function shake() {
    D.courtroom.classList.add('shake');
    setTimeout(() => D.courtroom.classList.remove('shake'), 400);
  }

  // ─── NICK EXPRESSIONS ──────────────────────────────────────────
  const EXPR_CN = { neutral: '平静', smile: '微笑', frown: '不悦', shocked: '震惊', gavel: '判决' };
  function setNick(expr) {
    D.nick_sprite.className = 'nick-sprite nick-' + expr;
    D.nick_expression.textContent = EXPR_CN[expr] || expr.toUpperCase();
  }

  // ─── QUESTION DISPLAY ────────────────────────────────────────────
  function showQuestion(text) {
    D.current_question.textContent = text;
    D.current_question.classList.remove('hidden');
    S.currentQuestion = text;
  }

  function hideQuestion() {
    D.current_question.classList.add('hidden');
  }

  // ─── TYPEWRITER DIALOGUE ────────────────────────────────────────
  function showDialogue(speaker, text, cb) {
    D.dialogue_box.classList.remove('hidden');
    D.input_area.classList.add('hidden');
    D.speaker_name.textContent = speaker;
    D.speaker_name.className = 'speaker-name ' +
      (speaker === '尼克' ? 'speaker-judge' : 'speaker-witness');
    D.dialogue_text.textContent = '';
    D.continue_indicator.classList.add('hidden');
    S.dialogueCb = cb || null;
    S.isTyping = true;

    let i = 0;
    const speed = 30;
    (function type() {
      if (i < text.length) {
        D.dialogue_text.textContent += text[i];
        if (i % 2 === 0) playTick();
        i++;
        setTimeout(type, speed);
      } else {
        S.isTyping = false;
        D.continue_indicator.classList.remove('hidden');
      }
    })();
  }

  function advanceDialogue() {
    if (S.isTyping) return;
    D.continue_indicator.classList.add('hidden');
    if (S.dialogueCb) { const cb = S.dialogueCb; S.dialogueCb = null; cb(); }
  }

  function dialogueSequence(entries, onDone) {
    let i = 0;
    (function next() {
      if (i >= entries.length) { if (onDone) onDone(); return; }
      const e = entries[i++];
      if (e.expression) setNick(e.expression);
      if (e.action) e.action();
      showDialogue(e.speaker, e.text, next);
    })();
  }

  // ─── AUTO-ADVANCE (multiplayer) ─────────────────────────────────
  function showDialogueAutoAdvance(speaker, text, cb, delay) {
    delay = delay || 1500;
    showDialogue(speaker, text, cb);
    const check = setInterval(() => {
      if (!S.isTyping) {
        clearInterval(check);
        setTimeout(() => {
          if (S.dialogueCb === cb) advanceDialogue();
        }, delay);
      }
    }, 100);
  }

  function dialogueSequenceAutoAdvance(entries, onDone, delay) {
    delay = delay || 1500;
    let i = 0;
    (function next() {
      if (i >= entries.length) { if (onDone) onDone(); return; }
      const e = entries[i++];
      if (e.expression) setNick(e.expression);
      if (e.action) e.action();
      showDialogueAutoAdvance(e.speaker, e.text, next, delay);
    })();
  }

  // ─── GAVEL ──────────────────────────────────────────────────────
  function gavelStrike(count, cb) {
    let done = 0;
    D.gavel_overlay.classList.remove('hidden');
    (function hit() {
      playGavel(); shake(); flash();
      if (++done < count) setTimeout(hit, 350);
      else setTimeout(() => { D.gavel_overlay.classList.add('hidden'); if (cb) cb(); }, 300);
    })();
  }

  // ─── OBJECTION ──────────────────────────────────────────────────
  function showObjection(reason, cb) {
    playObjection(); shake(); setNick('shocked');
    D.objection_banner.classList.remove('hidden');
    D.objection_reason.textContent = reason || '';
    setTimeout(() => { D.objection_banner.classList.add('hidden'); setNick('frown'); if (cb) cb(); }, 2000);
  }

  // ─── TIMER ──────────────────────────────────────────────────────
  function startTimer(secs, barEl, onTick, onEnd) {
    clearTimer();
    S.timerRemaining = secs;
    S.paused = false;
    const total = secs;
    barEl.style.width = '100%';
    barEl.classList.remove('urgent');
    if (D.hud_timer_text) D.hud_timer_text.textContent = secs + 's';
    if (D.pause_btn) { D.pause_btn.textContent = '⏸ 暂停'; D.pause_btn.style.borderColor = '#666'; }

    S.timerInterval = setInterval(() => {
      if (S.paused) return; // skip tick when paused
      S.timerRemaining--;
      const pct = (S.timerRemaining / total) * 100;
      barEl.style.width = pct + '%';
      barEl.style.background = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
      if (S.timerRemaining <= 10) barEl.classList.add('urgent');
      if (D.hud_timer_text) {
        D.hud_timer_text.textContent = S.timerRemaining + 's';
        D.hud_timer_text.style.color = S.timerRemaining <= 10 ? 'var(--red,#e74c3c)' : 'var(--warm-white,#f5e6c8)';
      }
      if (onTick) onTick(S.timerRemaining);
      if (S.timerRemaining <= 0) { clearTimer(); if (D.hud_timer_text) D.hud_timer_text.textContent = '0s'; if (onEnd) onEnd(); }
    }, 1000);
  }

  function togglePause() {
    S.paused = !S.paused;
    if (D.pause_btn) {
      D.pause_btn.textContent = S.paused ? '▶ 继续' : '⏸ 暂停';
      D.pause_btn.style.background = '#e74c3c';
      D.pause_btn.style.borderColor = '#e74c3c';
      D.pause_btn.style.color = '#fff';
    }
    if (D.hud_timer_text && S.paused) {
      D.hud_timer_text.style.color = '#e74c3c';
    }
  }

  function clearTimer() {
    if (S.timerInterval) { clearInterval(S.timerInterval); S.timerInterval = null; }
  }

  // ─── NICK AMBIENT BEHAVIOR (no gavel — only subtle expression changes) ───
  function startRandomNick() {
    stopRandomNick();
    (function sched() {
      S.nickRandomTimer = setTimeout(() => {
        if (S.phase === 'verdict' || S.phase === 'title') return;
        // Only subtle expression changes — no gavel, no interruption
        const exprs = ['neutral', 'frown', 'smile', 'neutral', 'neutral'];
        setNick(exprs[Math.floor(Math.random() * exprs.length)]);
        sched();
      }, 10000 + Math.random() * 20000); // every 10-30 seconds
    })();
  }

  function stopRandomNick() {
    if (S.nickRandomTimer) { clearTimeout(S.nickRandomTimer); S.nickRandomTimer = null; }
  }

  // ─── INPUT (mid-screen, question shown above by caller) ──────────
  function showInput(timeLimit, onSubmit) {
    D.dialogue_box.classList.add('hidden');
    D.input_area.classList.remove('hidden');
    D.user_input.value = '';
    D.user_input.focus();

    // Show pause button only in solo mode
    D.pause_btn.classList.toggle('hidden', S.multiplayer);
    D.mic_btn.classList.toggle('hidden', S.inputMode !== 'voice');
    D.user_input.placeholder = S.inputMode === 'voice'
      ? '语音识别内容会显示在这里...也可以手动输入。'
      : '请输入你的回答...';

    startTimer(timeLimit, D.input_timer_bar, null, () => {
      gavelStrike(3, () => {
        const text = D.user_input.value.trim();
        stopRecording();
        D.input_area.classList.add('hidden');
        onSubmit(text || '（未作答）');
      });
    });

    D.submit_btn.onclick = () => {
      const text = D.user_input.value.trim();
      if (!text) return;
      clearTimer(); stopRecording();
      D.input_area.classList.add('hidden');
      onSubmit(text);
    };
  }

  // ─── SPEECH RECOGNITION ─────────────────────────────────────────
  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    S.recognition = new SR();
    S.recognition.lang = 'en-US';
    S.recognition.interimResults = true;
    S.recognition.continuous = true;

    S.recognition.onresult = (e) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      D.user_input.value = t;
    };
    S.recognition.onerror = () => stopRecording();
    S.recognition.onend = () => { if (S.isRecording) try { S.recognition.start(); } catch (e) {} };
  }

  function startRecording() {
    if (!S.recognition) return;
    S.isRecording = true;
    D.mic_btn.classList.add('recording');
    D.mic_btn.textContent = '⏹ 停止';
    try { S.recognition.start(); } catch (e) {}
  }

  function stopRecording() {
    S.isRecording = false;
    D.mic_btn.classList.remove('recording');
    D.mic_btn.textContent = '🎤 录音';
    if (S.recognition) try { S.recognition.stop(); } catch (e) {}
  }

  // ─── AI ─────────────────────────────────────────────────────────
  async function callAI(messages) {
    const resp = await fetch('/api/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ messages, max_tokens: 1800, temperature: 0.5, stream: true }),
    });
    if (!resp.ok) throw new Error('API ' + resp.status);

    let buf = '';
    const reader = resp.body.getReader(), dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]') continue;
        try { buf += JSON.parse(d).choices?.[0]?.delta?.content || ''; } catch (e) {}
      }
    }
    return buf;
  }

  function parseJSON(raw) {
    const clean = raw.replace(/^```json\s*|^```\s*|```\s*$/gm, '').trim();
    try { return JSON.parse(clean); } catch (e) {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) try { return JSON.parse(m[0]); } catch (e2) {}
      return null;
    }
  }

  const EXAMINER_PROMPT = `You are Nick, a former IELTS examiner acting as a judge in a courtroom-themed IELTS speaking test. You are dramatic, intimidating but fair.

CRITICAL RULES for your reaction:
- You MUST actually evaluate the student's answer content, vocabulary, grammar, and relevance to the question.
- If the answer is short, vague, off-topic, or uses only basic vocabulary → react with "disappointed" or "concerned". Be stern.
- If the answer has grammar errors → trigger an objection with the specific error.
- If the answer is detailed, uses good vocabulary, and addresses the question well → react with "satisfied" or "impressed".
- NEVER say "interesting" or "impressive" to a weak or generic answer. That is dishonest.
- Your comment MUST reference specific things the student said (or failed to say).

Respond ONLY with this JSON (no markdown, no extra text):
{
  "reaction": "satisfied|concerned|impressed|disappointed|shocked",
  "comment": "1-2 sentence reaction referencing the SPECIFIC content of the answer. Use courtroom language.",
  "objection": null,
  "scores": {"FC": 1-9, "LR": 1-9, "GRA": 1-9, "Pron": 4-8}
}

Or if there's a grammar/vocabulary issue:
{
  "reaction": "concerned",
  "comment": "Your reaction",
  "objection": {"reason": "The specific grammar or vocabulary error you found"},
  "scores": {"FC": 1-9, "LR": 1-9, "GRA": 1-9, "Pron": 4-8}
}

Score guide: 4=weak, 5=limited, 6=competent, 7=good, 8=very good, 9=expert. Most students score 5-7. Do NOT give 8-9 unless the answer is genuinely exceptional.`;

  const VERDICT_PROMPT = `You are Judge Nick, a former senior IELTS examiner delivering the final verdict.

STEP 1: From the student's answers, mentally RECONSTRUCT each as a continuous spoken response. Ignore examiner questions and backchannels.

STEP 2: Score based on RECONSTRUCTED responses:

FC (Fluency & Coherence) - DO NOT penalize natural speech:
- Fillers/self-correction NORMAL even at 8-9
- 5=short/limited, 6=speaks at length, 7=coherent/well-maintained, 8=fluent/fully developed, 9=effortless
- Extended topic-relevant answers → FC 7+

LR (Lexical Resource) - REWARD advanced vocabulary:
- 5=basic, 6=adequate, 7=less common items/good range, 8=wide/skillful, 9=sophisticated
- Technical/specialized vocab naturally → LR 8+

GRA (Grammatical Range & Accuracy) - score STRICTLY:
- 5=limited/frequent errors, 6=simple+complex mix/errors present, 7=frequent complex/GOOD control, 8=wide range/MAJORITY error-free, 9=CONSISTENT accuracy
- Missing articles, wrong prepositions, subject-verb errors = real errors
- Only 8+ if complex structures with HIGH accuracy

Pron (from text): 5=basic, 6=multi-syllable, 7=varied, 8=complex/technical, 9=sophisticated

RULES: Sub-scores=integers(4-9). Overall=floor(avg to 0.5). Use FULL range.

Reference examples from a real IELTS examiner:

EXAMPLE 1 (Overall 5.0): Student with basic vocabulary, frequent grammar errors, short undeveloped answers, heavy repetition ("i like make friends", "so colorful", "so interesting" repeated). → FC=5, LR=5, GRA=5, Pron=5

EXAMPLE 2 (Overall 6.5): Student speaks at length, adequate vocabulary ("academic English", "international trade"), some complex structures but with errors, good willingness to communicate. → FC=7, LR=7, GRA=7, Pron=5

EXAMPLE 3 (Overall 7.5): Student fluent and articulate, good vocabulary ("sense of belonging", "historical buildings"), develops answers well with examples, some minor errors but overall good control. → FC=8, LR=7, GRA=7, Pron=8

EXAMPLE 4 (Overall 9.0): Student exceptional fluency, sophisticated vocabulary ("holistic admissions process", "diversify into niche areas", "bore fruit"), complex grammar with consistent accuracy, natural and effortless throughout. → FC=9, LR=9, GRA=9, Pron=9

Match these standards precisely.

JSON only (no markdown):
{
  "scores": {"FC": integer, "LR": integer, "GRA": integer, "Pron": integer},
  "overall": number,
  "verdict": "Dramatic 1-2 sentence verdict in courtroom style",
  "comment": "Detailed feedback (3-4 sentences) citing specific examples with concrete advice",
  "reaction": "merciful|harsh|impressed|disappointed"
}`;

  // ─── OFFLINE SCORING (when AI unavailable) ──────────────────────
  function offlineScore(answer) {
    const words = answer.trim().split(/\s+/).length;
    const sentences = answer.split(/[.!?]+/).filter(s => s.trim()).length;
    const avgWordLen = answer.replace(/\s/g, '').length / Math.max(words, 1);
    const hasComplex = /although|however|moreover|furthermore|consequently|nevertheless/i.test(answer);
    const hasFillers = /well,|actually|honestly|to be fair|i mean/i.test(answer);

    let fc = 5, lr = 5, gra = 5;

    // FC: based on length and sentence count
    if (words < 15) fc = 4;
    else if (words < 30) fc = 5;
    else if (words < 60) fc = 6;
    else if (words < 100) fc = 7;
    else fc = 7.5;
    if (hasFillers) fc = Math.min(fc + 0.5, 8);

    // LR: based on word variety and length
    const uniqueWords = new Set(answer.toLowerCase().match(/\b[a-z]+\b/g) || []);
    const variety = uniqueWords.size / Math.max(words, 1);
    if (variety > 0.7 && avgWordLen > 5) lr = 7;
    else if (variety > 0.6) lr = 6;
    else if (variety > 0.4) lr = 5;
    else lr = 4;
    if (hasComplex) lr = Math.min(lr + 1, 8);

    // GRA: based on sentence complexity
    if (sentences > 3 && words > 40) gra = 6;
    if (hasComplex) gra = Math.min(gra + 1, 8);
    if (words < 20) gra = Math.max(gra - 1, 4);

    fc = Math.round(fc); lr = Math.round(lr); gra = Math.round(gra);

    // Pron: infer from vocabulary complexity
    let pron = 5;
    if (hasComplex || avgWordLen > 5.5) pron = 7;
    else if (variety > 0.6) pron = 6;
    pron = Math.min(pron, 8);

    return { FC: fc, LR: lr, GRA: gra, Pron: pron };
  }

  function offlineReaction(answer, question) {
    const words = answer.trim().split(/\s+/).length;
    const scores = offlineScore(answer);
    const avg = (scores.FC + scores.LR + scores.GRA) / 3;

    // Check if answer addresses the question at all
    const qKeywords = question.toLowerCase().match(/\b\w{4,}\b/g) || [];
    const aLower = answer.toLowerCase();
    const relevance = qKeywords.filter(w => aLower.includes(w)).length / Math.max(qKeywords.length, 1);

    let reaction, comment;

    if (words < 10) {
      reaction = 'disappointed';
      comment = 'Is that ALL you have to say? The court expected far more substance. A few words do not constitute testimony.';
    } else if (words < 25) {
      reaction = 'concerned';
      comment = 'The court notes the brevity of your response. You must elaborate more — short answers will not help your case.';
    } else if (avg < 5.5) {
      reaction = 'disappointed';
      comment = 'The court is not impressed. Your vocabulary is limited and your ideas lack development. You must do better.';
    } else if (avg < 6.5) {
      reaction = 'concerned';
      comment = 'Adequate, but the court expects more sophisticated language. You are treading the line between competent and limited.';
    } else if (avg < 7.5) {
      reaction = 'satisfied';
      comment = 'The court acknowledges a reasonably well-constructed response. There is substance here, though room for refinement remains.';
    } else {
      reaction = 'impressed';
      comment = 'The court is... pleasantly surprised. Your vocabulary and coherence suggest genuine competence. Well argued.';
    }

    // Check for common grammar issues for objections
    let objection = null;
    if (/\bi\b/.test(answer) && !/\bI\b/.test(answer)) {
      objection = { reason: "Capitalize 'I' — basic grammar rule violated." };
    } else if (/\b(he|she) (don't|have)\b/i.test(answer)) {
      objection = { reason: "Subject-verb agreement error detected." };
    } else if (/\bmore better\b|\bmost biggest\b/i.test(answer)) {
      objection = { reason: "Double comparative detected — 'more better' is not valid English." };
    }

    return { reaction, comment, objection, scores };
  }

  // ─── UNIFIED ANSWER HANDLER ─────────────────────────────────────
  async function handleAnswer(answer, question, part, advanceFn) {
    setNick('neutral');
    D.dialogue_box.classList.remove('hidden');
    D.input_area.classList.add('hidden');
    hideQuestion();
    D.speaker_name.textContent = '尼克';
    D.speaker_name.className = 'speaker-name speaker-judge';
    D.dialogue_text.textContent = part === 3 ? '法庭正在审议...' : '嗯...让我考虑一下你的陈述...';
    D.continue_indicator.classList.add('hidden');

    let p = null;

    try {
      const extra = part === 3 ? '\nThis is Part 3 cross-examination. Be more critical and demanding.' : '';
      const raw = await callAI([
        { role: 'system', content: EXAMINER_PROMPT },
        { role: 'user', content: `Part ${part} question.\nQuestion: "${question}"\nStudent's answer: "${answer}"${extra}` },
      ]);
      p = parseJSON(raw);
    } catch (e) {
      console.warn('AI unavailable, using offline scoring:', e.message);
    }

    // Fallback to offline scoring if AI failed
    if (!p) {
      p = offlineReaction(answer, question);
    }

    const exprMap = { satisfied: 'smile', impressed: 'smile', concerned: 'frown', disappointed: 'frown', shocked: 'shocked' };
    const expr = exprMap[p.reaction] || 'neutral';

    // Store scores with the answer for final verdict
    const lastAnswer = S.answers[S.answers.length - 1];
    if (lastAnswer) lastAnswer.scores = p.scores;

    if (p.objection) {
      showObjection(p.objection.reason, () => {
        setNick(expr);
        showDialogue('尼克', p.comment || '法庭记录了你的错误。', advanceFn);
      });
    } else {
      setNick(expr);
      showDialogue('尼克', p.comment || '法庭已记录。', advanceFn);
    }
  }

  // ─── GAME FLOW ──────────────────────────────────────────────────
  function updateHUD() {
    D.part_badge.textContent = '第 ' + S.currentPart + ' 部分';
    D.part_badge.className = 'part-badge part-' + S.currentPart;
    const totals = { 1: S.questions.length, 2: 1, 3: 3 };
    D.question_counter.textContent = Math.min(S.qIndex + 1, totals[S.currentPart]) + '/' + totals[S.currentPart];
  }

  // ── Part 1 ──
  function askPart1() {
    if (S.qIndex >= S.questions.length) { stopRandomNick(); hideQuestion(); transitionPart2(); return; }
    updateHUD();
    const q = S.questions[S.qIndex];
    showQuestion(q);
    setNick('neutral');
    showDialogue('尼克', q, () => {
      showInput(PART1_TIME, (answer) => {
        S.answers.push({ part: 1, question: q, answer });
        hideQuestion();
        // Skip per-question AI feedback, go directly to next question
        setNick('neutral');
        S.qIndex++;
        askPart1();
      });
    });
  }

  // ── Part 2 transition ──
  function transitionPart2() {
    S.currentPart = 2; S.qIndex = 0; updateHUD();
    gavelStrike(2, () => {
      dialogueSequence([
        { speaker: '尼克', text: '第一部分结束。', expression: 'neutral' },
        { speaker: '尼克', text: '法庭现在进入第二部分。事情变得更加...严肃了。', expression: 'frown' },
        { speaker: '尼克', text: '法庭出示以下考题！', expression: 'shocked' },
      ], showEvidence);
    });
  }

  function showEvidence() {
    const t = S.part2Topic;
    console.log('showEvidence called, topic:', t);
    D.evidence_topic.textContent = t.topic;
    D.evidence_points.innerHTML = '';
    (t.points || []).forEach((p) => { const li = document.createElement('li'); li.textContent = p; D.evidence_points.appendChild(li); });
    D.evidence_card.classList.remove('hidden');
    D.evidence_card.style.display = 'block'; // force show in case CSS issues
    flash();

    D.evidence_close_btn.onclick = () => {
      D.evidence_card.classList.add('hidden');
      D.evidence_card.style.display = '';
      startPart2Prep();
    };
  }

  function startPart2Prep() {
    S.phase = 'part2-prep';
    showDialogue('尼克', '你有 60 秒准备陈述。计时开始！准备好后点击继续。', () => {
      D.dialogue_box.classList.remove('hidden');
      D.dialogue_text.textContent = '准备中... (60秒) — 点击此处或按空格键开始';
      D.continue_indicator.classList.remove('hidden');
      S.dialogueCb = () => {
        clearTimer();
        gavelStrike(1, startPart2Speak);
      };
      startTimer(PART2_PREP, D.hud_timer_bar, (rem) => {
        D.dialogue_text.textContent = '准备中... ' + rem + '秒 — 点击此处或按空格键开始';
      }, () => gavelStrike(1, startPart2Speak));
    });
  }

  function startPart2Speak() {
    S.phase = 'part2-speak';
    setNick('neutral');
    startRandomNick();
    const q = S.part2Topic.topic;
    showQuestion(q);
    showDialogue('尼克', '时间到！向法庭陈述你的证词。你有 2 分钟，开始！', () => {
      showInput(PART2_SPEAK, (answer) => {
        stopRandomNick();
        hideQuestion();
        S.answers.push({ part: 2, question: q, answer });
        transitionPart3();
      });
    });
  }

  // ── Part 3 ──
  function transitionPart3() {
    S.phase = 'part3'; S.currentPart = 3; S.qIndex = 0; updateHUD();
    gavelStrike(2, () => {
      dialogueSequence([
        { speaker: '尼克', text: '法庭尚未满意。', expression: 'frown' },
        { speaker: '尼克', text: '第三部分。交叉质询现在开始。', expression: 'neutral' },
        { speaker: '尼克', text: '我会质疑你的论点。三思而后答。', expression: 'frown' },
      ], () => { startRandomNick(); askPart3(); });
    });
  }

  function askPart3() {
    if (S.qIndex >= 3) { stopRandomNick(); hideQuestion(); goVerdict(); return; }
    updateHUD();
    const q = (S.part3Questions || FALLBACK_PART3)[S.qIndex];
    showQuestion(q);
    setNick('frown');
    showDialogue('尼克', q, () => {
      showInput(PART3_TIME, (answer) => {
        S.answers.push({ part: 3, question: q, answer });
        hideQuestion();
        // Skip per-question AI feedback, go directly to next question
        setNick('neutral');
        S.qIndex++;
        askPart3();
      });
    });
  }

  // ── Verdict ──
  function goVerdict() {
    S.phase = 'verdict'; stopRandomNick(); clearTimer();
    gavelStrike(3, () => {
      dialogueSequence([
        { speaker: '尼克', text: '肃静！', expression: 'shocked' },
        { speaker: '尼克', text: '审讯结束。法庭即将宣布判决。', expression: 'neutral' },
      ], deliverVerdict);
    });
  }

  async function deliverVerdict() {
    D.dialogue_box.classList.remove('hidden');
    D.speaker_name.textContent = '尼克';
    D.dialogue_text.textContent = '法庭正在审议...全体起立。';
    D.continue_indicator.classList.add('hidden');

    const answersText = S.answers.map((a) =>
      `[Part ${a.part}] Q: ${a.question}\nA: ${a.answer}`
    ).join('\n\n');

    let verdict = null;

    try {
      const raw = await callAI([
        { role: 'system', content: VERDICT_PROMPT },
        { role: 'user', content: `Here are ALL the student's answers from today's trial:\n\n${answersText}\n\nDeliver the verdict.` },
      ]);
      verdict = parseJSON(raw);
    } catch (e) {
      console.warn('Verdict AI unavailable, computing offline:', e.message);
    }

    // Offline verdict from accumulated per-question scores
    if (!verdict || !verdict.scores) {
      const allScores = S.answers.filter(a => a.scores).map(a => a.scores);
      if (allScores.length > 0) {
        const avg = (key) => Math.round(allScores.reduce((s, sc) => s + (sc[key] || 5), 0) / allScores.length);
        const fc = avg('FC'), lr = avg('LR'), gra = avg('GRA'), pron = avg('Pron') || Math.round((fc + lr) / 2);
        const overall = Math.floor(((fc + lr + gra + pron) / 4) * 2) / 2; // IELTS: round DOWN

        let verdictText, comment, reaction;
        if (overall >= 7) {
          reaction = 'impressed';
          verdictText = 'The court finds the defendant to be a competent speaker. You have defended yourself well today.';
          comment = 'Your answers showed good vocabulary range and coherent development. To reach higher bands, focus on using more sophisticated linking devices and less common vocabulary consistently.';
        } else if (overall >= 6) {
          reaction = 'merciful';
          verdictText = 'The court grants a moderate verdict. You have shown competence, but the court expects more.';
          comment = 'Your performance was adequate but uneven. Some answers lacked depth while others showed promise. Work on developing your ideas more fully and using a wider range of grammatical structures.';
        } else {
          reaction = 'disappointed';
          verdictText = 'The court is not satisfied. The defendant must significantly improve their command of English.';
          comment = 'Many of your answers were too brief or relied on basic vocabulary. Practice extending your answers with examples and explanations. Study common collocations and discourse markers.';
        }

        verdict = { scores: { FC: fc, LR: lr, GRA: gra, Pron: pron }, overall, verdict: verdictText, comment, reaction };
      } else {
        verdict = {
          scores: { FC: 5, LR: 5, GRA: 5, Pron: 5 },
          overall: 5.5,
          verdict: 'The court was unable to fully assess the defendant. A provisional verdict is issued.',
          comment: 'Insufficient evidence was presented. Practice giving longer, more detailed answers.',
          reaction: 'disappointed',
        };
      }
    }

    showVerdictScreen(verdict);
  }

  function showVerdictScreen(v) {
    _lastVerdict = v;
    showScreen('verdict');
    playDrum();

    const scores = v.scores || {};
    const cards = [
      [D.score_fc, scores.FC],
      [D.score_lr, scores.LR],
      [D.score_gra, scores.GRA],
      [D.score_pron, scores.Pron],
    ];

    cards.forEach(([el, val], i) => {
      el.textContent = '?';
      el.parentElement.classList.remove('revealed');
      setTimeout(() => {
        playGavel(); flash();
        el.textContent = val || '—';
        el.parentElement.classList.add('revealed');
      }, 800 + i * 1000);
    });

    setTimeout(() => {
      playDrum();
      D.overall_value.textContent = v.overall || '—';
      D.verdict_text.textContent = v.verdict || '';
      D.verdict_comment.textContent = v.comment || '';
    }, 800 + cards.length * 1000 + 500);

    // Save solo game session and generate report in background
    if (!S.multiplayer) {
      saveAndGenerateReport(v);
    }
  }

  async function saveAndGenerateReport(verdict) {
    // 1. Save game session
    let sessionId = 0;
    try {
      const res = await fetch('/api/save-game-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: 'solo', answers: S.answers, verdict }),
      });
      if (res.ok) {
        const d = await res.json();
        sessionId = d.session_id || 0;
      }
    } catch (e) { console.warn('Failed to save session:', e); }

    // 2. Generate detailed report in background (saved to DB, viewable in history)
    try {
      await fetch('/api/generate-mock-report-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          answers: S.answers,
          verdict,
          theme: S.themeName || 'General',
          band: selectedBand || 'band7',
          session_id: sessionId,
        }),
      });
    } catch (e) { console.warn('Failed to generate report:', e); }
  }

  let _lastVerdict = null;


  // ── Start game ──
  async function startGame() {
    // Wait for question bank to load if still in progress
    if (_qbPromise && !_qbLoaded) {
      await _qbPromise;
    }
    S.phase = 'intro'; S.qIndex = 0; S.answers = []; S.currentPart = 1;
    const picked = pickQuestionsFromBank();
    S.questions = picked.part1;
    S.part2Topic = picked.part2Topic;
    S.part3Questions = picked.part3;
    S.themeName = picked.themeName;

    showScreen('game');
    updateHUD();

    dialogueSequence([
      { speaker: '尼克', text: '...', expression: 'neutral', action: () => gavelStrike(3) },
      { speaker: '尼克', text: '现在开庭！', expression: 'neutral' },
      { speaker: '尼克', text: '全体起立！考官尼克到庭！', expression: 'smile' },
      { speaker: '尼克', text: '被告被指控犯有"英语口语不达标"之罪。', expression: 'frown' },
      { speaker: '尼克', text: '第一部分 — 常规提问。请清晰作答。法庭正在注视你。', expression: 'neutral' },
    ], () => {
      S.phase = 'part1'; S.currentPart = 1; S.qIndex = 0;
      startRandomNick();
      askPart1();
    });
  }

  // ─── MULTIPLAYER: WEBSOCKET ──────────────────────────────────────

  function connectWS(roomCode) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/game/${roomCode}`;
    const ws = new WebSocket(url);

    ws.onopen = () => { S.wsReady = true; };

    ws.onmessage = (e) => {
      try { handleWSMsg(JSON.parse(e.data)); } catch (err) { console.warn('WS parse error', err); }
    };

    ws.onclose = () => {
      S.wsReady = false;
      if (S.multiplayer && S.phase !== 'title') {
        showDialogue('尼克', '连接中断。法庭休庭。', () => {
          resetToTitle();
        });
      }
    };

    S.ws = ws;
  }

  function sendWS(msg) {
    if (S.ws && S.wsReady) S.ws.send(JSON.stringify(msg));
  }

  function resetToTitle() {
    S.multiplayer = false;
    S.roomCode = '';
    S.isHost = false;
    S.players = [];
    if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
    S.wsReady = false;
    clearTimer(); stopRandomNick();
    showScreen('title');
    S.phase = 'title';
  }

  // ─── MULTIPLAYER: LOBBY ────────────────────────────────────────

  function showLobby() {
    showScreen('lobby');
    D.lobby_join_panel.classList.remove('hidden');
    D.lobby_room_panel.classList.add('hidden');
  }

  function showLobbyRoom() {
    D.lobby_join_panel.classList.add('hidden');
    D.lobby_room_panel.classList.remove('hidden');
    D.lobby_room_code.textContent = S.roomCode;
    updateLobbyPlayers();
    updateLobbyStartBtn();
  }

  function updateLobbyPlayers() {
    D.lobby_player_list.innerHTML = '';
    S.players.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.display_name + (p.username === S.players[0]?.username ? ' (HOST)' : '');
      D.lobby_player_list.appendChild(li);
    });
  }

  function updateLobbyStartBtn() {
    const startBtn = $('btn-start-game');
    const waitMsg = D.lobby_wait_msg;
    if (S.isHost) {
      startBtn.classList.remove('hidden');
      waitMsg.classList.add('hidden');
    } else {
      startBtn.classList.add('hidden');
      waitMsg.classList.remove('hidden');
    }
  }

  async function ensureUsername() {
    if (S._myUsername) return;
    try {
      const r = await fetch('/api/me', { credentials: 'include' });
      if (r.ok) { const d = await r.json(); S._myUsername = d.username; S._myDisplayName = d.display_name; }
    } catch (e) {}
  }

  async function createRoom() {
    try {
      await ensureUsername();
      const resp = await fetch('/api/room/create', {
        method: 'POST', credentials: 'include',
      });
      if (!resp.ok) throw new Error('Failed to create room');
      const data = await resp.json();
      S.roomCode = data.code;
      S.isHost = true;
      connectWS(S.roomCode);
      showLobbyRoom();
    } catch (e) {
      alert('Failed to create room. Are you logged in?');
    }
  }

  async function joinRoom(code) {
    code = code.toUpperCase().trim();
    if (code.length !== 4) { alert('Enter a 4-character room code.'); return; }
    await ensureUsername();
    S.roomCode = code;
    S.isHost = false;
    connectWS(code);
    showLobbyRoom();
  }

  // ─── MULTIPLAYER: WS MESSAGE HANDLER ──────────────────────────

  function handleWSMsg(msg) {
    switch (msg.type) {
      case 'room_state':
        S.players = msg.players || [];
        S.isHost = (msg.host === getMyUsername());
        if (S.phase === 'title' || S.phase === 'lobby') {
          updateLobbyPlayers();
          updateLobbyStartBtn();
        }
        break;

      case 'game_start':
        S.phase = 'intro';
        S.answers = [];
        S.currentPart = 1;
        S.qIndex = 0;
        S.questions = msg.questions_part1;
        S.part2Topic = msg.part2_topic;
        showScreen('game');
        updateHUD();
        D.player_count_badge.textContent = S.players.length + ' PLAYERS';
        D.player_count_badge.classList.remove('hidden');

        // Multiplayer intro — shorter, auto-advance
        dialogueSequenceAutoAdvance([
          { speaker: '尼克', text: '...', expression: 'neutral', action: () => gavelStrike(3) },
          { speaker: '尼克', text: 'Court is now in session! Multiple defendants stand trial today.', expression: 'neutral' },
          { speaker: '尼克', text: 'All accused will answer the same questions. The court will judge you all.', expression: 'frown' },
        ], () => {
          sendWS({ type: 'ready' });
        });
        break;

      case 'phase_change':
        handlePhaseChange(msg);
        break;

      case 'timer_sync':
        if (S.timerRemaining > 0) {
          S.timerRemaining = msg.remaining;
        }
        break;

      case 'timer_end':
        // Server says time is up — force submit if input is still showing
        if (!D.input_area.classList.contains('hidden')) {
          const text = D.user_input.value.trim();
          clearTimer(); stopRecording();
          D.input_area.classList.add('hidden');
          sendWS({ type: 'submit_answer', answer: text || '（未作答）' });
          showWaiting('时间到！等待法庭审议...');
        }
        break;

      case 'player_submitted':
        if (D.waiting_overlay && !D.waiting_overlay.classList.contains('hidden')) {
          D.waiting_text.textContent = msg.count + '/' + msg.total + ' 位被告已完成陈述...';
        }
        break;

      case 'ai_feedback':
        D.waiting_overlay.classList.add('hidden');
        handleMPFeedback(msg);
        break;

      case 'all_feedback_done':
        // After seeing feedback, send ready to continue
        // (the dialogue callback will send ready)
        break;

      case 'verdict_result':
        D.waiting_overlay.classList.add('hidden');
        showMPVerdict(msg.leaderboard);
        break;

      case 'player_left':
        // Just update count badge
        S.players = S.players.filter(p => p.username !== msg.username);
        if (D.player_count_badge) {
          D.player_count_badge.textContent = S.players.length + ' PLAYERS';
        }
        break;

      case 'error':
        showDialogue('尼克', 'A disturbance in the court! ' + (msg.message || ''), null);
        break;
    }
  }

  function getMyUsername() {
    // Parse from players list or fetch from /api/me cache
    return S._myUsername || '';
  }

  function handlePhaseChange(msg) {
    S.phase = msg.phase;
    D.waiting_overlay.classList.add('hidden');

    if (msg.phase === 'intro') {
      // Handled by game_start
      return;
    }

    if (msg.phase === 'part1') {
      S.currentPart = 1;
      S.qIndex = msg.q_index;
      updateHUD();
      const q = msg.question;
      S.currentQuestion = q;
      showQuestion(q);
      setNick('neutral');
      showDialogueAutoAdvance('NICK', q, () => {
        showMPInput(msg.time_limit, q);
      });
      return;
    }

    if (msg.phase === 'part2-prep') {
      S.currentPart = 2;
      S.qIndex = 0;
      updateHUD();
      // Show evidence card
      const t = msg.part2_topic || S.part2Topic;
      gavelStrike(2, () => {
        dialogueSequenceAutoAdvance([
          { speaker: '尼克', text: 'Part 1 is concluded.', expression: 'neutral' },
          { speaker: '尼克', text: 'Part 2. The prosecution presents evidence!', expression: 'shocked' },
        ], () => {
          D.evidence_topic.textContent = t.topic;
          D.evidence_points.innerHTML = '';
          t.points.forEach((p) => { const li = document.createElement('li'); li.textContent = p; D.evidence_points.appendChild(li); });
          D.evidence_card.classList.remove('hidden');
          flash();

          // Start a local countdown display for prep
          S.phase = 'part2-prep';
          showDialogue('尼克', 'You have 60 seconds to prepare. The clock starts NOW.', null);
          startTimer(msg.time_limit, D.hud_timer_bar, null, null);
          D.evidence_close_btn.onclick = () => { D.evidence_card.classList.add('hidden'); };
        });
      });
      return;
    }

    if (msg.phase === 'part2-speak') {
      S.currentPart = 2;
      D.evidence_card.classList.add('hidden');
      updateHUD();
      const q = msg.question;
      S.currentQuestion = q;
      setNick('neutral');
      startRandomNick();
      showQuestion(q);
      gavelStrike(1, () => {
        showDialogueAutoAdvance('NICK', 'Time is up! Present your testimony. You have 2 minutes.', () => {
          showMPInput(msg.time_limit, q);
        });
      });
      return;
    }

    if (msg.phase === 'part3') {
      S.currentPart = 3;
      S.qIndex = msg.q_index;
      updateHUD();
      if (msg.q_index === 0) {
        gavelStrike(2, () => {
          dialogueSequenceAutoAdvance([
            { speaker: '尼克', text: '第三部分。交叉质询！', expression: 'frown' },
          ], () => {
            startRandomNick();
            showPart3Question(msg);
          });
        });
      } else {
        showPart3Question(msg);
      }
      return;
    }

    if (msg.phase === 'scoring') {
      stopRandomNick();
      hideQuestion();
      gavelStrike(3, () => {
        showDialogue('尼克', 'SILENCE! The court deliberates... All rise.', null);
        showWaiting('法官正在审议...');
      });
      return;
    }
  }

  function showPart3Question(msg) {
    const q = msg.question;
    S.currentQuestion = q;
    showQuestion(q);
    setNick('frown');
    showDialogueAutoAdvance('NICK', q, () => {
      showMPInput(msg.time_limit, q);
    });
  }

  function showMPInput(timeLimit, question) {
    D.dialogue_box.classList.add('hidden');
    D.input_area.classList.remove('hidden');
    D.user_input.value = '';
    D.user_input.focus();

    D.pause_btn.classList.add('hidden'); // No pause in multiplayer
    D.mic_btn.classList.toggle('hidden', S.inputMode !== 'voice');
    D.user_input.placeholder = S.inputMode === 'voice'
      ? '语音识别内容会显示在这里...也可以手动输入。'
      : '请输入你的回答...';

    startTimer(timeLimit, D.input_timer_bar, null, () => {
      // Timer end is handled by server's timer_end message
    });

    D.submit_btn.onclick = () => {
      const text = D.user_input.value.trim();
      if (!text) return;
      clearTimer(); stopRecording();
      D.input_area.classList.add('hidden');
      sendWS({ type: 'submit_answer', answer: text });
      showWaiting('陈述已提交。等待其他被告...');
    };
  }

  function showWaiting(text) {
    D.waiting_text.textContent = text;
    D.waiting_overlay.classList.remove('hidden');
  }

  function handleMPFeedback(msg) {
    hideQuestion();
    const exprMap = { satisfied: 'smile', impressed: 'smile', concerned: 'frown', disappointed: 'frown', shocked: 'shocked' };
    const expr = exprMap[msg.reaction] || 'neutral';

    if (msg.objection) {
      showObjection(msg.objection.reason, () => {
        setNick(expr);
        showDialogueAutoAdvance('NICK', msg.comment || 'The court notes your error.', () => {
          sendWS({ type: 'ready' });
        }, 3000);
      });
    } else {
      setNick(expr);
      showDialogueAutoAdvance('NICK', msg.comment || 'The court acknowledges.', () => {
        sendWS({ type: 'ready' });
      }, 3000);
    }
  }

  function showMPVerdict(leaderboard) {
    S.phase = 'verdict';
    stopRandomNick(); clearTimer();
    showScreen('verdict');
    playDrum();

    // Find my entry
    const myEntry = leaderboard.find(e => e.username === S._myUsername);
    if (myEntry) {
      const scores = myEntry.scores || {};
      const cards = [
        [D.score_fc, scores.FC],
        [D.score_lr, scores.LR],
        [D.score_gra, scores.GRA],
        [D.score_pron, scores.Pron],
      ];
      cards.forEach(([el, val], i) => {
        el.textContent = '?';
        el.parentElement.classList.remove('revealed');
        setTimeout(() => {
          playGavel(); flash();
          el.textContent = val || '—';
          el.parentElement.classList.add('revealed');
        }, 800 + i * 1000);
      });
      setTimeout(() => {
        playDrum();
        D.overall_value.textContent = myEntry.overall || '—';
        D.verdict_text.textContent = myEntry.rank === 1 ? '无罪！你是冠军！' : '有罪！你被超越了。';
        D.verdict_comment.textContent = myEntry.comment || '';
      }, 800 + 4 * 1000 + 500);
    }

    // Show leaderboard after scores
    setTimeout(() => {
      D.leaderboard.classList.remove('hidden');
      D.leaderboard_entries.innerHTML = '';
      leaderboard.forEach((entry) => {
        const div = document.createElement('div');
        div.className = 'lb-entry rank-' + entry.rank;
        div.innerHTML =
          '<span class="lb-rank">#' + entry.rank + '</span>' +
          '<span class="lb-name">' + escapeHTML(entry.display_name) + '</span>' +
          '<span class="lb-score">' + (entry.overall || '—') + '</span>' +
          '<span class="lb-verdict-label ' + (entry.rank === 1 ? 'not-guilty' : 'guilty') + '">' +
          (entry.rank === 1 ? '无罪' : '有罪') + '</span>';
        D.leaderboard_entries.appendChild(div);
      });
    }, 800 + 4 * 1000 + 1500);
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── INIT ───────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    cacheDom();
    initSpeech();
    _qbPromise = loadQuestionBank();

    // Fetch username immediately (needed for multiplayer host detection)
    fetch('/api/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { S._myUsername = d.username; S._myDisplayName = d.display_name; } })
      .catch(() => {});

    // Band selection
    document.querySelectorAll('.band-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.band-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedBand = btn.dataset.band;
      });
    });

    // Solo mode
    $('btn-solo').addEventListener('click', () => {
      ctx(); S.multiplayer = false;
      D.player_count_badge.classList.add('hidden');
      D.leaderboard.classList.add('hidden');
      startGame();
    });

    // Multiplayer mode
    $('btn-multi').addEventListener('click', () => {
      ctx(); S.multiplayer = true;
      S.phase = 'lobby';
      showLobby();
    });

    // Lobby buttons
    $('btn-create-room').addEventListener('click', createRoom);
    $('btn-join-room').addEventListener('click', () => {
      joinRoom($('room-code-input').value);
    });
    $('room-code-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-join-room').click();
    });
    $('btn-start-game').addEventListener('click', () => {
      sendWS({ type: 'start_game' });
    });
    $('btn-lobby-back').addEventListener('click', () => {
      if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
      S.multiplayer = false;
      showScreen('title');
      S.phase = 'title';
    });

    // Mode buttons
    $('btn-voice-mode').addEventListener('click', () => {
      S.inputMode = 'voice';
      $('btn-voice-mode').classList.add('selected');
      $('btn-type-mode').classList.remove('selected');
    });
    $('btn-type-mode').addEventListener('click', () => {
      S.inputMode = 'type';
      $('btn-type-mode').classList.add('selected');
      $('btn-voice-mode').classList.remove('selected');
    });
    $('btn-type-mode').classList.add('selected');

    D.pause_btn.addEventListener('click', togglePause);

    D.mic_btn.addEventListener('click', () => {
      if (S.isRecording) stopRecording(); else startRecording();
    });

    D.dialogue_box.addEventListener('click', advanceDialogue);

    $('btn-new-trial').addEventListener('click', () => {
      D.leaderboard.classList.add('hidden');
      D.player_count_badge.classList.add('hidden');
      resetToTitle();
    });


    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && document.activeElement === D.user_input) {
        e.preventDefault(); D.submit_btn.click();
      }
      if (e.key === ' ' && document.activeElement !== D.user_input &&
          document.activeElement?.tagName !== 'INPUT') advanceDialogue();
    });
  });

})();
