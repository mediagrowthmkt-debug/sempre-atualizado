#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SEMPRE ATUALIZADO — motor (skill pessoal do Bruno).
Radar de aprendizado: acumula assuntos NOVOS por categoria (lista fixa em categorias.json),
publica uma pagina de checklist COM LOGIN (Hostinger, mesmo dominio da API -> cookie HttpOnly)
que salva o que o Bruno marca (estado por ID estavel do item -> marca sobrevive a recoleta) e
gera um TEXTO em CAPITULOS com os itens selecionados, pra colar no Gemini/NotebookLM resumir.

Stdlib pura. Roda no Mac e na VPS.

Hospedagem: pagina + API no MESMO dominio (Hostinger) -> login por senha + cookie HttpOnly.
  Pagina : https://mediagrowth.com.br/atualizado/?u=bruno   (public_html/atualizado)
  API    : https://mediagrowth.com.br/atualizado-api/api.php (public_html/atualizado-api)
  Privado: ~/domains/mediagrowth.com.br/atualizado-private/ (secret.php + content/ + state/, FORA do web root)

Setup (uma vez):
  engine.py setup                          # cria dirs na Hostinger + migra estado antigo (fecha o vazamento)
  engine.py set-senha "SUA_SENHA_FORTE"    # gera hash bcrypt + token_secret no servidor (secret.php, chmod 600)
  engine.py backend                        # sobe api.php + _ratelimit.php
  engine.py publicar                       # sobe pagina + conteudo

Uso:
  engine.py coletar [--cat id1,id2] [--por-query N] [--publicar]   # RSS backbone (append + dedupe)
  engine.py contexto [--cat id1,id2]                               # briefs dos clientes (CLIENTE.md + reunioes + grupo) p/ ancorar a pesquisa dos nichos
  engine.py add --file payload.json [--publicar]                   # ingere pesquisa profunda do agente
  engine.py gerar-texto [--status checked|all|novos] [--out arq]   # monta o texto em capitulos
  engine.py materias [--cat id1,id2]                               # gera materias/<id>.html (curadoria por assunto, pro NotebookLM)
  engine.py audio-prompt [--status checked]                        # texto pro campo "Personalizar o Resumo em Áudio" do NotebookLM
  engine.py estudo --audio arq.m4a --file payload.json [--data YYYY-MM-DD] [--titulo "..."] [--publicar]  # cria/ADICIONA o estudo do podcast (hospeda audio + topicos com timestamp; ao enviar audio, os SELECIONADOS viram JA USADO)
  engine.py arquivar-selecionados                                 # move os SELECIONADOS ('checked') pra JA USADO ('read'), limpando os selecionados
  engine.py publicar [-m "msg"]                                    # materias + pagina (Hostinger) + conteudo (privado) + backup git
  engine.py deploy-frontend                                        # so a pagina -> Hostinger
  engine.py push-content                                           # so o conteudo -> dir privado
  engine.py backend                                                # scp api.php -> Hostinger
  engine.py setup / set-senha "..."                                # estrutura inicial / senha do login
  engine.py link                                                   # imprime os links
  engine.py status                                                 # contagem por categoria

Formato do payload de --add (pesquisa profunda do agente):
  { "itens": [ { "cat":"empresa", "titulo":"...", "resumo":"2-4 frases PT-BR",
                 "porque":"por que importa pra voce (1 frase)", "fonte":"Nome da fonte",
                 "url":"https://...", "tipo":"insight|noticia|tendencia|ferramenta",
                 "data":"YYYY-MM-DD" }, ... ] }
"""
import os, sys, json, re, hashlib, subprocess, urllib.request, urllib.parse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET

REPO = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable or "/usr/bin/python3"
CFG = os.path.join(REPO, "categorias.json")
USER = "bruno"
DADOS = os.path.join(REPO, "dados", f"{USER}.json")

# Backup opcional em git (so o CODIGO; dados pessoais estao no .gitignore)
GH_OWNER = os.environ.get("SA_GH_OWNER", "mediagrowthmkt-debug")
GH_REPO  = os.environ.get("SA_GH_REPO",  "sempre-atualizado")

# Hospedagem: pagina + API no MESMO dominio (Hostinger) -> sessao por cookie HttpOnly.
SSH        = os.environ.get("MG_HOSTINGER_SSH", "hostinger-mg")
API_REMOTE = os.environ.get("SA_HOSTINGER_DIR", "domains/mediagrowth.com.br/public_html/atualizado-api")
WEB_REMOTE = os.environ.get("SA_WEB_DIR",  "domains/mediagrowth.com.br/public_html/atualizado")
PRIV_REMOTE= os.environ.get("SA_PRIV_DIR", "domains/mediagrowth.com.br/atualizado-private")  # FORA do web root
REMOTE     = API_REMOTE  # compat
API_URL    = os.environ.get("SA_API_URL", "https://mediagrowth.com.br/atualizado-api/api.php")
SITE_URL   = os.environ.get("SA_SITE_URL", "https://mediagrowth.com.br/atualizado")

FRONT_FILES = ["index.html", "style.css", "app.js", "config.js", ".htaccess", "compilado.php"]

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


# ---------------------------------------------------------------- utils
def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def today():
    return datetime.now().strftime("%Y-%m-%d")


def load_cfg():
    return json.load(open(CFG, encoding="utf-8"))


def load_dados():
    if os.path.exists(DADOS):
        try:
            return json.load(open(DADOS, encoding="utf-8"))
        except Exception:
            pass
    return {"usuario": USER, "gerado_em": now_iso(), "ultima_coleta": {}, "itens": []}


def save_dados(d):
    d["gerado_em"] = now_iso()
    os.makedirs(os.path.dirname(DADOS), exist_ok=True)
    json.dump(d, open(DADOS, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def item_id(cat, url, titulo):
    base = (cat or "") + "|" + ((url or "").strip().lower() or (titulo or "").strip().lower())
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def strip_html(s):
    # decodifica as entidades ANTES de tirar as tags: o Google News manda o HTML
    # entity-encoded (&lt;a href="..."&gt;); se stripar antes de decodificar, a tag <a ...> sobrevive.
    s = ((s or "").replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">")
           .replace("&quot;", '"').replace("&#39;", "'").replace("&amp;", "&"))
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def clean_resumo(s):
    """Resumo limpo pro card/materia: sem HTML e sem URL crua; leftover curto vira vazio."""
    r = strip_html(s)
    r = re.sub(r"https?://\S+", " ", r)
    r = re.sub(r"\s+", " ", r).strip(" -–—|·•")
    return r if len(r) >= 25 else ""


def sh(cmd, cwd=REPO, check=True):
    print("· " + " ".join(cmd))
    return subprocess.run(cmd, cwd=cwd, check=check)


def git(args):
    base = ["git", "-c", "user.name=MediaGrowth Deploy", "-c", "user.email=mediagrowthmkt@gmail.com"]
    return sh(base + args)


# ---------------------------------------------------------------- coleta RSS
def gnews_url(query, lang):
    q = urllib.parse.quote(query)
    if lang == "en":
        return f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
    return f"https://news.google.com/rss/search?q={q}&hl=pt-BR&gl=BR&ceid=BR:pt-419"


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _parse_rss_regex(xml_bytes, por_query):
    """Fallback sem ElementTree (Python com expat quebrado, ex.: 3.14 do brew).
       Extrai os <item> por regex e devolve o mesmo formato de parse_rss."""
    out = []
    txt = xml_bytes.decode("utf-8", "ignore") if isinstance(xml_bytes, (bytes, bytearray)) else str(xml_bytes)

    def tag(block, name):
        m = re.search(rf"<{name}[^>]*>(.*?)</{name}>", block, re.S | re.I)
        if not m:
            return ""
        v = m.group(1).strip()
        cd = re.match(r"^\s*<!\[CDATA\[(.*?)\]\]>\s*$", v, re.S)
        return (cd.group(1) if cd else v).strip()

    for m in re.finditer(r"<item\b[^>]*>(.*?)</item>", txt, re.S | re.I):
        block = m.group(1)
        title = strip_html(tag(block, "title"))
        link = strip_html(tag(block, "link"))
        desc = strip_html(tag(block, "description"))
        source = strip_html(tag(block, "source"))
        if not source and " - " in title:
            source = title.rsplit(" - ", 1)[-1].strip()
        headline = title.rsplit(" - ", 1)[0].strip() if (" - " in title and source and title.endswith(source)) else title
        pub = tag(block, "pubDate")
        try:
            data = parsedate_to_datetime(pub).astimezone().strftime("%Y-%m-%d")
        except Exception:
            data = today()
        if not link or not headline:
            continue
        out.append({"titulo": headline, "url": link, "resumo": desc, "fonte": source or "Google News", "data": data})
        if len(out) >= por_query:
            break
    return out


def parse_rss(xml_bytes, por_query):
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except Exception:
        return _parse_rss_regex(xml_bytes, por_query)
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        desc = strip_html(it.findtext("description") or "")
        src_el = it.find("source")
        source = (src_el.text.strip() if src_el is not None and src_el.text else "")
        # Google News costuma vir "Headline - Fonte"
        if not source and " - " in title:
            source = title.rsplit(" - ", 1)[-1].strip()
        headline = title.rsplit(" - ", 1)[0].strip() if (" - " in title and source and title.endswith(source)) else title
        pub = it.findtext("pubDate") or ""
        try:
            data = parsedate_to_datetime(pub).astimezone().strftime("%Y-%m-%d")
        except Exception:
            data = today()
        if not link or not headline:
            continue
        out.append({"titulo": headline, "url": link, "resumo": desc, "fonte": source or "Google News", "data": data})
        if len(out) >= por_query:
            break
    return out


def cmd_coletar(cats=None, por_query=6, publicar=False):
    cfg = load_cfg()
    dados = load_dados()
    existentes = {i["id"] for i in dados["itens"]}
    alvo = [c for c in cfg["categorias"] if (not cats or c["id"] in cats)]
    novos = 0
    for c in alvo:
        cat_id, lang = c["id"], c.get("lang", "pt")
        add_c = 0
        vistos_cat = set()
        print(f"\n🔎 {c['emoji']} {c['nome']} ({cat_id})")
        for q in c.get("queries", []):
            try:
                raw = fetch(gnews_url(q, lang))
            except Exception as e:
                print(f"  ⚠️  falha query '{q}': {e}")
                continue
            for it in parse_rss(raw, por_query):
                iid = item_id(cat_id, it["url"], it["titulo"])
                if iid in existentes or iid in vistos_cat:
                    continue
                vistos_cat.add(iid)
                existentes.add(iid)
                dados["itens"].append({
                    "id": iid, "cat": cat_id, "titulo": it["titulo"],
                    "resumo": clean_resumo(it["resumo"]), "porque": "", "fonte": it["fonte"],
                    "url": it["url"], "tipo": "noticia", "data": it["data"],
                    "coletado_em": today(), "origem": "rss"
                })
                add_c += 1
                novos += 1
                # cap por categoria por coleta pra nao inundar
                if add_c >= 10:
                    break
            if add_c >= 10:
                break
        dados.setdefault("ultima_coleta", {})[cat_id] = today()
        print(f"  + {add_c} novos")
    save_dados(dados)
    print(f"\n✅ Coleta RSS: {novos} itens novos. Total no banco: {len(dados['itens'])}.")
    if publicar:
        cmd_publicar(f"coleta RSS {today()} (+{novos})")


# ---------------------------------------------------------------- contexto de cliente (grupo "nichos")
# Antes de pesquisar as categorias de Clientes & Nichos, junta o material REAL de cada cliente
# (CLIENTE.md + ultimas reunioes + id do grupo) num brief -> a pesquisa fica rica e no contexto do cliente.
import glob as _glob, shutil as _shutil

def _which_mg(name):
    p = _shutil.which(name)
    if p:
        return p
    for cand in (f"/Users/bruno/mg-mirror/bin/{name}", f"/root/mg-mirror/bin/{name}",
                 os.path.expanduser(f"~/mg-mirror/bin/{name}")):
        if os.path.exists(cand):
            return cand
    return None


def _resolve_cliente(q):
    """Path canonico da pasta do cliente (mg-cliente resolve -> fallback glob por slug)."""
    mgc = _which_mg("mg-cliente")
    if mgc:
        try:
            r = subprocess.run([mgc, "resolve", q], capture_output=True, text=True, timeout=30)
            for ln in (r.stdout or "").splitlines():
                if "→" in ln or "->" in ln:
                    path = ln.replace("->", "→").split("→")[-1].strip()
                    if os.path.isdir(path):
                        return path
        except Exception:
            pass
    # fallback: procura em clientes_convidados/clientes/*<token>*
    base = os.path.expanduser("~/clientes_convidados/clientes")
    if not os.path.isdir(base):
        base = "/Users/bruno/clientes_convidados/clientes"
    tok = re.sub(r"[^a-z0-9]", "", (q or "").lower())
    if os.path.isdir(base) and tok:
        for d in sorted(_glob.glob(os.path.join(base, "*"))):
            if os.path.isdir(d) and tok in re.sub(r"[^a-z0-9]", "", os.path.basename(d).lower()):
                return d
    return None


def _read_head(path, max_chars=7000):
    try:
        t = open(path, encoding="utf-8", errors="ignore").read()
        return t if len(t) <= max_chars else t[:max_chars] + "\n…[truncado]…"
    except Exception:
        return ""


def _ultimas_reunioes(folder, n=2):
    """As n reunioes mais recentes (prefere resumo/, senao transcricao/)."""
    for sub in ("reunioes/resumo", "reunioes/transcricao", "reunioes"):
        d = os.path.join(folder, sub)
        arqs = sorted(_glob.glob(os.path.join(d, "*.md")), key=lambda p: os.path.getmtime(p), reverse=True) if os.path.isdir(d) else []
        if arqs:
            return arqs[:n]
    return []


def _grupo_id(cliente_md_txt):
    m = re.search(r"(\d{12,}-group)", cliente_md_txt or "")
    return m.group(1) if m else ""


def cmd_contexto(cats=None):
    """Gera briefs de contexto dos clientes das categorias do grupo 'nichos'.
       Escreve _scratch/contexto/<slug>.md por cliente + INDEX.md, e imprime um resumo curto.
       O agente LÊ esses briefs no PASSO 1 e ancora a pesquisa nas dores/temas reais do cliente."""
    cfg = load_cfg()
    alvo = [c for c in cfg["categorias"]
            if c.get("clientes") and (not cats or c["id"] in cats)]
    if not alvo:
        print("Nenhuma categoria com clientes no escopo. (Grupo 'nichos': nicho_contractor, nicho_motel, aciona_ia.)")
        return
    outdir = os.path.join(REPO, "_scratch", "contexto")
    os.makedirs(outdir, exist_ok=True)
    vistos = {}
    index = ["# Contexto de clientes — Sempre Atualizado", f"_gerado {now_iso()}_", ""]
    for c in alvo:
        index.append(f"## {c['emoji']} {c['nome']} (`{c['id']}`)")
        for cli in c.get("clientes", []):
            nome, q = cli.get("nome", ""), cli.get("q") or cli.get("nome", "")
            slug = re.sub(r"[^a-z0-9]+", "-", nome.lower()).strip("-")
            if slug in vistos:
                index.append(f"- {nome} → `_scratch/contexto/{slug}.md` (já coletado)")
                continue
            folder = _resolve_cliente(q)
            partes = [f"# {nome}", f"_categoria: {c['nome']} ({c['id']})_ · nota: {cli.get('nota','')}", ""]
            grupo = ""
            if folder:
                partes.append(f"pasta: {folder}\n")
                cmd = os.path.join(folder, "CLIENTE.md")
                if os.path.exists(cmd):
                    cmd_txt = open(cmd, encoding="utf-8", errors="ignore").read()
                    grupo = _grupo_id(cmd_txt)
                    partes.append("## CLIENTE.md (negócio, nicho, links, dores)")
                    partes.append(_read_head(cmd, 6500))
                    partes.append("")
                reus = _ultimas_reunioes(folder, 2)
                if reus:
                    partes.append("## Últimas reuniões (o que foi falado — dores, pedidos, decisões)")
                    for r in reus:
                        partes.append(f"### {os.path.basename(r)}")
                        partes.append(_read_head(r, 6500))
                        partes.append("")
                if grupo:
                    partes.append(f"## Grupo WhatsApp: {grupo}")
                    partes.append("Pra minerar assuntos recentes do grupo (opcional): usar as ferramentas de WhatsApp respeitando o cap de output (| head -N).")
                    partes.append("")
            else:
                partes.append("⚠️ pasta não resolvida — pesquisar só pelo nicho/nome.")
            brief_path = os.path.join(outdir, slug + ".md")
            open(brief_path, "w", encoding="utf-8").write("\n".join(partes))
            vistos[slug] = brief_path
            tags = []
            if folder:
                tags.append("pasta ✓")
            if grupo:
                tags.append("grupo ✓")
            if folder and _ultimas_reunioes(folder, 1):
                tags.append("reuniões ✓")
            index.append(f"- {nome} → `_scratch/contexto/{slug}.md` ({', '.join(tags) or 'só nome'})")
        index.append("")
    open(os.path.join(outdir, "INDEX.md"), "w", encoding="utf-8").write("\n".join(index))
    print(f"✅ Contexto de {len(vistos)} clientes em {outdir}/  (leia INDEX.md e os briefs antes de pesquisar).")
    for slug, p in vistos.items():
        print(f"   · {slug}: {p}")


# ---------------------------------------------------------------- ingest (pesquisa profunda do agente)
def cmd_add(path, publicar=False):
    payload = json.load(open(path, encoding="utf-8"))
    itens = payload.get("itens", payload if isinstance(payload, list) else [])
    cfg = load_cfg()
    validos = {c["id"] for c in cfg["categorias"]}
    dados = load_dados()
    existentes = {i["id"] for i in dados["itens"]}
    novos, ign = 0, 0
    for it in itens:
        cat = (it.get("cat") or "").strip()
        titulo = (it.get("titulo") or "").strip()
        url = (it.get("url") or "").strip()
        if cat not in validos or not titulo:
            ign += 1
            continue
        iid = item_id(cat, url, titulo)
        if iid in existentes:
            ign += 1
            continue
        existentes.add(iid)
        dados["itens"].append({
            "id": iid, "cat": cat, "titulo": titulo,
            "resumo": (it.get("resumo") or "").strip(),
            "porque": (it.get("porque") or "").strip(),
            "fonte": (it.get("fonte") or "").strip(),
            "url": url, "tipo": (it.get("tipo") or "insight").strip(),
            "data": (it.get("data") or today()).strip(),
            "coletado_em": today(), "origem": "pesquisa"
        })
        novos += 1
    save_dados(dados)
    print(f"✅ Ingestão: {novos} novos, {ign} ignorados (duplicados/invalidos). Total: {len(dados['itens'])}.")
    if publicar:
        cmd_publicar(f"pesquisa profunda {today()} (+{novos})")


# ---------------------------------------------------------------- estado do backend
def backend_state():
    """Le as marcacoes/notas direto do arquivo de estado privado, via SSH (autenticado pela chave).
       O endpoint HTTP agora exige login por cookie, entao o CLI usa o SSH."""
    try:
        r = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=15", SSH, f"cat {PRIV_REMOTE}/state/{USER}.json 2>/dev/null || echo '{{}}'"],
            capture_output=True, text=True)
        st = json.loads(r.stdout or "{}")
        return st.get("decisions", {}) or {}
    except Exception as e:
        print(f"⚠️  não consegui ler o estado ({e}). Uso só o banco local.")
        return {}


def arquivar_selecionados_backend(verbose=True):
    """Move todo item SELECIONADO ('checked') pra JA USADO ('read') no estado do backend, via SSH.
       Limpa os selecionados pra nao poluir. Chamado automaticamente ao criar um estudo a partir de audio
       (os assuntos ja foram consumidos pra gerar o Resumo em Audio). Preserva notas/progresso.
       Retorna quantos itens foram movidos."""
    remote = f"{PRIV_REMOTE}/state/{USER}.json"
    try:
        r = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=15", SSH, f"cat {remote} 2>/dev/null || echo '{{}}'"],
            capture_output=True, text=True)
        st = json.loads(r.stdout or "{}")
    except Exception as e:
        print(f"⚠️  não consegui ler o estado pra arquivar os selecionados ({e}).")
        return 0
    if not isinstance(st, dict):
        st = {}
    dec = st.get("decisions") or {}
    ids = [i for i, d in dec.items() if isinstance(d, dict) and d.get("status") == "checked"]
    if not ids:
        if verbose:
            print("ℹ️  nenhum selecionado pra arquivar (os selecionados já estão limpos).")
        return 0
    at = now_iso()
    for i in ids:
        dec[i] = {"status": "read", "at": at}
    st["decisions"] = dec
    st["updated_at"] = at
    payload = json.dumps(st, ensure_ascii=False, indent=2)
    try:
        w = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=20", SSH,
             f"cat > {remote}.tmp && mv -f {remote}.tmp {remote} && chmod 600 {remote} && echo OK"],
            input=payload, capture_output=True, text=True)
        if "OK" not in (w.stdout or ""):
            print(f"⚠️  falha ao gravar o estado arquivado: {(w.stderr or '').strip()}")
            return 0
    except Exception as e:
        print(f"⚠️  não consegui gravar o estado arquivado ({e}).")
        return 0
    if verbose:
        print(f"📁 {len(ids)} selecionado(s) movido(s) pra 'já usado' (arquivados) — selecionados limpos.")
    return len(ids)


# ---------------------------------------------------------------- gerar texto em capitulos
def cmd_gerar_texto(status="checked", out=None):
    cfg = load_cfg()
    dados = load_dados()
    dec = backend_state() if status in ("checked",) else {}
    by_cat = {c["id"]: c for c in cfg["categorias"]}
    grp = {g["id"]: g for g in cfg["grupos"]}

    def keep(it):
        d = dec.get(it["id"], {})
        s = d.get("status", "pending")
        if status == "checked":
            return s == "checked"
        if status == "novos":
            return s in ("pending", "checked")
        return s != "read"  # all: tudo que nao foi arquivado

    sel = [i for i in dados["itens"] if keep(i)]
    # ordena por grupo -> categoria (ordem do config) -> data desc
    ordem_cat = {c["id"]: n for n, c in enumerate(cfg["categorias"])}
    sel.sort(key=lambda i: (ordem_cat.get(i["cat"], 999), i.get("data", ""), i["titulo"]), reverse=False)

    linhas = []
    linhas.append(f"# Meus assuntos para me atualizar — {today()}")
    linhas.append("")
    linhas.append("Abaixo, os assuntos que selecionei, organizados em capitulos por tema. "
                  "Faca um resumo didatico e aprofundado de cada capitulo, com os pontos-chave, "
                  "o que eu preciso saber e como aplicar na pratica.")
    linhas.append("")
    cats_com_item = [cid for cid in ordem_cat if any(i["cat"] == cid for i in sel)]
    if not cats_com_item:
        print("Nenhum item selecionado (status='%s'). Marque itens na pagina primeiro." % status)
        return
    n_cap = 0
    for cid in cats_com_item:
        c = by_cat[cid]
        itens = [i for i in sel if i["cat"] == cid]
        n_cap += 1
        linhas.append(f"## Capitulo {n_cap} — {c['emoji']} {c['nome']}")
        linhas.append(f"_{c.get('desc','')}_")
        linhas.append("")
        for i in itens:
            linhas.append(f"### {i['titulo']}")
            if i.get("resumo"):
                linhas.append(i["resumo"])
            if i.get("porque"):
                linhas.append(f"Por que importa: {i['porque']}")
            meta = []
            if i.get("fonte"):
                meta.append(f"Fonte: {i['fonte']}")
            if i.get("data"):
                meta.append(f"Data: {i['data']}")
            if i.get("url"):
                meta.append(f"Link: {i['url']}")
            if meta:
                linhas.append(" · ".join(meta))
            linhas.append("")
    txt = "\n".join(linhas).rstrip() + "\n"
    if out:
        open(out, "w", encoding="utf-8").write(txt)
        print(f"✅ Texto salvo em {out} — {n_cap} capitulos, {len(sel)} itens.")
    else:
        print(txt)
    print(f"\n--- {n_cap} capitulos · {len(sel)} itens ({status}) ---", file=sys.stderr)


def cmd_audio_prompt(status="checked"):
    """Texto pro campo 'Personalizar o Resumo em Áudio' do NotebookLM (foco dos apresentadores)."""
    cfg = load_cfg()
    dados = load_dados()
    dec = backend_state() if status == "checked" else {}

    def keep(it):
        s = dec.get(it["id"], {}).get("status", "pending")
        if status == "checked":
            return s == "checked"
        if status == "novos":
            return s in ("pending", "checked")
        return s != "read"

    sel = [i for i in dados["itens"] if keep(i)]
    if not sel:
        print("Nenhum item selecionado (status='%s')." % status)
        return
    linhas = [
        "Este episódio é um resumo de aprendizado para mim, Bruno, dono de uma agência de marketing digital (a MediaGrowth).",
        "",
        "Falem em português do Brasil, com tom prático, direto e envolvente, como dois especialistas conversando de igual para igual comigo. Sem introdução longa e sem definições óbvias.",
        "",
        "Concentrem-se em: (1) o que há de novo e realmente importante em cada tema; (2) os pontos-chave que eu preciso saber; (3) principalmente COMO aplicar na prática, na agência e na minha vida. Tragam números, exemplos e o porquê de cada coisa importar, e fechem cada tema com um próximo passo concreto.",
        "",
        "Conectem os assuntos entre si quando fizer sentido e priorizem insight acionável no lugar de teoria. Podem ser críticos e dar opinião, não só descrever.",
        "",
        f"Abaixo está o roteiro dos {len(sel)} assuntos deste episódio, organizados por tema. Para cada assunto deixei um resumo do que é, por que importa e a referência de onde ele saiu, pra vocês terem contexto e serem precisos ao falar:",
        "",
    ]
    for c in cfg["categorias"]:
        arr = [i for i in sel if i["cat"] == c["id"]]
        if not arr:
            continue
        cab = f"{c['emoji']} {c['nome']}"
        if c.get("desc"):
            cab += f" — {c['desc']}"
        linhas.append(cab)
        for i in arr:
            expl = " ".join((i.get("porque") or i.get("resumo") or "").split()).strip()
            if len(expl) > 240:
                expl = expl[:237].rsplit(" ", 1)[0] + "..."
            ref = i.get("fonte") or ""
            if i.get("url"):
                ref += (" — " if ref else "") + i["url"]
            linha = "- " + i["titulo"] + (f": {expl}" if expl else "")
            if ref:
                linha += f" (Referência: {ref})"
            linhas.append(linha)
        linhas.append("")
    print("\n".join(linhas).rstrip() + "\n")


# ---------------------------------------------------------------- materias (1 pagina por assunto, pro NotebookLM)
MATERIAS = os.path.join(REPO, "materias")


def _esc(s):
    return (str(s if s is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def materia_html(it, cfg):
    """Pagina-materia auto-contida: a NOSSA curadoria do assunto (nao a fonte crua).
       O NotebookLM le ESTE texto, entao o podcast sai da nossa versao."""
    c = next((x for x in cfg["categorias"] if x["id"] == it["cat"]), {})
    catnome = (c.get("emoji", "") + " " + c.get("nome", "")).strip() or it["cat"]
    titulo = it.get("titulo", "Assunto")
    resumo = it.get("resumo", "").strip()
    porque = it.get("porque", "").strip()
    fonte = it.get("fonte", "").strip()
    url = it.get("url", "").strip()
    data = it.get("data", "").strip()
    desc = c.get("desc", "").strip()

    corpo = []
    corpo.append(f'<p class="lead">{_esc(resumo) if resumo else _esc(titulo)}</p>')
    if porque:
        corpo.append('<h2>Por que isso importa</h2>')
        corpo.append(f'<p>{_esc(porque)}</p>')
    corpo.append('<h2>Contexto do tema</h2>')
    corpo.append(f'<p>Este material faz parte do acompanhamento sobre <b>{_esc(catnome)}</b>. '
                 f'{_esc(desc)}</p>')
    src = ""
    if url:
        src = (f'<p class="src">Referencia original: <a href="{_esc(url)}" '
               f'target="_blank" rel="noopener">{_esc(fonte or url)}</a>'
               + (f' · {_esc(data)}' if data else '') + '</p>')

    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="{_esc(resumo[:180] if resumo else titulo)}">
<title>{_esc(titulo)}</title>
<style>
  body{{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:0 auto;padding:32px 22px 60px;color:#1a1a1a;line-height:1.65;font-size:18px}}
  .kicker{{font-family:system-ui,Arial,sans-serif;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:#0f766e;font-weight:700;margin:0 0 6px}}
  h1{{font-size:30px;line-height:1.2;margin:0 0 6px}}
  .meta{{font-family:system-ui,Arial,sans-serif;font-size:13px;color:#6b7280;margin:0 0 22px;border-bottom:1px solid #e5e7eb;padding-bottom:14px}}
  .lead{{font-size:20px;font-weight:600}}
  h2{{font-family:system-ui,Arial,sans-serif;font-size:16px;margin:26px 0 6px;color:#111}}
  .src{{font-family:system-ui,Arial,sans-serif;font-size:13px;color:#6b7280;margin-top:30px;border-top:1px solid #e5e7eb;padding-top:14px}}
  a{{color:#0f766e}}
</style>
</head>
<body>
  <p class="kicker">{_esc(catnome)}</p>
  <h1>{_esc(titulo)}</h1>
  <div class="meta">Material de estudo{(' · ' + _esc(data)) if data else ''}{(' · Fonte: ' + _esc(fonte)) if fonte else ''}</div>
  {''.join(corpo)}
  {src}
</body>
</html>
"""


def cmd_materias(cats=None):
    """Regenera materias/<id>.html pra todo item (ou so das categorias em cats)."""
    cfg = load_cfg()
    dados = load_dados()
    os.makedirs(MATERIAS, exist_ok=True)
    n = 0
    ids_atuais = set()
    for it in dados["itens"]:
        if cats and it["cat"] not in cats:
            continue
        ids_atuais.add(it["id"])
        path = os.path.join(MATERIAS, it["id"] + ".html")
        open(path, "w", encoding="utf-8").write(materia_html(it, cfg))
        n += 1
    print(f"✅ Materias geradas: {n} paginas em materias/")
    return n


# ---------------------------------------------------------------- estudo do podcast
ESTUDOS = os.path.join(REPO, "dados", "estudos.json")
AUDIO_REMOTE = os.environ.get("SA_AUDIO_DIR", "domains/mediagrowth.com.br/public_html/atualizado-audio")
AUDIO_URL = os.environ.get("SA_AUDIO_URL", "https://mediagrowth.com.br/atualizado-audio")


def load_estudos():
    if os.path.exists(ESTUDOS):
        try:
            return json.load(open(ESTUDOS, encoding="utf-8"))
        except Exception:
            pass
    return {"episodios": []}


def _slugify(s):
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (s or "").strip().lower()).strip("-")
    return s[:60] or "episodio"


def cmd_estudo(audio, payload_path, data=None, titulo=None, publicar=False):
    """Cria/atualiza um episodio de estudo: hospeda o audio, grava topicos+transcricao, publica.
       payload.json: { titulo?, temas?[], duracao?, topicos:[{t,sec,txt}], transcricao? }"""
    p = json.load(open(payload_path, encoding="utf-8"))
    data = data or today()
    titulo = titulo or p.get("titulo") or "Episódio"
    slug = _slugify(titulo)
    ep_id = f"{data}-{slug}"

    est = load_estudos()
    prev = next((e for e in est.get("episodios", []) if e.get("id") == ep_id), None)

    audio_url = ""
    if audio and os.path.exists(audio):
        ext = os.path.splitext(audio)[1].lower() or ".m4a"
        fname = f"{ep_id}{ext}"
        sh(["ssh", "-o", "ConnectTimeout=20", SSH, f"mkdir -p {AUDIO_REMOTE} && echo OK"])
        print(f"⬆️  subindo áudio pra Hostinger ({os.path.getsize(audio)//1024//1024} MB)…")
        sh(["scp", "-o", "ConnectTimeout=60", audio, f"{SSH}:{AUDIO_REMOTE}/{fname}"])
        audio_url = f"{AUDIO_URL}/{fname}"
        print(f"✅ áudio no ar: {audio_url}")
    elif audio:
        print(f"⚠️  áudio não encontrado: {audio}")
    elif prev and prev.get("audio_url"):
        audio_url = prev["audio_url"]  # sem --audio: mantem o que ja esta hospedado (nao re-sobe)
        print(f"ℹ️  mantendo o áudio já hospedado: {audio_url}")

    ep = {
        "id": ep_id, "data": data, "titulo": titulo,
        "audio_url": audio_url, "duracao": p.get("duracao") or (prev.get("duracao", "") if prev else ""),
        "temas": p.get("temas", []),
        "topicos": p.get("topicos", []),
        "transcricao": p.get("transcricao", ""),
        "criado_em": now_iso(),
    }
    est["episodios"] = [e for e in est.get("episodios", []) if e.get("id") != ep_id]
    est["episodios"].insert(0, ep)
    est["episodios"].sort(key=lambda e: e.get("data", ""), reverse=True)
    os.makedirs(os.path.dirname(ESTUDOS), exist_ok=True)
    json.dump(est, open(ESTUDOS, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"✅ Episódio '{titulo}' ({data}) gravado: {len(ep['topicos'])} tópicos.")
    # Audio novo enviado => os assuntos selecionados ja foram usados pra gerar o Resumo em Audio:
    # move os SELECIONADOS ('checked') pra JA USADO ('read'), limpando os selecionados pra nao poluir.
    if audio and os.path.exists(audio):
        arquivar_selecionados_backend()
    if publicar:
        cmd_publicar(f"estudo: {titulo} ({data})")


# ---------------------------------------------------------------- deploy (Hostinger)
def _git_backup(msg=None):
    """Versiona so o CODIGO no GitHub (dados pessoais estao no .gitignore). Nao e a hospedagem."""
    try:
        git(["add", "-A"])
        r = subprocess.run(["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True)
        if not r.stdout.strip():
            return
        git(["commit", "-m", msg or f"sempre-atualizado {today()}"])
        subprocess.run(["git", "push", "origin", "main"], cwd=REPO, check=False)
    except Exception as e:
        print(f"ℹ️  backup no git pulado ({e})")


def cmd_deploy_frontend():
    """Sobe a pagina (index/style/app/config + materias) pro public_html/atualizado da Hostinger.
       Injeta cache-busting (?v=stamp) nos assets do index.html -> o navegador sempre pega a ultima versao."""
    sh(["ssh", "-o", "ConnectTimeout=20", SSH, f"mkdir -p {WEB_REMOTE}/materias && echo OK"])
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    os.makedirs(os.path.join(REPO, "_scratch"), exist_ok=True)
    for f in FRONT_FILES:
        p = os.path.join(REPO, f)
        if not os.path.exists(p):
            continue
        if f == "index.html":
            html = open(p, encoding="utf-8").read()
            html = html.replace('href="style.css"', f'href="style.css?v={stamp}"')
            html = html.replace('src="config.js"', f'src="config.js?v={stamp}"')
            html = html.replace('src="app.js"', f'src="app.js?v={stamp}"')
            tmp = os.path.join(REPO, "_scratch", "index.deploy.html")
            open(tmp, "w", encoding="utf-8").write(html)
            sh(["scp", "-o", "ConnectTimeout=30", tmp, f"{SSH}:{WEB_REMOTE}/index.html"])
        else:
            sh(["scp", "-o", "ConnectTimeout=30", p, f"{SSH}:{WEB_REMOTE}/{f}"])
    if os.path.isdir(MATERIAS):
        sh(["rsync", "-az", "--delete", "-e", "ssh", MATERIAS + "/", f"{SSH}:{WEB_REMOTE}/materias/"])
    print(f"✅ Pagina no ar (v={stamp}): {SITE_URL}/?u={USER}")


def cmd_push_content():
    """Sobe o conteudo curado (categorias + radar + estudos) pro dir PRIVADO (fora do web root)."""
    sh(["ssh", "-o", "ConnectTimeout=20", SSH,
        f"mkdir -p {PRIV_REMOTE}/content {PRIV_REMOTE}/state && chmod 700 {PRIV_REMOTE} && echo OK"])
    for src, dst in [(CFG, "categorias.json"), (DADOS, "bruno.json"), (ESTUDOS, "estudos.json")]:
        if os.path.exists(src):
            sh(["scp", "-o", "ConnectTimeout=30", src, f"{SSH}:{PRIV_REMOTE}/content/{dst}"])
    print("✅ Conteudo privado atualizado (categorias + radar + estudos).")


def cmd_publicar(msg=None):
    cmd_materias()          # regenera as paginas-materia (publicas, pro NotebookLM)
    cmd_deploy_frontend()   # pagina -> Hostinger
    cmd_push_content()      # conteudo -> dir privado
    _git_backup(msg)        # backup opcional do codigo no git
    print(f"✅ Publicado: {SITE_URL}/?u={USER}")


def cmd_backend():
    """Deploy do backend PHP (api.php + _ratelimit.php)."""
    sh(["ssh", "-o", "ConnectTimeout=15", SSH,
        f"mkdir -p {API_REMOTE} {PRIV_REMOTE}/state && chmod 700 {PRIV_REMOTE} && echo OK"])
    sh(["scp", "-o", "ConnectTimeout=15", os.path.join(REPO, "api", "api.php"), f"{SSH}:{API_REMOTE}/api.php"])
    rl = os.path.join(REPO, "api", "_ratelimit.php")
    if os.path.exists(rl):
        sh(["scp", "-o", "ConnectTimeout=15", rl, f"{SSH}:{API_REMOTE}/_ratelimit.php"])
    print(f"✅ Backend no ar: {API_URL}")


def cmd_setup():
    """Cria a estrutura na Hostinger e migra o estado antigo (publico -> privado), fechando o vazamento."""
    sh(["ssh", "-o", "ConnectTimeout=20", SSH,
        f"mkdir -p {PRIV_REMOTE}/content {PRIV_REMOTE}/state {WEB_REMOTE}/materias && chmod 700 {PRIV_REMOTE} && echo OK"])
    # migra as marcacoes/notas ja existentes do dir publico antigo pro privado, e apaga o publico (leak)
    subprocess.run(["ssh", "-o", "ConnectTimeout=20", SSH,
        f"if [ -f {API_REMOTE}/data/{USER}.json ]; then cp -n {API_REMOTE}/data/{USER}.json {PRIV_REMOTE}/state/{USER}.json && echo 'estado migrado'; fi; "
        f"rm -rf {API_REMOTE}/data; echo OK"], check=False)
    print("✅ Estrutura criada, estado migrado e dir publico de estado removido (vazamento fechado).")
    print("   Proximo: engine.py set-senha \"SUA_SENHA\"  ->  backend  ->  publicar")


def cmd_set_senha(senha=None):
    """Cria/atualiza o segredo (hash bcrypt da senha + token_secret) FORA do web root, via SSH.
       A senha vai pela STDIN do SSH (cifrado), nunca no argv. O hash e o secret sao gerados NO servidor."""
    senha = (senha or "").strip()
    if len(senha) < 8:
        print("Use: engine.py set-senha \"SUA_SENHA_FORTE\"  (minimo 8 caracteres)."); return
    os.makedirs(os.path.join(REPO, "_scratch"), exist_ok=True)
    helper = os.path.join(REPO, "_scratch", "setpw.php")
    php = (
        "<?php\n"
        "$pw=trim(stream_get_contents(STDIN));\n"
        "if($pw==='' || strlen($pw)<8){fwrite(STDERR,\"senha invalida\\n\");exit(1);}\n"
        f"$dir='{PRIV_REMOTE}';\n"
        "if(!is_dir($dir)) mkdir($dir,0700,true);\n"
        "$c=['password_hash'=>password_hash($pw,PASSWORD_DEFAULT),'token_secret'=>bin2hex(random_bytes(32))];\n"
        "file_put_contents($dir.'/secret.php',\"<?php\\nreturn \".var_export($c,true).\";\\n\");\n"
        "chmod($dir.'/secret.php',0600);\n"
        "echo 'ok';\n"
    )
    open(helper, "w", encoding="utf-8").write(php)
    sh(["scp", "-o", "ConnectTimeout=20", helper, f"{SSH}:~/.sa_setpw.php"])
    print("· definindo a senha no servidor (via STDIN do SSH, sem expor no argv)…")
    p = subprocess.run(["ssh", "-o", "ConnectTimeout=20", SSH, "php ~/.sa_setpw.php; rm -f ~/.sa_setpw.php"],
                       input=senha, capture_output=True, text=True)
    try:
        os.remove(helper)
    except OSError:
        pass
    if "ok" in (p.stdout or ""):
        print("✅ Senha definida. Segredo em atualizado-private/secret.php (chmod 600, fora do web root).")
    else:
        print("❌ Nao consegui definir a senha.")
        if p.stdout: print("   stdout:", p.stdout.strip())
        if p.stderr: print("   stderr:", p.stderr.strip())


def links():
    print(f"  Pagina  : {SITE_URL}/?u={USER}")
    print(f"  Backend : {API_URL}  (login por cookie; use a pagina)")


def cmd_status():
    cfg = load_cfg()
    dados = load_dados()
    dec = backend_state()
    cont = {}
    for i in dados["itens"]:
        cont.setdefault(i["cat"], {"tot": 0, "novos": 0, "sel": 0, "lidos": 0})
        cont[i["cat"]]["tot"] += 1
        s = dec.get(i["id"], {}).get("status", "pending")
        if s == "checked":
            cont[i["cat"]]["sel"] += 1
        elif s == "read":
            cont[i["cat"]]["lidos"] += 1
        else:
            cont[i["cat"]]["novos"] += 1
    print(f"Banco: {len(dados['itens'])} itens · ultima geracao {dados.get('gerado_em','?')}\n")
    print(f"{'categoria':22} {'total':>6} {'novos':>6} {'sel':>5} {'lidos':>6}")
    for c in cfg["categorias"]:
        k = cont.get(c["id"], {"tot": 0, "novos": 0, "sel": 0, "lidos": 0})
        print(f"{c['emoji']+' '+c['nome']:22} {k['tot']:>6} {k['novos']:>6} {k['sel']:>5} {k['lidos']:>6}")


# ---------------------------------------------------------------- main
def arg(name, default=None):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else default


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    c = a[0]
    if c == "coletar":
        cats = arg("--cat")
        cats = [x.strip() for x in cats.split(",")] if cats else None
        cmd_coletar(cats=cats, por_query=int(arg("--por-query", "6")), publicar="--publicar" in a)
    elif c == "contexto":
        cats = arg("--cat")
        cmd_contexto(cats=[x.strip() for x in cats.split(",")] if cats else None)
    elif c == "add":
        cmd_add(arg("--file"), publicar="--publicar" in a)
    elif c == "gerar-texto":
        cmd_gerar_texto(status=arg("--status", "checked"), out=arg("--out"))
    elif c == "materias":
        cats = arg("--cat")
        cmd_materias(cats=[x.strip() for x in cats.split(",")] if cats else None)
    elif c == "audio-prompt":
        cmd_audio_prompt(status=arg("--status", "checked"))
    elif c == "estudo":
        cmd_estudo(arg("--audio"), arg("--file"), data=arg("--data"),
                   titulo=arg("--titulo"), publicar="--publicar" in a)
    elif c == "arquivar-selecionados":
        arquivar_selecionados_backend()
    elif c == "publicar":
        cmd_publicar(arg("-m"))
    elif c == "deploy-frontend":
        cmd_deploy_frontend()
    elif c == "push-content":
        cmd_push_content()
    elif c == "backend":
        cmd_backend()
    elif c == "setup":
        cmd_setup()
    elif c == "set-senha":
        cmd_set_senha(a[1] if len(a) > 1 else None)
    elif c == "link":
        links()
    elif c == "status":
        cmd_status()
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
