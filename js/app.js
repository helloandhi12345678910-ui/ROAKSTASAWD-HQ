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
      var r = route();
      if (r === 'js') { return; }
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

  function me() {
    var raw = null;
    try { raw = window.localStorage.getItem(ME_KEY); } catch (e) {}
    if (!raw) { return ''; }
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { o = null; }
    if (o && o.name) { return o.name; }
    return '';                       /* old plain-name sign-ins are not accounts */
  }

  function myKey() {
    var raw = null;
    try { raw = window.localStorage.getItem(ME_KEY); } catch (e) {}
    if (!raw) { return ''; }
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { o = null; }
    return o && o.key ? o.key : '';
  }

  function setMe(name, key) {
    try {
      if (name) {
        window.localStorage.setItem(ME_KEY, JSON.stringify({ name: name, key: key || '' }));
      } else {
        window.localStorage.removeItem(ME_KEY);
      }
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

  function randomKey() {
    var s = '';
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    for (var i = 0; i < 24; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
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

  /* Every account has a private key; your own key is what lets the site edit
     or delete your posts. It never leaves this device except to be written
     back in the database with the rest of the tree. */
  function signUp(name, key, done) {
    name = cleanName(name);
    if (!name) { done('Type a name.'); return; }
    if (name.length > 20) { done('Keep it to 20 letters.'); return; }
    if (nameKey(name).length < 2) { done('Use at least 2 letters or numbers.'); return; }

    change(function (d) {
      var accs = list(d.accounts);
      for (var i = 0; i < accs.length; i++) {
        if (nameKey(accs[i].name) === nameKey(name)) {
          throw { taken: true };
        }
      }
      accs.push({ id: newId('a'), name: name, key: key, at: (new Date()).getTime() });
      d.accounts = accs;
    }, function (ok) {
      if (!ok) { done('Could not reach the server. Try again.'); return; }
      setMe(name, key);
      done(null);
    });
  }

  /* write with a name check that runs inside the same read-modify-write */
  function signUpSafe(name, key, done) {
    pull(function () {
      if (findAccount(name)) { done('That name is taken. Pick another.'); return; }
      var taken = false;
      var d = tree;
      var accs = list(d.accounts);
      for (var i = 0; i < accs.length; i++) {
        if (nameKey(accs[i].name) === nameKey(name)) { taken = true; }
      }
      if (taken) { done('That name is taken. Pick another.'); return; }
      accs.push({ id: newId('a'), name: name, key: key, at: (new Date()).getTime() });
      d.accounts = accs;
      d.meta = { updated: (new Date()).getTime(), by: name };
      tree = d;
      localPut(tree);
      if (!cloudOn()) { setMe(name, key); done(null); return; }

      var req = new XMLHttpRequest();
      req.open('PUT', rootUrl() + 'hq.json', true);
      try { req.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
      req.onreadystatechange = function () {
        if (req.readyState !== 4) { return; }
        if (req.status >= 200 && req.status < 300) {
          state = 'ready';
          setMe(name, key);
          done(null);
        } else {
          state = 'offline';
          done('Could not reach the server. Try again.');
        }
      };
      try {
        req.send(JSON.stringify(tree));
      } catch (e) {
        state = 'offline';
        done('Could not reach the server. Try again.');
      }
    });
  }

  function signIn(name, key, done) {
    pull(function () {
      var acc = findAccount(name);
      if (!acc) { done('No account called "' + cleanName(name) + '". Make one below.'); return; }
      if (!key) { done('This device is signed out. Sign in again or make a new account.'); return; }
      if (acc.key !== key) { done('That key does not match. Check it and try again.'); return; }
      setMe(acc.name, acc.key);
      done(null);
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
    ['topics', 'Topics'],
    ['js', 'JS App']
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
    var html = '<div class="box">' +
      '<h2 style="margin-top:0">' + (signup ? 'Make an account' : 'Sign in') + '</h2>' +
      (error ? '<div class="box tight" style="border-width:3px"><b>' + esc(error) + '</b></div>' : '') +
      '<p class="small">' + (signup
        ? 'An account is a name and a key. Names are unique &mdash; if someone has it, pick another.'
        : 'Your name and the key this device was given when you made the account.') + '</p>' +
      '<form id="accform" action="#">' +
        '<label for="accname">Name</label>' +
        '<input type="text" id="accname" maxlength="20" autocomplete="off" autocorrect="off" autocapitalize="off" value="' +
          (signup ? '' : esc(me())) + '">' +
        (signup
          ? '<button class="btn wide" type="submit">Create account</button>'
          : '<label for="acckey">Key</label>' +
            '<input type="text" id="acckey" maxlength="40" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="from the device you made it on">' +
            '<button class="btn wide" type="submit">Sign in</button>') +
        '<button class="btn wide" type="button" id="accswitch">' +
          (signup ? 'I already have an account' : 'I need an account') + '</button>' +
        '<button class="btn wide" type="button" id="acccancel">Cancel</button>' +
      '</form>' +
    '</div>';

    if (signup) {
      html += '<div class="box tight"><p class="small" style="margin:0">' +
        'When the account is made, this device keeps the key and stays signed in. ' +
        'The same name can never be taken twice.</p></div>';
    }
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
      var keyEl = document.getElementById('acckey');
      if (signup) {
        if (!name) { drawSignin('up', 'Type a name.'); return false; }
        if (nameKey(name).length < 2) { drawSignin('up', 'Use at least 2 letters or numbers.'); return false; }
        signUpSafe(name, randomKey(), function (err) {
          if (err) { drawSignin('up', err); return; }
          closeSignin();
          render();
          toast('Welcome, ' + me());
        });
      } else {
        var key = trim(keyEl ? keyEl.value : '');
        signIn(name, key, function (err) {
          if (err) { drawSignin('in', err); return; }
          closeSignin();
          render();
          toast('Signed in as ' + me());
        });
      }
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
      '<span class="small">An account is just a name, and no two accounts can share one.</span><br>' +
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
    body += '<a class="topic" href="#js"><span class="t">JS App</span>' +
            '<span class="m">write JavaScript, run it, see it work</span></a>';

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

  /* ----- JS app ----- */

  var SNIPPETS = [
    ['Hello', 'var name = "ROAKSTASAWD";\nreturn "Hello, " + name + "!";'],
    ['FizzBuzz', 'var out = [];\nfor (var i = 1; i <= 20; i++) {\n  if (i % 15 === 0) out.push("FizzBuzz");\n  else if (i % 3 === 0) out.push("Fizz");\n  else if (i % 5 === 0) out.push("Buzz");\n  else out.push(i);\n}\nreturn out.join(" ");'],
    ['Kindle check', 'var ua = navigator.userAgent;\nvar out = [];\nout.push("User agent: " + ua);\nout.push("Screen: " + screen.width + "x" + screen.height);\nout.push("Touch: " + (("ontouchstart" in window) ? "yes" : "no"));\nout.push("Async support: " + (function(){ try { eval("async function f(){}"); return "yes"; } catch (e) { return "no"; } })());\nreturn out.join("\\n");'],
    ['Fibonacci', 'var a = 0, b = 1, out = [];\nfor (var i = 0; i < 15; i++) {\n  out.push(a);\n  var t = a + b; a = b; b = t;\n}\nreturn out.join(", ");'],
    ['Page', 'document.body.innerHTML =\n  "<h1>Hello from the JS app</h1>" +\n  "<p>This HTML is drawn inside the preview box.</p>";\nreturn "Wrote to the preview.";']
  ];

  function pageJs() {
    var body = '';
    var i;
    body += '<p class="small dim">Write JavaScript in the box, tap Run, read the output. ' +
            'The preview box is a separate blank page, so drawing to it is safe.</p>';
    body += '<div class="chips" id="chips">';
    for (i = 0; i < SNIPPETS.length; i++) {
      body += '<a href="#" data-snip="' + i + '">' + esc(SNIPPETS[i][0]) + '</a>';
    }
    body += '</div>';
    body += '<label for="code">Code</label>';
    body += '<textarea class="codearea" id="code" spellcheck="false" autocorrect="off" autocapitalize="off">' +
            esc(SNIPPETS[0][1]) + '</textarea>';
    body += '<button class="btn" type="button" id="run">Run</button>' +
            '<button class="btn" type="button" id="clearcode">Clear</button>';
    body += '<h2>Output</h2><pre class="out" id="out">(nothing yet)</pre>';
    body += '<h2>Preview</h2>' +
            '<iframe class="preview" id="preview" title="preview"></iframe>';
    body += '<div class="box tight"><p class="small" style="margin:0">' +
            '<b>Tip:</b> <code>return</code> sends a value back to the output box. ' +
            '<code>document.body</code> draws in the preview. <code>console.log</code> is collected too.' +
            '</p></div>';
    shell('JS App', body);

    var fr = document.getElementById('preview');
    try {
      var doc = fr.contentDocument || fr.contentWindow.document;
      doc.open();
      doc.write('<!DOCTYPE html><html><head><style>body{font-family:Helvetica,Arial,sans-serif;font-size:16px;margin:10px;color:#000;background:#fff}h1{font-size:20px}</style></head><body><p>Preview is empty.</p></body></html>');
      doc.close();
    } catch (e) {}

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

    function run() {
      var code = document.getElementById('code').value;
      var out = document.getElementById('out');
      var logs = [];
      var fakeConsole = {
        log: function () { logs.push(joinArgs(arguments)); },
        error: function () { logs.push(joinArgs(arguments)); },
        warn: function () { logs.push(joinArgs(arguments)); }
      };
      var result;
      var err = null;
      var fr = document.getElementById('preview');
      var pdoc = null;
      try {
        pdoc = fr.contentDocument || fr.contentWindow.document;
        pdoc.open();
        pdoc.write('<!DOCTYPE html><html><head><style>body{font-family:Helvetica,Arial,sans-serif;font-size:16px;margin:10px;color:#000;background:#fff}h1{font-size:20px}</style></head><body></body></html>');
        pdoc.close();
      } catch (e) { pdoc = null; }

      try {
        var f = new Function('console', 'preview', '"use strict";\n' + code);
        result = f(fakeConsole, pdoc);
      } catch (e2) {
        err = e2 && e2.message ? e2.message : String(e2);
      }

      var text = '';
      if (logs.length) { text += logs.join('\n') + '\n'; }
      if (err) { text += 'Error: ' + err; }
      else if (result !== undefined) { text += String(result); }
      if (!text) { text = '(no output)'; }
      out.innerHTML = esc(text);
    }

    document.getElementById('run').onclick = run;
    document.getElementById('clearcode').onclick = function () {
      document.getElementById('code').value = '';
      document.getElementById('out').innerHTML = '(nothing yet)';
    };
    var chips = document.getElementById('chips').getElementsByTagName('a');
    for (var j = 0; j < chips.length; j++) {
      chips[j].onclick = (function (n) {
        return function (e) {
          e.preventDefault();
          document.getElementById('code').value = SNIPPETS[n][1];
          document.getElementById('out').innerHTML = '(nothing yet)';
          return false;
        };
      })(parseInt(chips[j].getAttribute('data-snip'), 10));
    }
  }

  /* ---------- boot ---------- */

  function render() {
    var r = route();
    closeSignin();
    if (r === 'chat') { pageChat(); }
    else if (r === 'neighborhood') { pageNeighborhood(); }
    else if (r === 'pinboard') { pagePinboard(); }
    else if (r === 'topics') { pageTopics(); }
    else if (r === 'js') { pageJs(); }
    else { pageHome(); }
  }

  /* redraw without jumping to the top (used by the live refresh) */
  function renderSoft() {
    var y = 0;
    try { y = window.pageYOffset || document.documentElement.scrollTop || 0; } catch (e) {}
    var r = route();
    if (r === 'js') { return; }
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
    myKey: myKey,
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
