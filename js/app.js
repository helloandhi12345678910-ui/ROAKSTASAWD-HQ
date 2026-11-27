/* ROAKSTASAWD HQ — shared engine
   Written for old browsers: ES5 only, no fetch, no arrow functions,
   no template literals, no let/const. Works on Kindle's experimental browser.

   Data lives in one JSON tree shared by everyone. Two backends can hold it:
     - "local":  this device's localStorage (offline copy, always kept)
     - "cloud":  any HTTP backend with GET/PUT of a JSON document.
                 Firebase Realtime Database is the one set up in js/backend.js.
   Every write reads the latest copy, changes its own piece, and puts it back,
   so nobody's post is overwritten by a stale page. */

var ROAK = (function () {

  var LS_KEY = 'roak.v2';          /* local cache of the shared tree */
  var ME_KEY = 'roak.me';          /* this device's display name */
  var VIEW_KEY = 'roak.view';      /* how many chat messages to show */
  var CHAT_SHOWN = 100;            /* chat messages rendered at once */
  var KEEP_CHAT = 300;             /* chat messages kept in the database */

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
  var pending = null;    /* what the user was trying to send */
  var poller = null;

  function localGet() {
    var raw = null;
    try { raw = window.localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
    if (!raw) { return null; }
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function localPut(d) {
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {}
  }

  function mergeLists(remote, local) {
    var seen = {};
    var out = [];
    var i;
    for (i = 0; i < remote.length; i++) {
      if (remote[i] && remote[i].id) { seen[remote[i].id] = 1; }
      out.push(remote[i]);
    }
    for (i = 0; i < local.length; i++) {
      if (local[i] && local[i].id && !seen[local[i].id]) { out.push(local[i]); }
    }
    out.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    return out;
  }

  /* Pull the shared copy into memory. Falls back to the local copy. */
  function pull(cb) {
    var cached = localGet();
    if (cached) { tree = normalize(cached); }

    if (!cloudOn()) {
      state = cached ? 'ready' : 'empty';
      if (cb) { cb(); }
      return;
    }

    state = 'loading';
    var req = new XMLHttpRequest();
    var url = rootUrl() + 'hq.json?ts=' + (new Date()).getTime();
    req.open('GET', url, true);
    req.onreadystatechange = function () {
      if (req.readyState !== 4) { return; }
      if (req.status >= 200 && req.status < 300) {
        var d = null;
        try { d = JSON.parse(req.responseText); } catch (e) { d = null; }
        if (d) {
          tree = normalize(d);
          localPut(tree);
          state = 'ready';
        } else {
          state = cached ? 'ready' : 'empty';
        }
      } else if (req.status === 0) {
        state = cached ? 'offline' : 'offline';
        lastError = 'No connection';
      } else {
        state = cached ? 'offline' : 'offline';
        lastError = 'Server said ' + req.status;
      }
      if (cb) { cb(); }
    };
    try {
      req.send(null);
    } catch (e) {
      state = cached ? 'offline' : 'offline';
      lastError = 'No connection';
      if (cb) { cb(); }
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

  function startPolling() {
    if (poller || !cloudOn()) { return; }
    poller = window.setInterval(function () {
      var r = route();
      if (r !== 'chat' && r !== 'neighborhood' && r !== 'topics' && r !== 'pinboard' && r !== 'home') { return; }
      pull(function () {
        var box = document.getElementById('live');
        if (!box) { return; }
        var h = stampLine();
        if (box.innerHTML !== h) {
          box.innerHTML = h;
          renderSoft();
        }
      });
    }, 20000);
  }

  function stampLine() {
    var t = tree.meta && tree.meta.updated ? tree.meta.updated : 0;
    return '<span class="dot"></span>' +
      (state === 'offline'
        ? 'Offline — showing the copy on this device'
        : 'Live · updated ' + when(t) + (tree.meta && tree.meta.by ? ' by ' + esc(tree.meta.by) : ''));
  }

  /* ---------- me ---------- */

  function me() {
    var n = null;
    try { n = window.localStorage.getItem(ME_KEY); } catch (e) {}
    return n || '';
  }

  function setMe(name) {
    name = String(name || '').replace(/^\s+|\s+$/g, '');
    try {
      if (name) { window.localStorage.setItem(ME_KEY, name); }
      else { window.localStorage.removeItem(ME_KEY); }
    } catch (e) {}
    return name;
  }

  function needName() {
    if (me()) { return true; }
    openSignin();
    toast('Pick a name first');
    return false;
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
    toastTimer = window.setTimeout(function () { el.className = ''; }, 2600);
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
        ' &middot; <a href="#" id="switchname"><u>switch</u></a></span>'
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
            ? 'posts are shared and saved on the server.'
            : 'no backend set yet &mdash; posts stay on this device.') +
        '</footer>' +
      '</div>' +
      '<div id="signin" class="overlay" style="display:none">' +
        '<div class="wrap" style="padding-top:0">' +
          '<div class="box">' +
            '<h2 style="margin-top:0">Pick a name</h2>' +
            '<p class="small">No password. It is the name that shows next to your posts.</p>' +
            '<form id="signinform" action="#">' +
              '<label for="namefield">Your name</label>' +
              '<input type="text" id="namefield" maxlength="20" autocomplete="off" autocorrect="off" autocapitalize="off">' +
              '<button class="btn wide" type="submit">Use this name</button>' +
              '<button class="btn wide" type="button" id="signincancel">Cancel</button>' +
            '</form>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="toast"></div>';

    document.getElementById('root').innerHTML = html;

    var sib = document.getElementById('signinbtn');
    if (sib) { sib.onclick = function (e) { e.preventDefault(); openSignin(); return false; }; }
    var sw = document.getElementById('switchname');
    if (sw) { sw.onclick = function (e) { e.preventDefault(); openSignin(); return false; }; }
    var sc = document.getElementById('signincancel');
    if (sc) { sc.onclick = function () { closeSignin(); }; }
    var sf = document.getElementById('signinform');
    if (sf) {
      sf.onsubmit = function (e) {
        e.preventDefault();
        var v = trim(document.getElementById('namefield').value);
        if (!v) { toast('Type a name'); return false; }
        setMe(v);
        closeSignin();
        render();
        return false;
      };
    }

    if (!window.scrollY) { window.scrollTo(0, 0); }
  }

  function openSignin() {
    var el = document.getElementById('signin');
    if (!el) { return; }
    el.style.display = 'block';
    var f = document.getElementById('namefield');
    if (f) { f.value = me(); try { f.focus(); } catch (e) {} }
  }

  function closeSignin() {
    var el = document.getElementById('signin');
    if (el) { el.style.display = 'none'; }
  }

  /* ---------- shared bits of page furniture ---------- */

  function statusBox() {
    if (state === 'loading') {
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
    if (me()) { return ''; }
    return '<div class="box">' +
      '<b>Pick a name to post.</b><br>' +
      '<span class="small">It only takes a second.</span><br>' +
      '<a class="btn" href="#" id="start">Start</a></div>';
  }

  /* ---------- pages ---------- */

  function pageHome() {
    var chat = list(tree.chat);
    var nb = list(tree.neighborhood);
    var pins = list(tree.pins);
    var topics = list(tree.topics);
    var body = '';

    body += '<p class="lede">A headquarters for people reading on Amazon Kindles. ' +
            'Plain pages, black and white, big buttons. If you can load it on a Kindle, ' +
            'you are in the right place.</p>';

    body += statusBox();
    body += nameBox();

    body += '<h2>Apps</h2>';
    body += '<a class="topic" href="#chat"><span class="t">Chat</span>' +
            '<span class="m">' + chat.length + ' message' + (chat.length === 1 ? '' : 's') + ' &middot; short and quick</span></a>';
    body += '<a class="topic" href="#neighborhood"><span class="t">Neighborhood</span>' +
            '<span class="m">' + nb.length + ' post' + (nb.length === 1 ? '' : 's') + ' &middot; longer posts, slower pace</span></a>';
    body += '<a class="topic" href="#pinboard"><span class="t">Pinboard</span>' +
            '<span class="m">' + pins.length + ' pin' + (pins.length === 1 ? '' : 's') + ' &middot; the permanent board</span></a>';
    body += '<a class="topic" href="#topics"><span class="t">Topics</span>' +
            '<span class="m">' + topics.length + ' thread' + (topics.length === 1 ? '' : 's') + ' &middot; one subject per thread</span></a>';
    body += '<a class="topic" href="#js"><span class="t">JS App</span>' +
            '<span class="m">write JavaScript, run it, see it work</span></a>';

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

    body += '<h2>How this place works</h2>' +
      '<div class="box tight"><p class="small" style="margin:0">' +
      '<b>One column, no scrolling sideways.</b> Everything is a single column of blocks so the ' +
      'Kindle does not have to guess where you are.<br><br>' +
      '<b>No images.</b> A Kindle repaints the whole screen for a picture. Text is faster.<br><br>' +
      '<b>Tap targets are big.</b> Buttons are at least 44px tall.<br><br>' +
      '<b>Nothing moves.</b> No animations, no spinners, no video. The screen only changes when you tap.<br><br>' +
      '<b>Saved for everyone.</b> Chat, posts, pins and topics are kept on the server, so a post made ' +
      'on one Kindle shows up on the others.' +
      '</p></div>';

    shell('HQ', body);
    wireStart();
  }

  function wireStart() {
    var st = document.getElementById('start');
    if (st) { st.onclick = function (e) { e.preventDefault(); openSignin(); return false; }; }
  }

  /* ----- chat ----- */

  function pageChat() {
    var all = list(tree.chat);
    var shown = CHAT_SHOWN;
    try {
      var v = parseInt(window.localStorage.getItem(VIEW_KEY), 10);
      if (v && v > shown) { shown = v; }
    } catch (e) {}
    var msgs = all.slice(Math.max(0, all.length - shown));
    var body = '';
    var log = '';
    var i;

    if (!msgs.length) {
      log = '<div class="empty"><b>No messages yet.</b><br><span class="small">Say hello.</span></div>';
    } else {
      for (i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        log += '<div class="msg' + (m.by === me() ? ' me' : '') + '">' +
          '<span class="who">' + esc(m.by) + '</span>' +
          '<span class="when">' + when(m.at) + '</span>' +
          '<div class="text">' + esc(m.text) + '</div>' +
        '</div>';
      }
    }

    body += statusBox();
    body += nameBox();
    body += '<p class="small dim">' + all.length + ' message' + (all.length === 1 ? '' : 's') +
            ' saved. Showing the last ' + msgs.length + '. The server keeps the latest ' + KEEP_CHAT + '.</p>';
    body += '<div class="chatlog" id="chatlog">' + log + '</div>';
    if (all.length > msgs.length) {
      body += '<a class="btn small" href="#" id="chatmore">Load ' +
              Math.min(CHAT_SHOWN, all.length - msgs.length) + ' older</a>';
    }
    body += '<div class="chatform">' +
      '<form id="chatform" action="#chat">' +
        '<label for="chattext">Message</label>' +
        '<textarea id="chattext" maxlength="500"></textarea>' +
        '<button class="btn wide" type="submit">Send</button>' +
      '</form>' +
    '</div>';

    shell('Chat', body);

    var lg = document.getElementById('chatlog');
    if (lg) { lg.scrollTop = lg.scrollHeight; }

    var more = document.getElementById('chatmore');
    if (more) {
      more.onclick = function (e) {
        e.preventDefault();
        try { window.localStorage.setItem(VIEW_KEY, String(shown + CHAT_SHOWN)); } catch (err) {}
        render();
        return false;
      };
    }

    document.getElementById('chatform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var t = trim(document.getElementById('chattext').value);
      if (!t) { toast('Type a message'); return false; }
      document.getElementById('chattext').value = '';
      change(function (d) {
        d.chat.push({ id: newId('c'), by: me(), text: t, at: (new Date()).getTime() });
      }, function (ok) {
        render();
        toast(ok ? 'Sent' : 'Saved on this device — will sync');
      });
      return false;
    };
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
          '<div class="post-meta"><span class="who">' + esc(p.by) + '</span> &middot; ' + when(p.at) +
            (p.by === me() ? '' : '') + '</div>' +
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
      'links, rules, a phone number, a book you finished, a meeting time.</p></div>';

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

  var lastRoute = '';

  function render() {
    var r = route();
    closeSignin();
    if (r === 'chat') { pageChat(); }
    else if (r === 'neighborhood') { pageNeighborhood(); }
    else if (r === 'pinboard') { pagePinboard(); }
    else if (r === 'topics') { pageTopics(); }
    else if (r === 'js') { pageJs(); }
    else { pageHome(); }
    lastRoute = r;
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
    setMe: setMe,
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
