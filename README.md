# Sempre Atualizado — radar de aprendizado pessoal do Bruno

Sistema pessoal pra se manter atualizado sobre uma lista **fixa** de assuntos (26 categorias em 2 grupos: Empresa & Negócios / Pessoal). A cada run a pesquisa roda, os assuntos **acumulam** por tema, e uma **página com login** deixa o Bruno **marcar** o que interessa. No fim, gera um **texto em capítulos** pra colar no Gemini / NotebookLM resumir. Tem também a aba **Estudo do podcast**.

## 🔐 Login e hospedagem (mesmo domínio → cookie HttpOnly)
Página e API rodam no **mesmo domínio** (Hostinger), então a sessão usa **cookie HttpOnly + Secure + SameSite=Strict** com token **HMAC assinado** (verificação timing-safe + expiração). Login por **senha** (bcrypt).
- Página : `https://mediagrowth.com.br/atualizado/?u=bruno`  → `public_html/atualizado`
- API    : `https://mediagrowth.com.br/atualizado-api/api.php` → `public_html/atualizado-api`
- **Privado (fora do web root):** `~/domains/mediagrowth.com.br/atualizado-private/`
  - `secret.php` — hash bcrypt da senha + `token_secret` (NUNCA no git, chmod 600)
  - `content/` — `categorias.json` + `bruno.json` (radar) + `estudos.json` (só servidos logado)
  - `state/bruno.json` — marcações + notas (só logado)
- Matérias (`atualizado/materias/*.html`) ficam **públicas de propósito** (NotebookLM precisa ler).

Segurança (checklist do Bruno): sessão em cookie HttpOnly (1.4), segredo/dados fora do web root e do git (1.2/8.2), token timing-safe + expiração (7.1/E7/E9), erro de login genérico + throttle (E8/Parte 4), CSRF header guard + SameSite=Strict (E2), security headers (11.3).

## Peças
- `categorias.json` — a lista fixa de assuntos (grupos, emoji, descrição, queries de busca).
- `engine.py` — motor stdlib (Mac e VPS): `coletar` · `add` · `gerar-texto` · `materias` · `estudo` · `publicar` · `deploy-frontend` · `push-content` · `backend` · `setup` · `set-senha` · `status` · `link`.
- `dados/bruno.json` + `dados/estudos.json` — banco acumulado (**gitignore**; sobem só pro dir privado da Hostinger).
- `index.html` + `style.css` + `app.js` + `config.js` — frontend (tema preto+dourado, login, radar, estudo).
- `api/api.php` + `api/_ratelimit.php` — backend na Hostinger. `api/secret.php.example` = template do segredo.

## Setup (uma vez)
```
python3 engine.py setup                       # cria dirs na Hostinger + migra o estado antigo (fecha o vazamento publico)
python3 engine.py set-senha "SUA_SENHA_FORTE" # gera o segredo no servidor (senha via STDIN do SSH)
python3 engine.py backend                     # sobe api.php + _ratelimit.php
python3 engine.py publicar                    # sobe pagina + conteudo
```

## Fluxo diário (a skill faz)
1. **Pesquisa profunda** de todas as categorias (agente) → `engine.py add --file payload.json`.
2. `engine.py coletar` — RSS de backbone (garante volume).
3. `engine.py publicar` — materias + página (Hostinger) + conteúdo (privado) + backup git.
4. Bruno abre a página, **faz login**, **marca** os assuntos, clica **Gerar texto** → copia → Gemini/NotebookLM.

## Estudo do podcast
Manda o áudio (Resumo em Áudio do NotebookLM) → transcreve (Whisper) → o agente monta os tópicos com timestamp → `engine.py estudo --audio ... --file ... --titulo "Título PT" --publicar`. Cada áudio vira **um estudo novo** (agrupados por dia no grid). O reader toca o áudio com **barra de progresso**, o **tópico atual acende** conforme anda, e dá pra **anotar por tópico** (nota escondida até você escrever).

## Estados de um item
`pending` (novo) · `checked` (selecionado pro texto) · `read` (arquivado/já li). Chaveado por **ID estável do item** → o que o Bruno marca sobrevive à recoleta.
