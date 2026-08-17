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
  var appMode = "radar", view = "novos", group = "all", q = "", catFilter = null;
  var catMap = {}, grpMap = {}, epMap = {}, booted = false;
  var anotaState = { q: "", filter: "todos", tema: null, estudo: "all" };

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
  var LS_DEC = "sa_decisions_bruno";  // backup local da selecao (rede de seguranca contra reload/queda)
  function persistLocal() { try { localStorage.setItem(LS_DEC, JSON.stringify(state.decisions)); } catch (e) {} }
  function statusOf(id) { return (state.decisions[id] && state.decisions[id].status) || "pending"; }
  function setStatus(id, status) {
    if (status === "pending") delete state.decisions[id];
    else state.decisions[id] = { status: status };
    persistLocal();  // salva local ANTES da rede: se o servidor falhar, a selecao nao se perde
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
    return DADOS.itens.filter(function (it) {
      if (!catMap[it.cat]) return false;
      // filtro por categoria (clique na barra lateral) ignora o grupo: mostra so aquela categoria
      if (catFilter) return it.cat === catFilter && passView(it.id) && passQ(it);
      return passGroup(it.cat) && passView(it.id) && passQ(it);
    });
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
        var row = document.createElement("div"); row.className = "side-cat" + (catFilter === c.id ? " on" : "");
        row.innerHTML = '<span class="em">' + c.emoji + '</span><span class="nm">' + esc(c.nome) + '</span>'
          + '<span class="badge' + (n ? "" : " zero") + '">' + n + '</span>';
        row.onclick = function () {
          // clica -> filtra o feed so nessa categoria; clica de novo -> volta pra todas
          catFilter = (catFilter === c.id) ? null : c.id;
          closeSide();
          render();
          var fc = document.querySelector(".feedcol"); if (fc) fc.scrollIntoView({ behavior: "smooth", block: "start" });
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
  // grava a nota (texto + star + tag) no backend a partir do estado em memoria; texto vazio remove.
  function persistNote(key) {
    var n = state.notes[key];
    var text = (n && n.text != null) ? String(n.text).trim() : "";
    apiPost("note", { key: key, text: text, star: (n && n.star) ? "1" : "0", tag: (n && n.tag) || "" })
      .then(function (r) { if (r.status === 401) showGate(); })
      .catch(function () { toast("Sem conexão pra salvar a nota"); });
  }
  // usada pelo reader (texto por topico/ep) — preserva star/tag ja existentes na nota
  function saveNote(key, text) {
    if (!state.notes) state.notes = {};
    text = (text == null ? "" : String(text)).trim();
    if (text) { state.notes[key] = state.notes[key] || {}; state.notes[key].text = text; }
    else { delete state.notes[key]; }
    persistNote(key);
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
      ? '<div class="rd-player" id="rd-player">' +
          '<div class="rd-now" id="rd-now"><span class="rd-now-kicker">Tocando</span><span class="rd-now-dot" id="rd-now-dot"></span><span class="rd-now-tag" id="rd-now-tag"></span><span class="rd-now-label" id="rd-now-label">Toque numa linha pra começar</span></div>' +
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
      var tagEl = li.querySelector(".bl-tag"), txtEl = li.querySelector(".bl-txt");
      return { li: li, i: i, fill: li.querySelector(".bl-fill"), track: li.querySelector(".bl-track"),
               start: parseFloat(li.dataset.sec) || 0,
               tag: tagEl ? tagEl.textContent : "", txt: txtEl ? txtEl.textContent : "" };
    });
    // "Tocando: [tema]" no player, acompanha o topico atual (ponto muda de cor por tema)
    var nowLabel = rd.querySelector("#rd-now-label"), nowTag = rd.querySelector("#rd-now-tag"), nowDot = rd.querySelector("#rd-now-dot"), playerEl = rd.querySelector("#rd-player");
    function hueOf(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
    function updateNow(idx) {
      if (!nowLabel) return;
      if (idx < 0) {
        nowLabel.textContent = "Toque numa linha pra começar"; if (nowTag) nowTag.textContent = "";
        if (nowDot) { nowDot.style.background = "var(--mut-2)"; nowDot.style.boxShadow = "none"; }
        if (playerEl) playerEl.style.removeProperty("--now"); return;
      }
      var s = segs[idx];
      if (nowTag) nowTag.textContent = s.tag || "";      // o tema
      nowLabel.textContent = s.txt || s.tag || "Tocando"; // o ASSUNTO (texto do topico)
      var hue = hueOf(s.tag || s.txt || "");
      if (nowDot) { nowDot.style.background = "hsl(" + hue + ",60%,62%)"; nowDot.style.boxShadow = "0 0 9px hsla(" + hue + ",60%,62%,.65)"; }
      if (playerEl) playerEl.style.setProperty("--now", "hsl(" + hue + ",55%,58%)");
    }
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
        updateNow(idx);
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

  /* ==================== ANOTAÇÕES & INSIGHTS ==================== */
  // Agrega TODAS as notas (por topico + gerais do estudo + avulsas) num lugar so.
  // A chave da nota decodifica o contexto: "<epId>:<sec>" = topico | "<epId>" = geral | "ins:<ts>" = avulsa.
  function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s; }
  function relTime(iso) {
    if (!iso) return "";
    var d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
    if (isNaN(diff)) return "";
    if (diff < 60) return "agora";
    if (diff < 3600) return "há " + Math.floor(diff / 60) + " min";
    if (diff < 86400) return "há " + Math.floor(diff / 3600) + "h";
    if (diff < 604800) return "há " + Math.floor(diff / 86400) + "d";
    return d.toLocaleDateString("pt-BR");
  }
  function parseNoteKey(key) {
    if (key.indexOf("ins:") === 0) return { kind: "insight", epId: null, sec: null };
    var i = key.lastIndexOf(":");
    if (i === -1) return { kind: "general", epId: key, sec: null };
    return { kind: "topic", epId: key.slice(0, i), sec: key.slice(i + 1) };
  }
  function noteContext(key) {
    var p = parseNoteKey(key), n = state.notes[key] || {};
    if (p.kind === "insight")
      return { kind: "insight", studyTitle: "Anotação avulsa", studyId: null, data: "", tema: (n.tag || ""), contextTxt: "", chapter: "", t: "", exists: true };
    var ep = epMap[p.epId];
    if (!ep)
      return { kind: p.kind, studyTitle: "Estudo removido", studyId: p.epId, data: "", tema: "", contextTxt: "", chapter: "", t: "", exists: false };
    if (p.kind === "general")
      return { kind: "general", studyTitle: ep.titulo, studyId: ep.id, data: ep.data, tema: "📝 Notas gerais", contextTxt: "", chapter: "", t: "", exists: true, ep: ep };
    var tp = null;
    (ep.topicos || []).forEach(function (x, idx) {
      if (tp) return;
      if (String(x.sec) === String(p.sec)) tp = x;
      else if (p.sec === ("i" + idx)) tp = x;
    });
    return { kind: "topic", studyTitle: ep.titulo, studyId: ep.id, data: ep.data,
             tema: (tp && tp.tag) || "", contextTxt: (tp && tp.txt) || "", chapter: (tp && tp.cap) || "", t: (tp && tp.t) || "", exists: true, ep: ep };
  }
  function notesList() {
    var arr = [];
    Object.keys(state.notes || {}).forEach(function (key) {
      var n = state.notes[key];
      if (!n) return;
      var hasText = n.text && String(n.text).trim();
      if (!hasText && !n._new) return;                 // ignora vazias (menos a recem-criada)
      arr.push({ key: key, note: n, ctx: noteContext(key) });
    });
    arr.sort(function (a, b) {
      var ta = a.note.up || a.note.at || "", tb = b.note.up || b.note.at || "";
      return String(tb).localeCompare(String(ta));      // mais recente primeiro
    });
    return arr;
  }
  // sem nenhum filtro ativo? (Tudo, sem tema, sem estudo, sem busca)
  function anotaUnfiltered() {
    return anotaState.filter === "todos" && !anotaState.tema && anotaState.estudo === "all" && !anotaState.q;
  }
  function anotaPass(r) {
    var f = anotaState.filter;
    if (f === "insight" && !r.note.star) return false;
    if (f === "avulsa" && r.ctx.kind !== "insight") return false;
    if (anotaState.tema && (r.ctx.tema || "") !== anotaState.tema) return false;
    if (anotaState.estudo !== "all" && (r.ctx.studyId || "__ins") !== anotaState.estudo) return false;
    if (anotaState.q) {
      var h = ((r.note.text || "") + " " + (r.ctx.contextTxt || "") + " " + (r.ctx.studyTitle || "") + " " + (r.ctx.tema || "")).toLowerCase();
      if (h.indexOf(anotaState.q) === -1) return false;
    }
    return true;
  }
  function renderAnotaChips() {
    var box = $("anotaChips");
    [].slice.call(box.querySelectorAll(".chip[data-tema]")).forEach(function (c) { c.remove(); });
    var seen = {}, order = [];
    notesList().forEach(function (r) { var t = r.ctx.tema; if (t && !seen[t]) { seen[t] = 1; order.push(t); } });
    order.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "chip tema" + (anotaState.tema === t ? " on" : "");
      b.setAttribute("data-tema", t); b.textContent = t;
      box.appendChild(b);
    });
    [].forEach.call(box.querySelectorAll(".chip[data-af]"), function (c) { c.classList.toggle("on", c.dataset.af === anotaState.filter); });
  }
  function renderAnotaEstudoSelect() {
    var sel = $("anotaEstudo");
    var eps = (ESTUDOS.episodios || []).slice().sort(function (a, b) { return (b.data || "").localeCompare(a.data || ""); });
    var opts = ['<option value="all">Todos os estudos</option>'];
    eps.forEach(function (e) { opts.push('<option value="' + esc(e.id) + '">' + esc(trunc(e.titulo, 42)) + '</option>'); });
    sel.innerHTML = opts.join("");
    sel.value = anotaState.estudo;
    if (sel.value !== anotaState.estudo) { anotaState.estudo = "all"; sel.value = "all"; }  // estudo sumiu
  }
  function anotaCard(r) {
    var ctx = r.ctx, n = r.note, isIns = ctx.kind === "insight";
    var d = document.createElement("div");
    d.className = "anota-card" + (n.star ? " star" : "") + (ctx.exists ? "" : " orphan");
    d.dataset.key = r.key;
    var dm = "";
    if (ctx.data) { var pd = String(ctx.data).split("-"); dm = pd.length === 3 ? pd[2] + "/" + pd[1] : ctx.data; }

    var temaHtml = isIns
      ? '<input class="ac-temainput" placeholder="tema (opcional)" value="' + esc(n.tag || "") + '">'
      : (ctx.tema ? '<span class="ac-tema">' + esc(ctx.tema) + '</span>' : '');
    var studyHtml = isIns
      ? '<span class="ac-study avulsa">✎ Avulsa</span>'
      : '<span class="ac-study">' + esc(ctx.studyTitle) + (dm ? ' · ' + esc(dm) : '') + '</span>';

    var goBtn = (!isIns && ctx.exists) ? '<button class="ac-go" title="Abrir no estudo">ir ao estudo ↗</button>' : '';
    var ctxHtml = '';
    if (!isIns) {
      if (ctx.contextTxt)
        ctxHtml = '<div class="ac-ctx"><span class="ac-tt">' + esc(ctx.t || "") + '</span>' +
                    '<span class="ac-ctxtxt">' + esc(ctx.contextTxt) + '</span>' + goBtn + '</div>';
      else if (!ctx.exists)
        ctxHtml = '<div class="ac-ctx orphan-note">Este estudo foi removido, mas sua anotação foi mantida aqui.</div>';
      else if (goBtn)
        ctxHtml = '<div class="ac-ctx"><span class="ac-ctxtxt muted">Notas gerais do estudo</span>' + goBtn + '</div>';
    }

    var whenTxt = (n.star ? "⭐ insight · " : "") + (n.up || n.at ? "editado " + relTime(n.up || n.at) : "");
    d.innerHTML =
      '<div class="ac-top">' + temaHtml + studyHtml +
        '<button class="ac-star" title="' + (n.star ? "Tirar de Insights" : "Marcar como Insight") + '">' + (n.star ? "★" : "☆") + '</button>' +
      '</div>' + ctxHtml +
      '<textarea class="ac-note" placeholder="Sua anotação…">' + esc(n.text || "") + '</textarea>' +
      '<div class="ac-foot"><span class="ac-when">' + esc(whenTxt) + '</span>' +
        '<button class="ac-del" title="Excluir anotação">🗑</button></div>';
    wireAnotaCard(d, r);
    return d;
  }
  function wireAnotaCard(d, r) {
    var key = r.key;
    var ta = d.querySelector(".ac-note"), star = d.querySelector(".ac-star"),
        del = d.querySelector(".ac-del"), go = d.querySelector(".ac-go"),
        temaInput = d.querySelector(".ac-temainput"), when = d.querySelector(".ac-when");
    var tmr = null;
    ta.addEventListener("input", function () {
      clearTimeout(tmr);
      tmr = setTimeout(function () {
        var v = ta.value.trim();
        if (!v) { delete state.notes[key]; persistNote(key); d.classList.add("removing"); setTimeout(renderAnotacoes, 200); return; }
        state.notes[key] = state.notes[key] || {};
        state.notes[key].text = v; state.notes[key].up = new Date().toISOString();
        delete state.notes[key]._new;
        persistNote(key);
        d.classList.add("saved"); setTimeout(function () { d.classList.remove("saved"); }, 900);
        if (when) when.textContent = (state.notes[key].star ? "⭐ insight · " : "") + "editado agora";
      }, 650);
    });
    star.onclick = function () {
      state.notes[key] = state.notes[key] || {};
      state.notes[key].star = !state.notes[key].star;
      persistNote(key);
      var on = !!state.notes[key].star;
      d.classList.toggle("star", on);
      star.textContent = on ? "★" : "☆";
      star.title = on ? "Tirar de Insights" : "Marcar como Insight";
      if (when) when.textContent = (on ? "⭐ insight · " : "") + "editado " + relTime(state.notes[key].up || state.notes[key].at);
      if (anotaState.filter === "insight" && !on) { d.classList.add("removing"); setTimeout(renderAnotacoes, 200); }
    };
    del.onclick = function () { delete state.notes[key]; persistNote(key); d.classList.add("removing"); setTimeout(renderAnotacoes, 200); };
    if (go) go.onclick = function () { goToStudyNote(key); };
    if (temaInput) {
      var t2 = null;
      temaInput.addEventListener("input", function () {
        clearTimeout(t2);
        t2 = setTimeout(function () {
          state.notes[key] = state.notes[key] || {};
          state.notes[key].tag = temaInput.value.trim();
          if (state.notes[key].text && String(state.notes[key].text).trim()) persistNote(key);
          renderAnotaChips();
        }, 650);
      });
    }
  }
  function goToStudyNote(key) {
    var ctx = noteContext(key);
    if (!ctx.exists || !ctx.ep) { toast("Estudo não encontrado"); return; }
    setMode("estudo");
    openReader(ctx.ep);
    setTimeout(function () {
      if (ctx.kind === "general") {
        var g = document.querySelector("#rd-generalnote");
        if (g) { g.scrollIntoView({ behavior: "smooth", block: "center" }); try { g.focus(); } catch (e) {} }
        return;
      }
      var li = document.querySelector('#estudoReader .bl[data-pkey="' + key + '"]');
      if (li) {
        var t = li.querySelector(".bl-note"), b = li.querySelector(".bl-note-btn");
        if (t) t.classList.add("show"); if (b) b.classList.add("has");
        li.scrollIntoView({ behavior: "smooth", block: "center" });
        li.classList.add("bl-flash"); setTimeout(function () { li.classList.remove("bl-flash"); }, 1600);
      }
    }, 140);
  }
  function novaAnotacao() {
    var key = "ins:" + Date.now();
    var iso = new Date().toISOString();
    state.notes[key] = { text: "", star: false, tag: "", at: iso, up: iso, _new: true };
    anotaState.filter = "todos"; anotaState.tema = null; anotaState.estudo = "all";
    $("anotaBusca").value = ""; anotaState.q = "";
    renderAnotacoes();
    setTimeout(function () {
      var card = document.querySelector('.anota-card[data-key="' + key + '"]');
      if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); var ta = card.querySelector(".ac-note"); if (ta) ta.focus(); }
    }, 60);
  }
  function renderAnotacoes() {
    renderAnotaEstudoSelect();
    renderAnotaChips();
    var feed = $("anotaFeed"); feed.innerHTML = "";
    var all = notesList(), rows = all.filter(anotaPass);
    // sem filtro: fixa os insights ⭐ no topo (sort estavel mantem a recencia dentro de cada grupo)
    if (anotaUnfiltered()) rows.sort(function (a, b) { return (b.note.star ? 1 : 0) - (a.note.star ? 1 : 0); });
    var real = all.filter(function (r) { return !(r.note._new && !(r.note.text && String(r.note.text).trim())); }).length;
    var stars = all.filter(function (r) { return r.note.star; }).length;
    $("anotaSub").textContent = real
      ? (real + (real === 1 ? " anotação" : " anotações") + (stars ? " · " + stars + " insight" + (stars === 1 ? "" : "s") + " ⭐" : "") + " · edite, marque os insights e filtre por tema.")
      : "Ainda não há anotações. Anote nos estudos do podcast que elas aparecem aqui, ou crie uma avulsa.";
    if (!rows.length) {
      feed.innerHTML = '<div class="empty"><b>Nada neste filtro.</b>' +
        (real ? "Troque o filtro, o tema ou a busca acima." : "Suas anotações dos estudos aparecem aqui automaticamente.") + '</div>';
      return;
    }
    rows.forEach(function (r) { feed.appendChild(anotaCard(r)); });
  }

  /* ---------- modo ---------- */
  function setMode(m) {
    appMode = m;
    $("radarView").style.display = (m === "radar") ? "" : "none";
    $("estudoView").style.display = (m === "estudo") ? "" : "none";
    $("anotacoesView").style.display = (m === "anotacoes") ? "" : "none";
    $("actionbar").style.display = (m === "radar") ? "" : "none";
    var stog = $("side-toggle"); if (stog) stog.style.display = (m === "radar") ? "" : "none";
    [].forEach.call(document.querySelectorAll(".mode-btn"), function (b) { b.classList.toggle("on", b.dataset.mode === m); });
    if (m === "estudo") renderEstudoGrid();
    if (m === "anotacoes") renderAnotacoes();
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
  var LINKS_POR_PARTE = 20; // NotebookLM trava quando cola muitos links de uma vez -> divide em partes
  function gerarLinks() {
    // UM link por assunto marcado (cada pagina de materia vira uma fonte "Web" no NotebookLM).
    // Como colar dezenas de uma vez estoura o limite do campo, os links saem em PARTES de 20:
    // copia a Parte 1, adiciona no NotebookLM, depois a Parte 2, e assim por diante.
    var sel = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; });
    var urls = sel.map(function (it) { return materiaURL(it.id); });
    var partes = [];
    for (var i = 0; i < urls.length; i += LINKS_POR_PARTE) partes.push(urls.slice(i, i + LINKS_POR_PARTE));
    return { partes: partes, n: urls.length };
  }
  var AUDIO_LIMITE = 500; // limite de caracteres do campo "Personalizar" do NotebookLM
  function gerarAudioPrompt() {
    var sel = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; });
    // Compacto de proposito: o campo "Personalizar" do NotebookLM tem ~500 caracteres.
    // Por isso vai so a intro curta (quem sou eu + foco) + os TITULOS dos assuntos (o roteiro),
    // sem resumo nem link — o conteudo em si o NotebookLM ja tem pelas fontes que voce colou.
    var intro = "Sou o Bruno, dono da MediaGrowth (agência de marketing digital). Uso isto pra me atualizar e aprender o que me faça vender, lucrar e ganhar mais no meu negócio e com meus clientes. Foquem no que é novo e em COMO aplicar. Cubram TODOS estes assuntos: ";
    var titulos = sel.map(function (it) { return (it.titulo || "").replace(/\s+/g, " ").trim(); }).filter(Boolean);
    var txt = intro + titulos.join(" · ") + ".";
    return { txt: txt, n: sel.length, chars: txt.length, limite: AUDIO_LIMITE };
  }

  /* ---------- modal ---------- */
  var modalMode = "links";
  var linkPartes = [];   // [[url,...], [url,...]] — partes de 20 links
  var linkParte = 0;     // parte visivel no momento
  function renderPartes() {
    var el = $("modal-partes"); if (!el) return;
    if (modalMode !== "links" || linkPartes.length <= 1) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "flex";
    el.innerHTML = linkPartes.map(function (p, i) {
      return '<button class="ppart' + (i === linkParte ? " on" : "") + '" data-p="' + i + '">Parte ' + (i + 1) + '</button>';
    }).join("");
  }
  function fillModal() {
    var title, hint, txt, saved;
    if (modalMode === "links") {
      var g = gerarLinks();
      linkPartes = g.partes;
      if (linkParte >= linkPartes.length) linkParte = 0;
      var atual = linkPartes[linkParte] || [];
      title = "Links pro NotebookLM";
      hint = "Um link por assunto (cada um vira uma fonte 'Web' no NotebookLM). Como colar muitos de uma vez trava, os links vêm em partes de " + LINKS_POR_PARTE + ": copie a Parte 1, adicione no NotebookLM, depois a Parte 2, e assim por diante.";
      txt = atual.join("\n");
      saved = linkPartes.length > 1
        ? "Parte " + (linkParte + 1) + " de " + linkPartes.length + " · " + atual.length + " links (total " + g.n + ")"
        : g.n + (g.n === 1 ? " link" : " links");
      renderPartes();
    } else if (modalMode === "audio") {
      var a = gerarAudioPrompt();
      title = "Personalizar o Resumo em Áudio";
      hint = "Cole no campo 'Personalizar' do Resumo em Áudio do NotebookLM. Vem curto: quem você é, o foco e a lista de todos os assuntos a cobrir (o conteúdo em si o NotebookLM pega das fontes que você colou).";
      txt = a.txt;
      var excedeu = a.chars > a.limite;
      saved = a.n + " assuntos · " + a.chars + "/" + a.limite + " caracteres"
            + (excedeu ? " ⚠️ acima do limite do NotebookLM — marque menos assuntos pra este áudio" : " ✓ dentro do limite");
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
    $("modal-saved").classList.toggle("over", modalMode === "audio" && typeof excedeu !== "undefined" && excedeu);
    renderPartes();
    [].forEach.call(document.querySelectorAll(".mtab"), function (x) { x.classList.toggle("on", x.dataset.m === modalMode); });
  }
  function openModal(mode) {
    var n = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; }).length;
    if (!n) { toast("Marque assuntos primeiro ✓"); return; }
    modalMode = mode || "links"; linkParte = 0; fillModal(); $("modal").classList.add("on");
  }
  function closeModal() { $("modal").classList.remove("on"); }
  function copiar() {
    var ta = $("modal-txt"); ta.select(); ta.setSelectionRange(0, 999999);
    var msg = modalMode === "links" ? (linkPartes.length > 1
                ? "Parte " + (linkParte + 1) + "/" + linkPartes.length + " copiada ✓ · cole no NotebookLM (fonte Web) e volte pra próxima parte"
                : "copiado ✓ · cole os links no NotebookLM (fonte Web)")
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
    persistLocal();
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
      if (b.dataset.f) { view = b.dataset.f; catFilter = null; [].forEach.call(document.querySelectorAll(".chip[data-f]"), function (x) { x.classList.toggle("on", x === b); }); }
      else if (b.dataset.g) { group = b.dataset.g; catFilter = null; [].forEach.call(document.querySelectorAll(".chip[data-g]"), function (x) { x.classList.toggle("on", x === b); }); }
      render();
    });
    $("busca").addEventListener("input", function (e) { q = e.target.value.trim().toLowerCase(); render(); });
    [].forEach.call(document.querySelectorAll(".mode-btn"), function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });
    // ---- anotacoes & insights ----
    $("anotaBusca").addEventListener("input", function (e) { anotaState.q = e.target.value.trim().toLowerCase(); renderAnotacoes(); });
    $("anotaChips").addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      if (b.dataset.af) anotaState.filter = b.dataset.af;
      else if (b.hasAttribute("data-tema")) anotaState.tema = (anotaState.tema === b.dataset.tema) ? null : b.dataset.tema;
      renderAnotacoes();
    });
    $("anotaEstudo").addEventListener("change", function (e) { anotaState.estudo = e.target.value; renderAnotacoes(); });
    $("anotaNova").onclick = novaAnotacao;
    $("btn-links").onclick = function () { openModal("links"); };
    $("btn-gerar").onclick = function () { openModal("texto"); };
    $("btn-logout").onclick = function () { apiPost("logout", {}).catch(function () {}).then(function () { location.reload(); }); };
    $("modal-close").onclick = closeModal;
    $("btn-copiar").onclick = copiar;
    $("btn-arquivar").onclick = arquivarSelecionados;
    $("modal-partes").addEventListener("click", function (e) {
      var b = e.target.closest(".ppart"); if (!b) return;
      linkParte = parseInt(b.dataset.p, 10) || 0; fillModal();
    });
    [].forEach.call(document.querySelectorAll(".mtab"), function (t) { t.onclick = function () { modalMode = t.dataset.m; linkParte = 0; fillModal(); }; });
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
        // rede de seguranca: resgata marcacoes locais que nao chegaram ao servidor (nunca perde a selecao num reload)
        try {
          var loc = JSON.parse(localStorage.getItem(LS_DEC) || "{}");
          Object.keys(loc).forEach(function (id) {
            if (!state.decisions[id] && loc[id] && loc[id].status) state.decisions[id] = loc[id];
          });
        } catch (e) {}
        persistLocal();
        catMap = {}; grpMap = {}; epMap = {};
        (CFG.categorias || []).forEach(function (c) { catMap[c.id] = c; });
        (CFG.grupos || []).forEach(function (g) { grpMap[g.id] = g; });
        (ESTUDOS.episodios || []).forEach(function (e) { epMap[e.id] = e; });
        if (CFG.subtitulo) $("subtitle").textContent = CFG.subtitulo;
        wire();
        render();
        var m = params.get("m") || params.get("modo");
        setMode(m === "estudo" ? "estudo" : (m === "anotacoes" || m === "anotacao" ? "anotacoes" : "radar"));
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
