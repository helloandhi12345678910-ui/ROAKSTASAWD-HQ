/* ROAKSTASAWD HQ — shared engine
   Written for old browsers: ES5 only, no fetch, no arrow functions,
   no template literals, no let/const. Works on Kindle's experimental browser. */

var ROAK = (function () {

  var STORE_KEY = 'roak.v1';
  var ME_KEY = 'roak.me';

  /* ---------- storage ---------- */

  function blank() {
    return {
      chat: [],
      neighborhood: [],
      topics: [],
      likes: [],
      seq: 1
    };
  }

  function load() {
    var raw = null;
    try { raw = window.localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (!raw) { return blank(); }
    var d;
    try { d = JSON.parse(raw); } catch (e) { d = null; }
    if (!d || typeof d !== 'object') { d = blank(); }
    if (!d.chat) { d.chat = []; }
    if (!d.neighborhood) { d.neighborhood = []; }
    if (!d.topics) { d.topics = []; }
    if (!d.likes) { d.likes = []; }
    if (!d.seq) { d.seq = 1; }
    return d;
  }

  function save(d) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (e) {}
  }

  function db() {
    var d = load();
    return d;
  }

  function commit(d) {
    save(d);
    return d;
  }

  function nextId(d) {
    var id = d.seq || 1;
    d.seq = id + 1;
    return 'p' + id;
  }

  /* ---------- me ---------- */

  function me() {
    var n = null;
    try { n = window.localStorage.getItem(ME_KEY); } catch (e) {}
    if (n) { return n; }
    return '';
  }

  function setMe(name) {
    name = String(name || '').replace(/^\s+|\s+$/g, '');
    try {
      if (name) { window.localStorage.setItem(ME_KEY, name); }
      else { window.localStorage.removeItem(ME_KEY); }
    } catch (e) {}
    return name;
  }

  function needName(where) {
    if (me()) { return true; }
    document.getElementById('signin').style.display = 'block';
    window.location.hash = '';
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
    var d = new Date(ts);
    var diff = (new Date()).getTime() - ts;
    if (diff < 60000) { return 'just now'; }
    if (diff < 3600000) { return Math.floor(diff / 60000) + 'm ago'; }
    if (diff < 86400000) { return Math.floor(diff / 3600000) + 'h ago'; }
    var mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return mo[d.getMonth()] + ' ' + d.getDate();
  }

  /* ---------- UI helpers ---------- */

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) { return; }
    el.innerHTML = esc(msg);
    el.className = 'show';
    if (toastTimer) { window.clearTimeout(toastTimer); }
    toastTimer = window.setTimeout(function () {
      el.className = '';
    }, 2200);
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
    if (!h) { h = 'home'; }
    return h;
  }

  /* ---------- shell ---------- */

  var NAV = [
    ['home', 'HQ'],
    ['chat', 'Chat'],
    ['neighborhood', 'Neighborhood'],
    ['topics', 'Topics'],
    ['js', 'JS App']
  ];

  function counts(d) {
    return {
      chat: d.chat.length,
      neighborhood: d.neighborhood.length,
      topics: d.topics.length
    };
  }

  function shell(title, body) {
    var d = db();
    var c = counts(d);
    var r = route();
    var nav = '';
    for (var i = 0; i < NAV.length; i++) {
      var key = NAV[i][0];
      var label = NAV[i][1];
      var tag = '';
      if (key === 'chat' && c.chat) { tag = '<span class="tag">' + c.chat + '</span>'; }
      if (key === 'neighborhood' && c.neighborhood) { tag = '<span class="tag">' + c.neighborhood + '</span>'; }
      if (key === 'topics' && c.topics) { tag = '<span class="tag">' + c.topics + '</span>'; }
      nav += '<a href="#' + key + '"' + (r === key ? ' class="on"' : '') + '>' + label + tag + '</a>';
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

        '<h1>' + esc(title) + '</h1>' +
        body +
        '<footer>' +
          'ROAKSTASAWD HQ &middot; built for e-ink &middot; ' +
          'every page is plain HTML, no images, no tracking.<br>' +
          'Posts are saved on this device only. Clearing browser data clears them.' +
        '</footer>' +
      '</div>' +
      '<div id="signin" style="display:none">' +
        '<div class="wrap" style="padding-top:0">' +
          '<div class="box">' +
            '<h2 style="margin-top:0">Pick a name</h2>' +
            '<p class="small">No password. It is just what shows next to your posts on this device.</p>' +
            '<form id="signinform" action="#' + r + '">' +
              '<label for="namefield">Your name</label>' +
              '<input type="text" id="namefield" maxlength="20" autocomplete="off" autocorrect="off" autocapitalize="off">' +
              '<button class="btn wide" type="submit">Use this name</button>' +
            '</form>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="toast"></div>';

    document.getElementById('root').innerHTML = html;

    var sib = document.getElementById('signinbtn');
    if (sib) {
      sib.onclick = function (e) { e.preventDefault(); openSignin(); return false; };
    }
    var sw = document.getElementById('switchname');
    if (sw) {
      sw.onclick = function (e) { e.preventDefault(); openSignin(); return false; };
    }
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

    window.scrollTo(0, 0);
  }

  function openSignin() {
    var el = document.getElementById('signin');
    el.style.display = 'block';
    var f = document.getElementById('namefield');
    if (f) {
      f.value = me();
      try { f.focus(); } catch (e) {}
    }
  }

  function closeSignin() {
    var el = document.getElementById('signin');
    if (el) { el.style.display = 'none'; }
  }

  /* ---------- pages ---------- */

  function pageHome() {
    var d = db();
    var c = counts(d);
    var who = me();
    var body = '';

    body += '<p class="lede">A headquarters for people reading on Amazon Kindles. ' +
            'Plain pages, black and white, big buttons. If you can load it on a Kindle, ' +
            'you are in the right place.</p>';

    if (!who) {
      body += '<div class="box">' +
        '<b>First time here?</b><br>' +
        '<span class="small">Pick a name and the apps below open up. Nothing leaves this device.</span><br>' +
        '<a class="btn" href="#" id="start">Start</a>' +
        '</div>';
    }

    body += '<h2>Apps</h2>';
    body += '<a class="topic" href="#chat"><span class="t">Chat</span>' +
            '<span class="m">' + c.chat + ' message' + (c.chat === 1 ? '' : 's') + ' &middot; talk in real time-ish</span></a>';
    body += '<a class="topic" href="#neighborhood"><span class="t">Neighborhood</span>' +
            '<span class="m">' + c.neighborhood + ' post' + (c.neighborhood === 1 ? '' : 's') + ' &middot; longer posts, slower pace</span></a>';
    body += '<a class="topic" href="#topics"><span class="t">Topics</span>' +
            '<span class="m">' + c.topics + ' thread' + (c.topics === 1 ? '' : 's') + ' &middot; one subject per thread</span></a>';
    body += '<a class="topic" href="#js"><span class="t">JS App</span>' +
            '<span class="m">write JavaScript, run it, see it work</span></a>';

    body += '<h2>How this place works</h2>' +
      '<div class="box tight"><p class="small" style="margin:0">' +
      '<b>One column, no scrolling sideways.</b> Everything is a single column of blocks so the ' +
      'Kindle does not have to guess where you are.<br><br>' +
      '<b>No images.</b> A Kindle repaints the whole screen for a picture. Text is faster.<br><br>' +
      '<b>Tap targets are big.</b> Buttons are at least 44px tall, because fingers are bigger than cursors.<br><br>' +
      '<b>Nothing moves.</b> No animations, no spinners, no video. The screen only changes when you tap.' +
      '</p></div>';

    body += '<div class="box fill">' +
      '<b>Try it on the Kindle</b><br>' +
      '<span class="small">Open the address of this site in the Kindle Experimental Browser, ' +
      'then add it to your reading list so you can get back to it.</span>' +
      '</div>';

    shell('HQ', body);

    var st = document.getElementById('start');
    if (st) {
      st.onclick = function (e) { e.preventDefault(); openSignin(); return false; };
    }
  }

  /* ----- chat ----- */

  function pageChat() {
    var d = db();
    var body = '';
    var log = '';
    var i;
    var msgs = d.chat.slice(-60);

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

    body += '<p class="small dim">Messages stay on this device. Newest at the bottom.</p>';
    body += '<div class="chatlog" id="chatlog">' + log + '</div>';
    body += '<div class="chatform">' +
      '<form id="chatform" action="#chat">' +
        '<label for="chattext">Message</label>' +
        '<textarea id="chattext" maxlength="500"></textarea>' +
        '<button class="btn wide" type="submit">Send</button>' +
      '</form>' +
      '<a class="btn small" href="#" id="chatclear">Clear chat</a>' +
    '</div>';

    shell('Chat', body);

    var lg = document.getElementById('chatlog');
    if (lg) { lg.scrollTop = lg.scrollHeight; }

    document.getElementById('chatform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var t = trim(document.getElementById('chattext').value);
      if (!t) { toast('Type a message'); return false; }
      var dd = db();
      dd.chat.push({ by: me(), text: t, at: (new Date()).getTime() });
      commit(dd);
      render();
      return false;
    };

    document.getElementById('chatclear').onclick = function (e) {
      e.preventDefault();
      var dd = db();
      dd.chat = [];
      commit(dd);
      toast('Chat cleared');
      render();
      return false;
    };
  }

  /* ----- neighborhood ----- */

  function pageNeighborhood() {
    var d = db();
    var body = '';
    var list = '';
    var i;

    var posts = d.neighborhood.slice().reverse();
    if (!posts.length) {
      list = '<div class="empty"><b>The neighborhood is quiet.</b><br>' +
             '<span class="small">Put the first post up.</span></div>';
    } else {
      for (i = 0; i < posts.length; i++) {
        var p = posts[i];
        var liked = false;
        for (var k = 0; k < d.likes.length; k++) {
          if (d.likes[k] === p.id) { liked = true; }
        }
        list += '<div class="post">' +
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

    body += '<p class="small dim">Post something, or read what the street is saying.</p>';
    body += '<form id="postform" action="#neighborhood">' +
      '<label for="posttext">Your post</label>' +
      '<textarea id="posttext" maxlength="1000"></textarea>' +
      '<label for="posttag">Tag (optional, one word)</label>' +
      '<input type="text" id="posttag" maxlength="16" autocomplete="off" autocorrect="off" autocapitalize="off">' +
      '<button class="btn wide" type="submit">Post to the neighborhood</button>' +
    '</form>';
    body += '<h2>Posts</h2>' + list;

    shell('Neighborhood', body);

    document.getElementById('postform').onsubmit = function (e) {
      e.preventDefault();
      if (!needName()) { return false; }
      var t = trim(document.getElementById('posttext').value);
      if (!t) { toast('Write something first'); return false; }
      var tag = trim(document.getElementById('posttag').value).replace(/[^A-Za-z0-9]/g, '');
      var dd = db();
      dd.neighborhood.push({
        id: nextId(dd),
        by: me(),
        text: t,
        tag: tag,
        at: (new Date()).getTime()
      });
      commit(dd);
      toast('Posted');
      render();
      return false;
    };

    var links = document.getElementById('root').getElementsByTagName('a');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      if (a.getAttribute('data-like')) {
        a.onclick = (function (id) {
          return function (e) {
            e.preventDefault();
            var dd = db();
            var idx = -1;
            for (var z = 0; z < dd.likes.length; z++) {
              if (dd.likes[z] === id) { idx = z; }
            }
            if (idx >= 0) { dd.likes.splice(idx, 1); }
            else { dd.likes.push(id); }
            commit(dd);
            render();
            return false;
          };
        })(a.getAttribute('data-like'));
      }
      if (a.getAttribute('data-del')) {
        a.onclick = (function (id) {
          return function (e) {
            e.preventDefault();
            var dd = db();
            var keep = [];
            for (var z = 0; z < dd.neighborhood.length; z++) {
              if (dd.neighborhood[z].id !== id) { keep.push(dd.neighborhood[z]); }
            }
            dd.neighborhood = keep;
            commit(dd);
            toast('Deleted');
            render();
            return false;
          };
        })(a.getAttribute('data-del'));
      }
    }
  }

  /* ----- topics ----- */

  function pageTopics() {
    var d = db();
    var id = qs('id');
    var body = '';
    var i;

    if (id) {
      var t = null;
      for (i = 0; i < d.topics.length; i++) {
        if (d.topics[i].id === id) { t = d.topics[i]; }
      }
      if (!t) {
        shell('Topics', '<div class="empty"><b>No such topic.</b><br><a class="btn" href="#topics">Back to topics</a></div>');
        return;
      }
      body += '<p class="small"><a href="#topics">&larr; All topics</a></p>';
      body += '<div class="box tight"><b>' + esc(t.title) + '</b><br>' +
              '<span class="small dim">started by ' + esc(t.by) + ' &middot; ' + when(t.at) + '</span></div>';
      var replies = t.replies || [];
      if (!replies.length) {
        body += '<div class="empty"><b>No replies yet.</b><br><span class="small">Be the first.</span></div>';
      }
      for (i = 0; i < replies.length; i++) {
        body += '<div class="post">' +
          '<div class="post-meta"><span class="who">' + esc(replies[i].by) + '</span> &middot; ' + when(replies[i].at) + '</div>' +
          '<div class="post-body">' + esc(replies[i].text) + '</div>' +
        '</div>';
      }
      body += '<form id="replyform" action="#topics?id=' + encodeURIComponent(id) + '">' +
        '<label for="replytext">Reply</label>' +
        '<textarea id="replytext" maxlength="1000"></textarea>' +
        '<button class="btn wide" type="submit">Post reply</button>' +
      '</form>';
      shell(t.title, body);

      document.getElementById('replyform').onsubmit = function (e) {
        e.preventDefault();
        if (!needName()) { return false; }
        var txt = trim(document.getElementById('replytext').value);
        if (!txt) { toast('Write a reply first'); return false; }
        var dd = db();
        for (var z = 0; z < dd.topics.length; z++) {
          if (dd.topics[z].id === id) {
            if (!dd.topics[z].replies) { dd.topics[z].replies = []; }
            dd.topics[z].replies.push({ by: me(), text: txt, at: (new Date()).getTime() });
          }
        }
        commit(dd);
        render();
        return false;
      };
      return;
    }

    body += '<p class="small dim">One subject per thread. Start one, or answer an existing one.</p>';
    body += '<form id="topicform" action="#topics">' +
      '<label for="topictitle">Topic title</label>' +
      '<input type="text" id="topictitle" maxlength="80" autocomplete="off" autocorrect="off" autocapitalize="off">' +
      '<label for="topictext">First post</label>' +
      '<textarea id="topictext" maxlength="1000"></textarea>' +
      '<button class="btn wide" type="submit">Start topic</button>' +
    '</form>';

    body += '<h2>All topics</h2>';
    var topics = d.topics.slice().reverse();
    if (!topics.length) {
      body += '<div class="empty"><b>No topics yet.</b><br><span class="small">Start the first one above.</span></div>';
    }
    for (i = 0; i < topics.length; i++) {
      var tt = topics[i];
      var n = (tt.replies || []).length;
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
      var dd = db();
      var nid = nextId(dd);
      dd.topics.push({
        id: nid,
        title: title,
        by: me(),
        at: (new Date()).getTime(),
        replies: [{ by: me(), text: txt, at: (new Date()).getTime() }]
      });
      commit(dd);
      window.location.hash = 'topics?id=' + encodeURIComponent(nid);
      render();
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

    function joinArgs(args) {
      var parts = [];
      for (var k = 0; k < args.length; k++) {
        var v = args[k];
        if (typeof v === 'object') {
          try { parts.push(JSON.stringify(v)); } catch (e) { parts.push(String(v)); }
        } else {
          parts.push(String(v));
        }
      }
      return parts.join(' ');
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
    else if (r === 'topics') { pageTopics(); }
    else if (r === 'js') { pageJs(); }
    else { pageHome(); }
  }

  function boot() {
    if (!window.addEventListener) {
      window.onhashchange = render;
    } else {
      window.addEventListener('hashchange', render, false);
    }
    render();
  }

  return {
    boot: boot,
    render: render,
    db: db,
    commit: commit,
    me: me,
    setMe: setMe,
    esc: esc,
    toast: toast
  };
})();

if (window.addEventListener) {
  window.addEventListener('DOMContentLoaded', ROAK.boot, false);
} else {
  window.onload = ROAK.boot;
}
