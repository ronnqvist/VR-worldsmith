import { defineConfig } from 'vite';

/**
 * Production Content-Security-Policy (defence in depth behind the markup
 * sanitizer): even if something slipped through, the page can only talk to
 * itself and openrouter.ai. Injected at build time only, because Vite's dev
 * server needs inline scripts/websockets that this policy would block.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: https://openrouter.ai",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

function cspPlugin() {
  return {
    name: 'worldsmith-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!-- %WS_CSP% (production Content-Security-Policy injected by vite.config.js) -->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`
      );
    }
  };
}

// `base: './'` makes every asset URL relative, so the same build works at
// https://ronnqvist.github.io/VR-worldsmith/, at any other sub-path, or at a
// domain root — no rebuild needed if the repo is renamed.
export default defineConfig(async ({ mode }) => {
  const plugins = [cspPlugin()];
  // `npm run dev:https` → self-signed HTTPS so a Quest on the LAN can use WebXR
  // (WebXR requires a secure context; localhost is the only HTTP exception).
  if (mode === 'https') {
    const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl');
    plugins.push(basicSsl());
  }
  return {
    base: './',
    plugins,
    build: {
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 2500
    },
    server: { host: true }
  };
});
