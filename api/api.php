<?php
/**
 * SEMPRE ATUALIZADO — backend (Hostinger, MESMO dominio da pagina: mediagrowth.com.br).
 *
 * Seguranca (checklist do Bruno):
 *  - Auth por SENHA -> cookie de sessao HttpOnly + Secure + SameSite=Strict (token HMAC assinado). (1.4)
 *  - Segredo (hash da senha + secret do HMAC) FORA do web root, nunca no git.                       (1.2)
 *  - Conteudo curado (categorias/radar/estudos) e estado (marcacoes/notas) FORA do web root.        (8.2)
 *  - Verificacao de token timing-safe (hash_equals) + expiracao.                                    (7.1, E7, E9)
 *  - Erro de login generico (anti account enumeration) + jitter.                                    (E8)
 *  - Throttle de login por IP alem do rate-limit geral.                                             (Parte 4)
 *  - Writes exigem header custom X-SA-App (nao setavel cross-site sem CORS) + SameSite=Strict.       (E2 CSRF)
 *  - Security headers, no-store, sem CORS aberto (mesma origem).                                    (11.3, E1)
 *  - Limite de corpo por campo.                                                                     (E10)
 *
 * Layout no servidor:
 *   public_html/atualizado-api/api.php          (este arquivo)
 *   ../../atualizado-private/secret.php         (return ['password_hash'=>..., 'token_secret'=>...])
 *   ../../atualizado-private/content/*.json     (categorias.json, bruno.json, estudos.json)  <- so leitura
 *   ../../atualizado-private/state/<slug>.json  (decisions + notes)                          <- leitura/escrita
 *
 * Endpoints:
 *   POST action=login   password=...            -> seta cookie de sessao          { ok:true }
 *   GET  action=me                              -> { auth:true, sub } | 401 { auth:false }
 *   POST action=logout                          -> limpa o cookie                 { ok:true }
 *   GET  action=data                            -> { categorias, radar, estudos } (gated)
 *   GET  action=get                             -> { decisions, notes, updated_at } (gated)
 *   POST action=mark  id status                 -> marca 1 item                    (gated + write guard)
 *   POST action=bulk  ids status                -> marca varios                    (gated + write guard)
 *   POST action=note  key text                  -> nota de estudo (por topico/ep)  (gated + write guard)
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');
header('Vary: Cookie');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }
@require __DIR__ . '/_ratelimit.php';

$PRIV    = __DIR__ . '/../../atualizado-private';
$CONTENT = $PRIV . '/content';
$STATE   = $PRIV . '/state';
$SECRET  = $PRIV . '/secret.php';
$COOKIE  = 'sa_session';
$TTL     = 30 * 24 * 3600; // 30 dias

if (!is_dir($STATE)) { @mkdir($STATE, 0700, true); }

function jexit($data, $code = 200) {
  http_response_code($code);
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
  exit;
}
function bad($msg, $code = 400) { jexit(['erro' => $msg], $code); }
function clip($s, $n) { $s = is_string($s) ? $s : ''; return mb_substr(trim($s), 0, $n); }

/* ---------- segredo (fora do web root) ---------- */
if (!is_file($SECRET)) bad('backend nao configurado (secret ausente)', 500);
$cfg = require $SECRET;
if (!is_array($cfg) || empty($cfg['password_hash']) || empty($cfg['token_secret'])) {
  bad('backend mal configurado', 500);
}

/* ---------- token de sessao (HMAC assinado) ---------- */
function b64url_e($s) { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64url_d($s) { return base64_decode(strtr($s, '-_', '+/')); }

function make_token($sub, $secret, $ttl) {
  $payload = json_encode(['sub' => $sub, 'iat' => time(), 'exp' => time() + $ttl]);
  $p = b64url_e($payload);
  $sig = b64url_e(hash_hmac('sha256', $p, $secret, true));
  return $p . '.' . $sig;
}
function verify_token($tok, $secret) {
  if (!is_string($tok) || substr_count($tok, '.') !== 1) return null;
  list($p, $sig) = explode('.', $tok, 2);
  $expected = b64url_e(hash_hmac('sha256', $p, $secret, true));
  if (!hash_equals($expected, $sig)) return null;             // timing-safe
  $data = json_decode(b64url_d($p), true);
  if (!is_array($data) || (int)($data['exp'] ?? 0) < time()) return null;
  return $data;
}
function cookie_secure() {
  // https detectado direto OU por proxy; em producao (dominio real) forca Secure.
  // So libera cookie inseguro em localhost (testes locais via http).
  $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || ((int)($_SERVER['SERVER_PORT'] ?? 0) === 443);
  $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
  $local = ($host === '' || strpos($host, 'localhost') === 0 || strpos($host, '127.0.0.1') === 0);
  return $https || !$local;
}
function set_session_cookie($tok, $ttl) {
  setcookie('sa_session', $tok, [
    'expires'  => time() + $ttl,
    'path'     => '/',
    'secure'   => cookie_secure(),
    'httponly' => true,
    'samesite' => 'Strict',
  ]);
}
function clear_session_cookie() {
  setcookie('sa_session', '', [
    'expires'  => time() - 3600,
    'path'     => '/',
    'secure'   => cookie_secure(),
    'httponly' => true,
    'samesite' => 'Strict',
  ]);
}

/* ---------- throttle de login (anti brute force) ---------- */
function login_throttle() {
  try {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'x';
    $dir = sys_get_temp_dir() . '/mg_sa_login';
    if (!is_dir($dir)) { @mkdir($dir, 0700, true); }
    $key = $dir . '/' . md5($ip);
    $now = time(); $window = 300; $limit = 12; // 12 tentativas / 5 min
    $st = @json_decode(@file_get_contents($key), true);
    if (!is_array($st) || ($now - ($st['t'] ?? 0)) > $window) { $st = ['t' => $now, 'c' => 0]; }
    $st['c']++;
    @file_put_contents($key, json_encode($st), LOCK_EX);
    if ($st['c'] > $limit) {
      header('Retry-After: ' . $window);
      bad('muitas tentativas, tente mais tarde', 429);
    }
  } catch (\Throwable $e) { /* fail-open */ }
}

$action = $_REQUEST['action'] ?? 'me';

/* ---------- LOGIN (unica rota publica) ---------- */
if ($action === 'login') {
  if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') bad('metodo', 405);
  login_throttle();
  $pw = (string)($_POST['password'] ?? '');
  usleep(random_int(120000, 260000)); // jitter (dificulta timing) + atrito
  if ($pw === '' || strlen($pw) > 256 || !password_verify($pw, $cfg['password_hash'])) {
    bad('credenciais invalidas', 401);  // generica
  }
  set_session_cookie(make_token('bruno', $cfg['token_secret'], $TTL), $TTL);
  jexit(['ok' => true]);
}

/* ---------- sessao ---------- */
$sess = verify_token($_COOKIE[$COOKIE] ?? null, $cfg['token_secret']);

if ($action === 'me') {
  if (!$sess) jexit(['auth' => false], 401);
  jexit(['auth' => true, 'sub' => $sess['sub']]);
}
if ($action === 'logout') {
  clear_session_cookie();
  jexit(['ok' => true]);
}
if (!$sess) bad('nao autenticado', 401);
$sub = preg_replace('/[^a-z0-9\-]/', '', (string)$sess['sub']) ?: 'bruno';

/* ---------- helpers ---------- */
function read_json($f, $fallback) {
  if (!is_file($f)) return $fallback;
  $j = json_decode(file_get_contents($f), true);
  return is_array($j) ? $j : $fallback;
}
function require_write_guard() {
  if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') bad('metodo', 405);
  if (($_SERVER['HTTP_X_SA_APP'] ?? '') !== '1') bad('requisicao nao permitida', 403); // CSRF guard
}

/* ---------- DATA: conteudo curado (gated) ---------- */
if ($action === 'data') {
  jexit([
    'categorias' => read_json("$CONTENT/categorias.json", ['grupos' => [], 'categorias' => []]),
    'radar'      => read_json("$CONTENT/$sub.json", ['itens' => [], 'gerado_em' => '']),
    'estudos'    => read_json("$CONTENT/estudos.json", ['episodios' => []]),
  ]);
}

/* ---------- GET: estado (marcacoes + notas) do usuario ---------- */
$file = "$STATE/$sub.json";

if ($action === 'get') {
  $st = read_json($file, ['decisions' => new stdClass(), 'notes' => new stdClass(), 'updated_at' => '']);
  if (!isset($st['decisions'])) $st['decisions'] = new stdClass();
  if (!isset($st['notes']))     $st['notes']     = new stdClass();
  if (!isset($st['progress']))  $st['progress']  = new stdClass();
  jexit($st);
}

/* ---------- escrita: trava exclusiva ---------- */
$VALID = ['checked', 'read', 'pending'];

if (in_array($action, ['mark', 'bulk', 'note', 'progress'], true)) {
  require_write_guard();
  $fp = fopen($file, 'c+');
  if (!$fp) bad('io', 500);
  flock($fp, LOCK_EX);
  $st = json_decode(stream_get_contents($fp), true);
  if (!is_array($st)) $st = ['decisions' => [], 'notes' => []];
  if (!isset($st['decisions']) || !is_array($st['decisions'])) $st['decisions'] = [];
  if (!isset($st['notes']) || !is_array($st['notes']))         $st['notes']     = [];
  if (!isset($st['progress']) || !is_array($st['progress']))   $st['progress']  = [];

  $commit = function () use ($fp, &$st) {
    $st['updated_at'] = date('c');
    ftruncate($fp, 0); rewind($fp);
    fwrite($fp, json_encode($st, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    fflush($fp); flock($fp, LOCK_UN); fclose($fp);
    jexit($st);
  };
  $abort = function ($msg, $code = 400) use ($fp) { flock($fp, LOCK_UN); fclose($fp); bad($msg, $code); };

  if ($action === 'mark') {
    $id     = clip($_POST['id'] ?? '', 40);
    $status = clip($_POST['status'] ?? '', 12);
    if ($id === '') $abort('id vazio');
    if (!in_array($status, $VALID, true)) $abort('status invalido');
    if ($status === 'pending') unset($st['decisions'][$id]);
    else $st['decisions'][$id] = ['status' => $status, 'at' => date('c')];
    $commit();
  }

  if ($action === 'bulk') {
    $ids    = clip($_POST['ids'] ?? '', 20000);
    $status = clip($_POST['status'] ?? '', 12);
    if (!in_array($status, $VALID, true)) $abort('status invalido');
    foreach (array_filter(array_map('trim', explode(',', $ids))) as $id) {
      $id = mb_substr($id, 0, 40);
      if ($id === '') continue;
      if ($status === 'pending') unset($st['decisions'][$id]);
      else $st['decisions'][$id] = ['status' => $status, 'at' => date('c')];
    }
    $commit();
  }

  if ($action === 'note') {
    // nota de estudo (por topico/ep) OU anotacao avulsa (key "ins:<ts>").
    // aceita star (insight validado) e tag (tema livre, usado nas avulsas). Preserva o "at" de criacao.
    $key  = clip($_POST['key'] ?? '', 120);
    $text = clip($_POST['text'] ?? '', 20000);
    $star = (($_POST['star'] ?? '') === '1');
    $tag  = clip($_POST['tag'] ?? '', 160);
    if ($key === '') $abort('key vazia');
    if ($text === '') { unset($st['notes'][$key]); }   // sem texto = nota removida
    else {
      $prev = (isset($st['notes'][$key]) && is_array($st['notes'][$key])) ? $st['notes'][$key] : [];
      $n = ['text' => $text];
      $n['at'] = isset($prev['at']) ? $prev['at'] : date('c');   // criacao preservada
      $n['up'] = date('c');                                      // ultima edicao
      if ($star)      $n['star'] = true;
      if ($tag !== '') $n['tag'] = $tag;
      $st['notes'][$key] = $n;
    }
    $commit();
  }

  if ($action === 'progress') {
    // posicao de escuta (segundos) por episodio -> retomar de onde parou
    $key = clip($_POST['key'] ?? '', 80);          // id do episodio
    if ($key === '') $abort('key vazia');
    $pos = (float)($_POST['pos'] ?? 0);
    if ($pos < 0) $pos = 0;
    if ($pos > 100000) $pos = 100000;
    $st['progress'][$key] = round($pos, 1);
    $commit();
  }
}

bad('action invalida', 404);
