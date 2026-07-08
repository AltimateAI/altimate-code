// Shared Altimate-branded shell for every prototype web page.
//
// Design language is sampled directly from prototype/assets/signup-design-reference.png
// (the live app.myaltimate.com/register). Palette below is taken from that image:
//   brand blue #3D6DD0 · accent #417EF6 · right bg #F4F5F8 · text #222529
//   password panel #FDECEA · error #DD524C · disabled button #9AB8F7
// Do not invent a new visual style — reuse this shell for all Altimate pages.

export const BRAND = {
  blue: "#3D6DD0",
  blueDark: "#315BB0",
  accent: "#417EF6",
  rightBg: "#F4F5F8",
  card: "#FFFFFF",
  border: "#DDE0E7",
  text: "#222529",
  textMuted: "#6B7280",
  pwPanel: "#FDECEA",
  error: "#DD524C",
  success: "#22A06B",
  disabled: "#9AB8F7",
}

/** The gradient triangle "A" mark + wordmark, matching the reference logo. */
export function logoSvg(): string {
  return `
  <span class="brand-logo">
    <svg width="30" height="30" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="alt-mark" x1="4" y1="36" x2="36" y2="6" gradientUnits="userSpaceOnUse">
          <stop stop-color="#2E5BC0"/>
          <stop offset="1" stop-color="#5FA8FF"/>
        </linearGradient>
      </defs>
      <path d="M20 3 L37 35 H27 L20 21 L13 35 H3 Z" fill="url(#alt-mark)"/>
      <path d="M20 12 L26 24 H14 Z" fill="#FFFFFF" fill-opacity="0.92"/>
    </svg>
    <span class="brand-word">Altimate AI</span>
  </span>`
}

/** Left-panel illustration — same iconography/palette as the reference (dashboard
 *  card with sliders, a $ coin, an SQL tile and a gear on a halo), minus the hands. */
function illustrationSvg(): string {
  return `
  <svg viewBox="0 0 420 360" fill="none" xmlns="http://www.w3.org/2000/svg" class="hero-art" aria-hidden="true">
    <circle cx="210" cy="180" r="150" fill="#FFFFFF" fill-opacity="0.10"/>
    <circle cx="210" cy="180" r="108" fill="#FFFFFF" fill-opacity="0.08"/>
    <!-- dashed connectors -->
    <g stroke="#F4C542" stroke-width="2.5" stroke-dasharray="6 7" stroke-linecap="round" fill="none" opacity="0.9">
      <path d="M150 120 H120 V96 H150"/>
      <path d="M270 120 H300 V150 H286"/>
      <path d="M150 250 H118 V214"/>
    </g>
    <!-- top mini card -->
    <rect x="150" y="70" width="120" height="52" rx="8" fill="#FFFFFF"/>
    <rect x="162" y="82" width="14" height="14" rx="3" fill="#2E5BC0"/>
    <rect x="182" y="82" width="14" height="14" rx="3" fill="#37C7B0"/>
    <rect x="202" y="82" width="14" height="14" rx="3" fill="#F4C542"/>
    <rect x="162" y="104" width="96" height="6" rx="3" fill="#C9D6F2"/>
    <!-- SQL tile -->
    <rect x="70" y="150" width="66" height="66" rx="10" fill="#FFFFFF"/>
    <circle cx="94" cy="176" r="12" fill="none" stroke="#2E5BC0" stroke-width="4"/>
    <line x1="103" y1="185" x2="114" y2="196" stroke="#2E5BC0" stroke-width="4" stroke-linecap="round"/>
    <rect x="86" y="192" width="34" height="16" rx="4" fill="#2E5BC0"/>
    <text x="103" y="204" font-family="Poppins, sans-serif" font-size="9" font-weight="700" fill="#FFFFFF" text-anchor="middle">SQL</text>
    <!-- gear -->
    <g transform="translate(300 130)">
      <circle cx="0" cy="0" r="26" fill="#FFFFFF"/>
      <g fill="#2E5BC0">
        <circle cx="0" cy="0" r="9" fill="none" stroke="#2E5BC0" stroke-width="5"/>
        <rect x="-3" y="-26" width="6" height="10" rx="2"/>
        <rect x="-3" y="16" width="6" height="10" rx="2"/>
        <rect x="-26" y="-3" width="10" height="6" rx="2"/>
        <rect x="16" y="-3" width="10" height="6" rx="2"/>
      </g>
    </g>
    <!-- main dashboard card with sliders + coin -->
    <rect x="140" y="150" width="150" height="120" rx="12" fill="#FFFFFF"/>
    <circle cx="172" cy="182" r="15" fill="#F4C542"/>
    <text x="172" y="187" font-family="Poppins, sans-serif" font-size="15" font-weight="700" fill="#2E5BC0" text-anchor="middle">$</text>
    <rect x="196" y="176" width="78" height="8" rx="4" fill="#C9D6F2"/>
    <!-- sliders -->
    <g stroke="#2E5BC0" stroke-width="4" stroke-linecap="round">
      <line x1="160" y1="220" x2="270" y2="220"/>
      <line x1="160" y1="246" x2="270" y2="246"/>
    </g>
    <circle cx="210" cy="220" r="9" fill="#37C7B0" stroke="#FFFFFF" stroke-width="3"/>
    <circle cx="238" cy="246" r="9" fill="#F4C542" stroke="#FFFFFF" stroke-width="3"/>
  </svg>`
}

function baseCss(): string {
  return `
  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --blue: ${BRAND.blue}; --blue-dark: ${BRAND.blueDark}; --accent: ${BRAND.accent};
    --right-bg: ${BRAND.rightBg}; --card: ${BRAND.card}; --border: ${BRAND.border};
    --text: ${BRAND.text}; --muted: ${BRAND.textMuted}; --pw-panel: ${BRAND.pwPanel};
    --error: ${BRAND.error}; --success: ${BRAND.success}; --disabled: ${BRAND.disabled};
  }
  html, body { height: 100%; }
  body {
    font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color: var(--text); background: var(--right-bg); -webkit-font-smoothing: antialiased;
  }
  .split { display: flex; min-height: 100vh; }
  .left {
    flex: 1 1 50%; background: var(--blue); color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 48px; gap: 8px;
  }
  .hero-art { width: 78%; max-width: 440px; height: auto; }
  .hero-caption { font-weight: 700; font-size: 20px; margin-top: 28px; letter-spacing: .2px; }
  .dots { display: flex; gap: 10px; margin-top: 20px; }
  .dots span { width: 9px; height: 9px; border-radius: 50%; background: rgba(255,255,255,.4); }
  .dots span.on { background: #fff; }
  .right {
    flex: 1 1 50%; display: flex; align-items: flex-start; justify-content: center;
    padding: 56px 40px; overflow-y: auto;
  }
  .content { width: 100%; max-width: 460px; }
  .brand-logo { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 40px; }
  .brand-word { font-weight: 600; font-size: 18px; color: var(--text); }
  h1 { font-size: 34px; font-weight: 700; letter-spacing: -.5px; }
  .sub { color: var(--muted); font-size: 15px; margin-top: 8px; }
  label.field-label { display: block; font-size: 15px; font-weight: 600; margin: 22px 0 8px; }
  input.field {
    width: 100%; background: #fff; border: 1px solid var(--border); border-radius: 8px;
    padding: 14px 16px; font-size: 15px; font-family: inherit; color: var(--text); outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  input.field:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(65,126,246,.15); }
  input.field::placeholder { color: #9aa1ad; }
  .btn {
    width: 100%; border: none; border-radius: 10px; padding: 15px 16px; font-size: 15px;
    font-weight: 600; font-family: inherit; cursor: pointer; transition: background .15s, opacity .15s;
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  }
  .btn-primary { background: var(--blue); color: #fff; }
  .btn-primary:hover { background: var(--blue-dark); }
  .btn-primary:disabled { background: var(--disabled); cursor: not-allowed; }
  .btn-oauth { background: #fff; color: var(--text); border: 1px solid var(--border); margin-top: 14px; }
  .btn-oauth:hover { background: #fafbfc; }
  .btn-oauth.secondary { color: var(--text); }
  .divider { display: flex; align-items: center; gap: 14px; color: var(--muted); font-size: 14px; margin: 26px 0 2px; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--border); }
  .link-btn {
    background: none; border: none; color: var(--accent); font-family: inherit; font-size: 15px;
    font-weight: 600; cursor: pointer; padding: 0; text-decoration: none;
  }
  .link-btn:hover { text-decoration: underline; }
  .legal { color: var(--muted); font-size: 13px; margin-top: 26px; line-height: 1.5; }
  .legal b { color: var(--text); font-weight: 600; }
  .card-box { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-top: 22px; }
  a { color: var(--accent); }
  .center-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 32px; }
  .center-card {
    background: #fff; border: 1px solid var(--border); border-radius: 16px; padding: 44px 40px;
    max-width: 440px; width: 100%; text-align: center; box-shadow: 0 10px 40px rgba(20,30,60,.06);
  }
  @media (max-width: 860px) { .left { display: none; } .right { flex-basis: 100%; } }
  `
}

/** Wrap right-panel content in the full split Altimate shell. */
export function altimateShell(opts: { title: string; body: string; extraCss?: string; extraJs?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${opts.title}</title>
  <style>${baseCss()}${opts.extraCss ?? ""}</style>
</head>
<body>
  <div class="split">
    <aside class="left">
      ${illustrationSvg()}
      <div class="hero-caption">Reduce Operational Costs</div>
      <div class="dots"><span></span><span></span><span class="on"></span></div>
    </aside>
    <main class="right">
      <div class="content">
        ${logoSvg()}
        ${opts.body}
      </div>
    </main>
  </div>
  ${opts.extraJs ? `<script>${opts.extraJs}</script>` : ""}
</body>
</html>`
}

/** Minimal centered-card Altimate page (used by /connected and /verify). */
export function altimateCard(opts: { title: string; body: string }): string {
  return altimateShell({
    title: opts.title,
    body: `<div style="margin-top:-8px">${opts.body}</div>`,
  })
}
