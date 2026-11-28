# Putting the HQ on a free subdomain (Stackryze)

Stackryze Domains (domain.stackryze.com) hands out free subdomains such as
`roak-hq.indevs.in`, `roak-hq.sryze.cc`, `roak-hq.ryzedns.org` or `roak-hq.nx.kg`,
and lets you point them wherever you like with your own DNS provider.

The HQ already has a home that is always on: the Cloudflare Worker
`roak-hq.andysurfer66.workers.dev`. It serves `/api` (the shared database) and
sends every other address on to the GitHub Pages site. A subdomain should point
there, not at a home computer.

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
4. **Tell the site its address.** Once the name works, open `js/backend.js` and
   set the site address, so a page opened from the new name finds the database:

   ```js
   window.ROAK_BACKEND = { url: 'https://roak-hq.indevs.in/api', ai: '' };
   ```

   (The Worker already finds itself when it is opened from its own workers.dev
   address; this line covers the new name.) Then push.

## Why not point the name at 172.1.177.154

That is this computer's own internet address. A name pointed there only works
while the computer is on, something is serving on port 80, and the router lets
port 80 in from outside — and it cannot have HTTPS. The Worker has none of those
problems and costs nothing.

## DuckDNS

`roak-hq.duckdns.org` is a DuckDNS name and only takes IP addresses, so it cannot
be pointed at the Worker. It can still be used as a second address for a computer
that serves the site itself; see `DUCKDNS.md`.
