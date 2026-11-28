"""
Deploy the HQ's server to Cloudflare without wrangler: the same API calls
`wrangler deploy` makes - upload the Worker, then attach it to the site. The
site's own files are NOT uploaded: the Worker reads them from the GitHub
repository, so a push to main is live on the HQ's name within a minute.

Run with:  python deploy-worker.py
Token and account id come from the environment (CLOUDFLARE_API_TOKEN,
CLOUDFLARE_ACCOUNT_ID) so they never sit in a file.
"""
import io, json, os, uuid, urllib.request, urllib.error

ACC = os.environ["CLOUDFLARE_ACCOUNT_ID"]
TOK = os.environ["CLOUDFLARE_API_TOKEN"]
API = "https://api.cloudflare.com/client/v4/accounts/" + ACC

DB_ID = "e78a9909-63b3-4bff-9314-bc3fb5c0ed99"

site = open("worker/roak.js", encoding="utf-8").read()


def call(method, url, body=None, ctype="application/json", raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + TOK,
        "Content-Type": ctype,
    })
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:1500])
        raise


def multipart(parts):
    boundary = "----roak" + uuid.uuid4().hex
    out = io.BytesIO()
    for name, filename, ctype, payload in parts:
        out.write(("--" + boundary + "\r\n").encode())
        if filename is None:
            out.write(('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode())
            out.write(payload + b"\r\n")
        else:
            out.write(('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (name, filename)).encode())
            out.write(("Content-Type: %s\r\n\r\n" % ctype).encode())
            out.write(payload + b"\r\n")
    out.write(("--" + boundary + "--\r\n").encode())
    return out.getvalue(), "multipart/form-data; boundary=" + boundary


metadata = {
    "main_module": "roak.js",
    "compatibility_date": "2026-01-01",
    "bindings": [
        {"type": "d1", "name": "DB", "id": DB_ID},
        {"type": "plain_text", "name": "ROAK", "text": "hq"},
    ],
    "observability": {"enabled": True},
}

parts = [
    ("metadata", None, "application/json", json.dumps(metadata).encode()),
    ("roak.js", "roak.js", "application/javascript+module", site.encode()),
]

body, ctype = multipart(parts)
print("uploading the worker (the site itself comes from GitHub) ...")
r = call("PUT", API + "/workers/scripts/roak-hq", raw=body, ctype=ctype)
print("worker upload:", r.get("success"), r.get("errors") or "")

r = call("POST", API + "/workers/scripts/roak-hq/subdomain", {"enabled": True})
print("subdomain:", r.get("success"), r.get("errors") or "")

r = call("GET", API + "/workers/subdomain")
sub = (r.get("result") or {}).get("subdomain")
print("workers.dev subdomain:", sub)
if sub:
    print("LIVE: https://roak-hq.%s.workers.dev/" % sub)
print("the Worker reads the site from the repository on every request (60s cache)")
