<?php
/**
 * Backend do SEMPRE ATUALIZADO — pessoal do Bruno (Hostinger).
 * Estado por SLUG num JSON (data/<slug>.json), com trava de arquivo.
 * As MARCACOES sao chaveadas pelo ID ESTAVEL do item (sha1 do motor) — por isso o que o
 * Bruno marca sobrevive a recoleta diaria: o banco cresce, as marcacoes ficam.
 *
 * status por item:  checked (selecionado p/ o texto) | read (ja li/arquivei) | pending
 *
 * Endpoints:
 *   GET  api.php?action=get&slug=<slug>                 -> estado atual { decisions:{}, updated_at }
 *   POST api.php  action=mark   slug id status          -> marca 1 item
 *   POST api.php  action=bulk   slug ids status         -> marca varios (ids separados por virgula)
 *
 * Sem login (pagina pessoal por slug, noindex). CORS liberado (roda no GitHub Pages).
 */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
@require __DIR__ . '/_ratelimit.php';

$DATA = __DIR__ . '/data';
if (!is_dir($DATA)) { @mkdir($DATA, 0775, true); }

function bad($msg) { http_response_code(400); echo json_encode(['erro' => $msg]); exit; }
function slug_ok($s) { return is_string($s) && preg_match('/^[a-z0-9\-]{1,64}$/', $s); }
function clip($s, $n) { $s = is_string($s) ? $s : ''; return mb_substr(trim($s), 0, $n); }

$slug = $_REQUEST['slug'] ?? '';
if (!slug_ok($slug)) bad('slug invalido');
$file = "$DATA/$slug.json";

function fresh() { return ['decisions' => new stdClass(), 'updated_at' => date('c')]; }

function load_state($file) {
  if (!file_exists($file)) return fresh();
  $j = json_decode(file_get_contents($file), true);
  if (!is_array($j)) return fresh();
  if (!isset($j['decisions'])) $j['decisions'] = new stdClass();
  if (!isset($j['notes']))     $j['notes']     = new stdClass();
  return $j;
}

$action = $_REQUEST['action'] ?? 'get';

if ($action === 'get') {
  echo json_encode(load_state($file), JSON_UNESCAPED_UNICODE);
  exit;
}

/* ---- escrita: trava exclusiva ---- */
$fp = fopen($file, 'c+');
if (!$fp) bad('io');
flock($fp, LOCK_EX);
$st = json_decode(stream_get_contents($fp), true);
if (!is_array($st)) $st = ['decisions' => [], 'notes' => []];
if (!isset($st['decisions']) || !is_array($st['decisions'])) $st['decisions'] = [];
if (!isset($st['notes']) || !is_array($st['notes'])) $st['notes'] = [];

function commit($fp, $st) {
  $st['updated_at'] = date('c');
  ftruncate($fp, 0); rewind($fp);
  fwrite($fp, json_encode($st, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
  fflush($fp);
  flock($fp, LOCK_UN); fclose($fp);
  echo json_encode($st, JSON_UNESCAPED_UNICODE);
  exit;
}
function abort_lock($fp, $msg) { flock($fp, LOCK_UN); fclose($fp); bad($msg); }

$VALID = ['checked', 'read', 'pending'];

if ($action === 'mark') {
  $id     = clip($_POST['id'] ?? '', 40);
  $status = clip($_POST['status'] ?? '', 12);
  if ($id === '') abort_lock($fp, 'id vazio');
  if (!in_array($status, $VALID, true)) abort_lock($fp, 'status invalido');
  if ($status === 'pending') { unset($st['decisions'][$id]); }
  else { $st['decisions'][$id] = ['status' => $status, 'at' => date('c')]; }
  commit($fp, $st);
}

if ($action === 'note') {
  // bloco de notas por episodio de estudo (key = id do episodio)
  $key  = clip($_POST['key'] ?? '', 64);
  $text = clip($_POST['text'] ?? '', 20000);
  if ($key === '') abort_lock($fp, 'key vazia');
  if ($text === '') { unset($st['notes'][$key]); }
  else { $st['notes'][$key] = ['text' => $text, 'at' => date('c')]; }
  commit($fp, $st);
}

if ($action === 'bulk') {
  $ids    = clip($_POST['ids'] ?? '', 20000);
  $status = clip($_POST['status'] ?? '', 12);
  if (!in_array($status, $VALID, true)) abort_lock($fp, 'status invalido');
  foreach (array_filter(array_map('trim', explode(',', $ids))) as $id) {
    $id = mb_substr($id, 0, 40);
    if ($id === '') continue;
    if ($status === 'pending') { unset($st['decisions'][$id]); }
    else { $st['decisions'][$id] = ['status' => $status, 'at' => date('c')]; }
  }
  commit($fp, $st);
}

abort_lock($fp, 'action invalida');
