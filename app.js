/* SEMPRE ATUALIZADO — pessoal do Bruno.
   Roda no MESMO dominio do backend (Hostinger). Sessao por cookie HttpOnly:
   - action=me        -> ja logado?
   - action=login     -> entra (seta cookie)
   - action=data      -> conteudo curado (categorias + radar + estudos), so logado
   - action=get/mark/note/bulk -> estado (marcacoes + notas), so logado
   Writes mandam o header X-SA-App:1 (guarda anti-CSRF, junto do cookie SameSite=Strict). */
(function () {
  "use strict";
  var API = (window.SA_CONFIG && window.SA_CONFIG.apiBase) || "../atualizado-api/api.php";
  var params = new URLSearchParams(location.search);
  var SLUG = "bruno";

  var CFG = null, DADOS = { itens: [], gerado_em: "" }, ESTUDOS = { episodios: [] };
  var state = { decisions: {}, notes: {} };
  var appMode = "radar", view = "novos", group = "all", q = "";
  var catMap = {}, grpMap = {}, booted = false;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function norm(x) { return (x && typeof x === "object" && !Array.isArray(x)) ? x : {}; }
  function toast(m) { var t = $("toast"); t.textContent = m; t.classList.add("show"); setTimeout(function () { t.classList.remove("show"); }, 2400); }
  function two(n) { n = Math.floor(n); return (n < 10 ? "0" : "") + n; }
  function mmss(sec) { sec = Math.max(0, sec || 0); return two(sec / 60) + ":" + two(sec % 60); }

  /* ---------- rede ---------- */
  function apiGet(action, extra) {
    return fetch(API + "?action=" + encodeURIComponent(action) + (extra || ""), { cache: "no-store", credentials: "same-origin" });
  }
  function apiPost(action, data) {
    var body = new URLSearchParams(); body.set("action", action);
    Object.keys(data || {}).forEach(function (k) { body.set(k, data[k] == null ? "" : data[k]); });
    return fetch(API, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-SA-App": "1" },
      body: body.toString()
    });
  }
  function okJson(r) { if (r.status === 401) { showGate(); throw { auth: false }; } return r.json(); }

  /* ---------- auth ---------- */
  function showGate() { $("gate").style.display = "flex"; $("app").style.display = "none"; setTimeout(function () { var p = $("gate-pass"); if (p) p.focus(); }, 60); }
  function showApp() { $("gate").style.display = "none"; $("app").style.display = ""; }

  function wireGate() {
    $("gate-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var pass = $("gate-pass").value, btn = $("gate-btn"), err = $("gate-err");
      if (!pass) return;
      btn.disabled = true; btn.textContent = "Entrando…"; err.textContent = "";
      apiPost("login", { password: pass })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok && res.j && res.j.ok) { $("gate-pass").value = ""; boot(); }
          else { err.textContent = (res.j && res.j.erro && /tentativas/.test(res.j.erro)) ? "Muitas tentativas. Aguarde uns minutos." : "Senha incorreta."; btn.disabled = false; btn.textContent = "Entrar"; $("gate-pass").select(); }
        })
        .catch(function () { err.textContent = "Erro de conexão."; btn.disabled = false; btn.textContent = "Entrar"; });
    });
  }

  /* ---------- estado ---------- */
  function statusOf(id) { return (state.decisions[id] && state.decisions[id].status) || "pending"; }
  function setStatus(id, status) {
    if (status === "pending") delete state.decisions[id];
    else state.decisions[id] = { status: status };
    apiPost("mark", { id: id, status: status })
      .then(function (r) { if (r.status === 401) return showGate(); if (status !== "read") toast(status === "checked" ? "Selecionado, salvo ✓" : "Desmarcado, salvo ✓"); })
      .catch(function () { toast("Não consegui salvar. Verifique a conexão."); });
  }

  /* ---------- filtros ---------- */
  function passView(id) {
    var s = statusOf(id);
    if (view === "novos") return s === "pending";
    if (view === "sel") return s === "checked";
    if (view === "lidos") return s === "read";
    return s !== "read";
  }
  function passGroup(cat) { return group === "all" || (catMap[cat] && catMap[cat].grupo === group); }
  function passQ(it) {
    if (!q) return true;
    var h = (it.titulo + " " + (it.resumo || "") + " " + (it.fonte || "")).toLowerCase();
    return h.indexOf(q) !== -1;
  }
  function visibleItems() {
    return DADOS.itens.filter(function (it) { return catMap[it.cat] && passGroup(it.cat) && passView(it.id) && passQ(it); });
  }

  /* ---------- contadores ---------- */
  function counts() {
    var novos = 0, sel = 0, tot = DADOS.itens.length, perCat = {};
    DADOS.itens.forEach(function (it) {
      var s = statusOf(it.id);
      perCat[it.cat] = perCat[it.cat] || 0;
      if (s === "pending") { novos++; perCat[it.cat]++; }
      if (s === "checked") sel++;
    });
    return { novos: novos, sel: sel, tot: tot, perCat: perCat };
  }

  /* ---------- render radar ---------- */
  function renderStats() {
    var c = counts();
    $("s-novos").textContent = c.novos;
    $("s-sel").textContent = c.sel;
    $("s-tot").textContent = c.tot;
    var upd = DADOS.gerado_em ? new Date(DADOS.gerado_em) : null;
    $("s-upd").textContent = upd ? "atualizado " + upd.toLocaleDateString("pt-BR") + " " + upd.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
    $("ab-count").textContent = c.sel + (c.sel === 1 ? " selecionado" : " selecionados");
    $("btn-gerar").disabled = c.sel === 0;
    return c;
  }
  function renderSide(perCat) {
    var el = $("sidelist"); el.innerHTML = "";
    (CFG.grupos || []).forEach(function (g) {
      var gh = document.createElement("div"); gh.className = "side-grp";
      gh.textContent = g.emoji + " " + g.nome; el.appendChild(gh);
      (CFG.categorias || []).filter(function (c) { return c.grupo === g.id; }).forEach(function (c) {
        var n = perCat[c.id] || 0;
        var row = document.createElement("div"); row.className = "side-cat";
        row.innerHTML = '<span class="em">' + c.emoji + '</span><span class="nm">' + esc(c.nome) + '</span>'
          + '<span class="badge' + (n ? "" : " zero") + '">' + n + '</span>';
        row.onclick = function () {
          closeSide();
          var t = document.getElementById("sec-" + c.id);
          if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
          else toast("Nada em " + c.nome + " nesse filtro.");
        };
        el.appendChild(row);
      });
    });
  }
  function card(it) {
    var s = statusOf(it.id);
    var d = document.createElement("div");
    d.className = "card" + (s === "checked" ? " checked" : "") + (s === "read" ? " read" : "");
    d.id = "it-" + it.id;
    var meta = [];
    if (it.tipo) meta.push('<span class="tag ' + esc(it.tipo) + '">' + esc(it.tipo) + '</span>');
    if (it.fonte) meta.push(esc(it.fonte));
    if (it.data) meta.push(esc(it.data));
    if (it.url) meta.push('<a href="' + esc(it.url) + '" target="_blank" rel="noopener">abrir ↗</a>');
    d.innerHTML =
      '<label class="chk"><input type="checkbox" ' + (s === "checked" ? "checked" : "") + '></label>' +
      '<div class="body">' +
        '<p class="tit">' + esc(it.titulo) + '</p>' +
        (it.resumo ? '<p class="res">' + esc(it.resumo) + '</p>' : '') +
        (it.porque ? '<div class="porque">💡 ' + esc(it.porque) + '</div>' : '') +
        '<div class="meta">' + meta.join('<span>·</span> ') +
          '<button class="arch" title="Marcar como lido/arquivar">📁</button>' +
        '</div>' +
      '</div>';
    d.querySelector(".chk input").onchange = function (e) {
      setStatus(it.id, e.target.checked ? "checked" : "pending");
      d.classList.toggle("checked", e.target.checked);
      renderStats();
    };
    d.querySelector(".arch").onclick = function () { setStatus(it.id, "read"); toast("Arquivado 📁"); render(); };
    return d;
  }
  function render() {
    var perCat = renderStats().perCat;
    renderSide(perCat);
    var feed = $("feed"); feed.innerHTML = "";
    var items = visibleItems();
    if (!items.length) {
      feed.innerHTML = '<div class="empty"><b>Nada por aqui nesse filtro.</b>' +
        (view === "novos" ? "Rode a skill pra trazer assuntos novos, ou veja <a href=\"javascript:void(0)\" onclick=\"document.querySelector('[data-f=todos]').click()\">Todos</a>." : "Troque o filtro acima.") + '</div>';
      return;
    }
    var byCat = {};
    items.forEach(function (it) { (byCat[it.cat] = byCat[it.cat] || []).push(it); });
    (CFG.categorias || []).forEach(function (c) {
      var arr = byCat[c.id]; if (!arr || !arr.length) return;
      arr.sort(function (a, b) { return (b.data || "").localeCompare(a.data || ""); });
      var sec = document.createElement("section"); sec.className = "catsec"; sec.id = "sec-" + c.id;
      sec.innerHTML = '<div class="catsec-head"><span class="em">' + c.emoji + '</span>' +
        '<h2>' + esc(c.nome) + '</h2><span class="cnt">' + arr.length + (arr.length === 1 ? " item" : " itens") + '</span></div>' +
        '<div class="catsec-desc">' + esc(c.desc || "") + '</div>';
      arr.forEach(function (it) { sec.appendChild(card(it)); });
      feed.appendChild(sec);
    });
  }

  /* ==================== ESTUDO ==================== */
  function fmtDia(s) {
    if (!s) return "";
    var p = String(s).split("-");
    if (p.length !== 3) return s;
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var txt = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
    return txt.charAt(0).toUpperCase() + txt.slice(1);
  }
  function fmtHora(iso) {
    if (!iso) return "";
    try { var d = new Date(iso); return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }
  function epNoteKey(epId, tp, idx) { return epId + ":" + (tp.sec != null ? tp.sec : "i" + idx); }
  function saveNote(key, text) {
    if (!state.notes) state.notes = {};
    if (text) state.notes[key] = { text: text }; else delete state.notes[key];
    apiPost("note", { key: key, text: text }).then(function (r) { if (r.status === 401) showGate(); }).catch(function () { toast("Sem conexão pra salvar a nota"); });
  }

  /* ---- grid de blocos, agrupado por dia ---- */
  function renderEstudoGrid() {
    $("estudoIntro").style.display = "";
    $("estudoReader").style.display = "none";
    var grid = $("estudoGrid"); grid.style.display = ""; grid.innerHTML = "";
    var eps = (ESTUDOS.episodios || []).slice();
    if (!eps.length) {
      grid.innerHTML = '<div class="daygroup"><div class="empty"><b>Nenhum estudo ainda.</b>' +
        'Gere o Resumo em Áudio no NotebookLM, me mande o arquivo e eu transcrevo, monto os tópicos com o tempo e crio o estudo aqui.</div></div>';
      return;
    }
    eps.sort(function (a, b) {
      var c = (b.data || "").localeCompare(a.data || "");
      return c !== 0 ? c : (b.criado_em || "").localeCompare(a.criado_em || "");
    });
    var byDay = {}, ordem = [];
    eps.forEach(function (ep) { if (!byDay[ep.data]) { byDay[ep.data] = []; ordem.push(ep.data); } byDay[ep.data].push(ep); });
    ordem.forEach(function (dia) {
      var dg = document.createElement("div"); dg.className = "daygroup";
      var blocks = byDay[dia].map(function (ep) {
        var tags = (ep.temas || []).slice(0, 4).map(function (t) { return '<span class="eb-tag">' + esc(t) + '</span>'; }).join("");
        var hora = fmtHora(ep.criado_em);
        var pdata = String(ep.data || "").split("-");
        var dm = pdata.length === 3 ? pdata[2] + "/" + pdata[1] : (ep.data || "");
        return '<button class="ep-block" data-id="' + esc(ep.id) + '">' +
          '<span class="eb-date"><span class="dot"></span>' + esc(dm) + (hora ? " · " + esc(hora) : "") + '</span>' +
          '<h3 class="eb-title">' + esc(ep.titulo) + '</h3>' +
          '<div class="eb-tags">' + tags + '</div>' +
          '<div class="eb-foot"><span class="play">▷</span> ouvir e estudar' + (ep.duracao ? ' · ' + esc(ep.duracao) : '') + '</div>' +
          '</button>';
      }).join("");
      dg.innerHTML = '<div class="day-h">' + esc(fmtDia(dia)) + '</div><div class="blocks">' + blocks + '</div>';
      grid.appendChild(dg);
    });
    [].forEach.call(grid.querySelectorAll(".ep-block"), function (b) {
      b.onclick = function () {
        var ep = (ESTUDOS.episodios || []).filter(function (e) { return e.id === b.dataset.id; })[0];
        if (ep) openReader(ep);
      };
    });
  }

  /* ---- reader: player sincronizado + notas inline ---- */
  function capNum(cap, fallback) { var m = /^\s*(\d+)/.exec(cap || ""); return m ? m[1] : String(fallback); }

  function openReader(ep) {
    $("estudoIntro").style.display = "none";
    $("estudoGrid").style.display = "none";
    var rd = $("estudoReader"); rd.style.display = ""; window.scrollTo(0, 0);

    var tops = ep.topicos || [];
    var temas = (ep.temas || []).map(function (t) { return '<span class="rd-tema">' + esc(t) + '</span>'; }).join("");
    var pdata = String(ep.data || "").split("-");
    var dm = pdata.length === 3 ? pdata[2] + "/" + pdata[1] + "/" + pdata[0] : (ep.data || "");
    var hora = fmtHora(ep.criado_em);

    // capitulos + navegacao
    var caps = [], seen = {};
    tops.forEach(function (tp) { var c = tp.cap || "Tópicos"; if (!seen[c]) { seen[c] = true; caps.push(c); } });
    var chapnav = caps.length > 1 ? '<div class="rd-chapnav">' + caps.map(function (c, i) {
      return '<button class="rd-chap-chip" data-cap="' + i + '">' + esc(c) + '</button>';
    }).join("") + '</div>' : "";

    // bullets por capitulo
    var html = "", curCap = null, capIdx = -1;
    tops.forEach(function (tp, idx) {
      var cap = tp.cap || "Tópicos";
      if (cap !== curCap) {
        if (curCap !== null) html += "</ul>";
        curCap = cap; capIdx++;
        html += '<div class="rd-cap" id="cap-' + capIdx + '"><span class="cap-n">' + esc(capNum(cap, capIdx + 1)) + '</span>' + esc(cap.replace(/^\s*\d+\.?\s*/, "")) + '</div><ul class="rd-bullets">';
      }
      var key = epNoteKey(ep.id, tp, idx);
      var noteVal = (state.notes && state.notes[key] && state.notes[key].text) || "";
      var hasNote = !!noteVal;
      var tag = tp.tag ? '<span class="bl-tag">' + esc(tp.tag) + '</span>' : "";
      html +=
        '<li class="bl" data-sec="' + (tp.sec || 0) + '" data-cap="' + capIdx + '" data-idx="' + idx + '" data-pkey="' + esc(key) + '">' +
          '<span class="bl-prog"></span>' +
          '<div class="bl-row">' +
            '<button class="bl-jump" title="Ouvir este trecho">' + esc(tp.t || mmss(tp.sec || 0)) + '</button>' +
            '<div class="bl-body"><p class="bl-txt">' + esc(tp.txt || "") + '</p>' + tag + '</div>' +
            '<button class="bl-note-btn' + (hasNote ? ' has' : '') + '" title="Anotar neste tópico">✎</button>' +
          '</div>' +
          '<div class="bl-track"><i class="bl-fill"></i></div>' +
          '<textarea class="bl-note' + (hasNote ? ' show' : '') + '" data-key="' + esc(key) + '" placeholder="Sua anotação neste tópico…">' + esc(noteVal) + '</textarea>' +
        '</li>';
    });
    if (curCap !== null) html += "</ul>";
    if (!html) html = '<div class="rd-noaudio">Sem tópicos.</div>';

    var epNoteVal = (state.notes && state.notes[ep.id] && state.notes[ep.id].text) || "";
    var player = ep.audio_url
      ? '<div class="rd-player">' +
          '<audio id="rd-audio" controls preload="none" src="' + esc(ep.audio_url) + '"></audio>' +
          '<div class="rd-progress"><div class="rd-bar" id="rd-bar"><i></i></div><span class="rd-time" id="rd-time">00:00 / 00:00</span></div>' +
          '<div class="rd-hint">◆ Toque numa linha pra ouvir; na linha atual, toca/pausa. Arraste a barra do tópico pra avançar ou voltar dentro dele. Anote no ✎.</div>' +
        '</div>'
      : '<div class="rd-player"><div class="rd-noaudio">Áudio não anexado neste estudo.</div></div>';

    rd.innerHTML =
      '<button class="rd-back" id="rd-back">← Voltar aos estudos</button>' +
      '<div class="rd-date">' + esc(dm) + (hora ? " · " + esc(hora) : "") + (ep.duracao ? " · " + esc(ep.duracao) : "") + '</div>' +
      '<h1 class="rd-title">' + esc(ep.titulo) + '</h1>' +
      (temas ? '<div class="rd-temas">' + temas + '</div>' : "") +
      player + chapnav +
      '<div id="rd-list">' + html + '</div>' +
      '<div class="rd-generalnote"><h3>📝 Notas gerais do estudo</h3>' +
        '<textarea class="ep-notes" id="rd-generalnote" placeholder="Anotações gerais deste estudo…">' + esc(epNoteVal) + '</textarea>' +
        '<div class="ep-notesaved" id="rd-generalsaved">salvo ✓</div></div>' +
      (ep.transcricao ? '<details class="rd-tr"><summary>Ver transcrição completa</summary><div class="rd-tr-body">' + esc(ep.transcricao) + '</div></details>' : "");

    wireReader(rd, ep, tops);
  }

  function wireReader(rd, ep, tops) {
    // rolagem livre enquanto escuta: marca quando VOCE rola pra o auto-scroll ceder
    var userScrollTs = 0;
    function markUserScroll() { userScrollTs = Date.now(); }
    window.addEventListener("wheel", markUserScroll, { passive: true });
    window.addEventListener("touchmove", markUserScroll, { passive: true });
    $("rd-back").onclick = function () {
      window.removeEventListener("wheel", markUserScroll);
      window.removeEventListener("touchmove", markUserScroll);
      renderEstudoGrid(); window.scrollTo(0, 0);
    };

    var bls = [].slice.call(rd.querySelectorAll(".bl"));
    var audio = rd.querySelector("#rd-audio");
    var bar = rd.querySelector("#rd-bar"), barFill = bar ? bar.querySelector("i") : null;
    var timeEl = rd.querySelector("#rd-time");
    var chips = [].slice.call(rd.querySelectorAll(".rd-chap-chip"));

    // botao de anotar (abre/fecha a nota; some quando vazia)
    bls.forEach(function (li) {
      var btn = li.querySelector(".bl-note-btn"), ta = li.querySelector(".bl-note");
      btn.onclick = function (e) {
        e.stopPropagation();
        var open = ta.classList.toggle("show");
        if (open) ta.focus();
        else if (!ta.value.trim()) btn.classList.remove("has");
      };
      var tmr = null;
      ta.addEventListener("input", function () {
        clearTimeout(tmr);
        btn.classList.toggle("has", !!ta.value.trim());
        tmr = setTimeout(function () {
          saveNote(ta.dataset.key, ta.value.trim());
          ta.classList.add("just-saved"); setTimeout(function () { ta.classList.remove("just-saved"); }, 1000);
        }, 700);
      });
    });

    // navegacao por capitulo
    chips.forEach(function (ch) {
      ch.onclick = function () {
        var cap = rd.querySelector("#cap-" + ch.dataset.cap);
        if (cap) cap.scrollIntoView({ behavior: "smooth", block: "start" });
      };
    });

    // notas gerais
    var gnote = rd.querySelector("#rd-generalnote"), gsaved = rd.querySelector("#rd-generalsaved"), gt = null;
    gnote.addEventListener("input", function () {
      clearTimeout(gt);
      gt = setTimeout(function () {
        saveNote(ep.id, gnote.value.trim());
        if (gsaved) { gsaved.classList.add("on"); setTimeout(function () { gsaved.classList.remove("on"); }, 1500); }
      }, 700);
    });

    if (!audio) return;

    // clique na barra global = seek
    if (bar) bar.onclick = function (e) {
      if (!audio.duration) return;
      var r = bar.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
    };

    // ---- cada topico = um mini-player independente do MESMO audio ----
    // A barra de cada topico mostra a posicao DENTRO daquele trecho (0..1), nao acumula nem enche
    // os outros. Clicar na linha do topico atual pausa/toca; em outro, pula pra ele. Arrastar a barra
    // busca dentro daquele trecho. A reproducao segue contigua de um topico pro outro, sem cortes.
    var segs = bls.map(function (li, i) {
      return { li: li, i: i, fill: li.querySelector(".bl-fill"), track: li.querySelector(".bl-track"),
               start: parseFloat(li.dataset.sec) || 0 };
    });
    function segEnd(i) {
      var dur = audio.duration || 0;
      return (i < segs.length - 1) ? segs[i + 1].start : (dur || segs[i].start + 600);
    }
    function activeIndex(t) {
      var idx = -1;
      for (var i = 0; i < segs.length; i++) { if (segs[i].start <= t + 0.05) idx = i; else break; }
      return idx;
    }
    function playSeg(i) { try { audio.currentTime = segs[i].start + 0.01; audio.play(); } catch (e) {} }
    function toggle() { try { if (audio.paused) audio.play(); else audio.pause(); } catch (e) {} }

    segs.forEach(function (s) {
      // arrastar / clicar a barra do topico -> busca DENTRO daquele trecho (e passa a ser o atual)
      var dragging = false;
      function seekAt(clientX) {
        if (!s.track) return;
        var r = s.track.getBoundingClientRect();
        var frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
        try { audio.currentTime = s.start + frac * (segEnd(s.i) - s.start); if (audio.paused) audio.play(); } catch (e) {}
      }
      if (s.track) {
        s.track.addEventListener("pointerdown", function (e) {
          e.stopPropagation(); dragging = true; try { s.track.setPointerCapture(e.pointerId); } catch (x) {} seekAt(e.clientX);
        });
        s.track.addEventListener("pointermove", function (e) { if (dragging) { e.preventDefault(); seekAt(e.clientX); } });
        var stop = function (e) { dragging = false; try { s.track.releasePointerCapture(e.pointerId); } catch (x) {} };
        s.track.addEventListener("pointerup", stop);
        s.track.addEventListener("pointercancel", stop);
      }
      // clique na linha: topico atual -> pausa/toca; outro -> vai pra ele (contiguo)
      s.li.querySelector(".bl-row").addEventListener("click", function (e) {
        if (e.target.closest(".bl-note-btn") || e.target.closest(".bl-jump") || e.target.closest(".bl-track")) return;
        if (s.li.classList.contains("on")) toggle(); else playSeg(s.i);
      });
      // o tempo (chip) (re)inicia aquele topico
      s.li.querySelector(".bl-jump").addEventListener("click", function (e) { e.stopPropagation(); playSeg(s.i); });
    });

    // ---- resume: continua de onde parou (posicao global salva por episodio) ----
    var savedPos = (state.progress && typeof state.progress[ep.id] === "number") ? state.progress[ep.id] : 0;
    if (savedPos > 3) {
      var applyResume = function () { try { if (savedPos < (audio.duration || 1e9) - 2) audio.currentTime = savedPos; } catch (e) {} };
      if (audio.readyState >= 1) applyResume(); else audio.addEventListener("loadedmetadata", applyResume, { once: true });
    }
    var posTmr = null;
    function savePos() {
      if (!state.progress) state.progress = {};
      state.progress[ep.id] = Math.floor(audio.currentTime || 0);
      apiPost("progress", { key: ep.id, pos: state.progress[ep.id] }).catch(function () {});
    }

    // ---- sincronizacao: so o topico ATUAL mostra a barra viva; os outros ficam vazios ----
    var lastActiveIdx = -1;
    function refresh() {
      var t = audio.currentTime || 0, dur = audio.duration || 0;
      if (barFill && dur) barFill.style.width = (t / dur * 100) + "%";
      if (timeEl) timeEl.textContent = mmss(t) + " / " + mmss(dur || 0);
      var idx = activeIndex(t);
      segs.forEach(function (s) {
        var on = s.i === idx;
        s.li.classList.toggle("on", on);
        if (s.fill) {
          if (on) {
            var f = Math.max(0, Math.min(1, (t - s.start) / Math.max(1, segEnd(s.i) - s.start)));
            s.fill.style.width = (f * 100) + "%";
          } else {
            s.fill.style.width = "0%";
          }
        }
      });
      if (idx >= 0 && chips.length) {
        var capOf = bls[idx].dataset.cap;
        chips.forEach(function (ch) { ch.classList.toggle("on", ch.dataset.cap === capOf); });
      }
      // rolagem livre: acompanha o topico so quando ELE muda, esta fora da tela e voce nao rolou nos ultimos 6s
      if (idx !== lastActiveIdx) {
        lastActiveIdx = idx;
        if (idx >= 0 && !audio.paused && (Date.now() - userScrollTs > 6000)) {
          var rct = bls[idx].getBoundingClientRect();
          if (rct.top < 100 || rct.bottom > (window.innerHeight - 40)) bls[idx].scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
    audio.addEventListener("timeupdate", function () { refresh(); clearTimeout(posTmr); posTmr = setTimeout(savePos, 4000); });
    audio.addEventListener("loadedmetadata", refresh);
    audio.addEventListener("play", refresh);
    audio.addEventListener("pause", function () { refresh(); savePos(); });
    audio.addEventListener("ended", savePos);
  }

  /* ---------- modo ---------- */
  function setMode(m) {
    appMode = m;
    $("radarView").style.display = (m === "radar") ? "" : "none";
    $("estudoView").style.display = (m === "estudo") ? "" : "none";
    $("actionbar").style.display = (m === "radar") ? "" : "none";
    var stog = $("side-toggle"); if (stog) stog.style.display = (m === "radar") ? "" : "none";
    [].forEach.call(document.querySelectorAll(".mode-btn"), function (b) { b.classList.toggle("on", b.dataset.mode === m); });
    if (m === "estudo") renderEstudoGrid();
    window.scrollTo(0, 0);
  }

  /* ---------- gerar texto / links / audio prompt ---------- */
  function gerarTexto() {
    var sel = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; });
    var hoje = new Date().toLocaleDateString("pt-BR");
    var L = [];
    L.push("# Meus assuntos para me atualizar — " + hoje); L.push("");
    L.push("Abaixo, os assuntos que selecionei, organizados em capitulos por tema. Faca um resumo didatico e aprofundado de cada capitulo, com os pontos-chave, o que eu preciso saber e como aplicar na pratica."); L.push("");
    var cap = 0;
    (CFG.categorias || []).forEach(function (c) {
      var arr = sel.filter(function (it) { return it.cat === c.id; });
      if (!arr.length) return;
      cap++;
      L.push("## Capitulo " + cap + " — " + c.emoji + " " + c.nome);
      if (c.desc) L.push("_" + c.desc + "_");
      L.push("");
      arr.forEach(function (it) {
        L.push("### " + it.titulo);
        if (it.resumo) L.push(it.resumo);
        if (it.porque) L.push("Por que importa: " + it.porque);
        var m = [];
        if (it.fonte) m.push("Fonte: " + it.fonte);
        if (it.data) m.push("Data: " + it.data);
        if (it.url) m.push("Link: " + it.url);
        if (m.length) L.push(m.join(" · "));
        L.push("");
      });
    });
    return { txt: L.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", cap: cap, n: sel.length };
  }
  function materiaURL(id) { return new URL("materias/" + id + ".html", location.href).href; }
  function gerarLinks() {
    var sel = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; });
    return { txt: sel.map(function (it) { return materiaURL(it.id); }).join("\n"), n: sel.length };
  }
  function gerarAudioPrompt() {
    var sel = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; });
    var cats = (CFG.categorias || []).filter(function (c) { return sel.some(function (it) { return it.cat === c.id; }); });
    var temas = cats.map(function (c) { return c.emoji + " " + c.nome; }).join(", ");
    var L = [];
    L.push("Este episódio é um resumo de aprendizado para mim, Bruno, dono de uma agência de marketing digital (a MediaGrowth).");
    L.push("");
    L.push("Falem em português do Brasil, com tom prático, direto e envolvente, como dois especialistas conversando de igual para igual comigo. Sem introdução longa e sem definições óbvias.");
    L.push("");
    L.push("Concentrem-se em: (1) o que há de novo e realmente importante em cada tema; (2) os pontos-chave que eu preciso saber; (3) principalmente COMO aplicar na prática, na agência e na minha vida. Tragam números, exemplos e o porquê de cada coisa importar, e fechem cada tema com um próximo passo concreto.");
    L.push("");
    L.push("Conectem os assuntos entre si quando fizer sentido e priorizem insight acionável no lugar de teoria. Podem ser críticos e dar opinião, não só descrever.");
    L.push("");
    L.push("Os " + sel.length + " assuntos deste episódio, por tema: " + temas + ".");
    return { txt: L.join("\n"), n: sel.length };
  }

  /* ---------- modal ---------- */
  var modalMode = "links";
  function fillModal() {
    var title, hint, txt, saved;
    if (modalMode === "links") {
      var g = gerarLinks();
      title = "Links pro NotebookLM";
      hint = "Cada link abre a NOSSA matéria do assunto (o resumo curado, não a fonte crua). Cole no NotebookLM como fontes: o podcast sai da nossa versão. Um link por linha.";
      txt = g.txt; saved = g.n + (g.n === 1 ? " link" : " links");
    } else if (modalMode === "audio") {
      var a = gerarAudioPrompt();
      title = "Personalizar o Resumo em Áudio";
      hint = "Cole no campo 'Personalizar' do Resumo em Áudio do NotebookLM (define no que os apresentadores focam neste episódio).";
      txt = a.txt; saved = a.n + " assuntos";
    } else {
      var t = gerarTexto();
      title = "Texto em capítulos";
      hint = "Os assuntos que você marcou, em capítulos. Copie e cole no Gemini/NotebookLM pedindo o resumo.";
      txt = t.txt; saved = t.cap + " capítulos · " + t.n + " itens";
    }
    $("modal-title").textContent = title;
    $("modal-hint").textContent = hint;
    $("modal-txt").value = txt;
    $("modal-saved").textContent = saved;
    [].forEach.call(document.querySelectorAll(".mtab"), function (x) { x.classList.toggle("on", x.dataset.m === modalMode); });
  }
  function openModal(mode) {
    var n = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; }).length;
    if (!n) { toast("Marque assuntos primeiro ✓"); return; }
    modalMode = mode || "links"; fillModal(); $("modal").classList.add("on");
  }
  function closeModal() { $("modal").classList.remove("on"); }
  function copiar() {
    var ta = $("modal-txt"); ta.select(); ta.setSelectionRange(0, 999999);
    var msg = modalMode === "links" ? "copiado ✓ · cole os links no NotebookLM"
            : modalMode === "audio" ? "copiado ✓ · cole em Personalizar o Resumo em Áudio"
            : "copiado ✓ · cole no Gemini/NotebookLM";
    var done = function () { $("modal-saved").textContent = msg; toast("Copiado ✓"); };
    if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(done, function () { document.execCommand("copy"); done(); });
    else { document.execCommand("copy"); done(); }
  }
  function arquivarSelecionados() {
    var ids = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; }).map(function (it) { return it.id; });
    if (!ids.length) return;
    ids.forEach(function (id) { state.decisions[id] = { status: "read" }; });
    apiPost("bulk", { ids: ids.join(","), status: "read" }).then(function (r) { if (r.status === 401) return showGate(); toast("Arquivados 📁"); }).catch(function () { toast("Salvo local, checar conexão"); });
    closeModal(); render();
  }

  /* ---------- sidebar mobile ---------- */
  function openSide() { $("side").classList.add("on"); $("side-backdrop").classList.add("on"); }
  function closeSide() { $("side").classList.remove("on"); $("side-backdrop").classList.remove("on"); }

  /* ---------- eventos ---------- */
  function wire() {
    if (booted) return; booted = true;
    $("chips").addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      if (b.dataset.f) { view = b.dataset.f; [].forEach.call(document.querySelectorAll(".chip[data-f]"), function (x) { x.classList.toggle("on", x === b); }); }
      else if (b.dataset.g) { group = b.dataset.g; [].forEach.call(document.querySelectorAll(".chip[data-g]"), function (x) { x.classList.toggle("on", x === b); }); }
      render();
    });
    $("busca").addEventListener("input", function (e) { q = e.target.value.trim().toLowerCase(); render(); });
    [].forEach.call(document.querySelectorAll(".mode-btn"), function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });
    $("btn-links").onclick = function () { openModal("links"); };
    $("btn-gerar").onclick = function () { openModal("texto"); };
    $("btn-logout").onclick = function () { apiPost("logout", {}).catch(function () {}).then(function () { location.reload(); }); };
    $("modal-close").onclick = closeModal;
    $("btn-copiar").onclick = copiar;
    $("btn-arquivar").onclick = arquivarSelecionados;
    [].forEach.call(document.querySelectorAll(".mtab"), function (t) { t.onclick = function () { modalMode = t.dataset.m; fillModal(); }; });
    $("modal").addEventListener("click", function (e) { if (e.target.id === "modal") closeModal(); });
    $("side-toggle").onclick = openSide;
    $("side-close").onclick = closeSide;
    $("side-backdrop").onclick = closeSide;
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeModal(); closeSide(); } });
  }

  /* ---------- boot ---------- */
  function boot() {
    showApp();
    Promise.all([apiGet("data").then(okJson), apiGet("get").then(okJson)])
      .then(function (res) {
        var data = res[0] || {}, st = res[1] || {};
        CFG = data.categorias || { grupos: [], categorias: [] };
        DADOS = data.radar || { itens: [], gerado_em: "" };
        if (!DADOS.itens) DADOS.itens = [];
        ESTUDOS = data.estudos || { episodios: [] };
        state = { decisions: norm(st.decisions), notes: norm(st.notes), progress: norm(st.progress) };
        catMap = {}; grpMap = {};
        (CFG.categorias || []).forEach(function (c) { catMap[c.id] = c; });
        (CFG.grupos || []).forEach(function (g) { grpMap[g.id] = g; });
        if (CFG.subtitulo) $("subtitle").textContent = CFG.subtitulo;
        wire();
        render();
        var m = params.get("m") || params.get("modo");
        setMode(m === "estudo" ? "estudo" : "radar");
      })
      .catch(function (e) {
        if (e && e.auth === false) return;
        $("feed").innerHTML = '<div class="empty"><b>Erro ao carregar.</b>' + esc(String(e && e.message || e)) + '</div>';
        showApp();
      });
  }

  /* ---------- start ---------- */
  wireGate();
  apiGet("me").then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { if (res.ok && res.j && res.j.auth) boot(); else showGate(); })
    .catch(function () { showGate(); });
})();
