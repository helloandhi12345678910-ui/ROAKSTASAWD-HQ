/* ROAKSTASAWD HQ — shared engine
   Written for old browsers: ES5 only, no fetch, no arrow functions,
   no template literals, no let/const. Works on Kindle's experimental browser.

   Data lives in one JSON tree shared by everyone, held in any HTTP backend that
   can GET and PUT a JSON document. Firebase Realtime Database is the one set up
   in js/backend.js. Every write reads the latest copy, changes its own piece and
   puts it back, so nobody's post is lost to a stale page.

   The same document is read constantly (every second on the chat page), so this
   doubles as the "real time" layer: a post on one Kindle shows up on the others
   within a second or two, and straight after your own writes. */

var ROAK = (function () {

  var LS_KEY = 'roak.v2';          /* local cache of the shared tree */
  var ME_KEY = 'roak.me';          /* { name, key } of the signed-in account */
  var VIEW_KEY = 'roak.view';      /* how many chat messages to show */
  var CHAT_SHOWN = 100;            /* chat messages rendered at once */
  var KEEP_CHAT = 300;             /* chat messages kept in the database */
  var FAST_MS = 1000;              /* refresh rate on the chat page */
  var SLOW_MS = 5000;              /* refresh rate everywhere else */

  /* ---------- backend selection ---------- */

  function backend() {
    var b = window.ROAK_BACKEND;
    if (b && b.url && b.url.indexOf('http') === 0 && b.url.indexOf('YOUR-') < 0) {
      return b;
    }
    return null;
  }

  function cloudOn() {
    return backend() !== null;
  }

  function rootUrl() {
    var u = backend().url;
    if (u.charAt(u.length - 1) !== '/') { u += '/'; }
    return u;
  }

  /* ---------- the tree ---------- */

  function blank() {
    return {
      meta: { updated: 0, by: '' },
      accounts: [],
      chat: [],
      neighborhood: [],
      topics: [],
      pins: [],
      likes: []
    };
  }

  function normalize(d) {
    if (!d || typeof d !== 'object') { d = {}; }
    var b = blank();
    if (!d.meta || typeof d.meta !== 'object') { d.meta = b.meta; }
    if (!d.accounts) { d.accounts = b.accounts; }
    if (!d.chat || !d.chat.length && typeof d.chat !== 'object') { d.chat = b.chat; }
    if (!d.neighborhood) { d.neighborhood = b.neighborhood; }
    if (!d.topics) { d.topics = b.topics; }
    if (!d.pins) { d.pins = b.pins; }
    if (!d.likes) { d.likes = b.likes; }
    return d;
  }

  /* Realtime Database gives back an object keyed by push id, not an array */
  function list(v) {
    if (!v) { return []; }
    if (v.length !== undefined) { return v; }
    var out = [];
    for (var k in v) {
      if (v.hasOwnProperty(k) && v[k] && typeof v[k] === 'object') {
        if (!v[k].id) { v[k].id = k; }
        out.push(v[k]);
      }
    }
    out.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    return out;
  }

  var tree = blank();
  var state = 'start';   /* start | loading | ready | offline | empty */
  var lastError = '';
  var poller = null;
  var polling = false;
  var tick = 0;

  function localGet() {
    var raw = null;
    try { raw = window.localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
    if (!raw) { return null; }
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function localPut(d) {
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {}
  }

  /* A stable fingerprint of everything a page shows, so a redraw only happens
     when something actually changed. */
  function sig(d) {
    try { return JSON.stringify(d); } catch (e) { return String((new Date()).getTime()); }
  }

  /* Pull the shared copy into memory. Falls back to the local copy. */
  function pull(cb) {
    var cached = localGet();
    if (cached) { tree = normalize(cached); }

    if (!cloudOn()) {
      state = cached ? 'ready' : 'empty';
      if (cb) { cb(false); }
      return;
    }

    if (state !== 'ready') { state = 'loading'; }
    var req = new XMLHttpRequest();
    var url = rootUrl() + 'hq.json?ts=' + (new Date()).getTime();
    req.open('GET', url, true);
    req.onreadystatechange = function () {
      if (req.readyState !== 4) { return; }
      var changed = false;
      if (req.status >= 200 && req.status < 300) {
        var d = null;
        try { d = JSON.parse(req.responseText); } catch (e) { d = null; }
        if (d) {
          var before = sig(tree);
          tree = normalize(d);
          localPut(tree);
          changed = sig(tree) !== before;
          state = 'ready';
        } else {
          state = cached ? 'ready' : 'empty';
        }
      } else if (req.status === 0) {
        state = 'offline';
        lastError = 'No connection';
      } else {
        state = 'offline';
        lastError = 'Server said ' + req.status;
      }
      if (cb) { cb(changed); }
    };
    try {
      req.send(null);
    } catch (e) {
      state = 'offline';
      lastError = 'No connection';
      if (cb) { cb(false); }
    }
  }

  /* Read-modify-write the whole tree. change() edits the tree in place. */
  function change(fn, cb) {
    pull(function () {
      var d = tree;
      fn(d);
      d.meta = { updated: (new Date()).getTime(), by: me() };
      if (d.chat.length > KEEP_CHAT) {
        d.chat = d.chat.slice(d.chat.length - KEEP_CHAT);
      }
      tree = d;
      localPut(tree);

      if (!cloudOn()) {
        state = 'ready';
        if (cb) { cb(true); }
        return;
      }

      var req = new XMLHttpRequest();
      req.open('PUT', rootUrl() + 'hq.json', true);
      try { req.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
      req.onreadystatechange = function () {
        if (req.readyState !== 4) { return; }
        if (req.status >= 200 && req.status < 300) {
          state = 'ready';
          lastError = '';
          if (cb) { cb(true); }
        } else {
          state = 'offline';
          lastError = req.status === 0 ? 'No connection' : 'Server said ' + req.status;
          if (cb) { cb(false); }
        }
      };
      try {
        req.send(JSON.stringify(tree));
      } catch (e) {
        state = 'offline';
        lastError = 'No connection';
        if (cb) { cb(false); }
      }
    });
  }

  /* ---------- live refresh ---------- */

  function fastRoute() {
    var r = route();
    return r === 'chat' || r === 'home';
  }

  function refresh() {
    if (polling || !cloudOn()) { return; }
    polling = true;
    pull(function (changed) {
      polling = false;
      tick++;
      var box = document.getElementById('live');
      if (box) {
        var h = stampLine();
        if (box.innerHTML !== h) { box.innerHTML = h; }
      }
      if (!changed) { return; }
      if (r === 'chat') { softChat(); }
      else { renderSoft(); }
    });
  }

  function startPolling() {
    if (poller || !cloudOn()) { return; }
    poller = window.setInterval(function () {
      refresh();
    }, FAST_MS);
    try {
      window.addEventListener('focus', refresh, false);
    } catch (e) {}
  }

  /* a message's "3m ago" needs to keep up even when nothing arrives */
  function stampAge(ts) {
    var diff = (new Date()).getTime() - (ts || 0);
    if (diff < 45000) { return 'now'; }
    if (diff < 3600000) { return Math.floor(diff / 60000) + 'm'; }
    return Math.floor(diff / 3600000) + 'h';
  }

  function stampLine() {
    var t = tree.meta && tree.meta.updated ? tree.meta.updated : 0;
    return '<span class="dot"></span>' +
      (state === 'offline'
        ? 'Offline — showing the copy on this device'
        : 'Live · ' + (t ? 'last post ' + when(t) + (tree.meta.by ? ' by ' + esc(tree.meta.by) : '') : 'no posts yet') +
          ' · checked ' + (tick ? 'just now' : '…'));
  }

  /* ---------- accounts ---------- */

  /* What is in the database about an account:
       { id, name, hash, salt, at }
     The password itself is never stored, never sent and never kept anywhere but
     the browser's memory while you type it. Only a slow salted hash goes up. */

  var PBKDF2_ITER = 60000;          /* enough for a small group, fast enough on a Kindle */
  var HASH_BUDGET_MS = 4000;        /* a hash slower than this is too much for a Kindle */
  var TRY_MS = 15000;               /* a Kindle can be very slow: wait this long for PBKDF2 */

  function me() {
    var raw = null;
    try { raw = window.localStorage.getItem(ME_KEY); } catch (e) {}
    if (!raw) { return ''; }
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { o = null; }
    if (o && o.name) { return o.name; }
    return '';                       /* old plain-name sign-ins are not accounts */
  }

  function setMe(name) {
    try {
      if (name) { window.localStorage.setItem(ME_KEY, JSON.stringify({ name: name })); }
      else { window.localStorage.removeItem(ME_KEY); }
    } catch (e) {}
    return name;
  }

  function cleanName(n) {
    return String(n || '').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
  }

  /* Names are compared without case or spacing, so "Big Joe", "bigjoe" and
     "BIG JOE" are the same account. */
  function nameKey(n) {
    return cleanName(n).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function findAccount(name) {
    var k = nameKey(name);
    if (!k) { return null; }
    var accs = list(tree.accounts);
    for (var i = 0; i < accs.length; i++) {
      if (nameKey(accs[i].name) === k) { return accs[i]; }
    }
    return null;
  }

  function signedIn() {
    return me() !== '';
  }

  function needName() {
    if (signedIn()) { return true; }
    openSignin('in');
    toast('Sign in first');
    return false;
  }

  /* ---------- hashing ---------- */

  function hexOf(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      s += h.length < 2 ? '0' + h : h;
    }
    return s;
  }

  function bytesOfHex(hex) {
    var out = [];
    for (var i = 0; i < hex.length; i += 2) { out.push(parseInt(hex.substr(i, 2), 16)); }
    return out;
  }

  function randomSalt() {
    var bytes = [];
    var strong = false;
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        var buf = new Uint8Array(16);
        window.crypto.getRandomValues(buf);
        for (var i = 0; i < buf.length; i++) { bytes.push(buf[i]); }
        strong = true;
      }
    } catch (e) { strong = false; }
    if (!strong) {
      for (var j = 0; j < 16; j++) { bytes.push(Math.floor(Math.random() * 256)); }
    }
    return hexOf(bytes);
  }


  /* ---------- fallback hash: a compact SHA-256, for browsers without Web Crypto ---------- */

  var HASH_BROKEN_KEY = 'roak.nohwc';

  function hashBroken() {
    try { return window.localStorage.getItem(HASH_BROKEN_KEY) === '1'; } catch (e) { return false; }
  }

  function markHashBroken() {
    try { window.localStorage.setItem(HASH_BROKEN_KEY, '1'); } catch (e) {}
  }

  function sha256Hex(str) {
    function rrot(x, n) { return (x >>> n) | (x << (32 - n)); }
    var K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];

    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) { bytes.push(c); }
      else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) { bytes.push(0); }
    for (var b = 7; b >= 0; b--) {
      bytes.push(b >= 4 ? 0 : ((bitLen >>> (b * 8)) & 255));
    }

    var w = [];
    for (var off = 0; off < bytes.length; off += 64) {
      var t;
      for (t = 0; t < 16; t++) {
        w[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) |
               (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
      }
      for (t = 16; t < 64; t++) {
        var s0 = rrot(w[t - 15], 7) ^ rrot(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rrot(w[t - 2], 17) ^ rrot(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], bb = H[1], cc = H[2], dd = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22);
        var maj = (a & bb) ^ (a & cc) ^ (bb & cc);
        var temp2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (dd + temp1) | 0;
        dd = cc; cc = bb; bb = a; a = (temp1 + temp2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + cc) | 0; H[3] = (H[3] + dd) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = '';
    for (var k = 0; k < 8; k++) {
      var v = H[k] >>> 0;
      out += ('00000000' + v.toString(16)).slice(-8);
    }
    return out;
  }

  /* Every account records which method made its hash, because a browser can
     advertise Web Crypto and then be too slow for it, or never answer at all.
     Both methods are salted and deterministic, so any device can check any
     account as long as it uses the method the account was made with. */
  function hashPassword(password, saltHex, done) {
    var plain = function () {
      done('sha256$' + hexOf(bytesOfHex(sha256Hex(saltHex + ':' + password))));
    };
    var subtle = null;
    try { subtle = window.crypto && window.crypto.subtle ? window.crypto.subtle : null; } catch (e) { subtle = null; }
    var enc = null;
    try { enc = window.TextEncoder ? new window.TextEncoder() : null; } catch (e) { enc = null; }

    if (!subtle || !enc || !subtle.importKey || !subtle.deriveBits || hashBroken()) {
      plain();
      return;
    }

    var saltBytes = new Uint8Array(bytesOfHex(saltHex));
    var pwBytes = enc.encode(password);
    var started = (new Date()).getTime();
    var settled = false;

    function give(hash) {
      if (settled) { return; }
      settled = true;
      done(hash);
    }

    window.setTimeout(function () {
      if (settled) { return; }
      markHashBroken();           /* still nothing after a long wait: not usable here */
      give('sha256$' + hexOf(bytesOfHex(sha256Hex(saltHex + ':' + password))));
    }, TRY_MS);

    try {
      subtle.importKey('raw', pwBytes, { name: 'PBKDF2' }, false, ['deriveBits'])
        .then(function (km) {
          return subtle.deriveBits(
            { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITER, hash: 'SHA-256' },
            km, 256);
        })
        .then(function (bits) {
          if (settled) { return; }
          if ((new Date()).getTime() - started > HASH_BUDGET_MS) {
            markHashBroken();     /* too slow on this device: use the fallback from now on */
            give('sha256$' + hexOf(bytesOfHex(sha256Hex(saltHex + ':' + password))));
            return;
          }
          give('pbkdf2:' + PBKDF2_ITER + '$' + hexOf(new Uint8Array(bits)));
        })
        .catch(function () {
          markHashBroken();
          give('sha256$' + hexOf(bytesOfHex(sha256Hex(saltHex + ':' + password))));
        });
    } catch (e) {
      markHashBroken();
      give('sha256$' + hexOf(bytesOfHex(sha256Hex(saltHex + ':' + password))));
    }
  }

  /* check a password against one account, using that account's own method */
  function checkPassword(account, password, done) {
    var want = String(account.hash || '');
    var salt = account.salt || '';
    if (want.indexOf('pbkdf2:') !== 0) {
      hashPassword(password, salt, function (hash) { done(hash === want); });
      return;
    }

    var iter = parseInt(String(want.split('$')[0]).split(':')[1], 10) || PBKDF2_ITER;
    derivePbkdf2(password, salt, iter, function (hash) {
      if (hash === want) { done(true); return; }
      if (hash === null) {
        /* this browser cannot do the account's method: say so, do not guess */
        done({ needsStrong: true });
        return;
      }
      done(false);
    });
  }

  /* PBKDF2 through Web Crypto, giving up with null when the browser cannot */
  function derivePbkdf2(password, saltHex, iter, cb) {
    var subtle = null;
    try { subtle = window.crypto && window.crypto.subtle ? window.crypto.subtle : null; } catch (e) { subtle = null; }
    var enc = null;
    try { enc = window.TextEncoder ? new window.TextEncoder() : null; } catch (e) { enc = null; }
    if (!subtle || !enc || !subtle.importKey || !subtle.deriveBits) { cb(null); return; }

    var settled = false;
    function give(v) {
      if (settled) { return; }
      settled = true;
      cb(v);
    }
    window.setTimeout(function () { give(null); }, TRY_MS);

    try {
      subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits'])
        .then(function (km) {
          return subtle.deriveBits(
            { name: 'PBKDF2', salt: new Uint8Array(bytesOfHex(saltHex)), iterations: iter, hash: 'SHA-256' },
            km, 256);
        })
        .then(function (bits) { give('pbkdf2:' + iter + '$' + hexOf(new Uint8Array(bits))); })
    } catch (e) {
      give(null);
    }
  }

  /* ---------- sign up / sign in ---------- */

  function passwordProblem(pw) {
    if (!pw) { return 'Type a password.'; }
    if (pw.length < 6) { return 'Use at least 6 characters.'; }
    if (pw.length > 100) { return 'Keep it under 100 characters.'; }
    return '';
  }

  function addAccount(name, hash, salt, done) {
    pull(function () {
      if (findAccount(name)) { done('That name is taken. Pick another.'); return; }
      var d = tree;
      var accs = list(d.accounts);
      for (var i = 0; i < accs.length; i++) {
        if (nameKey(accs[i].name) === nameKey(name)) { done('That name is taken. Pick another.'); return; }
      }
      accs.push({ id: newId('a'), name: name, hash: hash, salt: salt, at: (new Date()).getTime() });
      d.accounts = accs;
      d.meta = { updated: (new Date()).getTime(), by: name };
      tree = d;
      localPut(tree);

      if (!cloudOn()) { done(null); return; }

      var req = new XMLHttpRequest();
      req.open('PUT', rootUrl() + 'hq.json', true);
      try { req.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
      req.onreadystatechange = function () {
        if (req.readyState !== 4) { return; }
        if (req.status >= 200 && req.status < 300) {
          state = 'ready';
          done(null);
        } else {
          state = 'offline';
          done('Could not reach the server. Try again.');
        }
      };
      try { req.send(JSON.stringify(tree)); }
      catch (e) { state = 'offline'; done('Could not reach the server. Try again.'); }
    });
  }

  function signUp(name, password, password2, done) {
    name = cleanName(name);
    if (!name) { done('Type a name.'); return; }
    if (name.length > 20) { done('Keep the name to 20 letters.'); return; }
    if (nameKey(name).length < 2) { done('Use at least 2 letters or numbers.'); return; }
    var prob = passwordProblem(password);
    if (prob) { done(prob); return; }
    if (password !== password2) { done('The two passwords are not the same.'); return; }

    pull(function () {
      if (findAccount(name)) { done('That name is taken. Pick another.'); return; }
      var salt = randomSalt();
      hashPassword(password, salt, function (hash) {
        addAccount(name, hash, salt, function (err) {
          if (!err) { setMe(name); }
          done(err);
        });
      });
    });
  }

  function signIn(name, password, done) {
    name = cleanName(name);
    if (!name) { done('Type your name.'); return; }
    if (!password) { done('Type your password.'); return; }
    pull(function () {
      var acc = findAccount(name);
      if (!acc) { done('No account called "' + name + '".'); return; }
      if (!acc.salt || !acc.hash) {
        done('That account is from the old version and has no password. Make a new account.');
        return;
      }
      checkPassword(acc, password, function (ok) {
        if (ok && ok.needsStrong) {
          done('This browser cannot check this account\'s password. ' +
               'Sign in from a newer browser, or make a new account here.');
          return;
        }
        if (!ok) { done('Wrong password.'); return; }
        setMe(acc.name);
        done(null);
      });
    });
  }

  /* ---------- text ---------- */

  function esc(s) {
    s = String(s === undefined || s === null ? '' : s);
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
  }

  function trim(s) {
    return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  function when(ts) {
    if (!ts) { return 'never'; }
    var d = new Date(ts);
    var diff = (new Date()).getTime() - ts;
    if (diff < 0) { diff = 0; }
    if (diff < 60000) { return 'just now'; }
    if (diff < 3600000) { return Math.floor(diff / 60000) + 'm ago'; }
    if (diff < 86400000) { return Math.floor(diff / 3600000) + 'h ago'; }
    if (diff < 604800000) { return Math.floor(diff / 86400000) + 'd ago'; }
    var mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return mo[d.getMonth()] + ' ' + d.getDate();
  }

  function newId(prefix) {
    return (prefix || 'x') + (new Date()).getTime().toString(36) +
           Math.floor(Math.random() * 1296).toString(36);
  }

  /* ---------- UI helpers ---------- */

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) { return; }
    el.innerHTML = esc(msg);
    el.className = 'show';
    if (toastTimer) { window.clearTimeout(toastTimer); }
    toastTimer = window.setTimeout(function () { el.className = ''; }, 3000);
  }

  function qs(name) {
    var h = window.location.hash || '';
    var i = h.indexOf('?');
    if (i < 0) { return ''; }
    var parts = h.substring(i + 1).split('&');
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k].split('=');
      if (p[0] === name) { return decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); }
    }
    return '';
  }

  function route() {
    var h = (window.location.hash || '').replace(/^#/, '');
    var i = h.indexOf('?');
    if (i >= 0) { h = h.substring(0, i); }
    return h || 'home';
  }

  /* ---------- shell ---------- */

  var NAV = [
    ['home', 'HQ'],
    ['chat', 'Chat'],
    ['neighborhood', 'Neighborhood'],
    ['pinboard', 'Pinboard'],
    ['topics', 'Topics']
  ];

  function shell(title, body) {
    var chat = list(tree.chat);
    var nb = list(tree.neighborhood);
    var pins = list(tree.pins);
    var topics = list(tree.topics);
    var r = route();
    var counts = { chat: chat.length, neighborhood: nb.length, pinboard: pins.length, topics: topics.length };

    var nav = '';
    for (var i = 0; i < NAV.length; i++) {
      var key = NAV[i][0];
      var tag = counts[key] ? '<span class="tag">' + counts[key] + '</span>' : '';
      nav += '<a href="#' + key + '"' + (r === key ? ' class="on"' : '') + '>' + NAV[i][1] + tag + '</a>';
    }

    var who = me();
    var whoBar = who
      ? '<span class="small" style="float:right;padding-top:6px">' + esc(who) +
        ' &middot; <a href="#" id="switchname"><u>sign out</u></a></span>'
      : '<a class="btn small" style="float:right" href="#" id="signinbtn">Sign in</a>';

    var html =
      '<div class="bar">' + whoBar +
        '<a href="#home"><span class="bar-title">ROAKSTASAWD</span></a>' +
      '</div>' +
      '<div class="nav">' + nav + '</div>' +
      '<div class="wrap">' +
        '<div id="live" class="live">' + stampLine() + '</div>' +
        '<h1>' + esc(title) + '</h1>' +
        body +
        '<footer>' +
          'ROAKSTASAWD HQ &middot; built for e-ink &middot; ' +
          (cloudOn()
            ? 'accounts and posts are saved on the server.'
            : 'no backend set yet &mdash; posts stay on this device.') +
        '</footer>' +
      '</div>' +
      '<div id="signin" class="overlay" style="display:none"><div class="wrap" style="padding-top:0" id="signinbody"></div></div>' +
      '<div id="toast"></div>';

    document.getElementById('root').innerHTML = html;

    var sib = document.getElementById('signinbtn');
    if (sib) { sib.onclick = function (e) { e.preventDefault(); openSignin('in'); return false; }; }
    var sw = document.getElementById('switchname');
    if (sw) {
      sw.onclick = function (e) {
        e.preventDefault();
        setMe('');
        closeSignin();
        render();
        toast('Signed out on this device');
        return false;
      };
    }

    if (!window.scrollY) { window.scrollTo(0, 0); }
  }

  /* ----- sign in / make an account ----- */

  function openSignin(mode) {
    var el = document.getElementById('signin');
    if (!el) { return; }
    el.style.display = 'block';
    drawSignin(mode || 'in', '');
  }

  function closeSignin() {
    var el = document.getElementById('signin');
    if (el) { el.style.display = 'none'; }
  }

  function drawSignin(mode, error) {
    var box = document.getElementById('signinbody');
    if (!box) { return; }
    var signup = mode === 'up';
    var pw = '<input type="password" id="accpass" maxlength="100" autocomplete="off" ' +
             'autocorrect="off" autocapitalize="off" spellcheck="false">';

    var html = '<div class="box">' +
      '<h2 style="margin-top:0">' + (signup ? 'Make an account' : 'Sign in') + '</h2>' +
      (error ? '<div class="box tight" style="border-width:3px"><b>' + esc(error) + '</b></div>' : '') +
      '<p class="small">' + (signup
        ? 'A name, and a password only you know. No two accounts can share a name.'
        : 'Your name and password.') + '</p>' +
      '<form id="accform" action="#">' +
        '<label for="accname">Name</label>' +
        '<input type="text" id="accname" maxlength="20" autocomplete="off" autocorrect="off" ' +
          'autocapitalize="off" spellcheck="false" value="' + (signup ? '' : esc(me())) + '">' +
        '<label for="accpass">' + (signup ? 'Password (6+ characters)' : 'Password') + '</label>' +
        pw +
        (signup
          ? '<label for="accpass2">Password again</label>' +
            '<input type="password" id="accpass2" maxlength="100" autocomplete="off" ' +
            'autocorrect="off" autocapitalize="off" spellcheck="false">'
          : '') +
        '<button class="btn wide" type="submit" id="accgo">' +
          (signup ? 'Create account' : 'Sign in') + '</button>' +
        '<button class="btn wide" type="button" id="accswitch">' +
          (signup ? 'I already have an account' : 'I need an account') + '</button>' +
        '<button class="btn wide" type="button" id="acccancel">Cancel</button>' +
      '</form>' +
    '</div>';

    html += '<div class="box tight"><p class="small" style="margin:0">' +
      (signup
        ? 'Your password is never stored or sent. This page turns it into a slow, salted ' +
          'hash in your own browser and saves only that, so nobody reading the database can ' +
          'get a password out of it. The same name can never be taken twice.'
        : 'Wrong passwords get no hints. Nothing about your account is shown to anyone ' +
          'who is not signed in as you.') +
      '</p></div>';
    box.innerHTML = html;

    var f = document.getElementById('accname');
    if (f) { try { f.focus(); } catch (e) {} }

    document.getElementById('accswitch').onclick = function () {
      drawSignin(signup ? 'in' : 'up', '');
    };
    document.getElementById('acccancel').onclick = function () {
      closeSignin();
    };
    document.getElementById('accform').onsubmit = function (e) {
      e.preventDefault();
      var name = cleanName(document.getElementById('accname').value);
      var pass = document.getElementById('accpass').value;
      var pass2 = signup ? document.getElementById('accpass2').value : '';

      function busy(flag) {
        var b = document.getElementById('accgo');
        if (!b) { return; }
        b.disabled = flag;
        b.innerHTML = flag ? 'Working&hellip;' : (signup ? 'Create account' : 'Sign in');
      }

      busy(true);
      var finish = function (err) {
        if (err) { drawSignin(signup ? 'up' : 'in', err); return; }
        closeSignin();
        render();
        toast(signup ? 'Welcome, ' + me() : 'Signed in as ' + me());
      };

      if (signup) { signUp(name, pass, pass2, finish); }
      else { signIn(name, pass, finish); }
      return false;
    };
  }

  /* ---------- shared bits of page furniture ---------- */

  function statusBox() {
    if (state === 'loading' && !signedIn()) {
      return '<div class="empty">Loading&hellip;</div>';
    }
    if (state === 'offline') {
      return '<div class="box tight"><b>Offline.</b> ' +
        '<span class="small">Showing the copy saved on this device. ' +
        'New posts are kept here and go up when you are back on.</span></div>';
    }
    return '';
  }

  function nameBox() {
    if (signedIn()) { return ''; }
    return '<div class="box">' +
      '<b>Sign in to post.</b><br>' +
      '<span class="small">An account is a name and a password only you know. ' +
      'No two accounts can share a name.</span><br>' +
      '<a class="btn" href="#" id="start">Sign in</a> ' +
      '<a class="btn" href="#" id="startup">Make an account</a></div>';
  }

  function wireStart() {
    var st = document.getElementById('start');
    if (st) { st.onclick = function (e) { e.preventDefault(); openSignin('in'); return false; }; }
    var su = document.getElementById('startup');
    if (su) { su.onclick = function (e) { e.preventDefault(); openSignin('up'); return false; }; }
  }

  /* ---------- pages ---------- */

  function pageHome() {
    var chat = list(tree.chat);
    var nb = list(tree.neighborhood);
    var pins = list(tree.pins);
    var topics = list(tree.topics);
    var accounts = list(tree.accounts);
    var body = '';

    body += '<p class="lede">A headquarters for people reading on Amazon Kindles. ' +
            'Plain pages, black and white, big buttons. If you can load it on a Kindle, ' +
            'you are in the right place.</p>';

    body += statusBox();
    body += nameBox();

    body += '<h2>Apps</h2>';
    body += '<a class="topic" href="#chat"><span class="t">Chat</span>' +
            '<span class="m">' + chat.length + ' message' + (chat.length === 1 ? '' : 's') + ' &middot; live</span></a>';
    body += '<a class="topic" href="#neighborhood"><span class="t">Neighborhood</span>' +
            '<span class="m">' + nb.length + ' post' + (nb.length === 1 ? '' : 's') + ' &middot; longer posts, slower pace</span></a>';
    body += '<a class="topic" href="#pinboard"><span class="t">Pinboard</span>' +
            '<span class="m">' + pins.length + ' pin' + (pins.length === 1 ? '' : 's') + ' &middot; the permanent board</span></a>';
    body += '<a class="topic" href="#topics"><span class="t">Topics</span>' +
            '<span class="m">' + topics.length + ' thread' + (topics.length === 1 ? '' : 's') + ' &middot; one subject per thread</span></a>';

    if (chat.length) {
      var last = chat[chat.length - 1];
      body += '<h2>In chat right now</h2>' +
        '<div class="post"><div class="post-meta"><span class="who">' + esc(last.by) +
        '</span> &middot; ' + when(last.at) + '</div><div class="post-body">' + esc(last.text) + '</div></div>' +
        '<a class="btn" href="#chat">Open chat</a>';
    }

    if (pins.length) {
      body += '<h2>Latest pins</h2>';
      var recent = pins.slice(pins.length - 3).reverse();
      for (var i = 0; i < recent.length; i++) {
        body += '<div class="post"><div class="post-meta"><span class="who">' + esc(recent[i].by) +
                '</span> &middot; ' + when(recent[i].at) + '</div>' +
                '<div class="post-body">' + esc(recent[i].text) + '</div></div>';
      }
      body += '<a class="btn" href="#pinboard">Open the pinboard</a>';
    }

    body += '<h2>Members</h2>' +
      '<div class="box tight"><p class="small" style="margin:0">' +
      accounts.length + ' account' + (accounts.length === 1 ? '' : 's') + ': ' +
      (accounts.length ? esc(namesOf(accounts)) : 'none yet &mdash; make the first one.') +
      '</p></div>';

    body += '<h2>How this place works</h2>' +
      '<div class="box tight"><p class="small" style="margin:0">' +
      '<b>One column, no scrolling sideways.</b> Everything is a single column of blocks so the ' +
      'Kindle does not have to guess where you are.<br><br>' +
      '<b>No images.</b> A Kindle repaints the whole screen for a picture. Text is faster.<br><br>' +
      '<b>Tap targets are big.</b> Buttons are at least 44px tall.<br><br>' +
      '<b>Live.</b> Chat refreshes every second, the rest every five. A post made on one Kindle ' +
      'shows up on the others without reloading.<br><br>' +
      '<b>Saved for everyone.</b> Accounts, chat, posts, pins and topics are kept on the server.' +
      '</p></div>';

    shell('HQ', body);
    wireStart();
  }

  function namesOf(accs) {
    var out = [];
    for (var i = 0; i < accs.length; i++) { out.push(accs[i].name); }
    return out.join(', ');
  }

  /* ----- chat ----- */

  function chatShown() {
    var shown = CHAT_SHOWN;
    try {
      var v = parseInt(window.localStorage.getItem(VIEW_KEY), 10);
      if (v && v > shown) { shown = v; }
    } catch (e) {}
    return shown;
  }

  function chatLogHtml() {
    var all = list(tree.chat);
    var msgs = all.slice(Math.max(0, all.length - chatShown()));
    var log = '';
    var i;
    if (!msgs.length) {
      return '<div class="empty"><b>No messages yet.</b><br><span class="small">Say hello.</span></div>';
    }
    for (i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      log += '<div class="msg' + (m.by === me() ? ' me' : '') + '">' +
        '<span class="who">' + esc(m.by) + '</span>' +
        '<span class="when" data-at="' + (m.at || 0) + '">' + when(m.at) + '</span>' +
        '<div class="text">' + esc(m.text) + '</div>' +
      '</div>';
    }
    return log;
  }

  function pageChat() {
    var all = list(tree.chat);
    var shown = chatShown();
    var shownCount = Math.min(shown, all.length);
    var body = '';

    body += statusBox();
    body += nameBox();
    body += '<p class="small dim" id="chatcount">' + all.length + ' message' + (all.length === 1 ? '' : 's') +
            ' saved. Showing the last ' + shownCount + '. Live: new messages appear on their own.</p>';
    body += '<div class="chatlog" id="chatlog">' + chatLogHtml() + '</div>';
    body += '<div id="morebox">' + moreButtonHtml(all.length, shownCount) + '</div>';
    body += '<div class="chatform">' +
      '<form id="chatform" action="#chat">' +
        '<label for="chattext">Message</label>' +
        '<textarea id="chattext" maxlength="500"></textarea>' +
        '<button class="btn wide" type="submit">Send</button>' +
      '</form>' +
    '</div>';

    shell('Chat', body);
    wireStart();
    scrollChatToEnd();

    var more = document.getElementById('chatmore');
    if (more) { wireMore(more, shown, all.length); }

    document.getElementById('chatform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var t = trim(document.getElementById('chattext').value);
      if (!t) { toast('Type a message'); return false; }
      document.getElementById('chattext').value = '';
      var msg = { id: newId('c'), by: me(), text: t, at: (new Date()).getTime() };
      /* show it straight away, before the server answers */
      tree.chat = list(tree.chat).concat([msg]);
      var log = document.getElementById('chatlog');
      if (log) {
        if (log.getElementsByClassName('empty').length) { log.innerHTML = ''; }
        log.innerHTML += '<div class="msg me"><span class="who">' + esc(msg.by) +
          '</span><span class="when">just now</span><div class="text">' + esc(msg.text) + '</div></div>';
        scrollChatToEnd();
      }
      change(function (d) {
        d.chat = list(d.chat).concat([msg]);
      }, function (ok) {
        refresh();
        if (!ok) { toast('Saved on this device — will send when back online'); }
      });
      return false;
    };
  }

  function moreButtonHtml(total, shownCount) {
    if (total <= shownCount) { return ''; }
    return '<a class="btn small" href="#" id="chatmore">Load ' +
           Math.min(CHAT_SHOWN, total - shownCount) + ' older</a>';
  }

  function wireMore(a, shown, total) {
    a.onclick = function (e) {
      e.preventDefault();
      try { window.localStorage.setItem(VIEW_KEY, String(shown + CHAT_SHOWN)); } catch (err) {}
      render();
      return false;
    };
  }

  function scrollChatToEnd() {
    var lg = document.getElementById('chatlog');
    if (lg) { lg.scrollTop = lg.scrollHeight; }
  }

  /* redraw the chat without touching the box you may be typing in */
  function softChat() {
    var log = document.getElementById('chatlog');
    if (!log) { render(); return; }
    var atEnd = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
    var html = chatLogHtml();
    if (log.innerHTML !== html) {
      log.innerHTML = html;
      if (atEnd) { scrollChatToEnd(); }
    }
    var all = list(tree.chat);
    var c = document.getElementById('chatcount');
    if (c) {
      var shownCount = Math.min(chatShown(), all.length);
      c.innerHTML = all.length + ' message' + (all.length === 1 ? '' : 's') +
        ' saved. Showing the last ' + shownCount + '. Live: new messages appear on their own.';
    }
    var mb = document.getElementById('morebox');
    if (mb) { mb.innerHTML = moreButtonHtml(all.length, Math.min(chatShown(), all.length)); }
    var stamp = document.getElementById('live');
    if (stamp) { stamp.innerHTML = stampLine(); }
  }

  /* ----- neighborhood ----- */

  function pageNeighborhood() {
    var posts = list(tree.neighborhood).reverse();
    var likes = list(tree.likes);
    var body = '';
    var listHtml = '';
    var i;

    if (!posts.length) {
      listHtml = '<div class="empty"><b>The neighborhood is quiet.</b><br>' +
             '<span class="small">Put the first post up.</span></div>';
    } else {
      for (i = 0; i < posts.length; i++) {
        var p = posts[i];
        var liked = false;
        for (var k = 0; k < likes.length; k++) {
          if (likes[k].id === p.id) { liked = true; }
        }
        listHtml += '<div class="post">' +
          '<div class="post-meta"><span class="who">' + esc(p.by) + '</span> &middot; ' + when(p.at) +
            (p.tag ? ' &middot; #' + esc(p.tag) : '') + '</div>' +
          '<div class="post-body">' + esc(p.text) + '</div>' +
          '<div class="post-actions">' +
            '<a href="#" data-like="' + esc(p.id) + '">' + (liked ? '&#9733; Liked' : '&#9734; Like') + '</a>' +
            (p.by === me() ? '<a href="#" data-del="' + esc(p.id) + '">Delete</a>' : '') +
          '</div>' +
        '</div>';
      }
    }

    body += statusBox();
    body += nameBox();
    body += '<p class="small dim">Post something, or read what the street is saying. Every post is kept.</p>';
    body += '<form id="postform" action="#neighborhood">' +
      '<label for="posttext">Your post</label>' +
      '<textarea id="posttext" maxlength="2000"></textarea>' +
      '<label for="posttag">Tag (optional, one word)</label>' +
      '<input type="text" id="posttag" maxlength="16" autocomplete="off" autocorrect="off" autocapitalize="off">' +
      '<button class="btn wide" type="submit">Post to the neighborhood</button>' +
    '</form>';
    body += '<h2>Posts</h2>' + listHtml;

    shell('Neighborhood', body);
    wireStart();

    document.getElementById('postform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var t = trim(document.getElementById('posttext').value);
      if (!t) { toast('Write something first'); return false; }
      var tag = trim(document.getElementById('posttag').value).replace(/[^A-Za-z0-9]/g, '');
      change(function (d) {
        d.neighborhood.push({ id: newId('n'), by: me(), text: t, tag: tag, at: (new Date()).getTime() });
      }, function (ok) {
        render();
        toast(ok ? 'Posted' : 'Saved on this device — will sync');
      });
      return false;
    };

    wireListActions('data-like', function (id) {
      change(function (d) {
        var ls = list(d.likes);
        var keep = [];
        var had = false;
        for (var z = 0; z < ls.length; z++) {
          if (ls[z].id === id) { had = true; }
          else { keep.push(ls[z]); }
        }
        if (!had) { keep.push({ id: id, by: me(), at: (new Date()).getTime() }); }
        d.likes = keep;
      }, function () { render(); });
    });

    wireListActions('data-del', function (id) {
      change(function (d) {
        var src = list(d.neighborhood);
        var keep = [];
        for (var z = 0; z < src.length; z++) {
          if (src[z].id !== id) { keep.push(src[z]); }
        }
        d.neighborhood = keep;
      }, function () { render(); toast('Deleted'); });
    });
  }

  function wireListActions(attr, fn) {
    var links = document.getElementById('root').getElementsByTagName('a');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var id = a.getAttribute(attr);
      if (id) {
        a.onclick = (function (pid) {
          return function (e) { e.preventDefault(); fn(pid); return false; };
        })(id);
      }
    }
  }

  /* ----- pinboard ----- */

  function pagePinboard() {
    var pins = list(tree.pins).reverse();
    var body = '';
    var listHtml = '';
    var i;

    if (!pins.length) {
      listHtml = '<div class="empty"><b>The board is empty.</b><br>' +
        '<span class="small">Pin the first note.</span></div>';
    } else {
      for (i = 0; i < pins.length; i++) {
        var p = pins[i];
        listHtml += '<div class="post pin">' +
          '<div class="post-meta"><span class="who">' + esc(p.by) + '</span> &middot; ' + when(p.at) + '</div>' +
          '<div class="post-body">' + esc(p.text) + '</div>' +
          '<div class="post-actions">' +
            (p.by === me()
              ? '<a href="#" data-unpin="' + esc(p.id) + '">Unpin</a>' +
                '<a href="#" data-edit="' + esc(p.id) + '">Edit</a>'
              : '') +
          '</div>' +
        '</div>';
      }
    }

    body += statusBox();
    body += nameBox();
    body += '<div class="box tight"><p class="small" style="margin:0">' +
      '<b>The permanent board.</b> Pins are never trimmed or cleared by the site. ' +
      'Only you can edit or unpin your own pins. Keep it to things worth keeping: ' +
      'links, rules, a book you finished, a meeting time.</p></div>';

    var editId = qs('edit');
    var editing = null;
    if (editId) {
      for (i = 0; i < pins.length; i++) { if (pins[i].id === editId) { editing = pins[i]; } }
    }

    body += '<form id="pinform" action="#pinboard">' +
      '<label for="pintext">' + (editing ? 'Edit this pin' : 'New pin') + '</label>' +
      '<textarea id="pintext" maxlength="2000">' + (editing ? esc(editing.text) : '') + '</textarea>' +
      '<button class="btn wide" type="submit">' + (editing ? 'Save pin' : 'Pin it') + '</button>' +
      (editing ? '<a class="btn wide" href="#pinboard">Cancel</a>' : '') +
    '</form>';
    body += '<h2>Pinned</h2>' + listHtml;

    shell(editing ? 'Editing pin' : 'Pinboard', body);
    wireStart();

    document.getElementById('pinform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var t = trim(document.getElementById('pintext').value);
      if (!t) { toast('Write the pin first'); return false; }
      var now = (new Date()).getTime();
      change(function (d) {
        if (editing) {
          var ps = list(d.pins);
          for (var z = 0; z < ps.length; z++) {
            if (ps[z].id === editing.id) { ps[z].text = t; ps[z].edited = now; }
          }
          d.pins = ps;
        } else {
          d.pins.push({ id: newId('b'), by: me(), text: t, at: now });
        }
      }, function (ok) {
        if (editing) { window.location.hash = 'pinboard'; }
        render();
        toast(ok ? (editing ? 'Pin saved' : 'Pinned') : 'Saved on this device — will sync');
      });
      return false;
    };

    wireListActions('data-unpin', function (id) {
      change(function (d) {
        var ps = list(d.pins);
        var keep = [];
        for (var z = 0; z < ps.length; z++) { if (ps[z].id !== id) { keep.push(ps[z]); } }
        d.pins = keep;
      }, function () { render(); toast('Unpinned'); });
    });

    wireListActions('data-edit', function (id) {
      window.location.hash = 'pinboard?edit=' + encodeURIComponent(id);
      render();
    });
  }

  /* ----- topics ----- */

  function pageTopics() {
    var id = qs('id');
    var body = '';
    var i;

    if (id) {
      var t = null;
      var all = list(tree.topics);
      for (i = 0; i < all.length; i++) {
        if (all[i].id === id) { t = all[i]; }
      }
      if (!t) {
        shell('Topics', statusBox() + '<div class="empty"><b>No such topic.</b><br>' +
              '<a class="btn" href="#topics">Back to topics</a></div>');
        return;
      }
      var replies = list(t.replies);
      body += statusBox();
      body += '<p class="small"><a href="#topics">&larr; All topics</a></p>';
      body += '<div class="box tight"><b>' + esc(t.title) + '</b><br>' +
              '<span class="small dim">started by ' + esc(t.by) + ' &middot; ' + when(t.at) +
              ' &middot; ' + replies.length + ' repl' + (replies.length === 1 ? 'y' : 'ies') + '</span></div>';
      if (!replies.length) {
        body += '<div class="empty"><b>No replies yet.</b></div>';
      }
      for (i = 0; i < replies.length; i++) {
        body += '<div class="post">' +
          '<div class="post-meta"><span class="who">' + esc(replies[i].by) + '</span> &middot; ' + when(replies[i].at) + '</div>' +
          '<div class="post-body">' + esc(replies[i].text) + '</div>' +
        '</div>';
      }
      body += '<form id="replyform" action="#topics?id=' + encodeURIComponent(id) + '">' +
        '<label for="replytext">Reply</label>' +
        '<textarea id="replytext" maxlength="2000"></textarea>' +
        '<button class="btn wide" type="submit">Post reply</button>' +
      '</form>';
      shell(t.title, body);
      wireStart();

      document.getElementById('replyform').onsubmit = function (e) {
        e.preventDefault();
        if (!needName()) { return false; }
        var txt = trim(document.getElementById('replytext').value);
        if (!txt) { toast('Write a reply first'); return false; }
        change(function (d) {
          var ts = list(d.topics);
          for (var z = 0; z < ts.length; z++) {
            if (ts[z].id === id) {
              var rs = list(ts[z].replies);
              rs.push({ id: newId('r'), by: me(), text: txt, at: (new Date()).getTime() });
              ts[z].replies = rs;
            }
          }
          d.topics = ts;
        }, function (ok) {
          render();
          toast(ok ? 'Reply posted' : 'Saved on this device — will sync');
        });
        return false;
      };
      return;
    }

    body += statusBox();
    body += nameBox();
    body += '<p class="small dim">One subject per thread. Every topic and reply is kept.</p>';
    body += '<form id="topicform" action="#topics">' +
      '<label for="topictitle">Topic title</label>' +
      '<input type="text" id="topictitle" maxlength="80" autocomplete="off" autocorrect="off" autocapitalize="off">' +
      '<label for="topictext">First post</label>' +
      '<textarea id="topictext" maxlength="2000"></textarea>' +
      '<button class="btn wide" type="submit">Start topic</button>' +
    '</form>';

    body += '<h2>All topics</h2>';
    var topics = list(tree.topics).reverse();
    if (!topics.length) {
      body += '<div class="empty"><b>No topics yet.</b><br><span class="small">Start the first one above.</span></div>';
    }
    for (i = 0; i < topics.length; i++) {
      var tt = topics[i];
      var n = list(tt.replies).length;
      body += '<a class="topic" href="#topics?id=' + encodeURIComponent(tt.id) + '">' +
        '<span class="t">' + esc(tt.title) + '</span>' +
        '<span class="m">' + esc(tt.by) + ' &middot; ' + n + ' repl' + (n === 1 ? 'y' : 'ies') +
        ' &middot; ' + when(tt.at) + '</span></a>';
    }

    shell('Topics', body);
    wireStart();

    document.getElementById('topicform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var title = trim(document.getElementById('topictitle').value);
      var txt = trim(document.getElementById('topictext').value);
      if (!title) { toast('Give the topic a title'); return false; }
      if (!txt) { toast('Write the first post'); return false; }
      var nid = newId('t');
      var now = (new Date()).getTime();
      change(function (d) {
        var ts = list(d.topics);
        ts.push({
          id: nid,
          title: title,
          by: me(),
          at: now,
          replies: [{ id: newId('r'), by: me(), text: txt, at: now }]
        });
        d.topics = ts;
      }, function () {
        window.location.hash = 'topics?id=' + encodeURIComponent(nid);
        render();
      });
      return false;
    };
  }

  /* ---------- boot ---------- */

  function render() {
    var r = route();
    closeSignin();
    if (r === 'chat') { pageChat(); }
    else if (r === 'neighborhood') { pageNeighborhood(); }
    else if (r === 'pinboard') { pagePinboard(); }
    else if (r === 'topics') { pageTopics(); }
    else { pageHome(); }
  }

  /* redraw without jumping to the top (used by the live refresh) */
  function renderSoft() {
    var y = 0;
    try { y = window.pageYOffset || document.documentElement.scrollTop || 0; } catch (e) {}
    render();
    try { window.scrollTo(0, y); } catch (e) {}
  }

  function boot() {
    if (!window.addEventListener) {
      window.onhashchange = render;
    } else {
      window.addEventListener('hashchange', render, false);
    }
    pull(function () {
      render();
      startPolling();
    });
  }

  return {
    boot: boot,
    render: render,
    pull: pull,
    change: change,
    tree: function () { return tree; },
    list: list,
    me: me,
    signUp: signUp,
    signIn: signIn,
    hashPassword: hashPassword,
    sha256Hex: sha256Hex,
    randomSalt: randomSalt,
    signOut: function () { setMe(''); },
    esc: esc,
    toast: toast,
    cloudOn: cloudOn
  };
})();

if (window.addEventListener) {
  window.addEventListener('DOMContentLoaded', ROAK.boot, false);
} else {
  window.onload = ROAK.boot;
}
