# Sempre Atualizado — radar de aprendizado pessoal do Bruno

Sistema pessoal pra se manter atualizado sobre uma lista **fixa** de assuntos (26 categorias em 2 grupos: Empresa & Negócios / Pessoal). A cada run a pesquisa roda, os assuntos **acumulam** por tema, e uma **página de checklist** hospedada deixa o Bruno **marcar** o que interessa. No fim, gera um **texto em capítulos** pra colar no Gemini / NotebookLM resumir.

## Peças
- `categorias.json` — a lista fixa de assuntos (grupos, emoji, descrição, queries de busca).
- `engine.py` — motor stdlib (Mac e VPS): `coletar` (RSS backbone), `add` (ingere a pesquisa profunda do agente), `gerar-texto`, `publicar`, `backend`, `status`, `link`.
- `dados/bruno.json` — banco acumulado de itens (commitado → publicado no GitHub Pages).
- `index.html` + `style.css` + `app.js` + `config.js` — frontend do checklist.
- `api/api.php` + `api/_ratelimit.php` — backend na Hostinger (guarda o que o Bruno marca, por ID estável do item → sobrevive à recoleta).

## Fluxo diário (a skill faz)
1. **Pesquisa profunda** de todas as categorias (agente) → grava payload → `engine.py add --file payload.json`.
2. `engine.py coletar` — RSS de backbone (garante volume mesmo sem a pesquisa).
3. `engine.py publicar` — git push → GitHub Pages atualiza o banco.
4. Bruno abre a página, **marca** os assuntos, clica **Gerar texto** → copia → Gemini/NotebookLM.

## Links
- Página : https://mediagrowthmkt-debug.github.io/sempre-atualizado/?u=bruno
- Backend: https://mediagrowth.com.br/atualizado-api/api.php?action=get&slug=bruno

## Estados de um item
`pending` (novo) · `checked` (selecionado pro texto) · `read` (arquivado/já li).
