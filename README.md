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

## Accounts

- Joining makes an account: a **name** (20 characters max) and a **password**
  (6+ characters). No two accounts can share a name — compared without capitals
  or spaces, so `Big Joe`, `bigjoe` and `BIG JOE` are the same name.
- **The password is never stored or sent.** The page turns it into a salted hash
  in your own browser and only that hash goes into the database, so nothing in
  the database can be turned back into a password. A wrong password gets no hint
  and no account details are shown to anyone who is not signed in.
- The hash is made with PBKDF2-HMAC-SHA256 (60,000 rounds) where the browser has
  Web Crypto, and with a salted SHA-256 where it does not (old Kindle builds).
  Each account records which one it used, so it can be checked on any device.
  A browser that cannot do the account's method says so instead of guessing.
- Signing in on a Kindle means typing the password again; the site keeps only the
  signed-in name on the device, never the password.

## How data is saved

Everything is one shared JSON tree (`hq`) with `meta`, `accounts`, `chat`,
`neighborhood`, `pins`, `topics` and `likes`.

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

## Apps

- **Chat** — live messages, everyone at once.
- **Neighborhood** — longer posts.
- **Pinboard** — permanent pins.
- **Topics** — one thread per subject, with replies.
- **AI Chat** — your own conversation with an AI. Set the helper's address in
  `js/backend.js` (`ai:`); until then the page says the AI is not set up.
- **Code** — write code in one box and run it. JavaScript and HTML/CSS run for real
  in the page's own sandbox and preview; Python (print, variables, arithmetic,
  if/else, for and while loops over range), JSON and SQL are read and checked in the
  page, so nothing leaves the device.

## The top bar and favourites

Every page carries a **top bar** with the apps you starred, and it stays pinned at the
top of the screen while you scroll (by CSS where the browser has it, by script on older
Kindles). Tap a star on the home tiles (or open **Favourites** with the &#9733; button at
the left of the bar) to put an app up there; six at most. Tapping the app you are
already on opens the Favourites screen, so it is easy to change your mind. Favourites
are remembered on that device.

The home screen is a grid of six tiles, two across, each with a star in its corner.
