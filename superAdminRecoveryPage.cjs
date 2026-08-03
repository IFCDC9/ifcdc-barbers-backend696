/**
 * Minimal same-origin Super Admin recovery page (email outage).
 * Does not expose codes. Used when native app has not been updated yet.
 */
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSuperAdminRecoveryPage({ frontendUrl, outageOn }) {
  const fe = escapeHtml(frontendUrl || "https://ifcdcbarbersapp.com");
  if (!outageOn) {
    return `<!doctype html><html><body style="font-family:system-ui;padding:24px">
      <h1>Recovery unavailable</h1>
      <p>Super Admin email outage recovery is off. Use normal email verification on <a href="${fe}/login">${fe}/login</a>.</p>
    </body></html>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>IFCDC Super Admin recovery</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0b;color:#f5f5f5;margin:0;padding:24px}
    .card{max-width:420px;margin:40px auto;padding:24px;border:1px solid #333;border-radius:12px;background:#141414}
    label{display:block;font-size:13px;margin:12px 0 6px;color:#bbb}
    input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #444;background:#0f0f0f;color:#fff}
    button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#d4af37;color:#111;font-weight:700}
    .msg{margin-top:14px;font-size:14px;color:#f0c040;min-height:1.2em}
    .ok{color:#8f8}
    a{color:#d4af37}
  </style>
</head>
<body>
  <div class="card">
    <h1 style="margin:0 0 8px;font-size:22px">Super Admin recovery</h1>
    <p style="margin:0 0 8px;color:#aaa;font-size:14px">service@ifcdc.org only · password + one-time code · 10 minutes · single use</p>
    <label>Email</label>
    <input id="email" type="email" value="service@ifcdc.org" readonly />
    <label>Password</label>
    <input id="password" type="password" autocomplete="current-password" />
    <label>One-time recovery code</label>
    <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" />
    <button id="go" type="button">Verify and continue</button>
    <p class="msg" id="msg"></p>
    <p style="font-size:12px;color:#777;margin-top:18px">Get a fresh code from ops (never emailed during the Resend outage). After Resend is restored, use <a href="${fe}/login">${fe}/login</a> with email codes.</p>
  </div>
  <script>
    const msg = document.getElementById('msg');
    const fe = ${JSON.stringify(String(frontendUrl || "https://ifcdcbarbersapp.com").replace(/\\/g, ""))};
    document.getElementById('go').onclick = async () => {
      msg.className = 'msg';
      msg.textContent = 'Verifying…';
      try {
        const body = {
          email: document.getElementById('email').value.trim(),
          password: document.getElementById('password').value,
          verificationCode: document.getElementById('code').value.trim(),
        };
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (data && data.token && (data.ok === true || data.success === true)) {
          msg.className = 'msg ok';
          msg.textContent = 'Verified. Opening admin…';
          try {
            localStorage.setItem('token', data.token);
            localStorage.setItem('authToken', data.token);
            localStorage.setItem('user', JSON.stringify(data.user || {}));
          } catch (_) {}
          const url = fe.replace(/\\/$/, '') + '/login?recovery_token=' + encodeURIComponent(data.token);
          window.location.href = url;
          return;
        }
        msg.textContent = data.message || data.error || ('Login failed (HTTP ' + res.status + ')');
      } catch (e) {
        msg.textContent = e && e.message ? e.message : 'Network error';
      }
    };
  </script>
</body>
</html>`;
}

module.exports = {
  renderSuperAdminRecoveryPage,
};
