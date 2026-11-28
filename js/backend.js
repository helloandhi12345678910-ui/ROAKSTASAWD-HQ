window.ROAK_BACKEND = {
  /* Where the shared HQ lives. Leave empty and the site keeps everything on
     this device only.

     Cloudflare (recommended — the Worker checks every password and every admin
     action on the server). Put the Worker's address here, with /api on the end,
     and its session token storage works the same way as before:
       url: 'https://roak-hq.YOUR-SUBDOMAIN.workers.dev/api'

     The old Firebase Realtime Database address also still works, but its rules
     are open, so anyone could read the direct messages. */
  /* The HQ's own server. A page opened from roak-hq.indevs.in (or from the
     Worker's address) finds the server by itself; this line makes the GitHub
     Pages copy talk to the same server too. */
  url: 'https://roak-hq.indevs.in/api',

  /* the AI helper the AI Chat app asks (optional) */
  ai: ''
};
