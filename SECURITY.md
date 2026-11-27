# Who can touch the database, and what to do about it

Short answer: **yes, people can find it and write to it.** That is how the site is
built right now — no accounts, open write — and it is a real risk, not a theoretical
one. Here is exactly what the risk is, what it is not, and three ways to close it.

## What is exposed

The database URL is in `js/backend.js`, which is a public file on GitHub Pages. So
anyone who opens the site's source, or scans the web for Firebase URLs, can reach
the database. Scanners do this constantly: Google's own docs have a whole page on
"avoid insecure rules" because so many Firebase databases are left open.

With the current rules, a stranger can:

- **read everything** — every chat message, post and pin;
- **write and overwrite** — post spam, and `PUT` the whole `hq` tree, wiping it;
- **post as anyone** — a name is just a typed label, so nothing stops someone
  signing as you;
- **delete anyone's posts** — the Delete/Unpin buttons hide links, but the database
  itself accepts a write from anyone.

## What is NOT at risk

- **Money.** The free Spark plan has no payment method attached and Google stops
  serving at the quota. You cannot be billed, and the project cannot be turned
  into a crypto-mining host: Spark has no Cloud Functions.
- **Your Google account.** Nothing in the site has access to it.
- **Other things you own.** The URL only reaches this one database.

## The honest summary

The worst case is: **someone finds it, spams it, or erases the posts.** That is
annoying, not dangerous — but it means nothing private goes on the board, and the
posts are not safe from a determined vandal.

## Three ways to fix it, cheapest first

**1. A shared password (10 minutes, still free).**
Add one `secret` node to the rules, and make every write require it:

```json
"hq": {
  ".read": true,
  ".write": "auth == null && root.child('secret').val() === 'PUT-A-LONG-RANDOM-STRING-HERE'"
}
```

The site asks for the word once per device and sends it with each write. Anyone
without it can still *read*, but cannot post, spam or wipe. This is the usual
"invite word" pattern for small groups, and it is the best value for effort here.
Cost: the word is in the page's memory, so a determined person could find it —
it stops scanners and casual vandals, not a targeted attack.

**2. Lock reading too (same change, `.read` rule).**
Make `.read` require the same secret. Then nothing is visible without the word.
Cost: the site needs the word before it can load anything, so a wrong word shows
an empty page.

**3. Real accounts (Firebase Authentication).**
Each person signs in, and rules check `auth.uid`. The catch: the Kindle's
Experimental Browser is too old for Firebase's Google sign-in popup, so it would
need email+password, and even that is shaky on older Kindles. More work, more
breakage on the device this site exists for.

## What I recommend

- Do **1** (plus 2 if you want the posts hidden as well) — I can write the rules and
  the small "enter the word" screen in one go.
- Keep nothing private on the board either way: no addresses, phone numbers,
  passwords, or anything you would not put on a postcard.
- Do not paste the database URL anywhere public (issues, Discord, screenshots) —
  the URL is already in the page source, but there is no reason to spread it.
- Turn on **Firebase → Realtime Database → Backups** if you want a copy you can
  restore after a wipe (free plan allows manual backups via the console's export).
