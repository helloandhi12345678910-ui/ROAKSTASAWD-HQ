# Backend setup: Firebase Realtime Database (free)

The site now keeps everything on a backend: chat, neighborhood posts, pins and
topics all live in one shared JSON tree, so a post made on one Kindle shows up on
the others.

**Why Firebase Realtime Database:** its free Spark plan needs no card, it never
pauses from inactivity, and it answers plain `GET`/`PUT` on a URL — so the site
uses about twenty lines of `XMLHttpRequest` instead of an SDK the Kindle browser
could not run.

Free Spark limits (Google's docs and pricing page, checked 26 Nov 2026):

| Thing | Free limit |
|---|---|
| Stored data | 1 GB |
| Downloaded | 10 GB / month |
| Simultaneous connections | 100 |
| Writes | 1,000 / second |

A text post is about 200 bytes, so 1 GB is roughly five million posts. This site is
nowhere near any of it.

## 1. Make the database (about 3 minutes)

1. Go to <https://console.firebase.google.com/> and sign in with your Google account.
2. **Create a project** → name it something like `roak-hq` → Google Analytics: **off** →
   Create. (Stay on the free **Spark** plan; no billing needed.)
3. In the left menu: **Build → Realtime Database → Create Database**.
4. Location: pick the one nearest the group (e.g. `us-central1`).
5. Security rules: choose **Start in test mode** for now (we replace it in step 2).
6. Copy the URL shown at the top of the data tab. It looks like one of:
   - `https://roak-hq-default-rtdb.firebaseio.com`
   - `https://roak-hq-default-rtdb.europe-west1.firebasedatabase.app`

## 2. Put the rules in

In the Realtime Database page, open the **Rules** tab, delete what is there, and
paste the contents of [`database.rules.json`](database.rules.json) from this repo.
Press **Publish**.

What those rules do:

- Anyone can read and write — the site has no accounts, and the Kindle cannot do
  a modern sign-in flow.
- Every write must have the right shape and size: chat messages up to 500
  characters, posts and pins and replies up to 2000, a name up to 20, a topic
  title up to 80, a tag up to 16. Nothing else gets in.
- Nothing can be written outside `hq`.

Test mode expires after 30 days (the data stops being readable). The rules file
does not expire — that is why this step matters.

## 3. Point the site at it

The quickest way, no code editor needed: open `js/backend.js` **on github.com**,
press the pencil (Edit), put your URL between the quotes:

```js
window.ROAK_BACKEND = {
  url: 'https://roak-hq-default-rtdb.firebaseio.com'
};
```

then **Commit changes** on the `main` branch. GitHub Pages rebuilds in about a
minute.

Or tell the AI assistant the URL in the chat and it will make the commit for you.

Either way the site switches to the shared backend on the next load; the status
strip at the top says **LIVE · UPDATED …** when it is connected.

## 4. Check it works

1. Open the live site on your Kindle and on a computer.
2. On both, tap **Sign in** and type a name.
3. On the Kindle, post a pin. On the computer, open **Pinboard** — the pin is
   there, and the strip says **LIVE · UPDATED … BY <name>**.
4. Open `https://<your-url>/hq.json` in a browser: you should see the same posts
   as JSON.

While the URL still says `YOUR-PROJECT`, the site runs on the device's own copy
of the data and nothing is shared.

## How saving works

- Every page load does `GET <url>/hq.json` and keeps a copy in `localStorage`,
  so a Kindle with no signal still shows the last thing it saw.
- Every post does `GET`, changes its own piece of the tree, then `PUT` the whole
  tree back. That is why nobody's post is lost to a stale page.
- Pages check for new data every 20 seconds and redraw if something changed.
- If a write fails (no signal), the post is kept in the device copy and goes up
  with the next successful write. The strip says **Offline** until then.
- Chat keeps the latest **300** messages on the server (the page shows the last
  100, with a button for older ones). Posts, pins, topics and replies are never
  trimmed by the site — the pinboard is permanent until someone unpins.

## What this free setup does not give you

- **No logins.** A name is just a label, typed once per device. Anyone with the
  URL can post under any name, and "Delete"/"Unpin" only checks the name. For a
  group of Kindle readers that is usually fine; if you need real accounts, the
  next step up is Firebase Authentication, which is also free at this size but
  needs a newer browser than the Kindle has for the Google sign-in.
- **The JSON is public to anyone who finds the URL.** Do not put anything private
  on the board.
- **One writer at a time.** Two people posting in the same second can lose one of
  the two posts; the 20-second refresh keeps that window tiny.

## Other backends that would work

The site only needs `GET` and `PUT` of one JSON document, so any of these can
replace Firebase by changing the URL in `js/backend.js`:

- **Supabase** (free: 500 MB, 2 projects, but free projects pause after a week
  without activity) — needs a small edge function to expose `hq.json`, because its
  REST API is row-based.
- **A GitHub Gist or a small serverless function** — cheap, but writes need a
  token, which would be visible in the page.

Firebase is the least work and the most reliable of these for a Kindle-sized group.
