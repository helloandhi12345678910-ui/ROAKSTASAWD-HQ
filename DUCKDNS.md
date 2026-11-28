# Putting the HQ on roak-hq.duckdns.org

The name `roak-hq.duckdns.org` already points at **172.1.177.154**, which is
this computer's own internet address (DuckDNS sets that from whatever machine
sends the update). So the name follows this computer: while the computer is on
and something is serving on port 80, the name reaches it; while it is off, or
nothing is serving, the name reaches nothing.

There are two ways to put the HQ behind that name.

## Way 1 — a Cloudflare Tunnel (no router changes, HTTPS, free)

Cloudflare opens the connection from this computer outwards, so nothing has to be
forwarded on the router and the address gets a padlock.

1. Install `cloudflared` (the tunnel program) on this computer.
2. Sign in once: `cloudflared tunnel login` (picks a Cloudflare account).
3. Make a tunnel: `cloudflared tunnel create roak`
4. Point it at the site folder served on port 80, in `%USERPROFILE%\.cloudflared\config.yml`:

   ```yaml
   tunnel: roak
   credentials-file: C:\Users\Andy C\.cloudflared\<the tunnel id>.json
   ingress:
     - hostname: roak-hq.duckdns.org
       service: http://localhost:80
     - service: http_status:404
   ```

5. Run it: `cloudflared tunnel run roak`
6. A named tunnel can only be attached to a domain Cloudflare manages (a "zone").
   `duckdns.org` is not one — so for this name Cloudflare will not issue a
   certificate. The tunnel still works over `http://`, or the name can be pointed
   at the Worker instead (Way 2) which does have a certificate.

## Way 2 — the name in front of the Worker (the HQ's own server)

The Worker `roak-hq` already serves the site and `/api` on
`roak-hq.andysurfer66.workers.dev`. Pointing the DuckDNS name at it means the HQ
lives on Cloudflare's network: always up, HTTPS, nothing to keep running here.

- DuckDNS only points at IP addresses, so it cannot point at the Worker directly.
- What can do it is a small redirect: a Cloudflare Worker on `roak-hq.duckdns.org`
  cannot exist without the name being on Cloudflare, so in practice the name
  forwards to the Worker address, or
- a free redirect service (Cloudflare Rules, or DuckDNS's own "URL" record type
  if the account has it) sending `roak-hq.duckdns.org` to
  `https://roak-hq.andysurfer66.workers.dev/`.

## What this computer can serve today

Nothing yet: no web server is running on this computer, and port 80 is not
forwarded, so the name currently reaches a closed door. To serve the HQ from here,
something has to answer on port 80 all the time the computer is on — for example
the small static server in this repo run as a background job, or a web host like
IIS or Caddy installed and started.
