/* SEMPRE ATUALIZADO — pessoal do Bruno.
   Pagina estatica (GitHub Pages): le categorias.json + dados/<slug>.json (banco acumulado)
   e sincroniza as MARCACOES com api.php (backend por slug na Hostinger).
   Marcacoes chaveadas pelo ID do item -> o que voce marca sobrevive a recoleta diaria. */
(function () {
  "use strict";
  var API = (window.SA_CONFIG && window.SA_CONFIG.apiBase) || "";
  var params = new URLSearchParams(location.search);
  var SLUG = (params.get("u") || params.get("slug") || "bruno").toLowerCase().replace(/[^a-z0-9\-]/g, "");

  var CFG = null, DADOS = null;
  var state = { decisions: {} };
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

  function openModal() {
    var g = gerarTexto();
    if (!g.n) { toast("Marque assuntos primeiro ✅"); return; }
    $("modal-txt").value = g.txt;
    $("modal-saved").textContent = g.cap + " capítulos · " + g.n + " itens";
    $("modal").classList.add("on");
  }
  function closeModal() { $("modal").classList.remove("on"); }

  function copiar() {
    var ta = $("modal-txt"); ta.select(); ta.setSelectionRange(0, 999999);
    var done = function () { $("modal-saved").textContent = "copiado ✓ — cole no Gemini/NotebookLM"; toast("Copiado ✓"); };
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
    $("btn-gerar").onclick = openModal;
    $("modal-close").onclick = closeModal;
    $("btn-copiar").onclick = copiar;
    $("btn-arquivar").onclick = arquivarSelecionados;
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
    apiGet()
  ]).then(function (res) {
    CFG = res[0]; DADOS = res[1]; state = res[2] && res[2].decisions ? res[2] : { decisions: {} };
    if (!state.decisions) state.decisions = {};
    CFG.categorias.forEach(function (c) { catMap[c.id] = c; });
    CFG.grupos.forEach(function (g) { grpMap[g.id] = g; });
    if (CFG.subtitulo) $("subtitle").textContent = CFG.subtitulo;
    wire();
    render();
  }).catch(function (e) {
    $("feed").innerHTML = '<div class="empty"><b>Erro ao carregar.</b>' + esc(String(e)) + '</div>';
  });
})();
