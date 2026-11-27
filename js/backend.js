window.ROAK_BACKEND = {
  /* Where the shared HQ lives. Leave empty and the site keeps everything on
     this device only.

     Cloudflare (recommended — the Worker checks every password and every admin
     action on the server). Put the Worker's address here, with /api on the end,
     and its session token storage works the same way as before:
       url: 'https://roak-hq.YOUR-SUBDOMAIN.workers.dev/api'

     The old Firebase Realtime Database address also still works, but its rules
     are open, so anyone could read the direct messages. */
  url: '',

  /* the AI helper the AI Chat app asks (optional) */
  ai: ''
};
