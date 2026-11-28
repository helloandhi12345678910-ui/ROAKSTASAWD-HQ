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

  /* Which build this page is. Bump BUILD on every change that goes live, and
     the stamp in the footer tells you at a glance whether the page you are
     looking at is the new one or a copy the browser kept. */
  var BUILD = '3.9';
  var BUILD_DATE = '28 Nov 2026';

  var LS_KEY = 'roak.v2';          /* local cache of the shared tree */
  var ME_KEY = 'roak.me';          /* { name, at } of the signed-in account */
  var NAME_KEY = 'roak.name.last';  /* the last name here, so the name can come back */
  var VIEW_KEY = 'roak.view';      /* how many chat messages to show */
  var FAV_KEY = 'roak.favs';       /* the apps starred for the top bar, on this device */
  var CHAT_SHOWN = 100;            /* chat messages rendered at once */
  var KEEP_CHAT = 300;             /* chat messages kept in the database */
  var FAST_MS = 1000;              /* refresh rate on the chat page */
  var SLOW_MS = 5000;              /* refresh rate everywhere else */

  /* ---------- is the server up? ----------
     Every call the page makes records whether it got an answer and when, so the
     corner of the HQ can say plainly how things stand. */

  var SERVER_KEY = 'roak.server';

  function serverSeen() {
    var raw = null;
    try { raw = window.localStorage.getItem(SERVER_KEY); } catch (e) { raw = null; }
    if (!raw) { return { up: false, at: 0, ever: false }; }
    try {
      var d = JSON.parse(raw);
      return { up: !!d.up, at: d.at || 0, ever: true };
    } catch (e) { return { up: false, at: 0, ever: false }; }
  }

  function serverNote(up) {
    var d = { up: !!up, at: (new Date()).getTime() };
    try { window.localStorage.setItem(SERVER_KEY, JSON.stringify(d)); } catch (e) {}
  }

  /* ---------- backend selection ---------- */

  /* Where this copy of the site came from. The Worker serves the site and the
     API from one address, so a page opened from the Worker talks to the Worker
     without anyone having to type its address in. */
  function siteOrigin() {
    try {
      var u = String(window.location.protocol || '') + '//' + String(window.location.host || '');
      if (u.indexOf('http') !== 0) { return ''; }
      /* GitHub Pages is only the site; every other name that opens it - the
         Worker's own address, or a name pointed at the Worker - has the API */
      if (/(^|\.)github\.io$/i.test(String(window.location.hostname || ''))) { return ''; }
      if (window.location.hostname) { return u + '/api'; }
      return '';
    } catch (e) { return ''; }
  }

  function backend() {
    var b = window.ROAK_BACKEND;
    if (siteOrigin()) {
      return { url: siteOrigin(), ai: (b && b.ai) || '' };
    }
    if (b && b.url && b.url.indexOf('http') === 0 && b.url.indexOf('YOUR-') < 0) {
      return b;
    }
    return null;
  }

  function cloudOn() {
    return backend() !== null;
  }

  /* A Cloudflare Worker address ends in /api: everything then goes through one
     POST, and the Worker checks who is asking. The old Firebase address is a
     plain Realtime Database: one document, read and written as JSON. */
  function workerOn() {
    var b = backend();
    return !!(b && b.url.replace(/\/+$/, '').slice(-4) === '/api');
  }

  function apiUrl() {
    return backend().url.replace(/\/+$/, '');
  }

  function tokenGet() {
    var t = '';
    try { t = window.localStorage.getItem('roak.token') || ''; } catch (e) { t = ''; }
    if (t) { return t; }
    try { return window.localStorage.getItem('roak.token.backup') || ''; } catch (e2) { return ''; }
  }

  /* the token in two places, so a cleared store does not sign anyone out */
  function tokenRemember() {
    var t = tokenGet();
    if (!t) { return; }
    try { window.localStorage.setItem('roak.token.backup', t); } catch (e) {}
    var who = me();
    if (who) { try { window.localStorage.setItem(NAME_KEY, who); } catch (e2) {} }
  }

  function tokenSet(t) {
    try {
      if (t) { window.localStorage.setItem('roak.token', t); }
      else { window.localStorage.removeItem('roak.token'); }
    } catch (e) {}
    try {
      if (t) { window.localStorage.setItem('roak.token.backup', t); }
      else { window.localStorage.removeItem('roak.token.backup'); }
    } catch (e2) {}
  }

  /* One call to the Worker. cb(ok, data) */
  function apiCall(action, payload, cb) {
    var req = new XMLHttpRequest();
    req.open('POST', apiUrl(), true);
    try { req.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
    var t = tokenGet();
    if (t) { try { req.setRequestHeader('Authorization', 'Bearer ' + t); } catch (e) {} }
    req.onreadystatechange = function () {
      if (req.readyState !== 4) { return; }
      var d = null;
      try { d = JSON.parse(req.responseText); } catch (e) { d = null; }
      if (action === 'whoami') {
        if (req.status >= 200 && req.status < 300 && d && d.name) { if (cb) { cb(true, d); } return; }
        if (cb) { cb(false, d || { error: 'No connection' }); }
        return;
      }
      if (req.status >= 200 && req.status < 300 && d && !d.error) {
        serverNote(true);
        if (cb) { cb(true, d); }
        return;
      }
      serverNote(false);
      if (cb) { cb(false, d || { error: req.status === 0 ? 'No connection' : 'Server said ' + req.status }); }
    };
    try { req.send(JSON.stringify({ action: action, payload: payload || {} })); }
    catch (e) { if (cb) { cb(false, { error: 'No connection' }); } }
  }

  /* ---------- keeping people signed in ---------- */

  var sessionStrikes = 0;
  var sessionChecking = false;

  /* One "signin" or "banned" answer is not enough to sign someone out: a page
     can ask the server in the same instant a sign-in finishes, and that reply
     can belong to the old session. Ask again; only three answers in a row that
     all say the token is dead sign the device out. */
  function sessionSuspect(why) {
    if (sessionChecking) { return; }
    if (!tokenGet()) { sessionStrikes = 0; return; }
    sessionChecking = true;
    apiCall('whoami', {}, function (ok, d) {
      sessionChecking = false;
      if (ok && d && d.name) {
        sessionStrikes = 0;
        if (!me()) { setMe(d.name); }
        tokenRemember();
        return;
      }
      sessionStrikes++;
      if (sessionStrikes < 3) { return; }
      /* three strikes: the session really is over (signed out elsewhere, or banned) */
      sessionStrikes = 0;
      tokenSet('');
      setMe('');
      if (why === 'banned') {
        toast('That account has been banned from this HQ.');
      } else if (passGet()) {
        /* a password is kept here: sign back in without troubling anyone */
        signInAgain();
        return;
      } else {
        toast('You were signed out. Sign in again.');
      }
      renderSoft();
    });
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
      likes: [],
      ai: { msgs: [] },
      dm: {},
      bans: [],
      notices: []
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
    if (!d.ai || typeof d.ai !== 'object' || !d.ai.msgs) { d.ai = { msgs: [] }; }
    d.ai.msgs = list(d.ai.msgs);
    if (!d.dm || typeof d.dm !== 'object') { d.dm = {}; }
    if (!d.bans) { d.bans = b.bans; }
    if (!d.notices) { d.notices = b.notices; }
    d.bans = list(d.bans);
    d.notices = list(d.notices);
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
  /* the AI chat is its own piece of the shared document (tree.ai), so a post
     never undoes a message and a message never undoes a post */
  var aiData = { msgs: [] };
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

  function syncAi() {
    var a = tree && tree.ai ? tree.ai : null;
    aiData = a && a.msgs ? a : { msgs: [] };
    return aiData;
  }

  function aiSave(msgs) {
    tree.ai = { msgs: msgs };
    aiData = tree.ai;
  }

  /* A stable fingerprint of everything a page shows, so a redraw only happens
     when something actually changed. */
  function sig(d) {
    try { return JSON.stringify(d); } catch (e) { return String((new Date()).getTime()); }
  }

  /* Where the shared data sits: one document everyone reads and writes. */
  var NODES = ['hq'];
  var rooms = { hq: null };             /* room -> last copy read or written */
  var isAi = false;                     /* the current route is the AI chat */

  function roomUrl(name) {
    return rootUrl() + name + '.json';
  }

  /* keep the copy we already have for a room that was not read this time */
  function keepRoom(name, d) {
    if (!d) { return; }
    if (name === 'hq') {
      tree = normalize(d);
      localPut(tree);
    }
  }

  function mergeRoom(name, d) {
    var before = sig(tree);
    tree = normalize(d);
    localPut(tree);
    return sig(tree) !== before;
  }

  /* Pull the shared copy (and the AI chat when that page is open) into memory.
     Falls back to the local copy. */
  function pull(cb) {
    var cached = localGet();
    if (cached) { tree = normalize(cached); }

    if (!cloudOn()) {
      state = cached ? 'ready' : 'empty';
      if (cb) { cb(false); }
      return;
    }

    if (state !== 'ready') { state = 'loading'; }

    if (workerOn()) {
      apiCall('state', {}, function (ok, d) {
        if (ok && d && d.state) {
          rooms.hq = d.state;
          var moved = mergeRoom('hq', d.state);
          state = 'ready';
          lastError = '';
          if (cb) { cb(moved); }
          return;
        }
        if (d && (d.error === 'signin' || d.error === 'banned') && tokenGet()) {
          /* the token is dead. Never trust one answer for that: ask again, and
             only give up if the same thing comes back every time. A session
             that was just made must not be lost to a single early reply. */
          sessionSuspect(d.error);
        }
        state = cached ? 'ready' : 'offline';
        lastError = (d && d.error) || 'No connection';
        if (cb) { cb(false); }
      });
      return;
    }

    var names = isAi ? NODES : ['hq'];
    var left = names.length;
    var changed = false;

    function finish() {
      left--;
      if (left > 0) { return; }
      if (cb) { cb(changed); }
    }

    for (var i = 0; i < names.length; i++) {
      fetchRoom(names[i], function (name, d, ok) {
        if (ok && d) {
          rooms[name] = d;
          if (mergeRoom(name, d)) { changed = true; }
          state = 'ready';
        } else if (!ok) {
          state = 'offline';
          lastError = 'No connection';
        } else if (!cached) {
          state = 'empty';
        }
        finish();
      });
    }
  }

  function fetchRoom(name, cb) {
    var req = new XMLHttpRequest();
    var url = roomUrl(name) + '?ts=' + (new Date()).getTime();
    req.open('GET', url, true);
    req.onreadystatechange = function () {
      if (req.readyState !== 4) { return; }
      if (req.status >= 200 && req.status < 300) {
        var d = null;
        try { d = JSON.parse(req.responseText); } catch (e) { d = null; }
        cb(name, d, true);
        return;
      }
      cb(name, null, false);
    };
    try {
      req.send(null);
    } catch (e) {
      cb(name, null, false);
    }
  }

  function writeRoom(name, data, cb) {
    var req = new XMLHttpRequest();
    req.open('PUT', roomUrl(name), true);
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
      req.send(JSON.stringify(data));
    } catch (e) {
      state = 'offline';
      lastError = 'No connection';
      if (cb) { cb(false); }
    }
  }

  /* Read-modify-write the whole shared tree. change() edits the tree in place.
     The AI chat's own document is written back unchanged, so a post never
     undoes a message sent in the AI chat. */
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

      if (workerOn()) {
        /* the server is the truth: read it back after the edit has been sent */
        if (cb) { cb(true); }
        return;
      }

      writeRoom('hq', tree, cb);
    });
  }

  /* ---------- live refresh ---------- */

  /* Every page keeps itself up to date, so anything anyone posts shows up
     within a second or two without anyone touching the screen. */
  function fastRoute() {
    return true;
  }

  /* ---------- a box someone is writing in ---------- */
  /* Whatever is in the box being typed in belongs to the person typing it. A
     redraw of the page would throw it away and take the cursor with it, so
     while a box is being written in, nothing redraws the page. */
  var typingId = '';
  var typingAt = 0;

  function noteTyping() {
    var el = null;
    try { el = document.activeElement || null; } catch (e) { el = null; }
    if (!el || !el.id) { return; }
    var tag = String(el.tagName || '').toLowerCase();
    if (tag !== 'textarea' && tag !== 'input') { return; }
    if (el.id === 'accname' || el.id === 'accpass' || el.id === 'accpass2') { return; }
    typingId = el.id;
    typingAt = (new Date()).getTime();
  }

  /* is a box being written in, or was one a moment ago? */
  function typingNow() {
    var el = null;
    try { el = document.activeElement || null; } catch (e) { el = null; }
    var tag = el && el.id ? String(el.tagName || '').toLowerCase() : '';
    if ((tag === 'textarea' || tag === 'input') && el.id !== 'accname' &&
        el.id !== 'accpass' && el.id !== 'accpass2') {
      typingId = el.id;
      typingAt = (new Date()).getTime();
      return true;
    }
    /* the cursor can slip away for a moment (a tap elsewhere, a redraw of one
       small part): treat the box as busy for a little while after the last key */
    if (typingId && (new Date()).getTime() - typingAt < 20000) { return true; }
    return false;
  }

  function refresh() {
    /* Nothing may touch the page while the sign-in sheet is open: no refresh,
       no redraw, no rebuild. The boxes are the person's, not the page's. */
    if (signinOpen) { return; }
    if (typingNow()) { return; }
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
      var r = route();
      if (r === 'chat' || r === 'dm') { softChat(); }
      else if (r === 'ai') { softAi(); }
      else if (r === 'code') { return; }   /* never redraw under someone typing code */
      else { renderSoft(); }
    });
  }

  function startPolling() {
    if (poller || !cloudOn()) { return; }
    poller = window.setInterval(function () {
      if (signinOpen) { return; }   /* someone is typing their password */
      if (typingNow()) { return; }  /* someone is writing something else */
      refresh();
    }, FAST_MS);
    try {
      window.addEventListener('focus', function () {
        if (signinOpen || typingNow()) { return; }
        refresh();
      }, false);
      /* every key and every tap in a box says "this one is mine" */
      window.addEventListener('keydown', noteTyping, true);
      window.addEventListener('keyup', noteTyping, true);
      window.addEventListener('input', noteTyping, true);
      window.addEventListener('focusin', noteTyping, true);
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
    if (raw) {
      var o = null;
      try { o = JSON.parse(raw); } catch (e) { o = null; }
      if (o && o.name) { return o.name; }
    }
    /* the copy from setMe, used when the main one has gone */
    try { return window.localStorage.getItem(ME_KEY + '.backup') || ''; } catch (e2) { return ''; }
  }

  function setMe(name) {
    try {
      if (name) { window.localStorage.setItem(ME_KEY, JSON.stringify({ name: name, at: (new Date()).getTime() })); }
      else { window.localStorage.removeItem(ME_KEY); }
    } catch (e) {}
    /* a second copy, so a browser that clears one store still remembers, and
       a plain last-name copy that brings the name back if only the token is left */
    try {
      if (name) {
        window.localStorage.setItem(ME_KEY + '.backup', name);
        window.localStorage.setItem(NAME_KEY, name);
      } else {
        window.localStorage.removeItem(ME_KEY + '.backup');
        window.localStorage.removeItem(NAME_KEY);
      }
    } catch (e2) {}
    return name;
  }

  /* ---------- favourites ---------- */

  function appKeys() {
    var out = [];
    for (var i = 0; i < NAV.length; i++) { out.push(NAV[i][0]); }
    return out;
  }

  function appLabel(key) {
    for (var i = 0; i < NAV.length; i++) {
      if (NAV[i][0] === key) { return NAV[i][1]; }
    }
    return key;
  }

  function favs() {
    var raw = null;
    try { raw = window.localStorage.getItem(FAV_KEY); } catch (e) { raw = null; }
    var arr = null;
    if (raw) { try { arr = JSON.parse(raw); } catch (e) { arr = null; } }
    if (!arr || arr.length === undefined) { arr = []; }
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (isApp(arr[i]) && indexIn(out, arr[i]) < 0) { out.push(arr[i]); }
    }
    return out;
  }

  function isApp(key) {
    for (var i = 0; i < NAV.length; i++) {
      if (NAV[i][0] === key) { return true; }
    }
    return false;
  }

  function indexIn(arr, v) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === v) { return i; }
    }
    return -1;
  }

  function saveFavs(arr) {
    try { window.localStorage.setItem(FAV_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  /* star or unstar one app; returns the new state */
  function toggleFav(key) {
    if (!isApp(key)) { return false; }
    var arr = favs();
    var at = indexIn(arr, key);
    if (at >= 0) {
      arr.splice(at, 1);
      saveFavs(arr);
      return false;
    }
    if (arr.length >= 6) {
      toast('The top bar holds six. Unstar one first.');
      return false;
    }
    arr.push(key);
    saveFavs(arr);
    return true;
  }

  /* ---------- admin ----------
     blockwobble is the owner of this place and holds every power. The name is the
     source of the power: it is the account that was made under that name, signed
     in with its password like anyone else. */

  var OWNER_KEY = 'blockwobble';

  function isOwner() {
    var who = me();
    return who !== '' && nameKey(who) === OWNER_KEY;
  }

  function isBanned(name) {
    var key = nameKey(name);
    var bans = list(tree.bans);
    for (var i = 0; i < bans.length; i++) {
      if (nameKey(bans[i].name) === key) { return true; }
    }
    return false;
  }

  function banFor(name) {
    var key = nameKey(name);
    var bans = list(tree.bans);
    for (var i = 0; i < bans.length; i++) {
      if (nameKey(bans[i].name) === key) { return bans[i]; }
    }
    return null;
  }

  function accountIsAdmin(name) {
    var acc = accountNamed(name);
    return !!(acc && acc.admin);
  }

  /* a message the admin typed, kept on the board it was about */
  function noticeFor(kind, text) {
    var n = list(tree.notices);
    for (var i = 0; i < n.length; i++) {
      if (n[i].kind === kind) { return n[i]; }
    }
    return null;
  }

  function setNotice(kind, text, done) {
    if (workerOn()) {
      apiCall('admin.notice', { text: text, kind: kind }, function (ok, d) {
        if (!ok) { toast((d && d.error) || 'Could not save the notice'); }
        if (done) { done(); }
      });
      return;
    }
    var now = (new Date()).getTime();
    change(function (d) {
      var n = list(d.notices);
      var keep = [];
      for (var i = 0; i < n.length; i++) {
        if (n[i].kind !== kind) { keep.push(n[i]); }
      }
      if (text) { keep.push({ id: newId('n'), kind: kind, text: text, by: me(), at: now }); }
      d.notices = keep;
    }, done || function () { render(); });
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
    if (workerOn()) {
      if (!password || !password2) { done('Type your password twice.'); return; }
      if (password !== password2) { done('The two passwords are different.'); return; }
      if (password.length < 6) { done('The password needs 6 letters or more.'); return; }
      apiCall('signup', { name: name, password: password }, function (ok, d) {
        if (!ok) { done((d && d.error) || 'Could not sign up.'); return; }
        tokenSet(d.token);
        setMe(d.name);
        done(null);
      });
      return;
    }
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
    if (workerOn()) {
      apiCall('signin', { name: name, password: password }, function (ok, d) {
        if (!ok) { done((d && d.error) || 'Could not sign in.'); return; }
        tokenSet(d.token);
        setMe(d.name);
        done(null);
      });
      return;
    }
    pull(function () {
      var acc = findAccount(name);
      if (!acc) { done('No account called "' + name + '".'); return; }
      if (!acc.salt || !acc.hash) {
        done('That name came over from the old HQ with no password. ' +
             'Tap "I need an account" and use the same name to set one.');
        return;
      }
      if (nameKey(acc.name) !== OWNER_KEY && (isBanned(acc.name) || acc.banned)) {
        var bn = banFor(acc.name);
        done('That account has been banned from this HQ.' +
             (bn && bn.reason ? ' The reason: ' + bn.reason : ''));
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

  /* Send one post to the Worker. Through Cloudflare the server decides what is
     allowed, so the page only sends and then re-reads. Returns true when the
     request was handed to the Worker, false when the old path should run. */
  function sendPost(kind, text, thread, title, tag, cb) {
    if (!workerOn()) { return false; }
    apiCall('post', { kind: kind, text: text, thread: thread || '',
      title: title || '', tag: tag || '' }, function (ok, d) {
      if (!ok) {
        toast((d && d.error) || 'Could not send');
      }
      /* straight to the server for the new state, so what was just sent is on
         the screen at once rather than on the next tick */
      if (ok) { pull(function () {}); }
      if (cb) { cb(ok, d); }
    });
    return true;
  }

  /* a comment under a post or a pin */
  function sendComment(on, text, cb) {
    if (!workerOn()) { return false; }
    apiCall('comment', { on: on, text: text }, function (ok, d) {
      if (!ok) { toast((d && d.error) || 'Could not send'); }
      if (ok) { pull(function () {}); }
      if (cb) { cb(ok, d); }
    });
    return true;
  }

  /* what people said under one post, and the box to add to it */
  function commentsFor(p) {
    var cs = p.comments || [];
    var out = '<div class="comments">';
    for (var i = 0; i < cs.length; i++) {
      out += '<div class="comment"><span class="who">' + esc(cs[i].by) + '</span> ' +
        '<span class="small dim">' + when(cs[i].at) + '</span><br>' +
        esc(cs[i].text) + '</div>';
    }
    if (signedIn()) {
      out += '<form class="commentform" data-on="' + esc(p.id) + '" action="#">' +
        '<label for="c' + esc(p.id) + '">Comment</label>' +
        '<input type="text" id="c' + esc(p.id) + '" maxlength="300" ' +
          'autocomplete="off" autocorrect="off" autocapitalize="off">' +
        '<button class="btn wide" type="submit">Say it</button></form>';
    }
    out += '</div>';
    return out;
  }

  /* wire every comment box on the page, keeping whatever is typed in them */
  function wireComments() {
    var root = document.getElementById('root');
    if (!root) { return; }
    var forms = root.getElementsByClassName('commentform');
    for (var i = 0; i < forms.length; i++) {
      forms[i].onsubmit = (function (form) {
        return function (e) {
          e.preventDefault();
          if (!needName()) { return false; }
          var input = form.getElementsByTagName('input')[0];
          var txt = trim(input ? input.value : '');
          if (!txt) { toast('Write the comment first'); return false; }
          if (sendComment(form.getAttribute('data-on'), txt, function (ok) {
            if (ok) { render(); toast('Commented'); }
          })) { return false; }
          return false;
        };
      })(forms[i]);
    }
  }

  /* Ask the Worker to act (delete, like, admin powers). */
  function askServer(action, payload, cb) {
    if (!workerOn()) { return false; }
    apiCall(action, payload, function (ok, d) {
      if (!ok) { toast((d && d.error) || 'That did not work'); }
      if (cb) { cb(ok, d); }
    });
    return true;
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
    ['chat', 'Chat'],
    ['neighborhood', 'Neighborhood'],
    ['pinboard', 'Pinboard'],
    ['topics', 'Topics'],
    ['ai', 'AI Chat'],
    ['code', 'Code']
  ];

  /* The one bar with apps, pinned to the top of the screen on every page.
     Tapping the app you are on (or the star) goes to the Favourites screen. */
  /* The app bar: every app, always, in the same order, plus the HQ and Admin.
     Nothing to star and nothing to manage - it is the same bar for everyone. */
  function dockBar(r) {
    var h = '<div class="favbar dock" id="favbar">' +
      '<a class="fav' + (r === 'home' ? ' on' : '') + '" href="#home" title="The HQ screen">HQ</a>';
    if (isOwner()) {
      h += '<a class="fav' + (r === 'admin' ? ' on' : '') + '" href="#admin" title="Admin">Admin</a>';
    }
    for (var i = 0; i < NAV.length; i++) {
      var k = NAV[i][0];
      var short = NAV[i][1].replace('Neighborhood', 'Hood').replace('Pinboard', 'Pins');
      h += '<a class="fav' + (r === k ? ' on' : '') + '" href="#' + k + '">' + esc(short) + '</a>';
    }
    h += '</div>';
    return h;
  }

  /* The bar is fixed to the top of the screen by CSS, so it stays put while
     the page moves under it. The spacer at the very top of the page is given
     the bar's own height, so the title and the text never slide under it. */
  function stickBar() {
    var b = document.getElementById('favbar');
    var sp = document.getElementById('favspace');
    if (sp) {
      var h = 0;
      if (b && b.offsetHeight) { h = b.offsetHeight; }
      else { h = 56; }
      sp.style.height = h + 'px';
    }
  }

  /* Measure the space left on this device's screen and give it to the room box,
     so the reading part scrolls instead of the page. Runs on every redraw and
     every resize; where nothing can be measured the CSS fallback stands. */
  function fitRoom() {
    var room = null;
    var els = document.getElementsByClassName ? document.getElementsByClassName('room') : null;
    if (els && els.length) { room = els[0]; }
    if (!room || !room.style) { return; }
    var vh = 0;
    try { vh = window.innerHeight || document.documentElement.clientHeight || 0; } catch (e) { vh = 0; }
    if (!vh || vh < 200) { return; }

    var top = 0;
    try {
      var r = room.getBoundingClientRect ? room.getBoundingClientRect() : null;
      if (r) { top = r.top; }
      else { top = room.offsetTop || 0; }
    } catch (e) { top = 0; }

    var used = 0;
    try { used = (window.pageYOffset || document.documentElement.scrollTop || 0); } catch (e) { used = 0; }

    /* what comes under the box: the footer and the page's own bottom padding */
    var under = 74;
    var h = Math.floor(vh - top - under);
    if (h < 240) { h = 240; }
    if (h > 900) { h = 900; }
    room.style.height = h + 'px';
  }

  /* "a, b, c" from the account list */
  function namesOf(accounts) {
    var out = [];
    for (var i = 0; i < accounts.length && i < 40; i++) {
      out.push(accounts[i].name || '');
    }
    if (accounts.length > 40) { out.push('and ' + (accounts.length - 40) + ' more'); }
    return out.join(', ');
  }

  function shell(title, body) {
    var chat = list(tree.chat);
    var nb = list(tree.neighborhood);
    var pins = list(tree.pins);
    var topics = list(tree.topics);
    var r = route();
    var counts = { chat: chat.length, neighborhood: nb.length, pinboard: pins.length, topics: topics.length };


    var who = me();
    var whoBar = who
      ? '<span class="small" style="float:right;padding-top:6px">' + esc(who) +
        ' &middot; <a href="#" id="switchname"><u>sign out</u></a></span>'
      : '<a class="btn small" style="float:right" href="#" id="signinbtn">Sign in</a>';

    var html =
      dockBar(r) +
      '<div id="favspace" style="height:0;margin:0;padding:0"></div>' +
      '<div class="bar">' + whoBar +
        '<a href="#home"><span class="bar-title">ROAKSTASAWD</span></a>' +
      '</div>' +
      (r === 'home' ? '' : '<a class="closer" href="#home" id="tocloser" title="Back to the HQ">&#10005;</a>') +
      '<div class="wrap page-' + esc(r) + '">' +
        '<div id="live" class="live">' + stampLine() + '</div>' +
        '<h1>' + esc(title) + '</h1>' +
        body +
        '<footer>' +
          'ROAKSTASAWD HQ &middot; built for e-ink &middot; ' +
          (cloudOn()
            ? 'accounts and posts are saved on the server.'
            : 'no backend set yet &mdash; posts stay on this device.') +
          '<br><span class="build" id="buildstamp">' + esc(buildLine()) + '</span>' +
        '</footer>' +
      '</div>' +
      '<div id="picker" class="overlay" style="display:none"></div>' +
      '<div id="signin" class="overlay" style="' + (signinOpen ? 'display:block' : 'display:none') + '">' +
        '<div class="wrap" style="padding-top:0" id="signinbody"></div></div>' +
      '<div id="toast"></div>';

    document.getElementById('root').innerHTML = html;
    /* the whole page was just replaced, the sheet with it: put its form back */
    if (signinOpen) {
      var sheet = document.getElementById('signin');
      if (sheet) { sheet.style.display = 'block'; }
      drawSignin(signinMode, signinError, signinName);
    }
    stickBar();
    fitRoom();

    var cl = document.getElementById('tocloser');
    if (cl) {
      cl.onclick = function (e) {
        e.preventDefault();
        closePicker();
        window.location.hash = 'home';
        render();
        return false;
      };
    }
    var sib = document.getElementById('signinbtn');
    if (sib) { sib.onclick = function (e) { e.preventDefault(); openSignin('in'); return false; }; }
    var sw = document.getElementById('switchname');
    if (sw) {
      sw.onclick = function (e) {
        e.preventDefault();
        /* through the Worker the session is ended on the server too, so the
           token cannot be used from anywhere afterwards */
        if (workerOn()) { apiCall('signout', {}, function () {}); }
        passSet('');          /* signing out forgets the kept password too */
        tokenSet('');
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

  /* is the sheet open, and with what */
  /* Set by the sheet itself when it is opened or closed. It is declared on
     window so that no part of the code can be missing it, whatever order the
     browser runs the file in. Without it the page never redraws itself. */
  if (typeof window.ROAK_SIGNIN_OPEN === 'undefined') { window.ROAK_SIGNIN_OPEN = false; }
  var signinOpen = false;
  var signinMode = 'in';
  var signinError = '';
  var signinName = '';

  function setSigninOpen(flag) {
    signinOpen = !!flag;
    try { window.ROAK_SIGNIN_OPEN = !!flag; } catch (e) {}
  }

  function openSignin(mode) {
    var el = document.getElementById('signin');
    if (!el) { return; }
    setSigninOpen(true);
    var wasOpen = signinOpen && signinMode === (mode || 'in') && el.style.display === 'block';
    el.style.display = 'block';
    signinOpen = true;
    signinMode = mode || 'in';
    if (wasOpen) { return; }        /* already up: never wipe what is typed */
    signinError = '';
    signinName = '';
    drawSignin(signinMode, '');
  }

  function closeSignin() {
    setSigninOpen(false);
    signinError = '';
    var el = document.getElementById('signin');
    if (el) { el.style.display = 'none'; }
  }

  /* Signing in is never taken back by the page's own refresh: the session is
     saved, and the next look at the server happens a moment later, once the
     token is in place. */
  function signedInAgain() {
    if (me()) { return; }
    if (!tokenGet()) {
      if (passGet()) { signInAgain(); }
      return;
    }
    if (!passGet()) { return; }
    /* a token is still stored, but the page does not believe it: keep trying
       the kept password now and then until one of them works */
    var nowMs = (new Date()).getTime();
    if (nowMs - lastResign > 8000) {
      lastResign = nowMs;
      signInAgain();
    }
    var last = '';
    try { last = window.localStorage.getItem(NAME_KEY) || ''; } catch (e) { last = ''; }
    if (last) { setMe(last); }
  }

  /* ---------- keeping the sign-in on this device ---------- */
  /* The password is kept only when the person ticks the box, and only on this
     device. It signs them in again by itself if the HQ forgets who they are,
     so nobody has to type it a second time. */
  var PASS_KEY = 'roak.pass';
  var PASS_WANT = 'roak.pass.want';

  function passGet() {
    try { return window.localStorage.getItem(PASS_KEY) || ''; } catch (e) { return ''; }
  }

  function passSet(pass) {
    try {
      if (pass) {
        window.localStorage.setItem(PASS_KEY, pass);
        window.localStorage.setItem(PASS_WANT, '1');
      } else {
        window.localStorage.removeItem(PASS_KEY);
        window.localStorage.removeItem(PASS_WANT);
      }
    } catch (e) {}
  }

  function passWanted() {
    try { return window.localStorage.getItem(PASS_WANT) === '1'; } catch (e) { return false; }
  }

  /* sign in again from the password kept on this device, once at a time */
  var resigning = false;
  var lastResign = 0;

  function signInAgain() {
    if (resigning) { return; }
    var pass = passGet();
    var who = '';
    try { who = window.localStorage.getItem(NAME_KEY) || ''; } catch (e) { who = ''; }
    if (!pass || !who) { return; }
    resigning = true;
    /* the same call the sign-in form makes, so a kept password is treated
       exactly like a typed one */
    signIn(who, pass, function (err) {
      resigning = false;
      if (err) { return; }
      tokenRemember();
      renderSoft();
      pull(function () { renderSoft(); });
    });
  }

  function afterSignin() {
    tokenRemember();
    for (var i = 0; i < 3; i++) {
      window.setTimeout(function () {
        if (!signedIn() || !tokenGet()) { return; }
        pull(function () { renderSoft(); });
      }, 400 + i * 1200);
    }
  }

  function drawSignin(mode, error, keepName) {
    var box = document.getElementById('signinbody');
    if (!box) { return; }
    var signup = mode === 'up';
    /* what was typed, so a redraw never wipes it */
    var typedName = keepName !== undefined ? keepName : signinName;
    var typedPass = '';
    var typedPass2 = '';
    if (signinOpen) {
      try { typedPass = document.getElementById('accpass').value || ''; } catch (e1) {}
      try { typedPass2 = document.getElementById('accpass2').value || ''; } catch (e2) {}
    }
    signinMode = mode;
    signinError = error || '';
    var pw = '<input type="password" id="accpass" name="roakpass" maxlength="100" ' +
             'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
             'data-lpignore="true">';

    var html = '<div class="box">' +
      '<h2 style="margin-top:0">' + (signup ? 'Make an account' : 'Sign in') + '</h2>' +
      (error ? '<div class="box tight" style="border-width:3px"><b>' + esc(error) + '</b></div>' : '') +
      '<p class="small">' + (signup
        ? 'A name, and a password only you know. No two accounts can share a name.'
        : 'Your name and password.') + '</p>' +
      '<p class="small dim" style="margin:0 0 10px">' +
        'An account brought over from the old HQ with no password: type your old name ' +
        'and pick a password with <b>I need an account</b> &mdash; it takes the name back ' +
        'and sets the password.' +
      '</p>' +
      '<form id="accform" action="#">' +
        '<label for="accname">Name</label>' +
        '<input type="text" id="accname" name="roakname" maxlength="20" autocomplete="off" ' +
          'autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" value="' +
            esc(typedName || (signup ? '' : me())) + '">' +
        '<label for="accpass">' + (signup ? 'Password (6+ characters)' : 'Password') + '</label>' +
        pw +
        (signup
          ? '<label for="accpass2">Password again</label>' +
            '<input type="password" id="accpass2" name="roakpass2" maxlength="100" ' +
            'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
            'data-lpignore="true">'
          : '') +
        '<label style="display:block;margin-top:12px">' +
          '<input type="checkbox" id="acckeep" style="width:auto;min-height:0;margin-right:10px"' +
          (passWanted() ? ' checked' : '') + '> Keep me signed in on this device' +
        '</label>' +
        '<p class="small" style="margin:4px 0 10px">' +
          (passWanted()
            ? 'Your password is kept on this device only, so the HQ can sign you back ' +
              'in by itself. Untick the box to forget it.'
            : 'Ticked, your password is kept on this device only, so the HQ can sign ' +
              'you back in by itself if it forgets you.') +
        '</p>' +
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

    /* what was already typed goes back in, so a redraw costs nothing */
    if (typedPass) { try { document.getElementById('accpass').value = typedPass; } catch (e3) {} }
    if (typedPass2 && document.getElementById('accpass2')) {
      try { document.getElementById('accpass2').value = typedPass2; } catch (e4) {}
    }

    var f = document.getElementById('accname');
    if (f && !typedName) { try { f.focus(); } catch (e) {} }

    document.getElementById('accswitch').onclick = function () {
      var keep = '';
      try { keep = document.getElementById('accname').value || ''; } catch (e5) {}
      signinName = keep;
      drawSignin(signup ? 'in' : 'up', '', keep);
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

      signinName = name;
      busy(true);
      var keep = false;
      try { keep = !!(document.getElementById('acckeep') || {}).checked; } catch (e) {}
      var finish = function (err) {
        if (err) { drawSignin(signup ? 'up' : 'in', err, name); return; }
        passSet(keep ? pass : '');
        closeSignin();
        render();
        toast(signup ? 'Welcome, ' + me() : 'Signed in as ' + me());
        afterSignin();
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

  /* The server light in the corner of the HQ page: one line, plain words. */
  /* "Build 3.0 · 28 Nov 2026 · from the site" - short enough for a Kindle */
  function buildLine() {
    return 'Build ' + BUILD + ' \u00b7 ' + BUILD_DATE +
      ' \u00b7 ' + (cloudOn() ? 'from the site' : 'on this device');
  }

  function serverLight() {
    var on = cloudOn();
    var seen = serverSeen();
    var cls = ' light down';
    var word = 'Down';
    var why = '';
    if (!on) {
      cls = ' light local';
      word = 'On this device';
      why = 'No server is set, so everything is kept on this device only.';
    } else if (state === 'loading' && !seen.ever) {
      cls = ' light wait';
      word = 'Checking';
      why = 'Asking the server how things are.';
    } else if (seen.up && state !== 'offline') {
      cls = ' light up';
      word = 'Up';
      why = 'The server answered ' + (seen.at ? when(seen.at) : 'just now') + '.';
    } else {
      why = seen.at
        ? 'The last answer from the server was ' + when(seen.at) + '.'
        : 'The server has not answered yet.';
    }
    /* cls carries its own "light " so one class list reads plainly */
    return '<div class="serverlight' + cls + '" title="' + esc(why) + '">' +
      '<span class="dot"></span>' + esc(word) +
      '<span class="when">' + esc(seen.at && on ? when(seen.at) : '') + '</span></div>';
  }

  /* ---------- admin notes on the HQ page ---------- */

  function noteFor(kind) {
    var n = list(tree.notices);
    for (var i = 0; i < n.length; i++) {
      if (n[i].kind === kind) { return n[i]; }
    }
    return null;
  }

  function adminNotesBox() {
    var note = noteFor('home');
    var out = '';
    if (note) {
      out += '<div class="notice"><b>Note from ' + esc(note.by) + '</b><br>' + esc(note.text) +
        '<br><span class="small dim">' + when(note.at) + '</span></div>';
    } else if (!isAdminHere()) {
      return '';
    }
    if (isAdminHere()) {
      out += '<div class="box tight"><label for="homenote">' +
        (note ? 'Change the note' : 'Write a note for everyone') + '</label>' +
        '<textarea id="homenote" maxlength="500">' + (note ? esc(note.text) : '') + '</textarea>' +
        '<a class="btn wide" href="#" id="homenotesave">' + (note ? 'Save the note' : 'Put the note up') + '</a>' +
        (note ? '<a class="btn wide" href="#" id="homenoteclear">Take it down</a>' : '') +
        '</div>';
    }
    return out;
  }

  /* The Discord: a plain button and the QR code, on the HQ page only, so a
     Kindle that cannot scan can still be typed the link by a friend. */
  var DISCORD = 'https://discord.gg/ZXhBXCetKZ';

  function discordBox() {
    return '<h2>Discord</h2>' +
      '<div class="box"><p class="small" style="margin:0 0 8px 0">' +
        'The ROAKSTASAWD Discord is where the group chats off the HQ. ' +
        'Tap the button, or scan the code with a phone.' +
      '</p>' +
      '<a class="btn wide" href="' + DISCORD + '">Join the Discord</a>' +
      '<img class="qr" src="img-discord.png" alt="QR code for the ROAKSTASAWD Discord">' +
      '<p class="small dim" style="margin:8px 0 0 0">' + esc(DISCORD) + '</p>' +
      '</div>';
  }

  function isAdminHere() {
    var who = me();
    if (!who) { return false; }
    if (isOwner()) { return true; }
    var acc = accountNamed(who);
    return !!(acc && acc.admin);
  }

  function wireAdminNotes() {
    var save = document.getElementById('homenotesave');
    if (save) {
      save.onclick = function (e) {
        e.preventDefault();
        var t = trim(document.getElementById('homenote').value);
        setNotice('home', t, function () { render(); toast(t ? 'Note is up' : 'Note taken down'); });
        return false;
      };
    }
    var clear = document.getElementById('homenoteclear');
    if (clear) {
      clear.onclick = function (e) {
        e.preventDefault();
        setNotice('home', '', function () { render(); toast('Note taken down'); });
        return false;
      };
    }
  }

  /* A page that is only for members: said once, in plain words, with the two
     ways in right under it. Every app on the HQ uses this. */
  function gateBox(what) {
    return '<div class="empty">' +
      '<b>' + esc(what.charAt(0).toUpperCase() + what.slice(1)) + ' is for members.</b><br>' +
      '<span class="small">Sign in, or make an account, and it opens right up. ' +
      'An account is only a name and a password.</span>' +
      '</div>';
  }

  function nameBox(what) {
    if (signedIn()) { return ''; }
    what = what || 'this';
    return '<div class="box">' +
      '<b>' + esc(what.charAt(0).toUpperCase() + what.slice(1)) + ' needs an account.</b><br>' +
      '<span class="small">Sign in, or make one. An account is a name and a password ' +
      'only you know. No two accounts can share a name.</span><br>' +
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
    var who = me();
    var body = '';

    /* where you are */
    if (who) {
      body += '<div class="box tight"><p class="small" style="margin:0">' +
        'Signed in as <b>' + esc(who) + '</b> &middot; ' +
        '<a href="#" id="homeout">sign out</a></p></div>';
    } else {
      body += '<div class="box tight"><p class="small" style="margin:0">' +
        'You are not signed in. You can read everything; sign in to post.' +
        '</p><a class="btn" href="#" id="homein">Sign in</a> ' +
        '<a class="btn" href="#" id="homeup">Make an account</a></div>';
    }

    body += '<div class="corner">' + serverLight() + '</div>';
    /* which build this is, in plain words, at the top of the HQ page */
    body += '<p class="small dim" id="hqbuild" style="margin:0 0 10px 0">' +
            esc(buildLine()) + '</p>';
    body += statusBox();

    /* the apps, as big tiles, two to a row on wider screens */
    var tiles = [
      ['chat', 'Chat', chat.length + ' message' + (chat.length === 1 ? '' : 's'), 'live, everyone at once'],
      ['neighborhood', 'Neighborhood', nb.length + ' post' + (nb.length === 1 ? '' : 's'), 'longer posts, slower pace'],
      ['pinboard', 'Pinboard', pins.length + ' pin' + (pins.length === 1 ? '' : 's'), 'the permanent board'],
      ['topics', 'Topics', topics.length + ' thread' + (topics.length === 1 ? '' : 's'), 'one subject per thread'],
      ['ai', 'AI Chat', 'ask the AI', 'your own conversation'],
      ['code', 'Code', 'many languages', 'write and run code here']
    ];
    body += '<h2>Apps</h2>' +
      '<p class="small dim">Every app is also in the bar along the top of the screen.</p>' +
      '<div class="tiles">';
    for (var t = 0; t < tiles.length; t++) {
      var k = tiles[t][0];
      body += '<div class="tile">' +
        '<a class="tilego" href="#' + k + '">' +
          '<span class="tt">' + esc(tiles[t][1]) + '</span>' +
          '<span class="tn">' + esc(tiles[t][2]) + '</span>' +
          '<span class="td">' + esc(tiles[t][3]) + '</span>' +
        '</a>' +
      '</div>';
    }
    body += '</div>';

    /* a note from the admin, and the box to write one, on this page only */
    body += adminNotesBox();

    /* the group's Discord, with its QR code */
    body += discordBox();

    /* what is happening */
    body += '<h2>Right now</h2>';
    var shown = 0;
    if (chat.length) {
      var last = chat[chat.length - 1];
      body += '<div class="post"><div class="post-meta"><span class="who">' + esc(last.by) +
        '</span> &middot; in chat &middot; ' + when(last.at) + '</div>' +
        '<div class="post-body">' + esc(last.text) + '</div></div>';
      shown++;
    }
    if (nb.length) {
      var lp = nb[nb.length - 1];
      body += '<div class="post"><div class="post-meta"><span class="who">' + esc(lp.by) +
        '</span> &middot; in the neighborhood &middot; ' + when(lp.at) + '</div>' +
        '<div class="post-body">' + esc(lp.text) + '</div></div>';
      shown++;
    }
    if (pins.length) {
      var lpin = pins[pins.length - 1];
      body += '<div class="post"><div class="post-meta"><span class="who">' + esc(lpin.by) +
        '</span> &middot; pinned &middot; ' + when(lpin.at) + '</div>' +
        '<div class="post-body">' + esc(lpin.text) + '</div></div>';
      shown++;
    }
    if (topics.length) {
      var lt = topics[topics.length - 1];
      body += '<a class="topic" href="#topic?id=' + esc(lt.id) + '"><span class="t">' + esc(lt.title) +
        '</span><span class="m">' + esc(lt.by) + ' &middot; ' + when(lt.at) +
        ' &middot; ' + list(lt.replies).length + ' repl' + (list(lt.replies).length === 1 ? 'y' : 'ies') + '</span></a>';
      shown++;
    }
    if (!shown) {
      body += '<div class="empty"><b>Nothing posted yet.</b><br>' +
        '<span class="small">Say hello in the chat, and this fills up.</span></div>';
    }
    body += '<a class="btn" href="#chat">Go to the chat</a>';

    /* who is here */
    body += '<h2>Members</h2><div class="box tight"><p class="small" style="margin:0">' +
      (accounts.length
        ? accounts.length + ' account' + (accounts.length === 1 ? '' : 's') + ': ' + esc(namesOf(accounts))
        : 'No accounts yet &mdash; make the first one.') +
      '</p></div>';

    shell('HQ', body);

    wireAdminNotes();

    var bi = document.getElementById('homein');
    if (bi) { bi.onclick = function (e) { e.preventDefault(); openSignin('in'); return false; }; }
    var bu = document.getElementById('homeup');
    if (bu) { bu.onclick = function (e) { e.preventDefault(); openSignin('up'); return false; }; }
    var bo = document.getElementById('homeout');
    if (bo) {
      bo.onclick = function (e) {
        e.preventDefault();
        /* signing out ends the session on the server and forgets any password
           kept on this device, or the page would sign straight back in */
        if (workerOn()) { apiCall('signout', {}, function () {}); }
        passSet('');
        tokenSet('');
        setMe('');
        render();
        toast('Signed out');
        return false;
      };
    }
  }

  /* The app bar is the same for everyone: this page just shows what is in it. */
  function pageFavorites() {
    var body = '';
    body += '<p class="small dim">Every app sits in the bar along the top of the screen, ' +
            'on every page, so it is always one tap away. The <b>&times;</b> in the corner ' +
            'goes back to the HQ screen.</p>';
    for (var i = 0; i < NAV.length; i++) {
      body += '<a class="pick" href="#' + NAV[i][0] + '">' +
        '<span class="nm">' + esc(NAV[i][1]) + '</span>' +
        '<span class="st">open</span>' +
      '</a>';
    }
    body += '<a class="btn wide" href="#home">Back to the HQ</a>';
    shell('Apps', body);
  }


  /* Chat has two rooms: the global chat everyone shares, and direct messages. */
  function pageChat() {
    var id = qs('id');
    var tab = id ? 'dm' : (qs('tab') === 'dm' ? 'dm' : 'global');

    var head = '<div class="subtabs">' +
      '<a href="#chat" class="subtab' + (tab === 'global' ? ' on' : '') + '">Global chat</a>' +
      '<a href="#chat?tab=dm" class="subtab' + (tab === 'dm' ? ' on' : '') + '">Direct messages' +
        (dmMine().length ? '<span class="tag">' + dmMine().length + '</span>' : '') + '</a>' +
      '<a class="plus" href="#" id="chatplus" title="New direct message">+</a>' +
    '</div>';

    if (tab === 'dm') { pageDm(id, head); return; }

    var all = list(tree.chat);
    var shown = chatShown();
    var shownCount = Math.min(shown, all.length);
    var body = '';

    body += head;
    body += statusBox();
    body += nameBox('chat');
    if (!signedIn()) {
      body += gateBox('the chat');
      shell('Chat', body);
      wireStart();
      return;
    }
    body += '<div class="room">';
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
    '</div></div>';

    shell('Chat', body);
    wireStart();
    wirePlus('global');
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
      if (sendPost('chat', t, '', '', '', function () { refresh(); })) { return false; }
      change(function (d) {
        d.chat = list(d.chat).concat([msg]);
      }, function (ok) {
        refresh();
        if (!ok) { toast('Saved on this device — will send when back online'); }
      });
      return false;
    };
  }

  /* One conversation, or the list of them when no id is given. */
  function pageDm(id, head) {
    var body = head;
    body += statusBox();
    body += nameBox('direct messages');

    if (!signedIn()) {
      body += gateBox('direct messages');
      shell('Chat', body);
      wireStart();
      wirePlus('dm');
      return;
    }

    if (!id) {
      var mine = dmMine();
      body += '<div class="room"><div class="roomlist">';
      body += '<p class="small dim">Your conversations, kept from visit to visit. ' +
              'Tap <b>+</b> to start a new one.</p>';
      if (!mine.length) {
        body += '<div class="empty"><b>No direct messages yet.</b><br>' +
          '<span class="small">Tap + to pick someone.</span></div>';
      }
      for (var i = 0; i < mine.length; i++) {
        var m = mine[i];
        var unread = dmUnread(m.id);
        body += '<a class="topic" href="#dm?id=' + encodeURIComponent(m.id) + '">' +
          '<span class="t">' + esc(m.other) + (unread ? ' <span class="tag">' + unread + '</span>' : '') + '</span>' +
          '<span class="m">' + esc(String(m.preview).slice(0, 60)) + ' &middot; ' + when(m.at) + '</span></a>';
      }
      body += '</div><div class="roomfoot">' +
        '<a class="btn wide" href="#" id="dmnew">+ New direct message</a></div></div>';
      shell('Direct messages', body);
      wireStart();
      wirePlus('dm');
      var nb = document.getElementById('dmnew');
      if (nb) { nb.onclick = function (e) { e.preventDefault(); openPicker('dm'); return false; }; }
      return;
    }

    /* one conversation */
    var thread = dmThread(id);
    if (!thread) {
      body += '<div class="empty"><b>No conversation here yet.</b><br>' +
        '<span class="small">Pick someone with + to start one.</span></div>' +
        '<a class="btn" href="#chat?tab=dm">Back to direct messages</a>';
      shell('Direct messages', body);
      wireStart();
      wirePlus('dm');
      return;
    }

    var bits = id.split('~');
    var mineKey = nameKey(me());
    if (bits[0] !== mineKey && bits[1] !== mineKey) {
      body += '<div class="empty"><b>That is not one of your conversations.</b><br>' +
        '<a class="btn" href="#chat?tab=dm">Back to direct messages</a></div>';
      shell('Direct messages', body);
      wireStart();
      wirePlus('dm');
      return;
    }
    var otherKey = bits[0] === mineKey ? bits[1] : bits[0];
    var otherName = (thread.names && thread.names[otherKey]) ? thread.names[otherKey] : otherKey;
    var msgs = dmMsgs(id);

    body += '<p class="small"><a href="#chat?tab=dm">&larr; All direct messages</a></p>';
    body += '<div class="box tight"><b>With ' + esc(otherName) + '</b><br>' +
            '<span class="small dim">' + msgs.length + ' message' + (msgs.length === 1 ? '' : 's') +
            ' &middot; kept from visit to visit</span></div>';
    body += '<div class="room">';
    body += '<div class="chatlog" id="dmlog">' + dmLogHtml(id) + '</div>';
    body += '<div class="chatform"><form id="dmform" action="#dm?id=' + encodeURIComponent(id) + '">' +
      '<label for="dmtext">Message</label>' +
      '<textarea id="dmtext" maxlength="500"></textarea>' +
      '<button class="btn wide" type="submit">Send</button>' +
    '</form></div></div>';

    shell('Direct messages', body);
    wireStart();
    wirePlus('dm');
    dmSeen(id);
    scrollChatToEnd();

    document.getElementById('dmform').onsubmit = function (e) {
      e.preventDefault();
      var txt = trim(document.getElementById('dmtext').value);
      if (!txt) { toast('Type a message'); return false; }
      document.getElementById('dmtext').value = '';
      var msg = { id: newId('d'), by: me(), text: txt, at: (new Date()).getTime() };
      var store = dmStore();
      if (!store[id]) { store[id] = { names: {} }; }
      store[id].msgs = list(store[id].msgs).concat([msg]);
      if (!store[id].names) { store[id].names = {}; }
      store[id].names[mineKey] = me();
      store[id].names[otherKey] = otherName;
      var log = document.getElementById('dmlog');
      if (log) {
        if (log.getElementsByClassName('empty').length) { log.innerHTML = ''; }
        log.innerHTML += '<div class="msg me"><span class="who">' + esc(msg.by) +
          '</span><span class="when">just now</span><div class="text">' + esc(msg.text) + '</div></div>';
        scrollChatToEnd();
      }
      var mineMsgs = list(store[id].msgs);
      var names = store[id].names;
      if (sendPost('dm', txt, id, '', '', function (ok) {
        dmSeen(id);
        if (ok) { refresh(); }
      })) { return false; }
      change(function (d) {
        if (!d.dm) { d.dm = {}; }
        d.dm[id] = { names: names, msgs: mineMsgs };
      }, function (ok) {
        dmSeen(id);
        if (!ok) { toast('Saved on this device — will send when back online'); }
      });
      return false;
    };
  }

  function dmLogHtml(id) {
    var msgs = dmMsgs(id);
    if (!msgs.length) {
      return '<div class="empty"><b>Nothing said yet.</b><br>' +
        '<span class="small">Write the first message.</span></div>';
    }
    var h = '';
    for (var i = 0; i < msgs.length; i++) {
      h += '<div class="msg' + (msgs[i].by === me() ? ' me' : '') + '">' +
        '<span class="who">' + esc(msgs[i].by) + '</span>' +
        '<span class="when">' + when(msgs[i].at) + '</span>' +
        '<div class="text">' + esc(msgs[i].text) + '</div>' +
      '</div>';
    }
    return h;
  }

  /* the + in the chat header: a new conversation, or a new topic */
  function wirePlus(mode) {
    var plus = document.getElementById('chatplus');
    if (!plus) { return; }
    plus.onclick = function (e) {
      e.preventDefault();
      openPicker('dm');
      return false;
    };
  }

  /* the chat log's markup, so a live refresh can redraw just the log */
  function chatLogHtml() {
    var all = list(tree.chat);
    var shown = Math.min(chatShown(), all.length);
    var part = all.slice(all.length - shown);
    if (!part.length) {
      return '<div class="empty"><b>No messages yet.</b><br>' +
        '<span class="small">Say hello.</span></div>';
    }
    var h = '';
    for (var i = 0; i < part.length; i++) {
      var m = part[i];
      h += '<div class="msg' + (m.by === me() ? ' me' : '') + '">' +
        '<span class="who">' + esc(m.by) + '</span>' +
        '<span class="when">' + when(m.at) + '</span>' +
        '<div class="text">' + esc(m.text) + '</div>' +
      '</div>';
    }
    return h;
  }

  /* how many chat messages to draw: remembered on this device, capped */
  function chatShown() {
    var n = 0;
    try { n = parseInt(window.localStorage.getItem(VIEW_KEY), 10) || 0; } catch (e) { n = 0; }
    if (!n || n < CHAT_SHOWN) { return CHAT_SHOWN; }
    if (n > KEEP_CHAT) { return KEEP_CHAT; }
    return n;
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
    var dlog = document.getElementById('dmlog');
    if (dlog) {
      var did = qs('id');
      var atEnd2 = (dlog.scrollHeight - dlog.scrollTop - dlog.clientHeight) < 40;
      var h2 = dmLogHtml(did);
      if (dlog.innerHTML !== h2) {
        dlog.innerHTML = h2;
        if (atEnd2) { scrollChatToEnd(); }
        dmSeen(did);
      }
      var st2 = document.getElementById('live');
      if (st2) { st2.innerHTML = stampLine(); }
      stickBar();
      return;
    }
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
          commentsFor(p) +
        '</div>';
      }
    }

    body += statusBox();
    body += nameBox('the neighborhood');
    if (!signedIn()) {
      body += gateBox('the neighborhood');
      shell('Neighborhood', body);
      wireStart();
      return;
    }
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
    wireComments();

    document.getElementById('postform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var t = trim(document.getElementById('posttext').value);
      if (!t) { toast('Write something first'); return false; }
      var tag = trim(document.getElementById('posttag').value).replace(/[^A-Za-z0-9]/g, '');
      if (sendPost('post', t, '', '', tag, function (ok) {
        if (ok) { render(); toast('Posted'); }
      })) { return false; }
      change(function (d) {
        d.neighborhood.push({ id: newId('n'), by: me(), text: t, tag: tag, at: (new Date()).getTime() });
      }, function (ok) {
        render();
        toast(ok ? 'Posted' : 'Saved on this device — will sync');
      });
      return false;
    };

    wireListActions('data-like', function (id) {
      if (askServer('like', { id: id }, function () { render(); })) { return; }
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
      if (askServer('delete', { id: id }, function () { render(); toast('Deleted'); })) { return; }
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
    var note = noticeFor('pins');
    var body = '';
    if (note) {
      body += '<div class="notice"><b>Notice</b><br>' + esc(note.text) +
        '<br><span class="small dim">' + esc(note.by) + ' &middot; ' + when(note.at) + '</span></div>';
    }
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
          commentsFor(p) +
        '</div>';
      }
    }

    body += statusBox();
    body += nameBox('the pinboard');
    if (!signedIn()) {
      body += gateBox('the pinboard');
      shell('Pinboard', body);
      wireStart();
      return;
    }
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
    wireComments();

    document.getElementById('pinform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var t = trim(document.getElementById('pintext').value);
      if (!t) { toast('Write the pin first'); return false; }
      var now = (new Date()).getTime();
      if (workerOn()) {
        if (editing) {
          askServer('delete', { id: editing.id }, function () {
            sendPost('pin', t, '', '', '', function () {
              window.location.hash = 'pinboard';
              render();
              toast('Pin saved');
            });
          });
        } else {
          sendPost('pin', t, '', '', '', function (ok) {
            if (ok) { render(); toast('Pinned'); }
          });
        }
        return false;
      }
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
      if (askServer('delete', { id: id }, function () { render(); toast('Unpinned'); })) { return; }
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
      body += '<div class="room"><div class="roomlist" id="replies">';
      if (!replies.length) {
        body += '<div class="empty"><b>No replies yet.</b></div>';
      }
      for (i = 0; i < replies.length; i++) {
        body += '<div class="post">' +
          '<div class="post-meta"><span class="who">' + esc(replies[i].by) + '</span> &middot; ' + when(replies[i].at) + '</div>' +
          '<div class="post-body">' + esc(replies[i].text) + '</div>' +
        '</div>';
      }
      body += '</div><div class="roomfoot"><form id="replyform" action="#topics?id=' + encodeURIComponent(id) + '">' +
        '<label for="replytext">Reply</label>' +
        '<textarea id="replytext" maxlength="2000"></textarea>' +
        '<button class="btn wide" type="submit">Post reply</button>' +
      '</form></div></div>';
      body = '<div class="subtabs">' +
        '<a class="subtab" href="#topics">All topics</a>' +
        '<a class="plus" href="#" id="topicplus" title="New topic">+</a>' +
      '</div>' + body;
      shell(t.title, body);
      wireStart();
      var tp2 = document.getElementById('topicplus');
      if (tp2) {
        tp2.onclick = function (e) { e.preventDefault(); openPicker('topic'); return false; };
      }

      document.getElementById('replyform').onsubmit = function (e) {
        e.preventDefault();
        if (!needName()) { return false; }
        var txt = trim(document.getElementById('replytext').value);
        if (!txt) { toast('Write a reply first'); return false; }
        if (sendPost('reply', txt, id, '', '', function (ok) {
          if (ok) { render(); toast('Reply posted'); }
        })) { return false; }
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

    body += '<div class="subtabs">' +
      '<span class="subtab on">All topics</span>' +
      '<a class="plus" href="#" id="topicplus" title="New topic">+</a>' +
    '</div>';
    body += statusBox();
    body += nameBox('topics');
    if (!signedIn()) {
      body += gateBox('topics');
      shell('Topics', body);
      wireStart();
      return;
    }
    body += '<p class="small dim">One subject per thread. Every topic and reply is kept. ' +
            'Tap <b>+</b> to start one.</p>';

    body += '<div class="room"><div class="roomlist">';
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
    body += '</div></div>';

    shell('Topics', body);
    wireStart();

    var tp = document.getElementById('topicplus');
    if (tp) {
      tp.onclick = function (e) {
        e.preventDefault();
        openPicker('topic');
        return false;
      };
    }
  }

  /* ---------- direct messages ----------
     A conversation lives in the shared document under dm[convId], where the id is
     made from the two names sorted, so both people land in the same place and the
     list of your conversations is built from your own name. */

  function dmIdFor(a, b) {
    var ka = nameKey(a);
    var kb = nameKey(b);
    if (!ka || !kb || ka === kb) { return ''; }
    return ka < kb ? ka + '~' + kb : kb + '~' + ka;
  }

  function dmStore() {
    if (!tree.dm || typeof tree.dm !== 'object') { tree.dm = {}; }
    return tree.dm;
  }

  function dmThread(id) {
    if (!id) { return null; }
    var all = dmStore();
    return all[id] ? all[id] : null;
  }

  function dmMsgs(id) {
    var t = dmThread(id);
    return t ? list(t.msgs) : [];
  }

  /* every conversation the signed-in person is part of, newest first */
  function dmMine() {
    var who = me();
    if (!who) { return []; }
    var key = nameKey(who);
    var all = dmStore();
    var out = [];
    for (var id in all) {
      if (!all.hasOwnProperty(id)) { continue; }
      var bits = id.split('~');
      if (bits.length !== 2) { continue; }
      if (bits[0] !== key && bits[1] !== key) { continue; }
      var otherKey = bits[0] === key ? bits[1] : bits[0];
      var msgs = list(all[id].msgs);
      var last = msgs.length ? msgs[msgs.length - 1] : null;
      out.push({
        id: id,
        other: (all[id].names && all[id].names[otherKey]) ? all[id].names[otherKey] : otherKey,
        at: last ? last.at : 0,
        preview: last ? last.text : '',
        count: msgs.length
      });
    }
    out.sort(function (x, y) { return (y.at || 0) - (x.at || 0); });
    return out;
  }

  function dmUnread(id) {
    var seen = 0;
    try { seen = parseInt(window.localStorage.getItem('roak.seen.' + id), 10) || 0; } catch (e) { seen = 0; }
    var msgs = dmMsgs(id);
    var n = 0;
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].at > seen && msgs[i].by !== me()) { n++; }
    }
    return n;
  }

  function dmSeen(id) {
    var msgs = dmMsgs(id);
    var last = msgs.length ? msgs[msgs.length - 1].at : 0;
    try { window.localStorage.setItem('roak.seen.' + id, String(last)); } catch (e) {}
  }

  /* the account record whose name matches a typed name, or null */
  function accountNamed(name) {
    var key = nameKey(name);
    var accounts = list(tree.accounts);
    for (var i = 0; i < accounts.length; i++) {
      if (nameKey(accounts[i].name) === key) { return accounts[i]; }
    }
    return null;
  }

  function dmOpen(name) {
    var id = dmIdFor(me(), name);
    if (!id) { return; }
    window.location.hash = 'dm?id=' + encodeURIComponent(id);
    render();
  }

  /* ---------- the admin screen (owner only) ---------- */

  function pageAdmin() {
    var body = '';
    if (!isOwner()) {
      body += '<div class="empty"><b>Admins only.</b><br>' +
        '<span class="small">This screen belongs to the owner of the HQ.</span></div>' +
        '<a class="btn" href="#home">Back to the HQ</a>';
      shell('Admin', body);
      return;
    }

    var accounts = list(tree.accounts);
    var bans = list(tree.bans);
    var pins = list(tree.pins);
    var topics = list(tree.topics);
    var posts = list(tree.neighborhood);
    var chat = list(tree.chat);
    var i;

    body += statusBox();
    body += '<div class="box tight"><p class="small" style="margin:0">' +
      'You are signed in as <b>' + esc(me()) + '</b>, the owner. Everything below acts ' +
      'on the shared HQ straight away.</p></div>';

    /* people */
    body += '<h2>People (' + accounts.length + ')</h2>';
    body += '<div class="room"><div class="roomlist">';
    if (!accounts.length) {
      body += '<div class="empty"><b>No accounts yet.</b></div>';
    }
    for (i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      var owner = nameKey(a.name) === OWNER_KEY;
      var banned = isBanned(a.name) || !!a.banned;
      var admin = !!a.admin;
      body += '<div class="adminrow">' +
        '<div class="adminname">' + esc(a.name) +
          (owner ? ' <span class="tag">owner</span>' : '') +
          (admin ? ' <span class="tag">admin</span>' : '') +
          (banned ? ' <span class="tag">banned</span>' : '') +
        '</div>' +
        '<div class="adminacts">' +
          (owner ? '<span class="small dim">The owner cannot be changed here.</span>' :
            '<a class="btn small" href="#" data-ban="' + esc(a.name) + '">' + (banned ? 'Unban' : 'Ban') + '</a>' +
            '<a class="btn small" href="#" data-admin="' + esc(a.name) + '">' + (admin ? 'Remove admin' : 'Make admin') + '</a>' +
            '<a class="btn small" href="#" data-kick="' + esc(a.name) + '">Kick</a>' +
            '<a class="btn small" href="#" data-purge="' + esc(a.name) + '">Purge their posts</a>' +
            '<a class="btn small" href="#" data-forget="' + esc(a.name) + '">Delete account</a>') +
        '</div>' +
      '</div>';
    }
    body += '</div></div>';

    /* boards */
    body += '<h2>Boards</h2><div class="box tight"><p class="small" style="margin:0">' +
      chat.length + ' chat messages &middot; ' + posts.length + ' neighborhood posts &middot; ' +
      pins.length + ' pins &middot; ' + topics.length + ' topics</p></div>' +
      '<a class="btn" href="#" id="aclearchat">Clear the chat</a> ' +
      '<a class="btn" href="#" id="aclearboard">Clear the neighborhood</a> ' +
      '<a class="btn" href="#" id="aclearpins">Clear the pinboard</a> ' +
      '<a class="btn" href="#" id="acleartopics">Clear all topics</a>';

    /* pinned notice */
    var note = noticeFor('pins');
    body += '<h2>Notice on the pinboard</h2>' +
      '<div class="box tight"><p class="small" style="margin:0">' +
      (note ? 'Now: ' + esc(note.text) : 'No notice up.') + '</p></div>' +
      '<label for="adminnote">Write a notice for everyone</label>' +
      '<textarea id="adminnote" maxlength="500">' + esc(note ? note.text : '') + '</textarea>' +
      '<a class="btn wide" href="#" id="asavenote">Put the notice up</a>' +
      (note ? '<a class="btn wide" href="#" id="aclearnote">Take it down</a>' : '');

    /* bans and the rules */
    body += '<h2>Bans (' + bans.length + ')</h2>';
    if (!bans.length) {
      body += '<div class="empty"><span class="small">Nobody is banned.</span></div>';
    } else {
      for (i = 0; i < bans.length; i++) {
        body += '<div class="post"><div class="post-meta"><span class="who">' + esc(bans[i].name) +
          '</span> &middot; ' + when(bans[i].at) + '</div>' +
          (bans[i].reason ? '<div class="post-body">' + esc(bans[i].reason) + '</div>' : '') +
          '<div class="post-actions"><a href="#" data-unban="' + esc(bans[i].name) + '">Unban</a></div></div>';
      }
    }
    body += '<div class="box tight"><p class="small" style="margin:0">' +
      '<b>Kick</b> signs that person out everywhere and holds their messages until you let them back. ' +
      '<b>Ban</b> also blocks them from signing in. ' +
      '<b>Delete account</b> removes the account itself — that cannot be undone.</p></div>';

    shell('Admin', body);
    wireAdmin();
  }

  function wireAdmin() {
    var root = document.getElementById('root');
    var links = root.getElementsByTagName('a');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var v;
      if ((v = a.getAttribute('data-ban'))) {
        a.onclick = (function (n) { return function (e) { e.preventDefault(); adminToggleBan(n); return false; }; })(v);
      } else if ((v = a.getAttribute('data-unban'))) {
        a.onclick = (function (n) { return function (e) { e.preventDefault(); adminUnban(n); return false; }; })(v);
      } else if ((v = a.getAttribute('data-kick'))) {
        a.onclick = (function (n) { return function (e) { e.preventDefault(); adminKick(n); return false; }; })(v);
      } else if ((v = a.getAttribute('data-admin'))) {
        a.onclick = (function (n) { return function (e) { e.preventDefault(); adminToggleAdmin(n); return false; }; })(v);
      } else if ((v = a.getAttribute('data-purge'))) {
        a.onclick = (function (n) { return function (e) { e.preventDefault(); adminPurge(n); return false; }; })(v);
      } else if ((v = a.getAttribute('data-forget'))) {
        a.onclick = (function (n) { return function (e) { e.preventDefault(); adminForget(n); return false; }; })(v);
      }
    }
    var btns = [
      ['aclearchat', function () { adminClear('chat', 'chat messages'); }],
      ['aclearboard', function () { adminClear('neighborhood', 'neighborhood posts'); }],
      ['aclearpins', function () { adminClear('pins', 'pins'); }],
      ['acleartopics', function () { adminClear('topics', 'topics'); }],
      ['asavenote', function () {
        var t = trim(document.getElementById('adminnote').value);
        setNotice('pins', t, function () { render(); toast(t ? 'Notice is up' : 'Notice taken down'); });
      }],
      ['aclearnote', function () { setNotice('pins', '', function () { render(); toast('Notice taken down'); }); }]
    ];
    for (var b = 0; b < btns.length; b++) {
      var el = document.getElementById(btns[b][0]);
      if (!el) { continue; }
      el.onclick = (function (fn) {
        return function (e) { e.preventDefault(); fn(); return false; };
      })(btns[b][1]);
    }
  }

  function adminOnly(fn) {
    if (!isOwner()) { toast('Admins only'); return false; }
    fn();
    return true;
  }

  function adminToggleBan(name) {
    adminOnly(function () {
      if (isBanned(name)) { adminUnban(name); return; }
      askBanReason(name);
    });
  }

  /* a short sheet: why, then Ban. The reason is what the person is told. */
  function askBanReason(name) {
    var ov = document.getElementById('picker');
    ov.innerHTML = '<div class="sheet">' +
      '<h2 style="margin-top:0">Ban ' + esc(name) + '</h2>' +
      '<label for="banreason">Reason (they see this when they try to sign in)</label>' +
      '<textarea id="banreason" maxlength="200"></textarea>' +
      '<a class="btn wide" href="#" id="banok">Ban ' + esc(name) + '</a>' +
      '<a class="btn wide" href="#" id="bancancel">Cancel</a>' +
    '</div>';
    ov.style.display = 'block';
    document.getElementById('banok').onclick = function (e) {
      e.preventDefault();
      var why = trim(document.getElementById('banreason').value);
      closePicker();
      doBan(name, why);
      return false;
    };
    document.getElementById('bancancel').onclick = function (e) {
      e.preventDefault();
      closePicker();
      return false;
    };
  }

  function doBan(name, reason) {
    adminOnly(function () {
      if (askServer('admin.ban', { name: name, reason: reason || '' },
          function () { render(); toast(name + ' is banned'); })) { return; }
      var now = (new Date()).getTime();
      change(function (d) {
        var b = list(d.bans);
        b.push({ name: name, at: now, by: me(), reason: reason || '' });
        d.bans = b;
        var accs = list(d.accounts);
        for (var i = 0; i < accs.length; i++) {
          if (nameKey(accs[i].name) === nameKey(name)) { accs[i].banned = true; }
        }
        d.accounts = accs;
      }, function () { render(); toast(name + ' is banned'); });
    });
  }

  function adminUnban(name) {
    adminOnly(function () {
      if (askServer('admin.unban', { name: name },
          function () { render(); toast(name + ' is welcome again'); })) { return; }
      change(function (d) {
        var b = list(d.bans);
        var keep = [];
        for (var i = 0; i < b.length; i++) {
          if (nameKey(b[i].name) !== nameKey(name)) { keep.push(b[i]); }
        }
        d.bans = keep;
        var accs = list(d.accounts);
        for (var j = 0; j < accs.length; j++) {
          if (nameKey(accs[j].name) === nameKey(name)) { accs[j].banned = false; }
        }
        d.accounts = accs;
      }, function () { render(); toast(name + ' is welcome again'); });
    });
  }

  /* hold a person's posts, messages and conversations until they are let back */
  function adminKick(name) {
    adminOnly(function () {
      if (askServer('admin.kick', { name: name },
          function () { render(); toast(name + ' is kicked out'); })) { return; }
      var now = (new Date()).getTime();
      change(function (d) {
        var accs = list(d.accounts);
        for (var i = 0; i < accs.length; i++) {
          if (nameKey(accs[i].name) === nameKey(name)) { accs[i].kicked = now; }
        }
        d.accounts = accs;
        d.kicks = d.kicks || [];
        d.kicks.push({ name: name, at: now, by: me() });
      }, function () { render(); toast(name + ' is kicked out'); });
    });
  }

  function adminToggleAdmin(name) {
    adminOnly(function () {
      if (askServer('admin.admin', { name: name },
          function () { render(); toast('Changed'); })) { return; }
      change(function (d) {
        var accs = list(d.accounts);
        for (var i = 0; i < accs.length; i++) {
          if (nameKey(accs[i].name) === nameKey(name)) { accs[i].admin = !accs[i].admin; }
        }
        d.accounts = accs;
      }, function () { render(); toast('Changed'); });
    });
  }

  /* remove everything a person ever wrote */
  function adminPurge(name) {
    adminOnly(function () {
      if (askServer('admin.purge', { name: name },
          function () { render(); toast(name + '\'s posts are gone'); })) { return; }
      var key = nameKey(name);
      change(function (d) {
        var keep = [];
        var src = list(d.chat);
        for (var i = 0; i < src.length; i++) { if (nameKey(src[i].by) !== key) { keep.push(src[i]); } }
        d.chat = keep;
        keep = [];
        src = list(d.neighborhood);
        for (var j = 0; j < src.length; j++) { if (nameKey(src[j].by) !== key) { keep.push(src[j]); } }
        d.neighborhood = keep;
        keep = [];
        src = list(d.pins);
        for (var k = 0; k < src.length; k++) { if (nameKey(src[k].by) !== key) { keep.push(src[k]); } }
        d.pins = keep;
        src = list(d.topics);
        var topics = [];
        for (var t = 0; t < src.length; t++) {
          var replies = list(src[t].replies);
          var rkeep = [];
          for (var r = 0; r < replies.length; r++) {
            if (nameKey(replies[r].by) !== key) { rkeep.push(replies[r]); }
          }
          src[t].replies = rkeep;
          if (nameKey(src[t].by) !== key) { topics.push(src[t]); }
        }
        d.topics = topics;
        var ai = d.ai && d.ai.msgs ? list(d.ai.msgs) : [];
        var akeep = [];
        for (var m = 0; m < ai.length; m++) { if (nameKey(ai[m].by) !== key) { akeep.push(ai[m]); } }
        if (d.ai) { d.ai.msgs = akeep; }
        if (d.dm) {
          for (var id in d.dm) {
            if (!d.dm.hasOwnProperty(id)) { continue; }
            var msgs = list(d.dm[id].msgs);
            var mkeep = [];
            for (var q = 0; q < msgs.length; q++) { if (nameKey(msgs[q].by) !== key) { mkeep.push(msgs[q]); } }
            d.dm[id].msgs = mkeep;
          }
        }
      }, function () { render(); toast(name + '\'s posts are gone'); });
    });
  }

  /* remove the account itself */
  function adminForget(name) {
    adminOnly(function () {
      if (askServer('admin.forget', { name: name },
          function () { render(); toast(name + ' is deleted'); })) { return; }
      var key = nameKey(name);
      change(function (d) {
        var accs = list(d.accounts);
        var keep = [];
        for (var i = 0; i < accs.length; i++) {
          if (nameKey(accs[i].name) !== key) { keep.push(accs[i]); }
        }
        d.accounts = keep;
        var b = list(d.bans);
        var bkeep = [];
        for (var j = 0; j < b.length; j++) { if (nameKey(b[j].name) !== key) { bkeep.push(b[j]); } }
        d.bans = bkeep;
      }, function () { render(); toast(name + ' is deleted'); });
    });
  }

  function adminClear(which, label) {
    adminOnly(function () {
      if (askServer('admin.clear', { kind: which },
          function () { render(); toast('The ' + label + ' are cleared'); })) { return; }
      change(function (d) {
        d[which] = [];
      }, function () { render(); toast('The ' + label + ' are cleared'); });
    });
  }

  /* ---------- the people picker (the + button) ---------- */

  var pickerMode = 'dm';

  function openPicker(mode) {
    pickerMode = mode || 'dm';
    var el = document.getElementById('picker');
    if (!el) { return; }
    var body = '';
    if (pickerMode === 'dm') {
      body += '<h2>New direct message</h2>' +
        '<p class="small dim">Pick someone. The conversation is kept, so it is still there ' +
        'the next time you open this page.</p>';
      if (!signedIn()) {
        body += '<div class="box tight"><b>Sign in first.</b><br>' +
          '<span class="small">Direct messages are between accounts.</span><br>' +
          '<a class="btn" href="#" id="pickin">Sign in</a> ' +
          '<a class="btn" href="#" id="pickup">Make an account</a></div>';
      } else {
        var accounts = list(tree.accounts);
        var who = nameKey(me());
        var any = false;
        for (var i = 0; i < accounts.length; i++) {
          if (nameKey(accounts[i].name) === who) { continue; }
          any = true;
          var cid = dmIdFor(me(), accounts[i].name);
          body += '<a class="pick" href="#" data-dm="' + esc(accounts[i].name) + '">' +
            '<span class="star">&#9993;</span>' +
            '<span class="nm">' + esc(accounts[i].name) + '</span>' +
            '<span class="st">' + (dmThread(cid) ? 'conversation started' : 'start a conversation') + '</span>' +
          '</a>';
        }
        if (!any) {
          body += '<div class="empty"><b>Nobody else here yet.</b><br>' +
            '<span class="small">When another account exists, they show up here.</span></div>';
        }
        body += '<label for="dmname">Or type a name</label>' +
          '<input type="text" id="dmname" maxlength="20" autocomplete="off" autocorrect="off" autocapitalize="off">' +
          '<button class="btn wide" type="button" id="dmgo">Open the conversation</button>' +
          '<p class="small dim" id="dmnote"></p>';
      }
    } else {
      body += '<h2>New topic</h2>' +
        '<p class="small dim">One subject per thread. Every topic and reply is kept.</p>';
      if (!signedIn()) {
        body += '<div class="box tight"><b>Sign in first.</b><br>' +
          '<span class="small">A topic needs a name behind it.</span><br>' +
          '<a class="btn" href="#" id="pickin">Sign in</a> ' +
          '<a class="btn" href="#" id="pickup">Make an account</a></div>';
      } else {
        body += '<form id="newtopic" action="#topics">' +
          '<label for="topictitle">Topic title</label>' +
          '<input type="text" id="topictitle" maxlength="80" autocomplete="off" autocorrect="off" autocapitalize="off">' +
          '<label for="topictext">First post</label>' +
          '<textarea id="topictext" maxlength="2000"></textarea>' +
          '<button class="btn wide" type="submit">Start topic</button>' +
        '</form>';
      }
    }
    body += '<a class="btn wide" href="#" id="pickclose">Cancel</a>';

    el.innerHTML = '<div class="sheet">' + body + '</div>';
    el.style.display = 'block';

    document.getElementById('pickclose').onclick = function (e) {
      e.preventDefault();
      closePicker();
      return false;
    };
    var pin = document.getElementById('pickin');
    if (pin) { pin.onclick = function (e) { e.preventDefault(); closePicker(); openSignin('in'); return false; }; }
    var pup = document.getElementById('pickup');
    if (pup) { pup.onclick = function (e) { e.preventDefault(); closePicker(); openSignin('up'); return false; }; }

    var picks = el.getElementsByTagName('a');
    for (var p = 0; p < picks.length; p++) {
      if (!picks[p].getAttribute || !picks[p].getAttribute('data-dm')) { continue; }
      picks[p].onclick = function (e) {
        e.preventDefault();
        var nm = this.getAttribute('data-dm');
        closePicker();
        dmOpen(nm);
        return false;
      };
    }

    var go = document.getElementById('dmgo');
    if (go) {
      go.onclick = function () {
        var nm = cleanName(document.getElementById('dmname').value);
        var note = document.getElementById('dmnote');
        if (!nm) { if (note) { note.innerHTML = 'Type a name.'; } return; }
        var acc = accountNamed(nm);
        if (!acc) {
          if (note) { note.innerHTML = 'No account called "' + esc(nm) + '" yet. Names must match exactly.'; }
          return;
        }
        closePicker();
        dmOpen(acc.name);
      };
    }

    var nt = document.getElementById('newtopic');
    if (nt) {
      nt.onsubmit = function (e) {
        e.preventDefault();
        startTopic(document.getElementById('topictitle').value, document.getElementById('topictext').value);
        return false;
      };
    }
  }

  function closePicker() {
    var el = document.getElementById('picker');
    if (!el) { return; }
    el.style.display = 'none';
    el.innerHTML = '';
  }

  function startTopic(titleRaw, textRaw) {
    if (!needName()) { return false; }
    var title = trim(titleRaw);
    var txt = trim(textRaw);
    if (!title) { toast('Give the topic a title'); return false; }
    if (!txt) { toast('Write the first post'); return false; }
    var nid = newId('t');
    var now = (new Date()).getTime();
    closePicker();
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
  }

  /* ----- AI chat ----- */

  function aiMsgs() {
    syncAi();
    return aiData.msgs;
  }

  /* Ask the AI through the helper service the site is set up with. Nothing is
     sent anywhere else, and the conversation is only ever your own. */
  function askAi(question, history, done) {
    var b = backend();
    if (!b || !b.ai || String(b.ai).indexOf('http') !== 0 || String(b.ai).indexOf('YOUR-') === 0) {
      done('The AI is not set up yet. The owner of the site has to add its address in js/backend.js.', null);
      return;
    }
    var body = { question: question, history: history.slice(-10), user: me() };
    var req = new XMLHttpRequest();
    req.open('POST', b.ai, true);
    try { req.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
    req.onreadystatechange = function () {
      if (req.readyState !== 4) { return; }
      if (req.status >= 200 && req.status < 300) {
        var d = null;
        try { d = JSON.parse(req.responseText); } catch (e) { d = null; }
        if (d && d.answer) { done(null, String(d.answer)); }
        else { done('The AI sent back something this page could not read.', null); }
        return;
      }
      done('The AI could not be reached just now (' + req.status + ').', null);
    };
    try { req.send(JSON.stringify(body)); }
    catch (e) { done('No connection.', null); }
  }

  function aiLogHtml() {
    var msgs = aiMsgs();
    if (!msgs.length) {
      return '<div class="empty"><b>Ask the AI anything.</b><br><span class="small">' +
        'Only you can read this conversation.</span></div>';
    }
    var h = '';
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      h += '<div class="msg' + (m.by === 'ai' ? '' : ' me') + '">' +
        '<span class="who">' + (m.by === 'ai' ? 'AI' : esc(m.by || 'you')) + '</span>' +
        '<span class="when">' + when(m.at) + '</span>' +
        '<div class="text">' + esc(m.text) + '</div>' +
      '</div>';
    }
    return h;
  }

  function pageAi() {
    var body = '';
    body += statusBox();
    body += nameBox('AI chat');
    if (!signedIn()) {
      body += gateBox('AI chat');
      shell('AI Chat', body);
      wireStart();
      return;
    }
    body += '<div class="room"><div class="roomlist">';
    body += '<div class="box tight"><p class="small" style="margin:0">' +
      '<b>Your own conversation with the AI.</b> It is kept in its own place in the ' +
      'database, separate from the shared boards, and only the page here shows it.' +
      '</p></div>';
    body += '<div class="chatlog" id="ailog">' + aiLogHtml() + '</div>';
    body += '</div><div class="roomfoot"><div class="chatform">' +
      '<form id="aiform" action="#ai">' +
        '<label for="aitext">Question</label>' +
        '<textarea id="aitext" maxlength="2000"></textarea>' +
        '<button class="btn wide" type="submit" id="aigo">Ask</button>' +
        '<button class="btn wide" type="button" id="aiclear">Clear this conversation</button>' +
      '</form>' +
    '</div></div></div>';

    shell('AI Chat', body);
    wireStart();
    var lg = document.getElementById('ailog');
    if (lg) { lg.scrollTop = lg.scrollHeight; }

    document.getElementById('aiclear').onclick = function () {
      if (workerOn()) {
        /* remove each of this person's AI messages on the server */
        var mine = aiMsgs();
        for (var q = 0; q < mine.length; q++) {
          askServer('delete', { id: mine[q].id }, function () { render(); });
        }
        aiSave([]);
        render();
        toast('Conversation cleared');
        return false;
      }
      if (!needName()) { return; }
      aiSave([]);
      change(function (d) { d.ai = { msgs: [] }; }, function () { render(); toast('Cleared'); });
    };

    document.getElementById('aiform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var q = trim(document.getElementById('aitext').value);
      if (!q) { toast('Type a question'); return false; }
      document.getElementById('aitext').value = '';

      var history = aiMsgs().slice(-10);
      var now = (new Date()).getTime();
      var mine = { id: newId('q'), by: me(), text: q, at: now };
      aiSave(aiMsgs().concat([mine]));
      var lg2 = document.getElementById('ailog');
      if (lg2) {
        if (lg2.getElementsByClassName('empty').length) { lg2.innerHTML = ''; }
        lg2.innerHTML += '<div class="msg me"><span class="who">' + esc(me()) +
          '</span><span class="when">just now</span><div class="text">' + esc(q) + '</div></div>' +
          '<div class="msg" id="thinking"><span class="who">AI</span><div class="text">Thinking&hellip;</div></div>';
        lg2.scrollTop = lg2.scrollHeight;
      }
      var go = document.getElementById('aigo');
      if (go) { go.disabled = true; go.innerHTML = 'Thinking&hellip;'; }

      askAi(q, history, function (err, answer) {
        if (go) { go.disabled = false; go.innerHTML = 'Ask'; }
        var reply = err
          ? { id: newId('r'), by: 'ai', text: err, at: (new Date()).getTime(), failed: 1 }
          : { id: newId('r'), by: 'ai', text: answer, at: (new Date()).getTime() };
        var withReply = aiMsgs().concat([reply]);
        aiSave(withReply);
        if (workerOn()) {
          /* keep the question and the answer on the server, for this person only */
          sendPost('ai', q, '', '', '', function () {
            sendPost('ai', answer || err, '', '', '', function () {
              if (err) { render(); toast('No answer — see the message'); }
              else { softAi(); }
            });
          });
          return;
        }
        change(function (d) { d.ai = { msgs: withReply }; }, function () {
          if (err) { render(); toast('No answer — see the message'); }
          else { softAi(); }
        });
      });
      return false;
    };
  }

  /* redraw only the AI log, leaving the question box alone */
  function softAi() {
    var lg = document.getElementById('ailog');
    if (!lg) { render(); return; }
    var atEnd = (lg.scrollHeight - lg.scrollTop - lg.clientHeight) < 40;
    var h = aiLogHtml();
    if (lg.innerHTML !== h) {
      lg.innerHTML = h;
      if (atEnd) { lg.scrollTop = lg.scrollHeight; }
    }
    var stamp = document.getElementById('live');
    if (stamp) { stamp.innerHTML = stampLine(); }
    stickBar();
  }

  /* ----- Code app: one box, many languages, runs in the browser ----- */

  var LANGS = [
    ['javascript', 'JavaScript'],
    ['html', 'HTML + CSS'],
    ['css', 'CSS only'],
    ['json', 'JSON'],
    ['python', 'Python'],
    ['sql', 'SQL'],
    ['text', 'Anything']
  ];

  var SAMPLES = {
    javascript: 'var out = [];\nfor (var i = 1; i <= 15; i++) {\n  if (i % 15 === 0) out.push("FizzBuzz");\n  else if (i % 3 === 0) out.push("Fizz");\n  else if (i % 5 === 0) out.push("Buzz");\n  else out.push(i);\n}\nreturn out.join(" ");',
    html: '<h1>Hello from the HQ</h1>\n<p>A page made on a Kindle.</p>\n<style>\n  body { font-family: Helvetica, Arial, sans-serif; }\n  h1 { font-size: 20px; }\n</style>',
    css: 'body { font-family: Helvetica, Arial, sans-serif; }\nh1 { font-size: 20px; border-bottom: 3px solid #000; }\np { font-size: 16px; }',
    json: '{\n  "name": "ROAKSTASAWD",\n  "kindle": true,\n  "members": 5\n}',
    python: 'total = 0\nfor n in range(1, 11):\n    total = total + n\nprint("The sum of 1 to 10 is " + str(total))',
    sql: 'SELECT name, at\nFROM accounts\nORDER BY at DESC;',
    text: 'Write anything here. The preview shows it as plain text.'
  };

  function langOf(v) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i][0] === v) { return v; }
    }
    return 'javascript';
  }

  /* Runs JavaScript in a sandbox and collects what it logs or returns. */
  function runJs(code, out, frame) {
    var logs = [];
    function joinArgs(args) {
      var parts = [];
      for (var k = 0; k < args.length; k++) {
        var v = args[k];
        if (typeof v === 'object') {
          try { parts.push(JSON.stringify(v)); } catch (e) { parts.push(String(v)); }
        } else { parts.push(String(v)); }
      }
      return parts.join(' ');
    }
    var fake = {
      log: function () { logs.push(joinArgs(arguments)); },
      error: function () { logs.push(joinArgs(arguments)); },
      warn: function () { logs.push(joinArgs(arguments)); }
    };
    var pdoc = null;
    try {
      pdoc = frame.contentDocument || frame.contentWindow.document;
      pdoc.open();
      pdoc.write('<!DOCTYPE html><html><head><style>' +
        'body{font-family:Helvetica,Arial,sans-serif;font-size:16px;margin:10px;color:#000;background:#fff}' +
        'h1{font-size:20px}</style></head><body></body></html>');
      pdoc.close();
    } catch (e) { pdoc = null; }

    var result;
    var err = null;
    try {
      var f = new Function('console', 'preview', '"use strict";\n' + code);
      result = f(fake, pdoc);
    } catch (e2) {
      err = e2 && e2.message ? e2.message : String(e2);
    }
    var text = '';
    if (logs.length) { text += logs.join('\n') + '\n'; }
    if (err) { text += 'Error: ' + err; }
    else if (result !== undefined) { text += String(result); }
    out.innerHTML = esc(text || '(no output)');
  }

  /* Python is not in any Kindle browser, so this reads a useful part of it:
     print(), str(), len(), int(), variables, arithmetic, if/else and for and
     while loops over range(). */
  function runPy(code, out) {
    var lines = String(code).replace(/\r/g, '').split('\n');
    var vars = {};
    var printed = [];
    var guard = 0;

    function strip(expr) {
      expr = String(expr).replace(/^\s+|\s+$/g, '');
      var m;
      while ((m = expr.match(/^(str|int|float|len)\s*\(([\s\S]*)\)$/))) {
        var inner = val(m[2]);
        if (m[1] === 'str') { return String(inner); }
        if (m[1] === 'len') { return String(String(inner).length); }
        if (m[1] === 'int') { return String(parseInt(inner, 10) || 0); }
        return String(parseFloat(inner) || 0);
      }
      return expr;
    }

    function val(expr) {
      expr = String(expr).replace(/^\s+|\s+$/g, '');
      if (!expr) { return ''; }
      if (/^(['"])[\s\S]*\1$/.test(expr)) { return expr.slice(1, -1); }
      if (expr === 'True') { return true; }
      if (expr === 'False') { return false; }
      if (/^-?\d+(\.\d+)?$/.test(expr)) { return parseFloat(expr); }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
        return vars.hasOwnProperty(expr) ? vars[expr] : 0;
      }
      if (expr.indexOf('+') > 0) {
        var bits = expr.split('+');
        var parts = [];
        for (var bi = 0; bi < bits.length; bi++) { parts.push(strip(bits[bi])); }
        var vals = [];
        var allNum = true;
        for (var i = 0; i < parts.length; i++) {
          var v = val(parts[i]);
          if (typeof v !== 'number') { allNum = false; }
          vals.push(v);
        }
        if (allNum) {
          var sum = 0;
          for (var j = 0; j < vals.length; j++) { sum += vals[j]; }
          return sum;
        }
        var str = '';
        for (var k = 0; k < vals.length; k++) { str += show(vals[k]); }
        return str;
      }
      if (/^[-\d\s.()*/%]+$/.test(expr)) {
        try { return eval(expr); } catch (e) { return 0; }
      }
      var mm = expr.match(/^(.+?)\s*([-*\/])\s*(.+)$/);
      if (mm) {
        var left = val(mm[1]);
        var right = val(mm[3]);
        var a = Number(left) || 0;
        var b = Number(right) || 0;
        if (mm[2] === '-') { return a - b; }
        if (mm[2] === '*') { return a * b; }
        return b ? a / b : 0;
      }
      return 0;
    }

    function show(v) {
      if (typeof v === 'number' && !isFinite(v)) { return String(v); }
      if (v === true) { return 'True'; }
      if (v === false) { return 'False'; }
      return String(v);
    }

    /* run exactly the lines [from, to) as a block at `indent` */
    function runRange(indent, from, to) {
      var saved = lines;
      lines = saved.slice(from, to);
      runBlock(indent, 0);
      lines = saved;
    }

    function indentOf(line) {
      var l = line.replace(/\t/g, '    ');
      return l.length - l.replace(/^ +/, '').length;
    }

    /* run the lines from i while they are deeper than `indent`; returns where
       the block stops */
    function runBlock(indent, i) {
      while (i < lines.length) {
        var raw = lines[i];
        var line = raw.replace(/\t/g, '    ');
        if (!line.replace(/\s/g, '')) { i++; continue; }
        var ind = indentOf(line);
        if (ind < indent) { return i; }
        if (++guard > 20000) { printed.push('(stopped: too much to run)'); return lines.length; }

        var c = line.replace(/^\s+/, '').replace(/\s+#.*$/, '');
        var m;

        if ((m = c.match(/^print\s*\(([\s\S]*)\)$/))) {
          var args = m[1].split(',');
          var outs = [];
          for (var a = 0; a < args.length; a++) { outs.push(show(val(args[a]))); }
          printed.push(outs.join(' '));
          i++;
          continue;
        }
        if ((m = c.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\+=\s*([\s\S]+)$/))) {
          vars[m[1]] = val(strip(m[1]) + '+' + strip(m[2]));
          i++;
          continue;
        }
        if ((m = c.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/))) {
          vars[m[1]] = val(m[2]);
          i++;
          continue;
        }
        if ((m = c.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+range\s*\(([^)]*)\)\s*:$/))) {
          var ra = m[2].split(',');
          var from = 0, to = 0, step = 1;
          if (ra.length === 1) { to = Number(val(ra[0])); }
          else if (ra.length === 2) { from = Number(val(ra[0])); to = Number(val(ra[1])); }
          else { from = Number(val(ra[0])); to = Number(val(ra[1])); step = Number(val(ra[2])) || 1; }
          var bodyStart = i + 1;
          var bodyEnd = bodyStart;
          while (bodyEnd < lines.length) {
            var l2 = lines[bodyEnd].replace(/\t/g, '    ');
            if (l2.replace(/\s/g, '') && indentOf(l2) <= ind) { break; }
            bodyEnd++;
          }
          for (var n = from; step > 0 ? n < to : n > to; n += step) {
            vars[m[1]] = n;
            runRange(ind + 1, bodyStart, bodyEnd);
            if (guard > 20000) { break; }
          }
          i = bodyEnd;
          continue;
        }
        if ((m = c.match(/^while\s+([\s\S]+):$/))) {
          var wStart = i + 1;
          var wEnd = wStart;
          while (wEnd < lines.length) {
            var l3 = lines[wEnd].replace(/\t/g, '    ');
            if (l3.replace(/\s/g, '') && indentOf(l3) <= ind) { break; }
            wEnd++;
          }
          while (val(m[1]) && guard < 20000) { runRange(ind + 1, wStart, wEnd); }
          i = wEnd;
          continue;
        }
        if ((m = c.match(/^if\s+([\s\S]+):$/))) {
          var taken = !!val(m[1]);
          var iEnd = i + 1;
          var alt = -1;
          while (iEnd < lines.length) {
            var l4 = lines[iEnd].replace(/\t/g, '    ');
            if (l4.replace(/\s/g, '') && indentOf(l4) <= ind) { break; }
            if (/^\s*else\s*:/.test(l4)) { alt = iEnd; }
            iEnd++;
          }
          if (taken) { runBlock(ind + 1, i + 1); }
          else if (alt >= 0) { runBlock(ind + 1, alt + 1); }
          i = iEnd;
          continue;
        }
        i++;
      }
      return i;
    }

    runBlock(0, 0);
    out.innerHTML = esc(printed.length ? printed.join('\n') : '(no output)');
  }

  function checkJson(code, out) {
    try {
      var v = JSON.parse(code);
      out.innerHTML = esc('Valid JSON.\n\n' + JSON.stringify(v, null, 2));
    } catch (e) {
      out.innerHTML = esc('Not valid JSON: ' + (e && e.message ? e.message : e));
    }
  }

  function pageCode() {
    if (!signedIn()) {
      shell('Code', nameBox('the code app') + gateBox('code'));
      wireStart();
      return;
    }
    var lang = langOf(qs('lang'));
    var body = '';
    var i;
    body += '<p class="small dim">Pick a language, write code, tap Run. JavaScript and HTML/CSS ' +
            'run for real in the preview; Python, SQL and JSON are read and checked here in the page, ' +
            'so nothing leaves your device.</p>';
    body += '<div class="chips" id="langs">';
    for (i = 0; i < LANGS.length; i++) {
      body += '<a href="#code?lang=' + LANGS[i][0] + '"' +
        (LANGS[i][0] === lang ? ' class="on"' : '') + '>' + esc(LANGS[i][1]) + '</a>';
    }
    body += '</div>';
    body += '<label for="code">' + esc(langName(lang)) + '</label>';
    body += '<textarea class="codearea" id="code" spellcheck="false" autocorrect="off" autocapitalize="off">' +
            esc(SAMPLES[lang]) + '</textarea>';
    body += '<button class="btn" type="button" id="run">Run</button>' +
            '<button class="btn" type="button" id="clearcode">Clear</button>';
    body += '<h2>Output</h2><pre class="out" id="out">(nothing yet)</pre>';
    body += '<h2>Preview</h2><iframe class="preview" id="preview" title="preview"></iframe>';
    body += '<div class="box tight"><p class="small" style="margin:0">' +
            '<b>JavaScript:</b> <code>return</code> sends a value to Output, <code>console.log</code> is ' +
            'collected, and <code>preview</code> is a blank page you can write to. ' +
            '<b>Python:</b> print, variables, arithmetic, if/else, for and while loops work. ' +
            '<b>SQL:</b> shown as text — the HQ keeps its data as JSON, not tables.</p></div>';

    shell('Code', body);

    var frame = document.getElementById('preview');
    try {
      var doc = frame.contentDocument || frame.contentWindow.document;
      doc.open();
      doc.write('<!DOCTYPE html><html><head><style>body{font-family:Helvetica,Arial,sans-serif;' +
        'font-size:16px;margin:10px;color:#000;background:#fff}h1{font-size:20px}</style></head>' +
        '<body><p>Preview is empty.</p></body></html>');
      doc.close();
    } catch (e) {}

    function run() {
      var code = document.getElementById('code').value;
      var out = document.getElementById('out');
      if (lang === 'javascript') { runJs(code, out, frame); return; }
      if (lang === 'python') { runPy(code, out); return; }
      if (lang === 'json') { checkJson(code, out); return; }
      if (lang === 'sql') {
        out.innerHTML = esc('SQL is not run here — there is no database to run it against.\n' +
          'The HQ stores everything as JSON, so SQL would have nothing to query.\n\n' +
          'Your statement:\n' + code);
        return;
      }
      if (lang === 'css') {
        try {
          var cd = frame.contentDocument || frame.contentWindow.document;
          cd.open();
          cd.write('<!DOCTYPE html><html><head><style>' + code + '</style></head><body>' +
            '<h1>Style preview</h1><p>This text is here so your CSS has something to style. ' +
            'A list:</p><ul><li>one</li><li>two</li><li>three</li></ul></body></html>');
          cd.close();
          out.innerHTML = esc('CSS applied to the preview.');
        } catch (e) { out.innerHTML = esc('Could not draw the preview.'); }
        return;
      }
      if (lang === 'text') {
        out.innerHTML = esc(code);
        return;
      }
      /* html */
      try {
        var hd = frame.contentDocument || frame.contentWindow.document;
        hd.open();
        hd.write('<!DOCTYPE html><html><head><style>body{font-family:Helvetica,Arial,sans-serif;' +
          'font-size:16px;margin:10px;color:#000;background:#fff}</style></head><body>' +
          code + '</body></html>');
        hd.close();
        out.innerHTML = esc('Drawn in the preview.');
      } catch (e) {
        out.innerHTML = esc('Could not draw the preview.');
      }
    }

    document.getElementById('run').onclick = run;
    document.getElementById('clearcode').onclick = function () {
      document.getElementById('code').value = '';
      document.getElementById('out').innerHTML = '(nothing yet)';
    };
  }

  function langName(v) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i][0] === v) { return LANGS[i][1]; }
    }
    return 'Code';
  }

  /* ---------- boot ---------- */

  function render() {
    var r = route();
    isAi = (r === 'ai');
    closePicker();
    signedInAgain();
    if (r === 'chat') { pageChat(); }
    else if (r === 'neighborhood') { pageNeighborhood(); }
    else if (r === 'pinboard') { pagePinboard(); }
    else if (r === 'topics') { pageTopics(); }
    else if (r === 'ai') { pageAi(); }
    else if (r === 'code') { pageCode(); }
    else if (r === 'favorites') { pageFavorites(); }
    else if (r === 'admin') { pageAdmin(); }
    else if (r === 'dm') { pageDm(qs('id'), ''); }
    else { pageHome(); }
    keepSignin();
  }

  /* The refresh redraws the page under the sheet. The sheet is drawn again in
     the same spot, with the same words, and stays open until it is closed on
     purpose - a redraw must never take a half-typed sign-in away. */
  function keepSignin() {
    if (!signinOpen) { return; }
    var el = document.getElementById('signin');
    /* a fresh page puts a fresh, empty sheet in: fill it in again. But a sheet
       that is already on the screen is left alone - redrawing it would throw
       away whatever has been typed into it. */
    if (el && el.style.display === 'block' && document.getElementById('accform')) { return; }
    if (el) { el.style.display = 'block'; }
    drawSignin(signinMode, signinError, signinName);
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
      window.onscroll = stickBar;
    } else {
      window.addEventListener('hashchange', render, false);
      window.addEventListener('scroll', stickBar, false);
      window.addEventListener('resize', function () { stickBar(); fitRoom(); }, false);
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
    cloudOn: cloudOn,
    /* exposed for testing the Worker path from Node */
    workerOn: workerOn,
    apiCall: apiCall,
    sendPost: sendPost,
    askServer: askServer,
    /* exposed for testing the admin powers from Node */
    isOwner: isOwner,
    isBanned: isBanned,
    adminToggleBan: adminToggleBan,
    doBan: doBan,
    banFor: banFor,
    adminUnban: adminUnban,
    adminKick: adminKick,
    adminToggleAdmin: adminToggleAdmin,
    adminPurge: adminPurge,
    adminForget: adminForget,
    adminClear: adminClear,
    setNotice: setNotice,
    /* exposed for testing the Code app's runners from Node */
    runPy: runPy,
    runJs: runJs,
    checkJson: checkJson
  };
})();

/* Start. The page may already have finished loading by the time this runs (a
   cached page, a slow Kindle), and then DOMContentLoaded never comes again -
   so it is started straight away when the document is ready. */
function roakStart() {
  if (window.ROAK_STARTED) { return; }
  window.ROAK_STARTED = true;
  ROAK.boot();
}

if (document.readyState === 'loading') {
  if (window.addEventListener) {
    window.addEventListener('DOMContentLoaded', roakStart, false);
  } else {
    window.onload = roakStart;
  }
  /* a browser that never sends the event still starts, half a second later */
  window.setTimeout(function () {
    if (document.readyState !== 'loading') { roakStart(); }
  }, 500);
} else {
  roakStart();
}
