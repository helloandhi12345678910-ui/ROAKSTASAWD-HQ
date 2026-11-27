# ROAKSTASAWD HQ

A small web HQ for people reading on Amazon Kindles. Plain pages, black and white,
big buttons — built to open and stay open in the Kindle Experimental Browser.

Live at: **https://helloandhi12345678910-ui.github.io/ROAKSTASAWD-HQ/**

> **Set up the shared backend:** see [BACKEND.md](BACKEND.md). Until a Firebase
> Realtime Database URL is put in `js/backend.js`, the site saves on the device only.

## Apps

| Page | What it does |
|---|---|
| `#home` | Front door, links to everything, latest pins, member list |
| `#chat` | Short messages, live: the log refreshes every second; last 100 shown, older ones on a button |
| `#neighborhood` | Longer posts with optional one-word tags, likes, delete your own |
| `#pinboard` | Pins: permanent notes, kept until you unpin them; edit your own |
| `#topics` | One subject per thread, with replies |
| `#js` | A JavaScript playground: write code, tap Run, read the output and a live preview |

## Accounts

- Joining makes an account: a **name** (20 characters max) and a **key** made on
  the device. No two accounts can share a name — compared without capitals or
  spaces, so `Big Joe`, `bigjoe` and `BIG JOE` are the same name.
- The key is kept in the browser on the device that made the account, so that
  device stays signed in. Signing in elsewhere means typing the key.
- The key is what the page uses to decide which posts are yours (edit, delete,
  unpin). It is not sent anywhere except inside the shared tree, so treat it like
  a password and do not paste it into public places.

## How data is saved

Everything is one shared JSON tree (`hq`) with `meta`, `chat`, `neighborhood`,
`pins`, `topics` and `likes`.

- `GET <backend>/hq.json` on every load, cached in `localStorage` so the device
  still works with no signal.
- Each post: `GET`, change its own piece, `PUT` the whole tree back — no post lost
  to a stale page.
- The page re-reads the tree every second on Chat and HQ, every five seconds
  elsewhere, and straight after your own writes; it only redraws when something
  actually changed, and the chat box you are typing in is left alone.
- A failed write stays in the device copy and goes up on the next successful one.
- Chat keeps the latest 300 on the server. Posts, pins, topics and replies are
  never trimmed by the site.

## Built for e-ink

- ES5 only — no arrow functions, `let`/`const`, template literals or `fetch`,
  so the old Kindle WebKit engine runs it.
- No images, no icon fonts, no web fonts, no animations or transitions.
- Pure `#000` on `#fff`, 2px borders, so nothing dithers into grey mush.
- One column, tap targets at least 44px tall.
- Hash routing (`#chat`), because the Kindle browser handles fragment changes
  more reliably than history pushes.

## Files

```
index.html            shell page
css/roak.css          e-ink stylesheet
js/backend.js         backend URL (fill this in)
js/app.js             router, storage and all the apps
database.rules.json   Firebase Realtime Database rules to paste in
BACKEND.md            step-by-step Firebase setup
LICENSE               CC0 1.0
```

## Running locally

Open `index.html` in any browser, or serve the folder:

```
python -m http.server 8000
```

Then visit `http://localhost:8000/`.
