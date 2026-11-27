# ROAKSTASAWD HQ

A small web HQ for people reading on Amazon Kindles. Plain pages, black and white,
big buttons — built to open and stay open in the Kindle Experimental Browser.

Live at: **https://helloandhi12345678910-ui.github.io/ROAKSTASAWD-HQ/**

## Apps

| Page | What it does |
|---|---|
| `#home` | Front door, links to everything |
| `#chat` | Short messages, newest at the bottom |
| `#neighborhood` | Longer posts with optional one-word tags, likes, delete your own |
| `#topics` | One subject per thread, with replies |
| `#js` | A JavaScript playground: write code, tap Run, read the output and a live preview |

## Built for e-ink

- ES5 only — no arrow functions, `let`/`const`, template literals or `fetch`,
  so the old Kindle WebKit engine runs it.
- No images, no icon fonts, no web fonts, no animations or transitions.
- Pure `#000` on `#fff`, 2px borders, so nothing dithers into grey mush.
- One column, tap targets at least 44px tall.
- Hash routing (`#chat`), because the Kindle browser handles fragment changes
  more reliably than history pushes.

## Storage

There is no server. Every post, message and topic is saved in the browser's
`localStorage` on the device you type it on. Clearing browser data clears the posts.
If you want a shared backend later, swap the `load`/`save` functions at the top of
`js/app.js` for calls to one.

## Files

```
index.html      shell page
css/roak.css    e-ink stylesheet
js/app.js       router, storage and all four apps
LICENSE         CC0 1.0
```

## Running locally

Open `index.html` in any browser, or serve the folder:

```
python -m http.server 8000
```

Then visit `http://localhost:8000/`.
