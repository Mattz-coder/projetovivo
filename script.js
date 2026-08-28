(function(){
  // ==================================================================
  // CONFIGURAÇÃO DE REDIRECIONAMENTO
  // Troque estas URLs pelas páginas/links reais da Vivo.
  // ==================================================================
  const REDIRECT_URLS = {
    whatsapp:       "https://api.whatsapp.com/send?phone=5511999151515", // Atendimento com humano
    app:             "https://www.vivo.com.br/aplicativo",                // Redireciona para o aplicativo
    site_normal:     "https://www.vivo.com.br/atendimento",               // Site normal
    site_idoso:      "https://www.vivo.com.br/atendimento",                         // Site adaptado, mais zoom e imagens
    site_inclusivo:  "https://www.vivo.com.br/atendimento",                         // Site inclusivo, com mais imagens
  };

  // Tempo (ms) até o redirecionamento automático acontecer no fim do fluxo.
  const AUTO_REDIRECT_DELAY = 1500;

  // Tempo (ms) considerado "demorou" para responder a pergunta da idade.
  const DEMOROU_THRESHOLD_MS = 60 * 1000;

  // Tempo (ms) do timer visível de cada pergunta (2 minutos).
  const QUESTION_TIMER_MS = 2 * 60 * 1000;

  // ==================================================================
  // ELEMENTOS DA PÁGINA
  // ==================================================================
  const form = document.getElementById('quizForm');
  const introBlock = document.getElementById('introBlock');
  const progressText = document.getElementById('progressText');
  const progressFill = document.getElementById('progressFill');
  const btnBack = document.getElementById('btnBack');
  const btnNext = document.getElementById('btnNext');
  const hintText = document.getElementById('hintText');
  const resultSection = document.getElementById('result');
  const quizCard = document.getElementById('quizCard');
  const redirectText = document.getElementById('redirectText');
  const btnAudioToggle = document.getElementById('btnAudioToggle');

  // ==================================================================
  // LEITURA DINÂMICA (Web Speech API)
  // Permite que a pessoa ouça as perguntas e opções em voz alta —
  // essencial para quem não sabe ler (analfabetismo / baixo letramento).
  // ==================================================================
  const speechSupported = 'speechSynthesis' in window;
  let audioEnabled = false;
  try {
    audioEnabled = speechSupported && localStorage.getItem('triagem_audio') === 'on';
  } catch (e) { /* localStorage pode estar bloqueado; segue com audioEnabled = false */ }

  let ptVoice = null;
  function pickVoice(){
    if (!speechSupported) return;
    const voices = window.speechSynthesis.getVoices();
    ptVoice = voices.find(v => /pt-BR/i.test(v.lang)) ||
              voices.find(v => /^pt/i.test(v.lang)) ||
              null;
  }
  if (speechSupported) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }

  function speak(text){
    if (!speechSupported || !text) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'pt-BR';
    utter.rate = 0.92;
    if (ptVoice) utter.voice = ptVoice;
    window.speechSynthesis.speak(utter);
  }

  function stopSpeaking(){
    if (speechSupported) window.speechSynthesis.cancel();
  }

  function speechTextForStep(def){
    let text = def.title + '. ';
    def.options.forEach((opt, i) => {
      text += 'Opção ' + (i + 1) + ': ' + opt.label + '. ';
    });
    return text;
  }

  function setAudioToggleUI(){
    if (!btnAudioToggle) return;
    if (!speechSupported) {
      btnAudioToggle.hidden = true;
      return;
    }
    btnAudioToggle.setAttribute('aria-pressed', audioEnabled ? 'true' : 'false');
  }

  if (btnAudioToggle) {
    setAudioToggleUI();
    btnAudioToggle.addEventListener('click', () => {
      audioEnabled = !audioEnabled;
      setAudioToggleUI();
      try { localStorage.setItem('triagem_audio', audioEnabled ? 'on' : 'off'); } catch (e) {}
      if (audioEnabled && currentStepKey) {
        speak(speechTextForStep(STEP_DEFS[currentStepKey]));
        resetQuestionTimer();
      } else {
        stopSpeaking();
      }
    });
  }

  // ==================================================================
  // CONTROLE DE TAMANHO DE FONTE (manual e automático)
  // ==================================================================
  function applyFontSize(size){
    document.documentElement.setAttribute('data-fontsize', size === 'normal' ? '' : size);
    document.querySelectorAll('.fontctrl button').forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.size === size ? 'true' : 'false');
    });
  }
  document.querySelectorAll('.fontctrl button').forEach(btn => {
    btn.addEventListener('click', () => applyFontSize(btn.dataset.size));
  });

  // Garante que a fonte nunca "diminua" quando várias condições pedem aumento
  // (ex.: idoso já pediu A+ e "demorou 1min" também pede aumento).
  const FONT_RANK = { normal: 0, lg: 1, xl: 2 };
  function bumpFontSize(current, atLeast){
    return FONT_RANK[atLeast] > FONT_RANK[current] ? atLeast : current;
  }

  // ==================================================================
  // DETECÇÃO AUTOMÁTICA "Está pelo computador?"
  // (heurística por user-agent + largura de tela — não é perguntado ao usuário)
  // ==================================================================
  function isProbablyComputer(){
    const ua = navigator.userAgent || '';
    const mobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const smallScreen = window.innerWidth < 900;
    return !mobileUA && !smallScreen;
  }

  // ==================================================================
  // ESTADO GERAL DO FLUXO
  // ==================================================================
  let state = {
    fontSize: 'normal',
    idoso: false,               // idade 45+
    fundamentalIncompleto: false,
  };
  let history = []; // pilha para o botão "Voltar": { step, state, stepShownAt }
  let stepShownAt = 0; // timestamp de quando a etapa atual apareceu (p/ medir "demorou 1min")
  let redirectTimer = null;

  // ==================================================================
  // TIMER DE 2 MINUTOS POR PERGUNTA
  // Dá um tempo visível pra responder; se esgotar, ajuda a pessoa a
  // seguir em frente (confirma a opção já escolhida ou passa pro
  // fluxo com telas maiores e mais simples).
  // ==================================================================
  let questionTimerInterval = null;
  let questionTimerDeadline = 0;
  let questionTimerEl = null;

  function formatTimer(ms){
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function updateTimerUI(){
    if (!questionTimerEl) return;
    const remaining = questionTimerDeadline - Date.now();
    questionTimerEl.textContent = '⏱️ ' + formatTimer(remaining);
    questionTimerEl.classList.toggle('question-timer--warning', remaining <= 15000);
  }

  function clearQuestionTimer(){
    if (questionTimerInterval) {
      clearInterval(questionTimerInterval);
      questionTimerInterval = null;
    }
  }

  function startQuestionTimer(){
    clearQuestionTimer();
    questionTimerDeadline = Date.now() + QUESTION_TIMER_MS;
    updateTimerUI();
    questionTimerInterval = setInterval(() => {
      const remaining = questionTimerDeadline - Date.now();
      if (remaining <= 0) {
        clearQuestionTimer();
        onQuestionTimeUp();
        return;
      }
      updateTimerUI();
    }, 1000);
  }

  // Reinicia o tempo (ex.: quando a pessoa está ouvindo a pergunta,
  // ela não deve ser apressada).
  function resetQuestionTimer(){
    if (questionTimerInterval) startQuestionTimer();
  }

  function onQuestionTimeUp(){
    // Se já tinha escolhido uma opção, confirma automaticamente por ela.
    if (currentSelection) {
      STEP_DEFS[currentStepKey].onConfirm(currentSelection);
      return;
    }
    // Ninguém respondeu a tempo: deixa a tela mais simples e com fonte
    // maior. Se já estamos no modo simplificado, encaminha para
    // atendimento humano via WhatsApp.
    if (currentStepKey === 'especial') {
      finalize('whatsapp', 'o WhatsApp — atendimento com humano');
      return;
    }
    state.fontSize = bumpFontSize(state.fontSize, 'lg');
    applyFontSize(state.fontSize);
    goTo('especial');
  }

  function cloneState(s){ return JSON.parse(JSON.stringify(s)); }

  // ==================================================================
  // DEFINIÇÃO DAS ETAPAS (perguntas) DO FLUXOGRAMA
  // ==================================================================
  const STEP_DEFS = {

    idade: {
      title: "🎂 Qual sua idade?",
      options: [
        { label: "🧒 Até 17 anos" },
        { label: "🧑 18 - 29 anos" },
        { label: "🙂 30-44 anos" },
        { label: "👨‍🦳 45 - 59 anos", idoso: true, fontSize: 'lg' },
        { label: "👵 60+ anos", idoso: true, fontSize: 'xl' },
      ],
      onConfirm(opt){
        if (opt.idoso) {
          state.idoso = true;
          state.fontSize = bumpFontSize(state.fontSize, opt.fontSize);
          applyFontSize(state.fontSize);
        }

        const elapsed = Date.now() - stepShownAt;
        const demorou = elapsed > DEMOROU_THRESHOLD_MS;

        if (demorou) {
          // "Demorou 1min?" = Sim -> interface com fonte/botões maiores + fluxo por imagens
          state.fontSize = bumpFontSize(state.fontSize, 'lg');
          applyFontSize(state.fontSize);
          goTo('especial');
        } else {
          goTo('escolaridade');
        }
      }
    },

    escolaridade: {
      title: "🎓 Qual o seu nível de escolaridade?",
      options: [
        { label: "📘 Ensino Fundamental Incompleto", fundamentalIncompleto: true },
        { label: "📗 Ensino Fundamental Completo" },
        { label: "📙 Ensino Médio Incompleto" },
        { label: "📕 Ensino Médio Completo" },
      ],
      onConfirm(opt){
        if (opt.fundamentalIncompleto) {
          state.fundamentalIncompleto = true;
          state.fontSize = bumpFontSize(state.fontSize, 'lg');
          applyFontSize(state.fontSize);
          goTo('especial'); // Fundamental incompleto -> interface maior + fluxo por imagens
        } else {
          goTo('canal'); // Fundamental, Médio e Superior -> fluxo normal
        }
      }
    },

    canal: {
      title: "💬 Como prefere prosseguir com o atendimento?",
      options: [
        { label: "💬 WhatsApp", channel: "whatsapp" },
        { label: "🌐 Site VIVO", channel: "site" },
        { label: "📱 Aplicativo VIVO", channel: "app" },
      ],
      onConfirm(opt){
        if (opt.channel === 'whatsapp') {
          finalize('whatsapp', 'o WhatsApp — atendimento com humano');
          return;
        }
        if (opt.channel === 'site') {
          const dest = state.idoso ? 'site_idoso' : 'site_normal';
          finalize(dest, state.idoso ? 'o site adaptado da Vivo (mais zoom e imagens)' : 'o site da Vivo');
          return;
        }
        // Aplicativo: verifica automaticamente se está em um computador
        if (opt.channel === 'app') {
          if (isProbablyComputer()) {
            const dest = state.idoso ? 'site_idoso' : 'site_normal';
            finalize(dest, 'o site da Vivo (o aplicativo não está disponível no computador)');
          } else {
            finalize('app', 'o aplicativo VIVO');
          }
        }
      }
    },

    especial: {
      title: "✨ Como quer continuar?",
      iconOptions: true,
      options: [
        { label: "WhatsApp", href imag-src: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/1280px-WhatsApp.svg.png?utm_source=commons.wikimedia.org&utm_campaign=index&utm_content=thumbnail&_=20220228223904", target: "whatsapp" },
        { label: "Site da Vivo", icon: "🌐", target: "site_inclusivo" },
      ],
      onConfirm(opt){
        if (opt.target === 'whatsapp') {
          finalize('whatsapp', 'o WhatsApp — atendimento com humano');
        } else {
          finalize('site_inclusivo', 'o site inclusivo da Vivo, com mais imagens');
        }
      }
    },
  };

  // ==================================================================
  // RENDERIZAÇÃO
  // ==================================================================
  let currentStepKey = null;
  let currentSelection = null;

  function renderStep(stepKey){
    currentStepKey = stepKey;
    currentSelection = null;
    stepShownAt = Date.now();

    const def = STEP_DEFS[stepKey];
    form.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'question active';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-labelledby', 'qtext-current');

    const headerRow = document.createElement('div');
    headerRow.className = 'qheader';

    const p = document.createElement('p');
    p.className = 'qtext';
    p.id = 'qtext-current';
    p.textContent = def.title;
    headerRow.appendChild(p);

    const timerBadge = document.createElement('span');
    timerBadge.className = 'question-timer';
    timerBadge.setAttribute('aria-hidden', 'true'); // evita ansiedade extra p/ leitores de tela
    headerRow.appendChild(timerBadge);
    questionTimerEl = timerBadge;

    wrap.appendChild(headerRow);

    if (speechSupported) {
      const listenBtn = document.createElement('button');
      listenBtn.type = 'button';
      listenBtn.className = 'btn-listen';
      listenBtn.innerHTML = '<span class="icon" aria-hidden="true">🔊</span><span>Ouvir esta pergunta</span>';
      listenBtn.addEventListener('click', () => {
        speak(speechTextForStep(def));
        resetQuestionTimer();
      });
      wrap.appendChild(listenBtn);
    }

    const ul = document.createElement('ul');
    ul.className = 'options' + (def.iconOptions ? ' icon-options' : '');

    def.options.forEach((opt, oi) => {
      const li = document.createElement('li');
      li.className = 'option';
      const inputId = 'opt_' + oi;

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'currentQuestion';
      input.id = inputId;
      input.value = oi;
      if (def.iconOptions) input.className = 'sr-only';

      const label = document.createElement('label');
      label.setAttribute('for', inputId);

      if (def.iconOptions && opt.icon) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'option-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.textContent = opt.icon;
        label.appendChild(iconSpan);
        const textSpan = document.createElement('span');
        textSpan.textContent = opt.label;
        label.appendChild(textSpan);
      } else {
        label.textContent = opt.label;
      }

      input.addEventListener('change', () => {
        currentSelection = opt;
        [...ul.children].forEach(c => c.classList.remove('selected'));
        li.classList.add('selected');
        hintText.textContent = '';
      });

      li.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') input.click();
      });

      li.appendChild(input);
      li.appendChild(label);
      ul.appendChild(li);
    });

    wrap.appendChild(ul);
    form.appendChild(wrap);

    introBlock.style.display = history.length === 0 ? 'block' : 'none';
    progressText.textContent = 'Etapa ' + (history.length + 1);
    const pct = Math.min(100, Math.round(((history.length + 1) / 3) * 100));
    progressFill.style.width = pct + '%';
    btnBack.style.visibility = history.length === 0 ? 'hidden' : 'visible';
    btnNext.textContent = 'Continuar';
    hintText.textContent = '';

    if (audioEnabled) {
      speak(speechTextForStep(def));
    } else {
      stopSpeaking();
    }

    startQuestionTimer();
  }

  function goTo(stepKey){
    history.push({ step: currentStepKey, state: cloneState(state) });
    renderStep(stepKey);
  }

  // ==================================================================
  // FINALIZAÇÃO / REDIRECIONAMENTO
  // ==================================================================
  function finalize(destKey, description){
    clearQuestionTimer();
    quizCard.querySelector('.progress-wrap').style.display = 'none';
    form.style.display = 'none';
    document.querySelector('.nav').style.display = 'none';
    introBlock.style.display = 'none';
    hintText.style.display = 'none';

    redirectText.textContent = 'Você será redirecionado automaticamente para ' + description + ' em instantes...';
    resultSection.dataset.dest = destKey;

    resultSection.style.display = 'block';
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (audioEnabled) {
      speak('Tudo pronto! ' + redirectText.textContent);
    }

    clearTimeout(redirectTimer);
    redirectTimer = setTimeout(() => {
      window.location.href = REDIRECT_URLS[destKey] || REDIRECT_URLS.site_normal;
    }, AUTO_REDIRECT_DELAY);
  }

  // ==================================================================
  // NAVEGAÇÃO
  // ==================================================================
  btnNext.addEventListener('click', () => {
    if (!currentSelection) {
      hintText.textContent = 'Escolha uma opção para continuar.';
      if (audioEnabled) speak('Escolha uma opção para continuar.');
      return;
    }
    STEP_DEFS[currentStepKey].onConfirm(currentSelection);
  });

  btnBack.addEventListener('click', () => {
    if (history.length === 0) return;
    clearTimeout(redirectTimer);
    const prev = history.pop();
    state = prev.state;
    applyFontSize(state.fontSize);
    renderStep(prev.step);
  });

  document.getElementById('btnContinue').addEventListener('click', () => {
    clearTimeout(redirectTimer);
    const destKey = resultSection.dataset.dest;
    window.location.href = REDIRECT_URLS[destKey] || REDIRECT_URLS.site_normal;
  });

  document.getElementById('btnRestart').addEventListener('click', () => {
    clearTimeout(redirectTimer);
    state = { fontSize: 'normal', idoso: false, fundamentalIncompleto: false };
    applyFontSize('normal');
    history = [];

    quizCard.querySelector('.progress-wrap').style.display = 'block';
    form.style.display = 'block';
    document.querySelector('.nav').style.display = 'flex';
    hintText.style.display = 'block';
    resultSection.style.display = 'none';

    renderStep('idade');
    quizCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ==================================================================
  // INÍCIO
  // ==================================================================
  renderStep('idade');
})();
