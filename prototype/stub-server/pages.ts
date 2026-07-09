import { altimateShell, BRAND } from "./ui"
import type { PendingEmail } from "./state"

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}
const escapeAttr = escapeHtml

const googleGMark = `<svg width="20" height="20" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`

const microsoftMark = `<svg width="18" height="18" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
  <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
  <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
  <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
</svg>`

const PW_RULES = [
  { id: "len", label: "Be at least 12 characters long", test: `v.length >= 12` },
  { id: "upper", label: "Contain at least one uppercase letter", test: `/[A-Z]/.test(v)` },
  { id: "lower", label: "Contain at least one lowercase letter", test: `/[a-z]/.test(v)` },
  { id: "num", label: "Contain at least one number", test: `/[0-9]/.test(v)` },
  {
    id: "special",
    label: "Contain at least one special character (!@#$%^&*()_+\\-=[\\]{}|;:,.<>?)",
    test: `/[!@#$%^&*()_+\\-=\\[\\]{}|;:,.<>?]/.test(v)`,
  },
]

// ---------------------------------------------------------------------------
// Page 1 — /register
// ---------------------------------------------------------------------------
export function registerPage(
  userCode: string,
  opts: { open?: boolean; emailValue?: string; emailError?: string } = {},
): string {
  const rulesHtml = PW_RULES.map(
    (r) => `<li data-rule="${r.id}"><span class="mark">✗</span><span>${r.label}</span></li>`,
  ).join("")
  const emailValue = opts.emailValue ? ` value="${escapeAttr(opts.emailValue)}"` : ""
  const emailErr = opts.emailError ? escapeHtml(opts.emailError) : ""

  const body = `
    <h1>Sign Up</h1>
    <p class="sub">One click — your instance is provisioned for you.</p>

    <a class="btn btn-oauth" href="/oauth/google?code=${encodeURIComponent(userCode)}">
      ${googleGMark}<span>Continue with Google</span>
    </a>
    <button type="button" class="btn btn-oauth secondary" onclick="document.getElementById('ms-note').style.display='block'">
      ${microsoftMark}<span>Continue with Microsoft</span>
    </button>
    <p id="ms-note" style="display:none;color:var(--muted);font-size:13px;margin-top:10px">
      Microsoft SSO isn't wired in this prototype — use Google or the email option below.
    </p>

    <div class="divider">or</div>
    <div style="text-align:center;margin-top:6px">
      <button type="button" class="link-btn" id="email-toggle">or use email instead</button>
    </div>

    <div id="email-wrap" class="collapsible${opts.open ? " open" : ""}">
      <form id="email-form" method="POST" action="/auth/email">
        <input type="hidden" name="code" value="${userCode}" />
        <label class="field-label" for="email">Work email</label>
        <input class="field" type="email" id="email" name="email" placeholder="name@company.com" autocomplete="email"${emailValue} />
        <div id="email-err" class="inline-err">${emailErr}</div>

        <label class="field-label" for="password">Password</label>
        <div class="pw-row">
          <input class="field" type="password" id="password" name="password" placeholder="Password" autocomplete="new-password" />
          <button type="button" class="pw-eye" id="pw-eye" aria-label="Show password">👁</button>
        </div>

        <div id="pw-rules" class="pw-panel">
          <div class="pw-title">Password Should:</div>
          <ul>${rulesHtml}</ul>
        </div>

        <button type="submit" class="btn btn-primary" id="create-btn" disabled style="margin-top:22px">Create account</button>
      </form>
    </div>

    <p class="legal">By creating an account, you agree to the
      <b>Terms &amp; Conditions</b> and our <b>Privacy Policy</b>.</p>
  `

  const extraCss = `
    .collapsible { max-height: 0; opacity: 0; overflow: hidden; transition: max-height .45s ease, opacity .35s ease; }
    .collapsible.open { max-height: 760px; opacity: 1; }
    .pw-row { position: relative; }
    .pw-eye { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: none;
              border: none; cursor: pointer; font-size: 15px; opacity: .6; }
    .pw-panel { display: none; background: var(--pw-panel); border-radius: 8px; padding: 14px 16px; margin-top: 12px; }
    .pw-panel.show { display: block; }
    .pw-title { font-weight: 600; font-size: 14px; margin-bottom: 8px; }
    .pw-panel ul { list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .pw-panel li { display: flex; gap: 8px; align-items: flex-start; font-size: 13.5px; color: var(--error); }
    .pw-panel li.ok { color: var(--success); }
    .pw-panel li .mark { font-weight: 700; width: 14px; }
    .inline-err { color: var(--error); font-size: 13px; margin-top: 8px; min-height: 0; }
  `

  const rulesJs = PW_RULES.map((r) => `{ id: "${r.id}", test: (v) => ${r.test} }`).join(",\n")

  const extraJs = `
    (function () {
      var toggle = document.getElementById('email-toggle');
      var wrap = document.getElementById('email-wrap');
      toggle.addEventListener('click', function () {
        wrap.classList.toggle('open');
        if (wrap.classList.contains('open')) document.getElementById('email').focus();
      });

      var pw = document.getElementById('password');
      var panel = document.getElementById('pw-rules');
      var email = document.getElementById('email');
      var createBtn = document.getElementById('create-btn');
      var rules = [${rulesJs}];

      function refresh() {
        var v = pw.value;
        if (v.length > 0) panel.classList.add('show');
        var allOk = true;
        rules.forEach(function (r) {
          var ok = r.test(v);
          if (!ok) allOk = false;
          var li = panel.querySelector('li[data-rule="' + r.id + '"]');
          if (!li) return;
          li.classList.toggle('ok', ok);
          li.querySelector('.mark').textContent = ok ? '✓' : '✗';
        });
        var emailOk = /.+@.+\\..+/.test(email.value);
        createBtn.disabled = !(allOk && emailOk);
      }
      pw.addEventListener('input', refresh);
      email.addEventListener('input', refresh);

      document.getElementById('pw-eye').addEventListener('click', function () {
        pw.type = pw.type === 'password' ? 'text' : 'password';
      });
    })();
  `

  return altimateShell({ title: "Sign Up · Altimate AI", body, extraCss, extraJs })
}

// ---------------------------------------------------------------------------
// Page 2 — /oauth/google  (Google account chooser replica — NOT Altimate skin)
// ---------------------------------------------------------------------------
export function googleChooserPage(userCode: string): string {
  const cb = `/oauth/google/callback?code=${encodeURIComponent(userCode)}`
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in - Google Accounts</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Roboto', Arial, sans-serif; background: #F0F4F9; color: #202124;
         min-height: 100vh; display: flex; flex-direction: column; }
  .wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border-radius: 28px; width: 100%; max-width: 850px; display: flex;
          padding: 48px 56px; box-shadow: 0 1px 3px rgba(60,64,67,.15); }
  .left { flex: 1; padding-right: 40px; }
  .right { flex: 1; padding-top: 6px; }
  .glogo { width: 40px; height: 40px; margin-bottom: 20px; }
  .left h1 { font-size: 28px; font-weight: 400; line-height: 1.25; margin-bottom: 10px; }
  .left p { font-size: 15px; color: #202124; }
  .acct { display: flex; align-items: center; gap: 14px; padding: 12px 8px; border-radius: 8px; cursor: pointer;
          text-decoration: none; color: inherit; }
  .acct:hover { background: #f7f8f8; }
  .avatar { width: 36px; height: 36px; border-radius: 50%; background: #6d4bb8; color: #fff;
            display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 500; }
  .acct .name { font-size: 14px; font-weight: 500; }
  .acct .email { font-size: 13px; color: #5f6368; }
  .row-divider { height: 1px; background: #dadce0; margin: 4px 0; }
  .use-other .glyph { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; color: #5f6368; }
  .consent { font-size: 12px; color: #5f6368; line-height: 1.5; margin-top: 26px; }
  .consent a { color: #1a73e8; text-decoration: none; }
  .footer { display: flex; justify-content: space-between; align-items: center; padding: 18px 40px;
            font-size: 12px; color: #5f6368; max-width: 940px; width: 100%; margin: 0 auto; }
  .footer a { color: #5f6368; text-decoration: none; margin-left: 18px; }
  .lang { display: inline-flex; align-items: center; gap: 6px; }
  .note { font-size: 12px; color: #9aa0a6; margin-top: 20px; text-align: center; }
  @media (max-width: 700px) { .card { flex-direction: column; padding: 36px 28px; } .left { padding: 0 0 24px; } }
</style></head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="left">
        <svg class="glogo" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        <h1>Choose an account</h1>
        <p>to continue to <b>Altimate AI</b></p>
      </div>
      <div class="right">
        <a class="acct" href="${cb}">
          <div class="avatar">P</div>
          <div><div class="name">Priya Sharma</div><div class="email">priya@acme.com</div></div>
        </a>
        <div class="row-divider"></div>
        <div class="acct use-other" style="cursor:default">
          <div class="glyph">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="9" cy="8" r="3.4" stroke="#5f6368" stroke-width="1.6"/>
              <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="#5f6368" stroke-width="1.6" stroke-linecap="round"/>
              <path d="M18.5 8v6M15.5 11h6" stroke="#5f6368" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="name">Use another account</div>
        </div>
        <div class="consent">
          To continue, Google will share your name, email address, language preference and profile picture with Altimate AI.
          Before using this app, you can review Altimate AI's <a href="#">privacy policy</a> and <a href="#">terms of service</a>.
        </div>
      </div>
    </div>
    <div class="note">Personal Gmail accounts don't appear — filtered by the <code>hd</code> parameter.</div>
  </div>
  <div class="footer">
    <span class="lang">English (United States) ▾</span>
    <span><a href="#">Help</a><a href="#">Privacy</a><a href="#">Terms</a></span>
  </div>
</body></html>`
}

// ---------------------------------------------------------------------------
// Page 2b — /instance  (name your instance; same web flow, register skin)
// ---------------------------------------------------------------------------
export function instancePage(userCode: string, suggested: string, opts: { error?: string } = {}): string {
  const body = `
    <h1>Name your instance</h1>
    <p class="sub">Almost done — confirm the name and we'll provision it for you.</p>

    <form id="instance-form" method="POST" action="/web/instance">
      <input type="hidden" name="code" value="${escapeAttr(userCode)}" />
      <label class="field-label" for="name">Instance name</label>
      <input class="field" type="text" id="name" name="name" value="${escapeAttr(suggested)}"
             autocomplete="off" autocapitalize="none" spellcheck="false" autofocus />
      <div id="status" class="status-line">${opts.error ? `<span class="err">${escapeHtml(opts.error)}</span>` : ""}</div>
      <p class="help-line">This names your Altimate instance. You can rename it later.</p>
      <button type="submit" class="btn btn-primary" id="continue-btn" style="margin-top:18px">Continue</button>
    </form>

    <p class="legal">Your terminal is waiting — it will continue automatically once provisioning finishes.</p>
  `

  const extraCss = `
    .status-line { font-size: 13.5px; margin-top: 8px; min-height: 20px; }
    .status-line .ok { color: var(--success); font-weight: 600; }
    .status-line .warn { color: #B45309; font-weight: 600; }
    .status-line .err { color: var(--error); }
    .status-line .use-btn { background: none; border: none; padding: 0; color: var(--accent);
                            font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; }
    .help-line { color: var(--muted); font-size: 13px; margin-top: 6px; }
  `

  const extraJs = `
    (function () {
      var input = document.getElementById('name');
      var status = document.getElementById('status');
      var btn = document.getElementById('continue-btn');
      var timer = null;

      function render(html, disabled) {
        status.innerHTML = html;
        btn.disabled = !!disabled;
      }

      function check() {
        var v = input.value.trim();
        if (!v) { render('', true); return; }
        fetch('/api/instance/check?name=' + encodeURIComponent(v))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (input.value.trim() !== v) return; // stale response
            if (!d.valid) {
              render('<span class="err">' + d.error + '</span>', true);
            } else if (!d.available) {
              render('<span class="warn">taken — try <button type="button" class="use-btn" id="use-suggestion">' + d.suggestion + '</button></span>', true);
              var use = document.getElementById('use-suggestion');
              if (use) use.addEventListener('click', function () { input.value = d.suggestion; check(); });
            } else {
              render('<span class="ok">✓ available</span>', false);
            }
          })
          .catch(function () { render('', false); });
      }

      input.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(check, 350);
      });
      check(); // initial pre-fill check
    })();
  `

  return altimateShell({ title: "Name your instance · Altimate AI", body, extraCss, extraJs })
}

// ---------------------------------------------------------------------------
// Page 3 — /connected
// ---------------------------------------------------------------------------
export function connectedPage(email: string): string {
  const body = `
    <div style="text-align:center;padding-top:8px">
      <div style="width:68px;height:68px;border-radius:50%;background:rgba(34,160,107,.12);
           display:flex;align-items:center;justify-content:center;margin:0 auto 22px">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 12.5l4.5 4.5L19 7.5" stroke="${BRAND.success}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h1 style="font-size:28px">Connected</h1>
      <p class="sub" style="margin-top:12px">Signed in as ${email}.</p>
      <p class="sub" style="margin-top:6px">Your instance is being provisioned — return to your terminal; this tab can be closed.</p>
    </div>
  `
  return altimateShell({ title: "Connected · Altimate AI", body })
}

// ---------------------------------------------------------------------------
// Page 4a — /verify
// ---------------------------------------------------------------------------
export function verifyPage(email: string): string {
  const body = `
    <div style="text-align:center;padding-top:8px">
      <div style="font-size:52px;margin-bottom:16px">📬</div>
      <h1 style="font-size:28px">Check your inbox</h1>
      <p class="sub" style="margin-top:12px">Click the link we sent to <b style="color:var(--text)">${email}</b>.</p>
      <p class="sub" style="margin-top:6px">Your terminal will continue automatically.</p>
    </div>
  `
  return altimateShell({ title: "Check your inbox · Altimate AI", body })
}

// ---------------------------------------------------------------------------
// Page 4b — /dev/inbox  (prototype convenience mailbox)
// ---------------------------------------------------------------------------
export function devInboxPage(pending: PendingEmail[]): string {
  const items =
    pending.length === 0
      ? `<p style="color:#6B7280">No verification emails yet. Start the email sign-up in the CLI/browser first.</p>`
      : pending
          .map(
            (p) => `
      <div class="mail">
        <div class="mail-head">
          <div class="mail-avatar">A</div>
          <div>
            <div class="mail-from">Altimate AI &lt;no-reply@myaltimate.com&gt;</div>
            <div class="mail-to">to ${p.email}</div>
          </div>
          ${p.verified ? `<span class="badge ok">verified</span>` : `<span class="badge">unread</span>`}
        </div>
        <div class="mail-subject">Verify your email — Altimate AI</div>
        <div class="mail-body">Confirm your email address to finish setting up your Altimate AI instance.</div>
        ${
          p.verified
            ? `<div class="verified-note">✓ Verified — your terminal has continued.</div>`
            : `<a class="verify-btn" href="/dev/inbox/verify?code=${encodeURIComponent(p.userCode)}">Verify email</a>`
        }
      </div>`,
          )
          .join("")

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dev Inbox · Altimate prototype</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Poppins', system-ui, sans-serif; background: #F4F5F8; color: #222529; padding: 40px 20px; }
  .inbox { max-width: 620px; margin: 0 auto; }
  .inbox h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .inbox .hint { color: #6B7280; font-size: 13px; margin-bottom: 24px; }
  .mail { background: #fff; border: 1px solid #DDE0E7; border-radius: 12px; padding: 20px 22px; margin-bottom: 16px; }
  .mail-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .mail-avatar { width: 34px; height: 34px; border-radius: 50%; background: #3D6DD0; color: #fff;
                 display: flex; align-items: center; justify-content: center; font-weight: 600; }
  .mail-from { font-size: 13px; font-weight: 600; }
  .mail-to { font-size: 12px; color: #6B7280; }
  .badge { margin-left: auto; font-size: 11px; background: #eef1f6; color: #6B7280; padding: 3px 9px; border-radius: 999px; }
  .badge.ok { background: rgba(34,160,107,.12); color: #22A06B; }
  .mail-subject { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .mail-body { font-size: 13.5px; color: #4b5563; margin-bottom: 18px; }
  .verify-btn { display: inline-block; background: #3D6DD0; color: #fff; text-decoration: none;
                padding: 11px 22px; border-radius: 8px; font-size: 14px; font-weight: 600; }
  .verify-btn:hover { background: #315BB0; }
  .verified-note { color: #22A06B; font-size: 14px; font-weight: 600; }
</style></head>
<body>
  <div class="inbox">
    <h1>📥 Dev Inbox</h1>
    <p class="hint">Prototype-only mailbox. Open this in a second tab to play the user checking their mail.</p>
    ${items}
  </div>
</body></html>`
}
