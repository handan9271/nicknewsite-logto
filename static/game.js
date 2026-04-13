/* ==========================================================================
   IELTS COURT — Ace Attorney Style Game Engine
   State machine, dialogue system, timers, AI integration, random Nick events
   ========================================================================== */

(function () {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────
  const PART1_TIME = 45;
  const PART2_PREP = 60;
  const PART2_SPEAK = 120;
  const PART3_TIME = 60;

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
    currentQuestion: '', // track current question for display
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
      'part-badge', 'question-counter', 'hud-timer-bar', 'player-count-badge',
      'courtroom', 'nick-sprite', 'nick-expression',
      'gavel-overlay', 'objection-banner', 'objection-reason',
      'evidence-card', 'evidence-topic', 'evidence-points', 'evidence-close-btn',
      'dialogue-box', 'speaker-name', 'dialogue-text', 'continue-indicator',
      'input-area', 'input-timer-bar', 'user-input', 'mic-btn', 'submit-btn', 'input-hint',
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
  function setNick(expr) {
    D.nick_sprite.className = 'nick-sprite nick-' + expr;
    D.nick_expression.textContent = expr.toUpperCase();
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
      (speaker === 'NICK' ? 'speaker-judge' : 'speaker-witness');
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
    const total = secs;
    barEl.style.width = '100%';
    barEl.classList.remove('urgent');

    S.timerInterval = setInterval(() => {
      S.timerRemaining--;
      const pct = (S.timerRemaining / total) * 100;
      barEl.style.width = pct + '%';
      barEl.style.background = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
      if (S.timerRemaining <= 10) barEl.classList.add('urgent');
      if (onTick) onTick(S.timerRemaining);
      if (S.timerRemaining <= 0) { clearTimer(); if (onEnd) onEnd(); }
    }, 1000);
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

    D.mic_btn.classList.toggle('hidden', S.inputMode !== 'voice');
    D.user_input.placeholder = S.inputMode === 'voice'
      ? 'Your speech will appear here... or type manually.'
      : 'Type your answer...';

    startTimer(timeLimit, D.input_timer_bar, null, () => {
      gavelStrike(3, () => {
        const text = D.user_input.value.trim();
        stopRecording();
        D.input_area.classList.add('hidden');
        onSubmit(text || '(No answer provided)');
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
    D.mic_btn.textContent = '⏹ STOP';
    try { S.recognition.start(); } catch (e) {}
  }

  function stopRecording() {
    S.isRecording = false;
    D.mic_btn.classList.remove('recording');
    D.mic_btn.textContent = '🎤 REC';
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

  const VERDICT_PROMPT = `You are Judge Nick delivering the final verdict of an IELTS courtroom trial.

CRITICAL: Base scores strictly on the actual quality of ALL answers below. Evaluate:
- FC (Fluency & Coherence): Did they develop answers fully? Were ideas connected? Or were answers short/disjointed?
- LR (Lexical Resource): Did they use varied, precise vocabulary? Or just basic words?
- GRA (Grammatical Range & Accuracy): Did they use complex sentences correctly? Any errors?
- Pron (Pronunciation): Infer from their WRITTEN text. Consider: Do they use multi-syllable advanced words (suggesting comfort with complex pronunciation)? Do they use natural contractions (I'd, won't, gonna)? Do they use phonetically complex expressions? Score 4-8 range. If vocabulary is very basic/simple → 5. If varied and complex → 7. Do NOT give 9.

Score guide: 4=weak, 5=limited, 6=competent, 7=good, 8=very good. Pron range 4-8 only.
Overall = average of FC+LR+GRA+Pron, rounded to nearest 0.5.

Your verdict and comment MUST reference specific things the student said across their answers.

Respond ONLY with this JSON (no markdown):
{
  "scores": {"FC": number, "LR": number, "GRA": number, "Pron": number},
  "overall": number,
  "verdict": "Dramatic 1-2 sentence verdict in courtroom style, referencing the student's actual performance",
  "comment": "Detailed feedback (3-4 sentences) citing specific examples from their answers, with concrete advice",
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
    D.speaker_name.textContent = 'NICK';
    D.speaker_name.className = 'speaker-name speaker-judge';
    D.dialogue_text.textContent = part === 3 ? 'The court deliberates...' : 'Hmm... let me consider your testimony...';
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
        showDialogue('NICK', p.comment || 'The court notes your error.', advanceFn);
      });
    } else {
      setNick(expr);
      showDialogue('NICK', p.comment || 'The court acknowledges.', advanceFn);
    }
  }

  // ─── GAME FLOW ──────────────────────────────────────────────────
  function updateHUD() {
    D.part_badge.textContent = 'PART ' + S.currentPart;
    D.part_badge.className = 'part-badge part-' + S.currentPart;
    const totals = { 1: S.questions.length, 2: 1, 3: 3 };
    D.question_counter.textContent = 'Q ' + Math.min(S.qIndex + 1, totals[S.currentPart]) + '/' + totals[S.currentPart];
  }

  // ── Part 1 ──
  function askPart1() {
    if (S.qIndex >= S.questions.length) { stopRandomNick(); hideQuestion(); transitionPart2(); return; }
    updateHUD();
    const q = S.questions[S.qIndex];
    showQuestion(q);
    setNick('neutral');
    showDialogue('NICK', q, () => {
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
        { speaker: 'NICK', text: 'Part 1 is concluded.', expression: 'neutral' },
        { speaker: 'NICK', text: 'The court now moves to Part 2. A more... serious matter.', expression: 'frown' },
        { speaker: 'NICK', text: 'The prosecution presents the following evidence!', expression: 'shocked' },
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
    showDialogue('NICK', 'You have 60 seconds to prepare your testimony. The clock starts NOW. Click when ready.', () => {
      D.dialogue_box.classList.remove('hidden');
      D.dialogue_text.textContent = 'Preparing... (60 seconds) — click here or press SPACE when ready';
      D.continue_indicator.classList.remove('hidden');
      S.dialogueCb = () => {
        clearTimer();
        gavelStrike(1, startPart2Speak);
      };
      startTimer(PART2_PREP, D.hud_timer_bar, (rem) => {
        D.dialogue_text.textContent = 'Preparing... ' + rem + 's — click here or press SPACE when ready';
      }, () => gavelStrike(1, startPart2Speak));
    });
  }

  function startPart2Speak() {
    S.phase = 'part2-speak';
    setNick('neutral');
    startRandomNick();
    const q = S.part2Topic.topic;
    showQuestion(q);
    showDialogue('NICK', 'Time is up! Present your testimony to the court. You have 2 minutes. Speak!', () => {
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
        { speaker: 'NICK', text: 'The court is not yet satisfied.', expression: 'frown' },
        { speaker: 'NICK', text: 'Part 3. Cross-examination begins now.', expression: 'neutral' },
        { speaker: 'NICK', text: 'I will challenge your claims. Think carefully before you speak.', expression: 'frown' },
      ], () => { startRandomNick(); askPart3(); });
    });
  }

  function askPart3() {
    if (S.qIndex >= 3) { stopRandomNick(); hideQuestion(); goVerdict(); return; }
    updateHUD();
    const q = (S.part3Questions || FALLBACK_PART3)[S.qIndex];
    showQuestion(q);
    setNick('frown');
    showDialogue('NICK', q, () => {
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
        { speaker: 'NICK', text: 'SILENCE IN THE COURT!', expression: 'shocked' },
        { speaker: 'NICK', text: 'The examination is complete. The court will now deliver its verdict.', expression: 'neutral' },
      ], deliverVerdict);
    });
  }

  async function deliverVerdict() {
    D.dialogue_box.classList.remove('hidden');
    D.speaker_name.textContent = 'NICK';
    D.dialogue_text.textContent = 'The court is deliberating... All rise.';
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
        const overall = Math.round(((fc + lr + gra + pron) / 4) * 2) / 2;

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

    // Save solo game session to database
    if (!S.multiplayer) {
      saveGameSession(v);
    }
  }

  // ─── PDF REPORT ─────────────────────────────────────────────────
  let _lastVerdict = null;

  function downloadPDFReport() {
    if (!_lastVerdict || !window.jspdf) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const v = _lastVerdict;
    const scores = v.scores || {};
    const margin = 20;
    let y = 25;

    // Title
    doc.setFontSize(22);
    doc.setTextColor(10, 90, 69); // teal
    doc.text('IELTS COURT — Mock Test Report', margin, y);
    y += 12;

    // Theme & date
    doc.setFontSize(11);
    doc.setTextColor(100);
    doc.text(`Theme: ${S.themeName || 'General'}  |  Band: ${selectedBand}  |  Date: ${new Date().toLocaleDateString()}`, margin, y);
    y += 12;

    // Scores
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text('Scores', margin, y); y += 8;
    doc.setFontSize(12);
    doc.text(`FC (Fluency & Coherence):  ${scores.FC || '-'}`, margin + 5, y); y += 7;
    doc.text(`LR (Lexical Resource):     ${scores.LR || '-'}`, margin + 5, y); y += 7;
    doc.text(`GRA (Grammar):             ${scores.GRA || '-'}`, margin + 5, y); y += 7;
    doc.text(`Pron (Pronunciation):      ${scores.Pron || '-'}`, margin + 5, y); y += 7;
    doc.setFontSize(14);
    doc.setTextColor(10, 90, 69);
    doc.text(`Overall: ${v.overall || '-'}`, margin + 5, y); y += 12;

    // Verdict
    doc.setTextColor(0);
    doc.setFontSize(12);
    doc.text('Verdict:', margin, y); y += 7;
    doc.setFontSize(10);
    const verdictLines = doc.splitTextToSize(v.verdict || '', 170);
    doc.text(verdictLines, margin + 5, y); y += verdictLines.length * 5 + 5;

    // Comment
    doc.setFontSize(12);
    doc.text('Feedback:', margin, y); y += 7;
    doc.setFontSize(10);
    const commentLines = doc.splitTextToSize(v.comment || '', 170);
    doc.text(commentLines, margin + 5, y); y += commentLines.length * 5 + 10;

    // Answers
    doc.setFontSize(12);
    doc.text('Your Answers:', margin, y); y += 8;
    doc.setFontSize(9);
    S.answers.forEach((a, i) => {
      if (y > 260) { doc.addPage(); y = 25; }
      doc.setTextColor(100);
      doc.text(`[Part ${a.part}] ${a.question}`, margin + 5, y); y += 5;
      doc.setTextColor(0);
      const ansLines = doc.splitTextToSize(a.answer || '(No answer)', 165);
      doc.text(ansLines, margin + 10, y); y += ansLines.length * 4.5 + 5;
    });

    // Footer
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text('Generated by Nick Speaking Platform — nicknewsitelogtohk.zeabur.app', margin, 290);

    doc.save(`IELTS-Mock-Report-${new Date().toISOString().slice(0,10)}.pdf`);
  }

  async function saveGameSession(verdict) {
    try {
      await fetch('/api/save-game-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode: 'solo',
          answers: S.answers,
          verdict: verdict,
        }),
      });
    } catch (e) {
      console.warn('Failed to save game session:', e);
    }
  }

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
      { speaker: 'NICK', text: '...', expression: 'neutral', action: () => gavelStrike(3) },
      { speaker: 'NICK', text: 'Court is now in session!', expression: 'neutral' },
      { speaker: 'NICK', text: 'All rise for Examiner Nick!', expression: 'smile' },
      { speaker: 'NICK', text: 'The defendant stands accused of crimes against the English language.', expression: 'frown' },
      { speaker: 'NICK', text: 'Part 1 — general questions. Answer clearly. The court is watching.', expression: 'neutral' },
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
        showDialogue('NICK', 'Connection lost. The court is adjourned.', () => {
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
          { speaker: 'NICK', text: '...', expression: 'neutral', action: () => gavelStrike(3) },
          { speaker: 'NICK', text: 'Court is now in session! Multiple defendants stand trial today.', expression: 'neutral' },
          { speaker: 'NICK', text: 'All accused will answer the same questions. The court will judge you all.', expression: 'frown' },
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
          sendWS({ type: 'submit_answer', answer: text || '(No answer provided)' });
          showWaiting('Time is up! Waiting for the court...');
        }
        break;

      case 'player_submitted':
        if (D.waiting_overlay && !D.waiting_overlay.classList.contains('hidden')) {
          D.waiting_text.textContent = msg.count + '/' + msg.total + ' defendants have testified...';
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
        showDialogue('NICK', 'A disturbance in the court! ' + (msg.message || ''), null);
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
          { speaker: 'NICK', text: 'Part 1 is concluded.', expression: 'neutral' },
          { speaker: 'NICK', text: 'Part 2. The prosecution presents evidence!', expression: 'shocked' },
        ], () => {
          D.evidence_topic.textContent = t.topic;
          D.evidence_points.innerHTML = '';
          t.points.forEach((p) => { const li = document.createElement('li'); li.textContent = p; D.evidence_points.appendChild(li); });
          D.evidence_card.classList.remove('hidden');
          flash();

          // Start a local countdown display for prep
          S.phase = 'part2-prep';
          showDialogue('NICK', 'You have 60 seconds to prepare. The clock starts NOW.', null);
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
            { speaker: 'NICK', text: 'Part 3. Cross-examination!', expression: 'frown' },
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
        showDialogue('NICK', 'SILENCE! The court deliberates... All rise.', null);
        showWaiting('The judges are deliberating...');
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

    D.mic_btn.classList.toggle('hidden', S.inputMode !== 'voice');
    D.user_input.placeholder = S.inputMode === 'voice'
      ? 'Your speech will appear here... or type manually.'
      : 'Type your answer...';

    startTimer(timeLimit, D.input_timer_bar, null, () => {
      // Timer end is handled by server's timer_end message
    });

    D.submit_btn.onclick = () => {
      const text = D.user_input.value.trim();
      if (!text) return;
      clearTimer(); stopRecording();
      D.input_area.classList.add('hidden');
      sendWS({ type: 'submit_answer', answer: text });
      showWaiting('Testimony submitted. Waiting for other defendants...');
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
        D.verdict_text.textContent = myEntry.rank === 1 ? 'NOT GUILTY! You are the champion!' : 'GUILTY! You have been outperformed.';
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
          (entry.rank === 1 ? 'NOT GUILTY' : 'GUILTY') + '</span>';
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

    D.mic_btn.addEventListener('click', () => {
      if (S.isRecording) stopRecording(); else startRecording();
    });

    D.dialogue_box.addEventListener('click', advanceDialogue);

    $('btn-new-trial').addEventListener('click', () => {
      D.leaderboard.classList.add('hidden');
      D.player_count_badge.classList.add('hidden');
      resetToTitle();
    });

    $('btn-download-pdf').addEventListener('click', downloadPDFReport);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && document.activeElement === D.user_input) {
        e.preventDefault(); D.submit_btn.click();
      }
      if (e.key === ' ' && document.activeElement !== D.user_input &&
          document.activeElement?.tagName !== 'INPUT') advanceDialogue();
    });
  });

})();
