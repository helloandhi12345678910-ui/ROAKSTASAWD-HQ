# Putting the HQ on Cloudflare

This moves the shared HQ off Firebase and onto a Cloudflare Worker with a D1
database. It is still free, needs no card, and this time **the server checks
every password and every admin action** — a banned person's request is refused
before it reaches the data, and direct messages are only ever sent to the two
people in them.

Everything is written already: `worker/roak.js` (the server), `worker/schema.sql`
(the database) and `wrangler.toml` (the settings). What is left is your account.

---

## 1. Make a free Cloudflare account

<https://dash.cloudflare.com/sign-up> — an email address and a password. No card.

## 2. Note your Account ID

In the dashboard, **Workers & Pages** (left side). Your Account ID is on the right
hand side of that page, or in the address bar of any dashboard page after
`dash.cloudflare.com/`. It looks like `1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`.

## 3. Make an API token for this

Go to <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
**Create Custom Token**, and give it these three permissions:

| Type    | Permission          | Access |
|---------|---------------------|--------|
| Account | Workers Scripts     | Edit   |
| Account | D1                  | Edit   |
| Account | Account Settings    | Read   |

(Account Settings: Read is only so the deploy can find your account.)

Copy the token when it is shown — it is not shown again.

## 4. Send me two things

Paste them in the chat:

```
account id: ...
api token: ...
```

I will then run the deploy from here (or hand you the four commands to run if you
would rather do it yourself). Nothing in your account is touched except the one
Worker and the one database this makes.

> The token is only used to deploy. If you would rather not paste it, tell me and
> I will give you the exact commands to run in your own terminal instead.

## 5. What I do with it

```
npm install -g wrangler                     # Cloudflare's deploy tool
wrangler login --token ...                  # or CLOUDFLARE_API_TOKEN
wrangler d1 create roak-hq                  # the database, free
wrangler d1 execute roak-hq --remote --file worker/schema.sql
wrangler deploy                             # the Worker + the site
```

Then the Worker's address — `https://roak-hq.<your-subdomain>.workers.dev` — goes
into `js/backend.js` with `/api` on the end, and the site is live on Cloudflare.

## 6. The accounts carry over

The old Firebase data is still there and readable. Once the Worker is up I read it
once and write it into D1: accounts, chat, neighbourhood, pins, topics, replies.
Passwords come across as they are (the browser's hash is stored as a fallback and
upgraded to the Worker's own hash the next time that person signs in), so nobody
has to sign up again.

## 7. Afterwards

- The site can be served from the Worker as well, so GitHub Pages is optional.
- `database.rules.open.json` and the Firebase project can then be left alone or
  deleted — the site will not be reading from it any more.
- A free Worker allows 100,000 requests a day and D1 5 million rows read and
  100,000 written a day. The HQ uses a tiny fraction of that.
