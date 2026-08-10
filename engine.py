#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SEMPRE ATUALIZADO — motor (skill pessoal do Bruno).
Radar de aprendizado: acumula assuntos NOVOS por categoria (lista fixa em categorias.json),
publica uma pagina de checklist (GitHub Pages) que salva o que o Bruno marca (backend PHP na
Hostinger, estado por ID estavel do item -> marca sobrevive a recoleta) e gera um TEXTO em
CAPITULOS com os itens selecionados, pra colar no Gemini/NotebookLM resumir.

Stdlib pura. Roda no Mac e na VPS.

Uso:
  engine.py coletar [--cat id1,id2] [--por-query N] [--publicar]   # RSS backbone (append + dedupe)
  engine.py add --file payload.json [--publicar]                   # ingere pesquisa profunda do agente
  engine.py gerar-texto [--status checked|all|novos] [--out arq]   # monta o texto em capitulos
  engine.py materias [--cat id1,id2]                               # gera materias/<id>.html (curadoria por assunto, pro NotebookLM)
  engine.py publicar [-m "msg"]                                    # git push -> GitHub Pages
  engine.py backend                                                # scp api.php -> Hostinger
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

GH_OWNER = os.environ.get("SA_GH_OWNER", "mediagrowthmkt-debug")
GH_REPO  = os.environ.get("SA_GH_REPO",  "sempre-atualizado")
PAGES    = os.environ.get("SA_PAGES_URL", f"https://{GH_OWNER}.github.io/{GH_REPO}")
SSH      = os.environ.get("MG_HOSTINGER_SSH", "hostinger-mg")
REMOTE   = os.environ.get("SA_HOSTINGER_DIR", "domains/mediagrowth.com.br/public_html/atualizado-api")
API_URL  = os.environ.get("SA_API_URL", "https://mediagrowth.com.br/atualizado-api/api.php")

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
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
           .replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " "))
    return re.sub(r"\s+", " ", s).strip()


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


def parse_rss(xml_bytes, por_query):
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except Exception:
        return out
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
                    "resumo": it["resumo"], "porque": "", "fonte": it["fonte"],
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
    try:
        raw = fetch(f"{API_URL}?action=get&slug={USER}", timeout=15)
        st = json.loads(raw.decode("utf-8"))
        return st.get("decisions", {}) or {}
    except Exception as e:
        print(f"⚠️  não consegui ler o backend ({e}). Uso só o banco local.")
        return {}


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
<meta name="viewport" content="width=device-width, initial-scale=1">
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


# ---------------------------------------------------------------- publicar / backend / status
def cmd_publicar(msg=None):
    cmd_materias()  # sempre regenera as paginas-materia antes de publicar
    git(["add", "-A"])
    r = subprocess.run(["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True)
    if not r.stdout.strip():
        print("Nada novo para publicar.")
        return
    git(["commit", "-m", msg or f"atualiza sempre-atualizado {today()}"])
    git(["push", "origin", "main"])
    print(f"✅ Publicado. Pagina: {PAGES}/?u={USER}  (leva ~1 min pra atualizar)")


def cmd_backend():
    sh(["ssh", "-o", "ConnectTimeout=15", SSH,
        f"mkdir -p {REMOTE}/data && chmod 775 {REMOTE}/data && echo OK"])
    sh(["scp", "-o", "ConnectTimeout=15", os.path.join(REPO, "api", "api.php"), f"{SSH}:{REMOTE}/api.php"])
    rl = os.path.join(REPO, "api", "_ratelimit.php")
    if os.path.exists(rl):
        sh(["scp", "-o", "ConnectTimeout=15", rl, f"{SSH}:{REMOTE}/_ratelimit.php"])
    print(f"✅ Backend no ar: {API_URL}")


def links():
    print(f"  Pagina  : {PAGES}/?u={USER}")
    print(f"  Backend : {API_URL}?action=get&slug={USER}")


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
    elif c == "add":
        cmd_add(arg("--file"), publicar="--publicar" in a)
    elif c == "gerar-texto":
        cmd_gerar_texto(status=arg("--status", "checked"), out=arg("--out"))
    elif c == "materias":
        cats = arg("--cat")
        cmd_materias(cats=[x.strip() for x in cats.split(",")] if cats else None)
    elif c == "publicar":
        cmd_publicar(arg("-m"))
    elif c == "backend":
        cmd_backend()
    elif c == "link":
        links()
    elif c == "status":
        cmd_status()
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
