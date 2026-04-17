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

  // Gibberish "歪比巴卜" sound — 4 random syllables with pitch jumps
  function playGibberish() {
    try {
      const c = ctx();
      const baseTime = c.currentTime;
      const syllables = 4 + Math.floor(Math.random() * 2); // 4-5 syllables
      const syllableDur = 0.13;
      for (let i = 0; i < syllables; i++) {
        const t0 = baseTime + i * syllableDur;
        const osc = c.createOscillator();
        const gain = c.createGain();
        // Random pitch in Nick's "voice" range (low gibberish)
        const startFreq = 150 + Math.random() * 120;
        const endFreq = startFreq * (0.6 + Math.random() * 0.8);
        osc.type = i % 2 === 0 ? 'sawtooth' : 'square';
        osc.frequency.setValueAtTime(startFreq, t0);
        osc.frequency.linearRampToValueAtTime(endFreq, t0 + syllableDur * 0.9);
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + syllableDur);
        osc.connect(gain).connect(c.destination);
        osc.start(t0); osc.stop(t0 + syllableDur);
      }
    } catch (e) {}
  }

  // ─── NPC SOUND PACK (Minecraft villager style) ──────────────────
  function npcSound(mood) {
    try {
      const c = ctx(), t = c.currentTime;
      const presets = {
        // Happy: rising pitch, bright tone
        happy:    { freqs: [220, 280, 330], dur: 0.12, wave: 'triangle', vol: 0.15 },
        // Approving: short pleased "hmm" up
        approving:{ freqs: [200, 260, 300, 340], dur: 0.1, wave: 'triangle', vol: 0.12 },
        // Thinking: mid "hmm" wobble
        thinking: { freqs: [180, 200, 180], dur: 0.15, wave: 'sawtooth', vol: 0.1 },
        // Bored: low descending sigh
        bored:    { freqs: [200, 160, 120], dur: 0.2, wave: 'triangle', vol: 0.1 },
        // Frown: short low grunt
        frown:    { freqs: [150, 120], dur: 0.15, wave: 'square', vol: 0.12 },
        // Annoyed: harsh descending "tch"
        annoyed:  { freqs: [250, 180, 100], dur: 0.1, wave: 'sawtooth', vol: 0.15 },
        // Shocked: sharp rising "huh?!"
        shocked:  { freqs: [180, 350, 500], dur: 0.08, wave: 'square', vol: 0.18 },
        // Yawn: long slow descend
        yawn:     { freqs: [250, 220, 180, 140, 100], dur: 0.18, wave: 'triangle', vol: 0.08 },
        // Hmph: short dismissive
        hmph:     { freqs: [200, 140], dur: 0.12, wave: 'sawtooth', vol: 0.13 },
        // Impressed: ascending bright
        impressed:{ freqs: [200, 300, 400, 450], dur: 0.09, wave: 'triangle', vol: 0.14 },
      };
      const p = presets[mood] || presets.thinking;
      const gap = 0.02; // tiny gap between syllables

      p.freqs.forEach((freq, i) => {
        const t0 = t + i * (p.dur + gap);
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = p.wave;
        // Add slight random variation to each syllable (+/- 15%)
        const f = freq * (0.85 + Math.random() * 0.3);
        osc.frequency.setValueAtTime(f, t0);
        // Slight pitch slide within syllable
        osc.frequency.linearRampToValueAtTime(f * (0.9 + Math.random() * 0.2), t0 + p.dur);
        // Envelope: quick attack, decay
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(p.vol, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + p.dur);
        osc.connect(gain).connect(c.destination);
        osc.start(t0);
        osc.stop(t0 + p.dur + 0.01);
      });
    } catch (e) {}
  }

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
  const EXPR_CN = {
    neutral: '平静', smile: '微笑', frown: '不悦', shocked: '震惊', gavel: '判决',
    bored: '困倦', thinking: '沉思', approving: '赞许', annoyed: '恼火'
  };
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
    // #5 Nick reacts to pause (randomized)
    if (S.paused) {
      setNick(pick(['frown', 'annoyed', 'thinking']));
      npcSound('hmph'); // SOUND: pause displeasure
    } else {
      setNick(pick(['neutral', 'neutral', 'smile']));
      NR.lastInputTime = Date.now();
      NR.idleStage = 0;
    }
  }

  function clearTimer() {
    if (S.timerInterval) { clearInterval(S.timerInterval); S.timerInterval = null; }
  }

  // ─── NICK REACTIVE EXPRESSION SYSTEM (20 behavior modes) ──────
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function nickFlash(expr, dur) {
    setNick(expr);
    if (dur) setTimeout(() => { if (!D.input_area.classList.contains('hidden')) setNick('neutral'); }, dur);
  }

  const NR = {
    checkTimer: null,
    lastWordCount: 0,
    lastInputTime: 0,
    idleStage: 0,            // 0=ok, 1=thinking, 2=bored, 3=frown, 4=annoyed
    inputStarted: false,     // has student typed anything yet
    prevSpeed: 0,            // words in previous check cycle
    sustainedInputSecs: 0,   // how long continuously inputting
    history: [],             // [{time, words}] ring buffer for speed tracking
    longWordTriggered: false, // already reacted to a long word this question
    deleteTriggered: false,   // already reacted to deletion this question
    hesitateTriggered: false, // already reacted to hesitation
  };

  function startRandomNick() {
    stopRandomNick();
    Object.assign(NR, {
      lastWordCount: 0, lastInputTime: Date.now(), idleStage: 0,
      inputStarted: false, prevSpeed: 0, sustainedInputSecs: 0,
      history: [], longWordTriggered: false, deleteTriggered: false, hesitateTriggered: false, _gibberishCooldown: false,
    });

    NR.checkTimer = setInterval(() => {
      if (S.phase === 'verdict' || S.phase === 'title') return;

      if (!D.input_area.classList.contains('hidden')) {
        nickInputReaction();
      } else {
        // Dialogue phase — ambient
        if (Math.random() < 0.12) {
          setNick(pick(['neutral', 'thinking', 'neutral', 'frown', 'neutral', 'neutral']));
        }
      }
    }, 3000); // check every 3 seconds for more responsive reactions
  }

  function stopRandomNick() {
    if (NR.checkTimer) { clearInterval(NR.checkTimer); NR.checkTimer = null; }
    if (S.nickRandomTimer) { clearTimeout(S.nickRandomTimer); S.nickRandomTimer = null; }
  }

  function nickInputReaction() {
    const now = Date.now();
    const words = countWords(D.user_input.value);
    const text = D.user_input.value;
    const delta = words - NR.lastWordCount;
    const timeSinceInput = now - NR.lastInputTime;
    const limit = WORD_LIMITS[S.currentPart] || WORD_LIMITS[1];

    // Record history for speed tracking
    NR.history.push({ time: now, words });
    if (NR.history.length > 10) NR.history.shift();

    // === ACTIVE INPUT BEHAVIORS ===
    if (delta > 0) {
      NR.lastInputTime = now;
      NR.idleStage = 0;

      // #6 First word typed
      if (!NR.inputStarted && words > 0) {
        NR.inputStarted = true;
        nickFlash('thinking', 2000);
        NR.lastWordCount = words;
        NR.prevSpeed = delta;
        return;
      }

      // #17 Sustained input (30+ seconds non-stop)
      NR.sustainedInputSecs += 3;
      if (NR.sustainedInputSecs >= 30 && Math.random() < 0.3) {
        nickFlash(pick(['smile', 'approving']), 2000);
        NR.sustainedInputSecs = 0; // reset so it can trigger again later
        NR.lastWordCount = words;
        NR.prevSpeed = delta;
        return;
      }

      // #14 Speed suddenly increased (was slow, now fast)
      if (NR.prevSpeed <= 2 && delta >= 5) {
        nickFlash(pick(['approving', 'smile', 'shocked']), 1500);
        NR.lastWordCount = words;
        NR.prevSpeed = delta;
        return;
      }

      // #1 Fast input (≥6 words/cycle)
      if (delta >= 6) {
        nickFlash(pick(['approving', 'shocked', 'smile']), 1500);
      }
      // #2 Normal input (≥3 words/cycle)
      else if (delta >= 3) {
        nickFlash(pick(['neutral', 'thinking', 'smile']), 1200);
      }
      // Ambient: gentle random expression shifts while typing (even with 1-2 words)
      else if (delta >= 1 && Math.random() < 0.5) {
        setNick(pick(['neutral', 'smile', 'thinking', 'approving']));
      }

      // Gibberish detection: if most words lack vowels → annoyed for 5s
      if (words >= 5 && !NR._gibberishCooldown) {
        const allWords = text.trim().split(/\s+/);
        const noVowel = allWords.filter(w => !/[aeiouAEIOU]/.test(w)).length;
        if (noVowel / allWords.length > 0.6) {
          NR._gibberishCooldown = true;
          setNick('annoyed');
          setTimeout(() => { NR._gibberishCooldown = false; }, 5000);
        }
      }

      // #19 Long/advanced word detected
      if (!NR.longWordTriggered) {
        const longWords = (text.match(/\b[a-zA-Z]{8,}\b/g) || []);
        if (longWords.length >= 2) {
          NR.longWordTriggered = true;
          setTimeout(() => nickFlash(pick(['approving', 'shocked']), 2000), 500);
        }
      }

      // #18 Approaching word limit (≥80%)
      if (words >= limit.max * 0.8) {
        nickFlash(pick(['bored', 'thinking']), 1500);
      }

      // #10 Near word limit (≥90%)
      if (words >= limit.max * 0.9 && Math.random() < 0.5) {
        nickFlash(pick(['shocked', 'approving']), 1500);
      }

      // #9 Just reached minimum
      if (NR.lastWordCount < limit.min && words >= limit.min) {
        nickFlash(pick(['thinking', 'neutral']), 1200);
      }

      NR.lastWordCount = words;
      NR.prevSpeed = delta;
      return;
    }

    // === DELETION BEHAVIOR ===
    if (delta <= -10 && !NR.deleteTriggered) {
      // #7 Large deletion (≥10 words)
      NR.deleteTriggered = true;
      nickFlash(pick(['shocked', 'thinking']), 2000);
      npcSound('shocked'); // SOUND: massive deletion
      NR.lastWordCount = words;
      return;
    }
    if (delta < -4 && !NR.deleteTriggered) {
      // Moderate deletion (silent, expression only)
      NR.deleteTriggered = true;
      nickFlash(pick(['shocked', 'thinking']), 2000);
      NR.lastWordCount = words;
      return;
    }

    // === SPEED DECREASE ===
    if (delta === 0 && NR.prevSpeed >= 5 && timeSinceInput > 5000 && timeSinceInput < 10000) {
      // #15 Was typing fast, suddenly stopped
      if (Math.random() < 0.4) {
        nickFlash(pick(['thinking', 'frown']), 1800);
      }
    }

    // === IDLE BEHAVIORS (progressive) ===
    NR.sustainedInputSecs = 0;

    // #13 Hesitation (typed 1-2 words then stopped ≥6s)
    if (!NR.hesitateTriggered && words > 0 && words <= 3 && timeSinceInput > 6000) {
      NR.hesitateTriggered = true;
      nickFlash(pick(['thinking', 'frown']), 2000);
      return;
    }

    // #11 Was flowing then stopped (≥8s after sustained input)
    if (NR.prevSpeed >= 3 && timeSinceInput > 8000 && timeSinceInput < 12000 && NR.idleStage < 1) {
      NR.idleStage = 1;
      setNick(pick(['thinking', 'frown']));
      return;
    }

    // #3 Progressive idle stages
    if (timeSinceInput > 30000 && NR.idleStage < 4) {
      NR.idleStage = 4;
      setNick('annoyed');
      npcSound(pick(['yawn', 'hmph'])); // SOUND: long idle
    } else if (timeSinceInput > 22000 && NR.idleStage < 3) {
      NR.idleStage = 3;
      setNick('frown');
    } else if (timeSinceInput > 15000 && NR.idleStage < 2) {
      NR.idleStage = 2;
      setNick('bored');
    } else if (timeSinceInput > 8000 && NR.idleStage < 1) {
      NR.idleStage = 1;
      setNick('thinking');
    }

    // #8 Timer running low (≤10s)
    if (S.timerRemaining && S.timerRemaining <= 10 && S.timerRemaining > 3) {
      if (Math.random() < 0.3) setNick(pick(['frown', 'annoyed']));
    }
    // #16 Timer critical (≤3s)
    if (S.timerRemaining && S.timerRemaining <= 3 && NR.idleStage < 5) {
      NR.idleStage = 5; // prevent repeat
      setNick('shocked');
      npcSound('shocked'); // SOUND: time's up!
    }

    NR.lastWordCount = words;
  }

  // Called on every input event — resets idle state
  function onInputActivity() {
    NR.lastInputTime = Date.now();
    const words = countWords(D.user_input.value);

    // #4 Resume after idle
    if (NR.idleStage > 0) {
      NR.idleStage = 0;
      nickFlash(pick(['neutral', 'neutral', 'approving']), 1200);
    }

    // #20 Delete-then-retype pattern (fluctuating word count)
    if (NR.history.length >= 3) {
      const h = NR.history;
      const a = h[h.length-3]?.words || 0, b = h[h.length-2]?.words || 0, c = words;
      if (a < b && b > c && Math.abs(b - c) >= 3) {
        if (Math.random() < 0.3) nickFlash(pick(['thinking', 'bored']), 1500);
      }
    }

    NR.lastWordCount = words;
  }

  // ─── WORD LIMITS PER PART ─────────────────────────────────────────
  const WORD_LIMITS = { 1: { min: 10, max: 150 }, 2: { min: 10, max: 300 }, 3: { min: 10, max: 250 } };

  function countWords(text) {
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
  }

  // Chinese detection easter egg (throttled to once every 5s)
  let _lastChineseTrigger = 0;
  function checkChineseEasterEgg(text) {
    if (!/[\u4e00-\u9fa5]/.test(text)) return;
    const now = Date.now();
    if (now - _lastChineseTrigger < 5000) return;
    _lastChineseTrigger = now;
    playGibberish();
    setNick('shocked');
    // Show a small scolding message in dialogue box
    if (D.dialogue_box && D.speaker_name && D.dialogue_text) {
      const wasHidden = D.dialogue_box.classList.contains('hidden');
      D.dialogue_box.classList.remove('hidden');
      const oldName = D.speaker_name.textContent;
      const oldText = D.dialogue_text.textContent;
      D.speaker_name.textContent = '尼克';
      D.dialogue_text.textContent = '歪比巴卜！这是英语考试，请说英文！';
      setTimeout(() => {
        D.speaker_name.textContent = oldName;
        D.dialogue_text.textContent = oldText;
        if (wasHidden) D.dialogue_box.classList.add('hidden');
        setNick('neutral');
      }, 2500);
    }
  }

  function updateWordCount() {
    onInputActivity();
    checkChineseEasterEgg(D.user_input.value);
    const limit = WORD_LIMITS[S.currentPart] || WORD_LIMITS[1];
    const words = countWords(D.user_input.value);
    const hint = D.input_hint;
    const overLimit = words > limit.max;
    const underLimit = words < limit.min;

    hint.textContent = words + '/' + limit.max + ' 词' + (underLimit ? '（至少 ' + limit.min + ' 词）' : '');
    hint.style.color = overLimit ? 'var(--red, #e74c3c)' : underLimit ? 'var(--yellow, #f1c40f)' : 'var(--green, #27ae60)';

    // Hard cap: prevent typing beyond max
    if (overLimit) {
      const trimmed = D.user_input.value.trim().split(/\s+/).slice(0, limit.max).join(' ');
      D.user_input.value = trimmed;
      hint.textContent = limit.max + '/' + limit.max + ' 词（已达上限）';
      hint.style.color = 'var(--red, #e74c3c)';
    }

    // Disable submit if under min
    D.submit_btn.disabled = underLimit;
    D.submit_btn.style.opacity = underLimit ? '0.4' : '1';
    D.submit_btn.style.cursor = underLimit ? 'not-allowed' : 'pointer';
  }

  // ─── INPUT (mid-screen, question shown above by caller) ──────────
  function showInput(timeLimit, onSubmit) {
    D.dialogue_box.classList.add('hidden');
    D.input_area.classList.remove('hidden');
    D.user_input.value = '';
    S.savedTranscript = '';
    D.user_input.focus();

    // Show pause button only in solo mode
    D.pause_btn.classList.toggle('hidden', S.multiplayer);
    D.mic_btn.classList.toggle('hidden', S.inputMode !== 'voice');
    D.user_input.placeholder = S.inputMode === 'voice'
      ? '语音识别内容会显示在这里...也可以手动输入。'
      : '请输入你的回答...';

    // Init word count
    D.user_input.oninput = updateWordCount;
    updateWordCount();

    startTimer(timeLimit, D.input_timer_bar, null, () => {
      gavelStrike(3, () => {
        stopRecording();
        const text = D.user_input.value.trim();
        D.input_area.classList.add('hidden');
        D.user_input.oninput = null;
        onSubmit(text || '（未作答）');
      });
    });

    D.submit_btn.onclick = () => {
      const raw = D.user_input.value.trim();
      const words = countWords(raw);
      const limit = WORD_LIMITS[S.currentPart] || WORD_LIMITS[1];
      if (!raw || words < limit.min) return;
      clearTimer(); stopRecording();
      const text = D.user_input.value.trim(); // re-read after punctuation added
      D.input_area.classList.add('hidden');
      D.user_input.oninput = null;
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
      D.user_input.value = (S.savedTranscript || '') + t;
      updateWordCount();
    };
    S.recognition.onerror = () => stopRecording();
    S.recognition.onend = () => { if (S.isRecording) try { S.recognition.start(); } catch (e) {} };
  }

  function addPunctuation(text) {
    if (!text || !text.trim()) return text;
    // Split into sentences by common patterns (long pauses become spaces)
    let s = text.trim();
    // Capitalize first letter
    s = s.charAt(0).toUpperCase() + s.slice(1);
    // Add periods: split on patterns that look like sentence boundaries
    // Pattern: lowercase letter + space + capital letter (or common sentence starters)
    s = s.replace(/([a-z])(\s+)(I |So |But |And |Well |Actually |However |Because |The |This |That |It |My |We |They |He |She |You |In |On |For |Also |Then )/g,
      (m, end, space, start) => end + '. ' + start);
    // Add period at end if missing
    if (!/[.!?]$/.test(s)) s += '.';
    // Clean up double periods / spaces
    s = s.replace(/\.\./g, '.').replace(/\s+/g, ' ');
    return s;
  }

  function startRecording() {
    if (!S.recognition) return;
    S.savedTranscript = D.user_input.value.trim() ? D.user_input.value.trim() + ' ' : '';
    S.isRecording = true;
    // #12 Re-mic reaction
    nickFlash(pick(['neutral', 'smile']), 1500);
    NR.lastInputTime = Date.now();
    NR.idleStage = 0;
    D.mic_btn.classList.add('recording');
    D.mic_btn.textContent = '⏹ 停止';
    // Show recording hint
    if (D.input_hint) {
      D.input_hint.textContent = '🎙 录音中...标点将在停止后自动添加';
      D.input_hint.style.color = 'var(--gold, #C9963A)';
    }
    try { S.recognition.start(); } catch (e) {}
  }

  function stopRecording() {
    S.isRecording = false;
    // Apply punctuation when stopping
    const raw = D.user_input.value.trim();
    if (raw) {
      D.user_input.value = addPunctuation(raw);
    }
    S.savedTranscript = D.user_input.value.trim() ? D.user_input.value.trim() + ' ' : '';
    D.mic_btn.classList.remove('recording');
    D.mic_btn.textContent = '🎤 开麦';
    updateWordCount();
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

RULES: Sub-scores=integers(4-9). Overall=ceil(avg to nearest 0.5), i.e. .25→.5 and .75→next whole. Use FULL range.

Reference examples from a real IELTS examiner:

EXAMPLE 1 (Overall 5.0): Student with basic vocabulary, frequent grammar errors, short undeveloped answers, heavy repetition ("i like make friends", "so colorful", "so interesting" repeated). → FC=5, LR=5, GRA=5, Pron=5

EXAMPLE 2 (Overall 6.5): Student speaks at length, adequate vocabulary ("academic English", "international trade"), some complex structures but with errors, good willingness to communicate. → FC=7, LR=7, GRA=7, Pron=5

EXAMPLE 3 (Overall 7.5): Student fluent and articulate, good vocabulary ("sense of belonging", "historical buildings"), develops answers well with examples, some minor errors but overall good control. → FC=8, LR=7, GRA=7, Pron=8

EXAMPLE 4 (Overall 9.0): Student exceptional fluency, sophisticated vocabulary ("holistic admissions process", "diversify into niche areas", "bore fruit"), complex grammar with consistent accuracy, natural and effortless throughout. → FC=9, LR=9, GRA=9, Pron=9

Match these standards precisely.

IMPORTANT: verdict and comment MUST be written in Chinese (中文). Use a mean, sarcastic courtroom tone (毒舌法官风格).

Verdict style examples by band:
- Band 7+: "无罪释放。被告勉强证明了自己不是英语文盲。" (reluctantly acquit, still mock them)
- Band 6-6.5: "有罪！被告的口语水平仅够在菜市场砍价。" (guilty, compare to something mundane)
- Band 5-5.5: "有罪！被告对英语口语犯下了不可原谅的罪行。" (guilty, dramatic condemnation)
- Band 4-: "重罪！被告的英语水平对听者造成了严重的精神伤害。" (severe, exaggerated damage)

Comment style: 3-4 sentences in Chinese, cite specific quotes from student's answers, mock their weaknesses, give concrete but harsh advice. Example: "你的回答像一碗没放盐的面——能吃，但毫无味道。'I think it's good' 出现了三次，法庭已经听腻了。语法错误此起彼伏，建议你先把基础句型练熟再来。"

JSON only (no markdown):
{
  "scores": {"FC": integer, "LR": integer, "GRA": integer, "Pron": integer},
  "overall": number,
  "verdict": "中文毒舌判决词 1-2 句",
  "comment": "中文毒舌详细点评 3-4 句，引用学生原话，给出具体建议",
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
      comment = '就这？法庭期待的是一段陈述，不是一条短信。几个词就想蒙混过关，未免太天真了。';
    } else if (words < 25) {
      reaction = 'concerned';
      comment = '法庭注意到你的回答短得可怜。这不是填空题，是口语考试——你需要展开论述，而不是惜字如金。';
    } else if (avg < 5.5) {
      reaction = 'disappointed';
      comment = '法庭对你的表现深感失望。词汇量捉襟见肘，观点毫无深度，这样的回答连及格线都够不着。';
    } else if (avg < 6.5) {
      reaction = 'concerned';
      comment = '勉强过得去，但法庭期待的是更高水平的表达。你正在"能用"和"凑合"之间的危险边缘徘徊。';
    } else if (avg < 7.5) {
      reaction = 'satisfied';
      comment = '法庭承认这是一个还算像样的回答。有内容，有结构，但离精彩还有距离，继续打磨。';
    } else {
      reaction = 'impressed';
      comment = '法庭......有些意外。你的词汇和逻辑都展现了一定的水准，算你过关。别骄傲，下次法庭会更严格。';
    }

    // Check for common grammar issues for objections
    let objection = null;
    if (/\bi\b/.test(answer) && !/\bI\b/.test(answer)) {
      objection = { reason: "'I' 必须大写——这是最基本的语法规则！" };
    } else if (/\b(he|she) (don't|have)\b/i.test(answer)) {
      objection = { reason: "主谓一致错误！这种低级错误不应该出现。" };
    } else if (/\bmore better\b|\bmost biggest\b/i.test(answer)) {
      objection = { reason: "双重比较级！'more better' 不是英语！" };
    }

    return { reaction, comment, objection, scores };
  }

  // ─── UNIFIED ANSWER HANDLER ─────────────────────────────────────
  async function handleAnswer(answer, question, part, advanceFn) {
    // Brief "thinking" before evaluating — the examiner is considering
    setNick('thinking');
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
    if (S.qIndex >= S.questions.length) { stopRandomNick(); hideQuestion(); if (S._skipToVerdict) { goVerdict(); } else { transitionPart2(); } return; }
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
        if (S._skipToVerdict) { goVerdict(); } else { transitionPart3(); }
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
      // Force correct IELTS rounding: .25 → up to .5, .75 → up to next whole
      if (verdict && verdict.scores) {
        const sc = verdict.scores;
        const correctOverall = Math.ceil(((sc.FC + sc.LR + sc.GRA + sc.Pron) / 4) * 2) / 2;
        verdict.overall = correctOverall;
      }
    } catch (e) {
      console.warn('Verdict AI unavailable, computing offline:', e.message);
    }

    // Offline verdict from accumulated per-question scores
    if (!verdict || !verdict.scores) {
      const allScores = S.answers.filter(a => a.scores).map(a => a.scores);
      if (allScores.length > 0) {
        const avg = (key) => Math.round(allScores.reduce((s, sc) => s + (sc[key] || 5), 0) / allScores.length);
        const fc = avg('FC'), lr = avg('LR'), gra = avg('GRA'), pron = avg('Pron') || Math.round((fc + lr) / 2);
        const overall = Math.ceil(((fc + lr + gra + pron) / 4) * 2) / 2; // IELTS: .25→.5, .75→next whole

        let verdictText, comment, reaction;
        if (overall >= 7) {
          reaction = 'impressed';
          verdictText = '无罪释放。被告勉强证明了自己不是英语文盲。';
          comment = '法庭承认你的表达尚可，词汇量没让人昏睡。但别得意——你的语法偶尔还是像一辆没上油的自行车。离真正的流利还差得远，回去继续练。';
        } else if (overall >= 6) {
          reaction = 'merciful';
          verdictText = '有罪！被告的口语水平仅够日常寒暄。';
          comment = '你的表现时好时坏，有些回答还算像样，有些则让法庭昏昏欲睡。展开论述的能力严重不足，语法结构单一。法庭建议你多用复杂句型，少说废话。';
        } else {
          reaction = 'disappointed';
          verdictText = '有罪！被告的英语水平令法庭深感遗憾。';
          comment = '你的回答大多过于简短，词汇量仿佛还停留在初中水平。法庭强烈建议你多背搭配、多练口语，学会用例子和解释来充实你的回答。';
        }

        verdict = { scores: { FC: fc, LR: lr, GRA: gra, Pron: pron }, overall, verdict: verdictText, comment, reaction };
      } else {
        verdict = {
          scores: { FC: 5, LR: 5, GRA: 5, Pron: 5 },
          overall: 5,
          verdict: '法庭无法对被告作出充分评估，暂时从宽处理。',
          comment: '你提供的证据严重不足，法庭几乎无从判断你的英语水平。下次请给出更完整的回答。',
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

      // Dynamic history hint based on score
      const hintEl = document.getElementById('verdict-history-hint');
      if (hintEl) {
        const o = parseFloat(v.overall) || 0;
        if (o >= 7) hintEl.textContent = '侥幸过关的记录已归档至历史记录，里面有逐句点评和升级建议，别嫌烦，去看';
        else if (o >= 6) hintEl.textContent = '这份勉强及格的答卷已存入历史记录，里面有详细诊断和句子升级，强烈建议去看';
        else if (o >= 5) hintEl.textContent = '令人失望的表现已记录在案，历史记录里有逐句分析和改进方案，去好好看吧';
        else hintEl.textContent = '犯罪证据已保存至历史记录，里面有详细的抢救方案和句子重写，你非常需要去看';
      }
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

    const partMode = S.selectedPart || 'all';

    showScreen('game');
    updateHUD();

    // Intro dialogue varies by part mode
    const introBase = [
      { speaker: '尼克', text: '...', expression: 'neutral', action: () => gavelStrike(3) },
      { speaker: '尼克', text: '现在开庭！', expression: 'neutral' },
      { speaker: '尼克', text: '全体起立！雅思考官尼克到庭！', expression: 'smile' },
    ];

    const partIntros = {
      'all': [
        { speaker: '尼克', text: '被告被指控犯有"英语口语不达标"之罪。', expression: 'frown' },
        { speaker: '尼克', text: '第一部分 — 常规提问。请清晰作答。法庭正在注视你。', expression: 'neutral' },
      ],
      '1': [
        { speaker: '尼克', text: '今天只审 Part 1 — 常规提问。', expression: 'neutral' },
        { speaker: '尼克', text: '别以为简单就能敷衍！法庭正在注视你。', expression: 'frown' },
      ],
      '2': [
        { speaker: '尼克', text: '今天直接进入 Part 2 — 独白陈述。', expression: 'frown' },
        { speaker: '尼克', text: '法庭将出示考题，你有 60 秒准备，然后陈述 2 分钟。', expression: 'neutral' },
      ],
      '3': [
        { speaker: '尼克', text: '今天直接进入 Part 3 — 交叉质询。', expression: 'frown' },
        { speaker: '尼克', text: '我会质疑你的论点。三思而后答。', expression: 'neutral' },
      ],
    };

    const afterIntro = {
      'all': () => { S.phase = 'part1'; S.currentPart = 1; S.qIndex = 0; startRandomNick(); askPart1(); },
      '1':   () => { S.phase = 'part1'; S.currentPart = 1; S.qIndex = 0; startRandomNick(); askPart1(); },
      '2':   () => { S.currentPart = 2; S.qIndex = 0; updateHUD(); startRandomNick(); showEvidence(); },
      '3':   () => { S.phase = 'part3'; S.currentPart = 3; S.qIndex = 0; updateHUD(); startRandomNick(); askPart3(); },
    };

    // Override part flow: when practicing single part, go to verdict after that part
    if (partMode === '1') {
      // After Part 1, skip to verdict instead of Part 2
      S._skipToVerdict = true;
    } else if (partMode === '2') {
      // After Part 2, skip to verdict instead of Part 3
      S._skipToVerdict = true;
    } else if (partMode === '3') {
      S._skipToVerdict = false; // Part 3 already ends with verdict
    } else {
      S._skipToVerdict = false;
    }

    dialogueSequence([...introBase, ...(partIntros[partMode] || partIntros['all'])], afterIntro[partMode] || afterIntro['all']);
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
        S.selectedPart = msg.part_mode || 'all';
        S._skipToVerdict = (msg.part_mode === '1' || msg.part_mode === '2');
        showScreen('game');
        updateHUD();
        D.player_count_badge.textContent = S.players.length + ' 人';
        D.player_count_badge.classList.remove('hidden');

        const mpPartLabel = { 'all': '完整模考', '1': 'Part 1 练习', '2': 'Part 2 练习', '3': 'Part 3 练习' };
        dialogueSequenceAutoAdvance([
          { speaker: '尼克', text: '...', expression: 'neutral', action: () => gavelStrike(3) },
          { speaker: '尼克', text: '现在开庭！今天有多名被告同时受审。', expression: 'neutral' },
          { speaker: '尼克', text: '模式：' + (mpPartLabel[msg.part_mode] || '完整模考') + '。法庭将审判你们每一个人。', expression: 'frown' },
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
    S.savedTranscript = '';
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

    // Part selector
    let selectedPart = 'all';
    document.querySelectorAll('.part-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.part-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedPart = btn.dataset.part;
      });
    });

    // Solo mode
    $('btn-solo').addEventListener('click', () => {
      ctx(); S.multiplayer = false;
      S.selectedPart = selectedPart;
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
      sendWS({ type: 'start_game', part_mode: selectedPart || 'all' });
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
      if (e.key === 'Escape') {
        const ov = document.getElementById('audio-select-overlay');
        if (ov && ov.style.display !== 'none') closeAudioSelect();
      }
    });

    // ── Hidden audio input selector (F9) ─────────────────────────────
    let S_selectedMicId = null;

    async function openAudioSelect() {
      const overlay = document.getElementById('audio-select-overlay');
      const list = document.getElementById('audio-device-list');
      if (!overlay || !list) return;

      // Request mic permission first so labels are available
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch(err) { /* ignore — labels may be empty */ }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');

      list.innerHTML = '';
      if (mics.length === 0) {
        list.innerHTML = '<div style="color:#e74c3c;font-size:10px;letter-spacing:2px;">未检测到麦克风设备</div>';
      } else {
        mics.forEach((mic, i) => {
          const label = mic.label || `麦克风 ${i + 1}`;
          const isSelected = mic.deviceId === S_selectedMicId ||
                             (!S_selectedMicId && mic.deviceId === 'default');
          const btn = document.createElement('button');
          btn.textContent = (isSelected ? '▶ ' : '　') + label;
          btn.style.cssText = `
            background: ${isSelected ? 'rgba(212,160,23,0.15)' : 'transparent'};
            border: 2px solid ${isSelected ? 'var(--gold,#d4a017)' : '#333'};
            color: ${isSelected ? 'var(--gold,#d4a017)' : 'var(--warm-white,#f0e8d0)'};
            font-family: var(--font-ark, monospace);
            font-size: 10px; letter-spacing: 2px;
            padding: 10px 14px; cursor: pointer; text-align: left;
            transition: border-color 0.1s;
          `;
          btn.onclick = () => selectMicDevice(mic.deviceId, label, mics, list);
          list.appendChild(btn);
        });
      }

      overlay.style.display = 'flex';
    }

    function closeAudioSelect() {
      const overlay = document.getElementById('audio-select-overlay');
      if (overlay) overlay.style.display = 'none';
    }

    async function selectMicDevice(deviceId, label, mics, list) {
      S_selectedMicId = deviceId;
      // Prime OS to use selected device, then restart recognition
      const wasRecording = S.isRecording;
      if (wasRecording) { try { S.recognition.stop(); } catch(e) {} }
      try {
        // Opening a getUserMedia stream with the deviceId causes the browser/OS
        // to route subsequent audio to this device for SpeechRecognition too
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } }
        });
        stream.getTracks().forEach(t => t.stop());
      } catch(e) { /* device may not support exact constraint — use best effort */ }
      if (wasRecording) { try { S.recognition.start(); } catch(e) {} }
      // Rebuild the button list to reflect new selection
      Array.from(list.children).forEach((btn, i) => {
        const mic = mics[i];
        const sel = mic && mic.deviceId === deviceId;
        btn.textContent = (sel ? '▶ ' : '　') + (mic ? (mic.label || `麦克风 ${i+1}`) : '');
        btn.style.background = sel ? 'rgba(212,160,23,0.15)' : 'transparent';
        btn.style.borderColor = sel ? 'var(--gold,#d4a017)' : '#333';
        btn.style.color = sel ? 'var(--gold,#d4a017)' : 'var(--warm-white,#f0e8d0)';
      });
      // Show confirmation
      const confirm = document.createElement('div');
      confirm.style.cssText = 'color:#2ecc71;font-size:9px;letter-spacing:2px;text-align:center;margin-top:4px;';
      confirm.textContent = `已选择: ${label}`;
      list.appendChild(confirm);
      setTimeout(() => { if (confirm.parentNode) confirm.parentNode.removeChild(confirm); }, 2000);
    }

    // Expose globally so F9 listener (outside IIFE) can reach them
    window._audioSelectOpen = openAudioSelect;
    window._audioSelectClose = closeAudioSelect;
  });

})();

// Hidden audio selector trigger — outside IIFE, works at any time
// Trigger 1: backtick key (` — top-left of keyboard, no conflicts on any OS)
// Trigger 2: double-click on Nick's name plate (see game.html)
window.addEventListener('keydown', (e) => {
  if (e.key === '`' || e.key === 'F9') {
    e.preventDefault(); e.stopPropagation();
    if (window._audioSelectOpen) window._audioSelectOpen();
  }
  if (e.key === 'Escape') {
    const ov = document.getElementById('audio-select-overlay');
    if (ov && ov.style.display !== 'none' && window._audioSelectClose) window._audioSelectClose();
  }
}, true);

// Trigger 3: double-click on name plate
document.addEventListener('DOMContentLoaded', () => {
  const plate = document.querySelector('.name-plate');
  if (plate) plate.addEventListener('dblclick', () => {
    if (window._audioSelectOpen) window._audioSelectOpen();
  });
});
