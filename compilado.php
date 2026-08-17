<?php
/**
 * compilado.php — junta as materias SELECIONADAS numa PAGINA UNICA, pro NotebookLM ler como 1 fonte so.
 *
 * Por que existe: o campo "Web" do NotebookLM tem limite de links, e os links de referencia
 * (Google News RSS) sao enormes. Colar dezenas de URLs estoura o limite. Aqui o NotebookLM recebe
 * UM link so (este) que ja traz o texto curado de cada assunto + a referencia original embutida.
 *
 * Publico e stateless de proposito (as materias ja sao publicas): recebe ?ids=a,b,c com os ids das
 * materias (materias/<id>.html) e concatena o corpo de cada uma. ids sao validados (hex) -> sem path traversal.
 */
header('Content-Type: text/html; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');

$raw = isset($_GET['ids']) ? (string)$_GET['ids'] : '';
$ids = array_filter(array_map('trim', explode(',', $raw)), function ($x) {
    return preg_match('/^[a-f0-9]{6,40}$/', $x); // ids de materia = hex
});
$ids = array_slice(array_values(array_unique($ids)), 0, 400); // teto de sanidade

$dir = __DIR__ . '/materias/';
$blocks = [];
foreach ($ids as $id) {
    $f = $dir . $id . '.html';
    if (!is_file($f)) continue;                 // item podado/inexistente -> ignora
    $html = @file_get_contents($f);
    if ($html === false) continue;
    if (preg_match('/<body[^>]*>(.*)<\/body>/is', $html, $m)) {
        $blocks[] = trim($m[1]);                 // corpo ja e escapado na geracao (materia_html)
    }
}
$n = count($blocks);
$titulo = 'Compilado de estudo — ' . $n . ($n === 1 ? ' assunto' : ' assuntos');
?><!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="Compilado de assuntos para estudo (NotebookLM).">
<title><?php echo htmlspecialchars($titulo, ENT_QUOTES, 'UTF-8'); ?></title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;max-width:760px;margin:0 auto;padding:32px 22px 80px;color:#1a1a1a;line-height:1.65;font-size:18px}
  .page-head{font-family:system-ui,Arial,sans-serif;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:8px}
  .page-head h1{font-size:24px;margin:0 0 4px}
  .page-head p{font-size:13px;color:#6b7280;margin:0}
  article{border-bottom:1px solid #e5e7eb;margin:0 0 8px;padding:26px 0 12px}
  article:last-of-type{border-bottom:0}
  .kicker{font-family:system-ui,Arial,sans-serif;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:#0f766e;font-weight:700;margin:0 0 6px}
  h1{font-size:26px;line-height:1.2;margin:0 0 6px}
  .meta{font-family:system-ui,Arial,sans-serif;font-size:13px;color:#6b7280;margin:0 0 16px;border-bottom:1px solid #eee;padding-bottom:10px}
  .lead{font-size:20px;font-weight:600}
  h2{font-family:system-ui,Arial,sans-serif;font-size:16px;margin:22px 0 6px;color:#111}
  .src{font-family:system-ui,Arial,sans-serif;font-size:13px;color:#6b7280;margin-top:18px}
  a{color:#0f766e;word-break:break-word}
</style>
</head>
<body>
  <div class="page-head">
    <h1><?php echo htmlspecialchars($titulo, ENT_QUOTES, 'UTF-8'); ?></h1>
    <p>Curadoria do radar &ldquo;Sempre Atualizado&rdquo; do Bruno. Cada bloco traz o resumo do assunto e a refer&ecirc;ncia original de onde ele saiu.</p>
  </div>
<?php if ($n === 0): ?>
  <p>Nenhum assunto encontrado para os ids informados.</p>
<?php else: foreach ($blocks as $b): ?>
  <article><?php echo $b; ?></article>
<?php endforeach; endif; ?>
</body>
</html>
