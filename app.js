/* SEMPRE ATUALIZADO — pessoal do Bruno.
   Pagina estatica (GitHub Pages): le categorias.json + dados/<slug>.json (banco acumulado)
   e sincroniza as MARCACOES com api.php (backend por slug na Hostinger).
   Marcacoes chaveadas pelo ID do item -> o que voce marca sobrevive a recoleta diaria. */
(function () {
  "use strict";
  var API = (window.SA_CONFIG && window.SA_CONFIG.apiBase) || "";
  var params = new URLSearchParams(location.search);
  var SLUG = (params.get("u") || params.get("slug") || "bruno").toLowerCase().replace(/[^a-z0-9\-]/g, "");

  var CFG = null, DADOS = null, ESTUDOS = { episodios: [] };
  var state = { decisions: {}, notes: {} };
  var appMode = "radar";   // radar | estudo
  var view = "novos";      // novos | sel | todos | lidos
  var group = "all";       // all | negocios | pessoal
  var q = "";
  var catMap = {}, grpMap = {};

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(m) { var t = $("toast"); t.textContent = m; t.classList.add("show"); setTimeout(function () { t.classList.remove("show"); }, 2400); }

  /* ---------- rede ---------- */
  function apiGet() {
    if (!API) return Promise.resolve({ decisions: {} });
    return fetch(API + "?action=get&slug=" + encodeURIComponent(SLUG), { cache: "no-store" })
      .then(function (r) { return r.json(); }).catch(function () { return { decisions: {} }; });
  }
  function post(action, data) {
    var body = new URLSearchParams();
    body.set("action", action); body.set("slug", SLUG);
    Object.keys(data).forEach(function (k) { body.set(k, data[k] == null ? "" : data[k]); });
    return fetch(API, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() })
      .then(function (r) { return r.json(); });
  }

  /* ---------- estado ---------- */
  function statusOf(id) { return (state.decisions[id] && state.decisions[id].status) || "pending"; }
  function setStatus(id, status) {
    if (status === "pending") delete state.decisions[id];
    else state.decisions[id] = { status: status };
    post("mark", { id: id, status: status }).catch(function () { toast("Não consegui salvar. Verifique a conexão."); });
  }

  /* ---------- filtros ---------- */
  function passView(id) {
    var s = statusOf(id);
    if (view === "novos") return s === "pending";
    if (view === "sel") return s === "checked";
    if (view === "lidos") return s === "read";
    return s !== "read"; // todos = ativos (novos + selecionados)
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

  /* ---------- render ---------- */
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
    CFG.grupos.forEach(function (g) {
      var gh = document.createElement("div"); gh.className = "side-grp";
      gh.textContent = g.emoji + " " + g.nome; el.appendChild(gh);
      CFG.categorias.filter(function (c) { return c.grupo === g.id; }).forEach(function (c) {
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
    d.querySelector(".arch").onclick = function () {
      setStatus(it.id, "read");
      toast("Arquivado 📁");
      render();
    };
    return d;
  }

  function render() {
    var perCat = renderStats().perCat;
    renderSide(perCat);
    var feed = $("feed"); feed.innerHTML = "";
    var items = visibleItems();
    if (!items.length) {
      feed.innerHTML = '<div class="empty"><b>Nada por aqui nesse filtro.</b>' +
        (view === "novos" ? "Rode a skill pra trazer assuntos novos, ou veja os <b style=\"display:inline;color:#6366f1;cursor:pointer\" onclick=\"document.querySelector('[data-f=todos]').click()\">Todos</b>." : "Troque o filtro acima.") + '</div>';
      return;
    }
    var byCat = {};
    items.forEach(function (it) { (byCat[it.cat] = byCat[it.cat] || []).push(it); });
    CFG.categorias.forEach(function (c) {
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

  /* ---------- estudo do podcast ---------- */
  function fmtData(s) {
    if (!s) return "";
    var p = String(s).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : s;
  }
  function saveNote(epId, text) {
    if (!state.notes) state.notes = {};
    state.notes[epId] = { text: text };
    post("note", { key: epId, text: text }).catch(function () { toast("Sem conexão pra salvar a nota"); });
  }
  function renderEstudo() {
    var feed = $("estudoFeed"); feed.innerHTML = "";
    var eps = ESTUDOS.episodios || [];
    if (!eps.length) {
      feed.innerHTML = '<div class="empty"><b>Nenhum podcast de estudo ainda.</b>Gere o Resumo em Áudio no NotebookLM e me mande o arquivo. Eu transcrevo, monto os tópicos com o tempo e crio o estudo aqui.</div>';
      return;
    }
    eps.forEach(function (ep) {
      var sec = document.createElement("section"); sec.className = "ep";
      var temas = (ep.temas || []).map(function (t) { return '<span class="ep-tema">' + esc(t) + "</span>"; }).join("");
      var bullets = (ep.topicos || []).map(function (tp) {
        return '<li data-sec="' + (tp.sec || 0) + '"><span class="ts">' + esc(tp.t || "") + '</span><span class="bx">' + esc(tp.txt || "") + "</span></li>";
      }).join("");
      var noteVal = (state.notes && state.notes[ep.id] && state.notes[ep.id].text) || "";
      sec.innerHTML =
        '<div class="ep-head"><span class="ep-date">' + esc(fmtData(ep.data)) + (ep.duracao ? " · " + esc(ep.duracao) : "") + "</span>" +
          "<h2>" + esc(ep.titulo) + "</h2></div>" +
        (temas ? '<div class="ep-temas">' + temas + "</div>" : "") +
        (ep.audio_url ? '<audio class="ep-audio" controls preload="none" src="' + esc(ep.audio_url) + '"></audio>' : '<div class="ep-noaudio">Áudio não anexado.</div>') +
        '<h3>📌 Tópicos e anotações <small>(clique no tempo pra ouvir o trecho)</small></h3>' +
        '<ul class="ep-bullets">' + bullets + "</ul>" +
        "<h3>📝 Minhas notas</h3>" +
        '<textarea class="ep-notes" placeholder="Escreva o que você quer lembrar deste episódio…">' + esc(noteVal) + "</textarea>" +
        '<div class="ep-notesaved">salvo ✓</div>' +
        (ep.transcricao ? '<details class="ep-tr"><summary>Ver transcrição completa</summary><div class="ep-tr-body">' + esc(ep.transcricao) + "</div></details>" : "");
      var audio = sec.querySelector(".ep-audio");
      [].forEach.call(sec.querySelectorAll(".ep-bullets li"), function (li) {
        li.onclick = function () { if (audio) { try { audio.currentTime = parseFloat(li.dataset.sec) || 0; audio.play(); } catch (e) {} } };
      });
      var ta = sec.querySelector(".ep-notes"), tmr = null, saved = sec.querySelector(".ep-notesaved");
      ta.addEventListener("input", function () {
        clearTimeout(tmr);
        tmr = setTimeout(function () {
          saveNote(ep.id, ta.value);
          if (saved) { saved.classList.add("on"); setTimeout(function () { saved.classList.remove("on"); }, 1500); }
        }, 700);
      });
      feed.appendChild(sec);
    });
  }
  function setMode(m) {
    appMode = m;
    $("radarView").style.display = (m === "radar") ? "" : "none";
    $("estudoView").style.display = (m === "estudo") ? "" : "none";
    $("actionbar").style.display = (m === "radar") ? "" : "none";
    var stog = $("side-toggle"); if (stog) stog.style.display = (m === "radar") ? "" : "none";
    [].forEach.call(document.querySelectorAll(".mode-btn"), function (b) { b.classList.toggle("on", b.dataset.mode === m); });
    if (m === "estudo") renderEstudo();
    window.scrollTo(0, 0);
  }

  /* ---------- gerar texto em capitulos ---------- */
  function gerarTexto() {
    var sel = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; });
    var hoje = new Date().toLocaleDateString("pt-BR");
    var L = [];
    L.push("# Meus assuntos para me atualizar — " + hoje);
    L.push("");
    L.push("Abaixo, os assuntos que selecionei, organizados em capitulos por tema. Faca um resumo didatico e aprofundado de cada capitulo, com os pontos-chave, o que eu preciso saber e como aplicar na pratica.");
    L.push("");
    var cap = 0;
    CFG.categorias.forEach(function (c) {
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

  /* ---------- links pro NotebookLM (materias hospedadas) ---------- */
  function materiaURL(id) {
    // materias/<id>.html fica ao lado do index (mesma pasta no GitHub Pages)
    return new URL("materias/" + id + ".html", location.href).href;
  }
  function gerarLinks() {
    var sel = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; });
    return { txt: sel.map(function (it) { return materiaURL(it.id); }).join("\n"), n: sel.length };
  }

  /* ---------- prompt de "Personalizar o Resumo em Áudio" (NotebookLM) ---------- */
  function gerarAudioPrompt() {
    var sel = DADOS.itens.filter(function (it) { return statusOf(it.id) === "checked"; });
    var cats = CFG.categorias.filter(function (c) { return sel.some(function (it) { return it.cat === c.id; }); });
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

  /* ---------- modal (3 modos: links | audio | texto) ---------- */
  var modalMode = "links";
  function fillModal() {
    var title, hint, txt, saved;
    if (modalMode === "links") {
      var g = gerarLinks();
      title = "🔗 Links pro NotebookLM";
      hint = "Cada link abre a NOSSA matéria do assunto (o resumo curado, não a fonte crua). Cole estes links no NotebookLM como fontes: o podcast sai da nossa versão. Um link por linha.";
      txt = g.txt; saved = g.n + (g.n === 1 ? " link" : " links");
    } else if (modalMode === "audio") {
      var a = gerarAudioPrompt();
      title = "🎙️ Personalizar o Resumo em Áudio";
      hint = "Cole este texto no campo 'Personalizar' do Resumo em Áudio do NotebookLM (define no que os apresentadores devem focar neste episódio).";
      txt = a.txt; saved = a.n + " assuntos";
    } else {
      var t = gerarTexto();
      title = "🧠 Texto em capítulos";
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
    if (!n) { toast("Marque assuntos primeiro ✅"); return; }
    modalMode = mode || "links";
    fillModal();
    $("modal").classList.add("on");
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
    post("bulk", { ids: ids.join(","), status: "read" }).then(function () { toast("Arquivados 📁"); }).catch(function () { toast("Salvo local, checar conexão"); });
    closeModal(); render();
  }

  /* ---------- sidebar mobile ---------- */
  function openSide() { $("side").classList.add("on"); $("side-backdrop").classList.add("on"); }
  function closeSide() { $("side").classList.remove("on"); $("side-backdrop").classList.remove("on"); }

  /* ---------- eventos ---------- */
  function wire() {
    $("chips").addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      if (b.dataset.f) {
        view = b.dataset.f;
        [].forEach.call(document.querySelectorAll(".chip[data-f]"), function (x) { x.classList.toggle("on", x === b); });
      } else if (b.dataset.g) {
        group = b.dataset.g;
        [].forEach.call(document.querySelectorAll(".chip[data-g]"), function (x) { x.classList.toggle("on", x === b); });
      }
      render();
    });
    $("busca").addEventListener("input", function (e) { q = e.target.value.trim().toLowerCase(); render(); });
    [].forEach.call(document.querySelectorAll(".mode-btn"), function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });
    $("btn-links").onclick = function () { openModal("links"); };
    $("btn-gerar").onclick = function () { openModal("texto"); };
    $("modal-close").onclick = closeModal;
    $("btn-copiar").onclick = copiar;
    $("btn-arquivar").onclick = arquivarSelecionados;
    [].forEach.call(document.querySelectorAll(".mtab"), function (t) {
      t.onclick = function () { modalMode = t.dataset.m; fillModal(); };
    });
    $("modal").addEventListener("click", function (e) { if (e.target.id === "modal") closeModal(); });
    $("side-toggle").onclick = openSide;
    $("side-close").onclick = closeSide;
    $("side-backdrop").onclick = closeSide;
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeModal(); closeSide(); } });
  }

  /* ---------- boot ---------- */
  Promise.all([
    fetch("categorias.json", { cache: "no-store" }).then(function (r) { return r.json(); }),
    fetch("dados/" + SLUG + ".json", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return { itens: [], gerado_em: "" }; }),
    apiGet(),
    fetch("dados/estudos.json", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return { episodios: [] }; })
  ]).then(function (res) {
    CFG = res[0]; DADOS = res[1];
    var st = res[2] || {};
    state = { decisions: st.decisions || {}, notes: st.notes || {} };
    ESTUDOS = res[3] || { episodios: [] };
    CFG.categorias.forEach(function (c) { catMap[c.id] = c; });
    CFG.grupos.forEach(function (g) { grpMap[g.id] = g; });
    if (CFG.subtitulo) $("subtitle").textContent = CFG.subtitulo;
    wire();
    render();
    if ((params.get("m") || params.get("modo")) === "estudo") setMode("estudo");
  }).catch(function (e) {
    $("feed").innerHTML = '<div class="empty"><b>Erro ao carregar.</b>' + esc(String(e)) + '</div>';
  });
})();
