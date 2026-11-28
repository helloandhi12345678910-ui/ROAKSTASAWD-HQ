# Putting the HQ on a free subdomain (Stackryze)

Stackryze Domains (domain.stackryze.com) hands out free subdomains such as
`roak-hq.indevs.in`, `roak-hq.sryze.cc`, `roak-hq.ryzedns.org` or `roak-hq.nx.kg`,
and lets you point them wherever you like with your own DNS provider.

The HQ already has a home that is always on: the Cloudflare Worker `roak-hq`,
which serves the whole site *and* `/api` (the shared database) from its own
name, with no redirect. A subdomain should point there, not at a home computer.

## What to do

1. **Claim the name.** Sign in at https://domain.stackryze.com with GitHub, take
   `roak-hq` under one of the extensions, and note the nameservers it gives you
   (ns1/ns2/ns3.stackryze.com).
2. **Give it DNS at Cloudflare.** In the Cloudflare dashboard add the subdomain as
   a zone, copy the two nameservers Cloudflare shows, then put those nameservers
   into the Stackryze dashboard for the name. (This is the "Cloudflare Setup" page
   of the Stackryze docs.) Wait for the zone to turn **Active**.
3. **Attach the name to the Worker.** Workers & Pages → `roak-hq` → Settings →
   Domains & Routes → **Add → Custom domain** → type the new name. Cloudflare
   makes the DNS record and the certificate itself. The Worker then answers on
   that name.
4. **Nothing else.** A page opened from the name finds the Worker's API by
   itself (`siteOrigin()` in `js/app.js`). `js/backend.js` also names
   `https://roak-hq.indevs.in/api`, so the GitHub Pages copy uses the same
   database.

## How updates get there

The Worker reads the site's files (`index.html`, `css/roak.css`, `js/app.js`,
`js/backend.js` and the notes) straight from the `main` branch of the GitHub
repository, keeping each one for a minute. So **a push to `main` is live on
roak-hq.indevs.in within about a minute** — no deploy step. The list of files it
will serve is `SITE_PATHS` in `worker/roak.js`; a new file of a new kind (a new
page, say) is added to that list once, and then it too follows GitHub.

## Why not point the name at 172.1.177.154

That is this computer's own internet address. A name pointed there only works
while the computer is on, something is serving on port 80, and the router lets
port 80 in from outside — and it cannot have HTTPS. The Worker has none of those
problems and costs nothing.

## DuckDNS

`roak-hq.duckdns.org` is a DuckDNS name and only takes IP addresses, so it cannot
be pointed at the Worker. It can still be used as a second address for a computer
that serves the site itself; see `DUCKDNS.md`.
