/*
  ROAKSTASAWD HQ — the server.

  Every read and write goes through here, so the rules are real rules: a banned
  account is refused, an admin power is checked against the database (not the
  page), and a direct message is only ever returned to the two people in it.

  Plain JSON in and out over POST /api, so the Kindle site needs nothing more
  than the XMLHttpRequest it already uses. The site's own files are served from
  the same Worker (see [assets] in wrangler.toml).

  Passwords: the browser sends the password once, over HTTPS; the Worker keeps
  only a PBKDF2-SHA256 hash with a random salt. Nothing readable is stored.

  The site's own files are read from the GitHub repository (see SITE_PATHS), so
  a push to main is live on the HQ's name within a minute.
*/

var OWNER_KEY = 'blockwobble';   // the owner of the HQ
/* The site's own files are read from the repository on GitHub, so a push to the
   site is live on the HQ's name within a minute - nothing to deploy by hand. */
var ASSET_FILES = {};
var REPO = 'helloandhi12345678910-ui/ROAKSTASAWD-HQ';
var BRANCH = 'main';
var CACHE_MS = 60000;          /* how long a fetched file is kept */
var SITE_PATHS = ['index.html', 'css/roak.css', 'js/app.js', 'js/backend.js',
                  'README.md', 'BACKEND.md', 'SECURITY.md', 'DEPLOY.md',
                  'SUBDOMAIN.md', 'DUCKDNS.md', '.nojekyll'];
var cache = {};                /* path -> { text, at } */
var ITERATIONS = 100000;   // the most Cloudflare's PBKDF2 allows
var SESSION_DAYS = 365;

var LIMITS = {
  name: 20, password: 100, passwordMin: 6,
  chat: 500, dm: 500, post: 2000, pin: 2000, reply: 2000,
  title: 80, tag: 16, reason: 200, notice: 500, ai: 4000
};

/* ---------- small helpers ---------- */


var MIME = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  png: 'image/png'
};

/* The site's files live beside the Worker in its own storage: each one was
   uploaded as an extra module, and its text is read from there. */
/* A file of the site: kept in memory for a minute, then fetched again, so a new
   push shows up without anyone deploying. */
async function siteFile(path, wait) {
  var hit = cache[path];
  var now = Date.now();
  if (hit && (now - hit.at) < CACHE_MS) { return hit.text; }
  if (hit && wait) { return hit.text; }
  try {
    var res = await fetch('https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + path,
      { cf: { cacheTtl: 60 } });
    if (res.status !== 200) {
      return hit ? hit.text : null;
    }
    var text = await res.text();
    cache[path] = { text: text, at: now };
    return text;
  } catch (e) {
    return hit ? hit.text : null;
  }
}

async function serveSite(request, url) {
  var path = url.pathname;
  if (path === '/' || path === '') { path = '/index.html'; }
  path = path.replace(/^\.?\/+/, '');
  if (path === '') { path = 'index.html'; }
  if (indexIn(SITE_PATHS, path) < 0) {
    return new Response('Not found.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
  var body = await siteFile(path, false);
  if (body === null) {
    return new Response('That file could not be read from GitHub just now. Try again in a minute.', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
  var ext = path.split('.').pop().toLowerCase();
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=30'
    }
  });
}

function json(obj, status, extra) {
  var headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS'
  };
  if (extra) {
    for (var k in extra) {
      if (extra.hasOwnProperty(k)) { headers[k] = extra[k]; }
    }
  }
  return new Response(JSON.stringify(obj), { status: status || 200, headers: headers });
}

function indexIn(arr, v) {
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === v) { return i; }
  }
  return -1;
}

function str(v, max) {
  var s = String(v === undefined || v === null ? '' : v);
  if (s.length > max) { s = s.slice(0, max); }
  return s;
}

function trim(s) {
  return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, '');
}

function nameKey(n) {
  return trim(String(n || '')).toLowerCase().replace(/\s+/g, ' ');
}

function cleanName(n) {
  return trim(String(n || '')).replace(/\s+/g, ' ').slice(0, LIMITS.name);
}

function newId(prefix, size) {
  var bytes = new Uint8Array(size || 12);
  crypto.getRandomValues(bytes);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return (prefix || 'x') + hex;
}

/* a session token: long, random, and never stored (only its hash is) */
function newToken() {
  return newId('t', 32);
}

function now() {
  return Date.now();
}

function hexOf(buf) {
  var b = new Uint8Array(buf);
  var out = '';
  for (var i = 0; i < b.length; i++) {
    out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  }
  return out;
}

function toBase64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
}

function fromBase64(s) {
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function sha256Hex(text) {
  var d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hexOf(d);
}

async function pbkdf2(password, saltBytes, iterations) {
  var base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' },
    base, 256);
  return hexOf(bits);
}

/* the same length of time either way, so a wrong name and a wrong password
   cannot be told apart by how long the answer takes */
async function burn(password) {
  try {
    await pbkdf2(String(password || 'x'), new Uint8Array(16), ITERATIONS);
  } catch (e) { /* nothing to do */ }
}

function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) { return false; }
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------- the database ---------- */

function db(env) {
  return env.DB;
}

async function one(env, sql, args) {
  var stmt = db(env).prepare(sql);
  if (args && args.length) { stmt = stmt.bind.apply(stmt, args); }
  var r = await stmt.first();
  return r || null;
}

async function all(env, sql, args) {
  var stmt = db(env).prepare(sql);
  if (args && args.length) { stmt = stmt.bind.apply(stmt, args); }
  var r = await stmt.all();
  return (r && r.results) || [];
}

async function run(env, sql, args) {
  var stmt = db(env).prepare(sql);
  if (args && args.length) { stmt = stmt.bind.apply(stmt, args); }
  return stmt.run();
}

/* ---------- who is asking ---------- */

function bearer(request) {
  var h = request.headers.get('authorization') || '';
  var m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : '';
}

async function whoIsIt(env, request) {
  var token = bearer(request);
  if (!token) { return null; }
  var hash = await sha256Hex(token);
  /* "token = ?" is never true for an empty column, so a wiped token cannot
     match anyone (a plain "= NULL" would match every signed-out account) */
  var acc = await one(env, 'SELECT * FROM accounts WHERE token = ? AND token IS NOT NULL', [hash]);
  if (!acc) {
    /* the token was wiped (banned, kicked, signed out, or signed in elsewhere):
       say why if it can be told from a ban record */
    return null;
  }
  if (acc.banned) { return { banned: true, name: acc.name }; }
  return acc;
}

function isOwner(acc) {
  return !!(acc && nameKey(acc.name) === OWNER_KEY);
}

async function isAdmin(env, acc) {
  if (!acc) { return false; }
  if (isOwner(acc)) { return true; }
  var r = await one(env, 'SELECT key FROM admins WHERE key = ?', [acc.key]);
  return !!r;
}

function publicAccount(acc) {
  return {
    name: acc.name,
    admin: !!(acc.admin || nameKey(acc.name) === OWNER_KEY),
    banned: !!acc.banned,
    banReason: acc.ban_reason || '',
    at: acc.created
  };
}

/* ---------- reading ---------- */

async function boardOf(env, kind, limit) {
  var rows = await all(env,
    'SELECT id, by, body, tag, at FROM posts WHERE kind = ? ORDER BY at ASC LIMIT ?',
    [kind, limit || 300]);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var item = { id: r.id, by: r.by, text: r.body, at: r.at };
    if (kind === 'post') { item.tag = r.tag || ''; }
    out.push(item);
  }
  return out;
}

async function topicsOf(env) {
  var tops = await all(env,
    'SELECT id, by, body, at FROM posts WHERE kind = ? ORDER BY at ASC', ['topic']);
  var replies = await all(env,
    'SELECT id, by, body, at, thread FROM posts WHERE kind = ? ORDER BY at ASC', ['reply']);
  var byThread = {};
  for (var i = 0; i < replies.length; i++) {
    var r = replies[i];
    if (!byThread[r.thread]) { byThread[r.thread] = []; }
    byThread[r.thread].push({ id: r.id, by: r.by, text: r.body, at: r.at });
  }
  var out = [];
  for (var j = 0; j < tops.length; j++) {
    var t = tops[j];
    out.push({
      id: t.id, title: t.body, by: t.by, at: t.at,
      replies: byThread[t.id] || []
    });
  }
  return out;
}

async function dmFor(env, acc, id) {
  if (!acc || !id) { return null; }
  if (id.indexOf(acc.key + '~') !== 0 && id.indexOf('~' + acc.key) < 0) {
    return null;   // not one of the two people in this conversation
  }
  var msgs = await all(env,
    'SELECT id, by, body, at FROM posts WHERE kind = ? AND thread = ? ORDER BY at ASC',
    ['dm', id]);
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    out.push({ id: msgs[i].id, by: msgs[i].by, text: msgs[i].body, at: msgs[i].at });
  }
  return out;
}

async function dmListFor(env, acc) {
  if (!acc) { return []; }
  var rows = await all(env,
    'SELECT thread, MAX(at) AS last FROM posts WHERE kind = ? AND thread LIKE ? GROUP BY thread',
    ['dm', '%' + acc.key + '%']);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var id = rows[i].thread;
    if (id.indexOf(acc.key + '~') !== 0 && id.indexOf('~' + acc.key) < 0) { continue; }
    var names = id.split('~');
    out.push({ id: id, names: names, last: rows[i].last });
  }
  return out;
}

async function stateFor(env, acc) {
  var state = {
    meta: { at: now() },
    accounts: [],
    chat: await boardOf(env, 'chat', 300),
    neighborhood: await boardOf(env, 'post', 2000),
    pins: await boardOf(env, 'pin', 2000),
    topics: await topicsOf(env),
    likes: [],
    bans: [],
    notices: [],
    ai: { msgs: [] },
    dm: {}
  };

  var accs = await all(env, 'SELECT * FROM accounts ORDER BY created ASC');
  for (var i = 0; i < accs.length; i++) {
    state.accounts.push(publicAccount(accs[i]));
  }

  var likes = await all(env, 'SELECT post_id, by, at FROM likes ORDER BY at ASC');
  for (var l = 0; l < likes.length; l++) {
    state.likes.push({ id: likes[l].post_id, by: likes[l].by, at: likes[l].at });
  }

  var bans = await all(env, 'SELECT name, reason, by, at FROM bans ORDER BY at ASC');
  for (var b = 0; b < bans.length; b++) {
    state.bans.push({ name: bans[b].name, reason: bans[b].reason, by: bans[b].by, at: bans[b].at });
  }

  var notices = await all(env, 'SELECT kind, body, by, at FROM notices');
  for (var n = 0; n < notices.length; n++) {
    state.notices.push({ id: 'n' + notices[n].kind, kind: notices[n].kind,
      text: notices[n].body, by: notices[n].by, at: notices[n].at });
  }

  /* the AI conversation and the direct messages are only ever this person's */
  if (acc) {
    var ai = await all(env,
      'SELECT id, by, body, at FROM posts WHERE kind = ? AND thread = ? ORDER BY at ASC',
      ['ai', acc.key]);
    for (var a = 0; a < ai.length; a++) {
      state.ai.msgs.push({ id: ai[a].id, by: ai[a].by, text: ai[a].body, at: ai[a].at });
    }
    var list = await dmListFor(env, acc);
    for (var d = 0; d < list.length; d++) {
      var names = {};
      for (var k = 0; k < list[d].names.length; k++) {
        var key = list[d].names[k];
        var named = await one(env, 'SELECT name FROM accounts WHERE key = ?', [key]);
        names[key] = named ? named.name : key;
      }
      state.dm[list[d].id] = { names: names, msgs: await dmFor(env, acc, list[d].id) };
    }
  }

  return state;
}

/* ---------- actions ---------- */

async function signUp(env, p) {
  var name = cleanName(p.name);
  var password = String(p.password || '');
  if (!name) { return { error: 'Type a name.' }; }
  if (name.length < 2) { return { error: 'That name is too short.' }; }
  if (password.length < LIMITS.passwordMin) { return { error: 'The password needs 6 letters or more.' }; }
  if (password.length > LIMITS.password) { return { error: 'That password is too long.' }; }
  var key = nameKey(name);
  var existing = await one(env, 'SELECT id FROM accounts WHERE key = ?', [key]);
  if (existing) { return { error: 'That name is taken. Try another.' }; }

  var saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  var salt = toBase64(saltBytes);
  var hash = await pbkdf2(password, saltBytes, ITERATIONS);
  var token = newToken();
  var id = newId('a');
  var at = now();

  await run(env,
    'INSERT INTO accounts (id, name, key, salt, hash, iter, token, seen, created) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, key, salt, hash, ITERATIONS, await sha256Hex(token), at, at]);

  return { token: token, name: name };
}

async function signIn(env, p) {
  var name = cleanName(p.name);
  var password = String(p.password || '');
  if (!name || !password) { return { error: 'Type your name and password.' }; }
  var acc = await one(env, 'SELECT * FROM accounts WHERE key = ?', [nameKey(name)]);
  if (!acc) {
    await burn(password);
    return { error: 'No account called "' + name + '".' };
  }
  if (acc.banned && nameKey(acc.name) !== OWNER_KEY) {
    return { error: 'That account has been banned from this HQ.' +
      (acc.ban_reason ? ' The reason: ' + acc.ban_reason : '') };
  }
  var hash = await pbkdf2(password, fromBase64(acc.salt), acc.iter || ITERATIONS);
  if (!safeEqual(hash, acc.hash)) {
    return { error: 'Wrong password.' };
  }
  var token = newToken();
  await run(env, 'UPDATE accounts SET token = ?, seen = ? WHERE id = ?',
    [await sha256Hex(token), now(), acc.id]);
  return { token: token, name: acc.name };
}

async function signOut(env, acc) {
  if (acc) { await run(env, 'UPDATE accounts SET token = NULL WHERE id = ?', [acc.id]); }
  return { ok: true };
}

async function addPost(env, acc, kind, body, thread, tag) {
  var id = newId(kind.charAt(0));
  await run(env,
    'INSERT INTO posts (id, kind, thread, by, body, tag, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, kind, thread || '', acc.name, body, tag || '', now()]);
  return id;
}

async function handle(env, request, action, p) {
  var acc = await whoIsIt(env, request);

  if (action === 'state') {
    if (bearer(request) && !acc) { return { error: 'signin' }; }   // the token is dead
    if (acc && acc.banned) { return { error: 'banned' }; }
    return { state: await stateFor(env, acc) };
  }
  if (action === 'signup') { return await signUp(env, p); }
  if (action === 'signin') { return await signIn(env, p); }

  if (action === 'signout') {
    /* wipe whatever token was sent, signed in or not */
    var t = bearer(request);
    if (t) { await run(env, 'UPDATE accounts SET token = NULL WHERE token = ?', [await sha256Hex(t)]); }
    return { ok: true };
  }

  /* everything below needs a signed-in account */
  if (!acc || acc.banned) {
    return { error: acc && acc.banned ? 'banned' : 'signin' };
  }

  if (action === 'post') {
    var kind = String(p.kind || '');
    /* a topic carries its words in the title, everything else in the text */
    var text = kind === 'topic' ? trim(p.title) : trim(p.text);
    if (!text) { return { error: 'Nothing to post.' }; }
    if (kind === 'chat') {
      text = str(text, LIMITS.chat);
      return { id: await addPost(env, acc, 'chat', text) };
    }
    if (kind === 'post') {
      text = str(text, LIMITS.post);
      return { id: await addPost(env, acc, 'post', text, '', str(trim(p.tag), LIMITS.tag)) };
    }
    if (kind === 'pin') {
      text = str(text, LIMITS.pin);
      return { id: await addPost(env, acc, 'pin', text) };
    }
    if (kind === 'topic') {
      var title = str(trim(p.title), LIMITS.title);
      if (!title) { return { error: 'Give the topic a title.' }; }
      return { id: await addPost(env, acc, 'topic', title) };
    }
    if (kind === 'reply') {
      var tid = String(p.thread || '');
      var t = await one(env, 'SELECT id FROM posts WHERE id = ? AND kind = ?', [tid, 'topic']);
      if (!t) { return { error: 'That topic is gone.' }; }
      text = str(text, LIMITS.reply);
      return { id: await addPost(env, acc, 'reply', text, tid) };
    }
    if (kind === 'dm') {
      var did = String(p.thread || '');
      if (did.indexOf(acc.key + '~') !== 0 && did.indexOf('~' + acc.key) < 0) {
        return { error: 'Not your conversation.' };
      }
      text = str(text, LIMITS.dm);
      return { id: await addPost(env, acc, 'dm', text, did) };
    }
    if (kind === 'ai') {
      text = str(text, LIMITS.ai);
      return { id: await addPost(env, acc, 'ai', text, acc.key) };
    }
    return { error: 'Unknown board.' };
  }

  if (action === 'like') {
    var pid = String(p.id || '');
    var had = await one(env, 'SELECT 1 AS x FROM likes WHERE post_id = ? AND by = ?', [pid, acc.name]);
    if (had) {
      await run(env, 'DELETE FROM likes WHERE post_id = ? AND by = ?', [pid, acc.name]);
    } else {
      await run(env, 'INSERT INTO likes (post_id, by, at) VALUES (?, ?, ?)', [pid, acc.name, now()]);
    }
    return { liked: !had };
  }

  if (action === 'delete') {
    var id = String(p.id || '');
    var row = await one(env, 'SELECT * FROM posts WHERE id = ?', [id]);
    if (!row) { return { ok: true }; }
    var admin = await isAdmin(env, acc);
    if (row.by !== acc.name && !admin) { return { error: 'That is not yours to delete.' }; }
    await run(env, 'DELETE FROM posts WHERE id = ? OR (kind = ? AND thread = ?)', [id, 'reply', id]);
    return { ok: true };
  }

  /* ---- admin powers: checked here, on the server ---- */

  if (action.indexOf('admin.') === 0) {
    if (!(await isAdmin(env, acc))) { return { error: 'Admins only.' }; }
    return await adminAction(env, acc, action.slice(6), p);
  }

  return { error: 'Unknown action.' };
}

async function adminAction(env, acc, what, p) {
  var name = cleanName(p.name);
  var key = nameKey(name);

  if (what === 'ban') {
    if (key === OWNER_KEY) { return { error: 'The owner cannot be banned.' }; }
    var reason = str(trim(p.reason), LIMITS.reason);
    await run(env, 'INSERT INTO bans (name, key, reason, by, at) VALUES (?, ?, ?, ?, ?)',
      [name, key, reason, acc.name, now()]);
    await run(env, 'UPDATE accounts SET banned = 1, ban_reason = ?, token = NULL WHERE key = ?',
      [reason, key]);
    return { ok: true };
  }
  if (what === 'unban') {
    await run(env, 'DELETE FROM bans WHERE key = ?', [key]);
    await run(env, 'UPDATE accounts SET banned = 0, ban_reason = ? WHERE key = ?', ['', key]);
    return { ok: true };
  }
  if (what === 'kick') {
    if (key === OWNER_KEY) { return { error: 'The owner cannot be kicked.' }; }
    await run(env, 'UPDATE accounts SET kicked = ?, token = NULL WHERE key = ?', [now(), key]);
    await run(env, 'INSERT INTO kicks (name, by, at) VALUES (?, ?, ?)', [name, acc.name, now()]);
    return { ok: true };
  }
  if (what === 'admin') {
    if (key === OWNER_KEY) { return { error: 'The owner is always an admin.' }; }
    var row = await one(env, 'SELECT admin FROM accounts WHERE key = ?', [key]);
    if (!row) { return { error: 'No such account.' }; }
    var make = row.admin ? 0 : 1;
    await run(env, 'UPDATE accounts SET admin = ? WHERE key = ?', [make, key]);
    if (make) {
      await run(env, 'INSERT OR REPLACE INTO admins (key) VALUES (?)', [key]);
    } else {
      await run(env, 'DELETE FROM admins WHERE key = ?', [key]);
    }
    return { ok: true };
  }
  if (what === 'purge') {
    if (key === OWNER_KEY) { return { error: 'The owner\'s posts stay.' }; }
    await run(env, 'DELETE FROM posts WHERE by = ?', [name]);
    await run(env, 'DELETE FROM likes WHERE by = ?', [name]);
    return { ok: true };
  }
  if (what === 'forget') {
    if (key === OWNER_KEY) { return { error: 'The owner cannot be deleted.' }; }
    await run(env, 'DELETE FROM accounts WHERE key = ?', [key]);
    await run(env, 'DELETE FROM admins WHERE key = ?', [key]);
    await run(env, 'DELETE FROM bans WHERE key = ?', [key]);
    await run(env, 'DELETE FROM posts WHERE by = ?', [name]);
    return { ok: true };
  }
  if (what === 'clear') {
    var kind = String(p.kind || '');
    if (kind === 'topics') {
      await run(env, 'DELETE FROM posts WHERE kind IN (?, ?)', ['topic', 'reply']);
    } else if (kind === 'chat' || kind === 'pin' || kind === 'post') {
      await run(env, 'DELETE FROM posts WHERE kind = ?', [kind]);
    } else {
      return { error: 'Unknown board.' };
    }
    return { ok: true };
  }
  if (what === 'notice') {
    /* a note on the pinboard ('pins') or on the HQ page ('home') */
    var kind = String(p.kind || 'pins');
    if (kind !== 'pins' && kind !== 'home') { return { error: 'Unknown place for a note.' }; }
    var text = str(trim(p.text), LIMITS.notice);
    if (!text) {
      await run(env, 'DELETE FROM notices WHERE kind = ?', [kind]);
    } else {
      await run(env, 'INSERT OR REPLACE INTO notices (kind, body, by, at) VALUES (?, ?, ?, ?)',
        [kind, text, acc.name, now()]);
    }
    return { ok: true };
  }
  return { error: 'Unknown admin action.' };
}

/* ---------- the door ---------- */

export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return json({ ok: true });
    }

    if (url.pathname === '/api') {
      if (request.method !== 'POST') {
        return json({ error: 'POST only.' }, 405);
      }
      var body = {};
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'Bad request.' }, 400);
      }
      var action = String(body.action || '');
      var payload = body.payload || {};
      try {
        var out = await handle(env, request, action, payload);
        return json(out, out && out.error === 'signin' ? 401 : 200);
      } catch (e) {
        return json({ error: 'The server had a problem: ' + (e && e.message ? e.message : 'unknown') }, 500);
      }
    }

    if (url.pathname === '/api' || url.pathname === '/api/') {
      return json({ error: 'POST only.' }, 405);
    }

    /* the site itself, from the files that came up with the Worker */
    return await serveSite(request, url);
  }
};
