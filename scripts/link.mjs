#!/usr/bin/env node
// First-time (or re-) linking of the MCP's own WhatsApp device.
//
//   WA_SESSION_DIR=C:/path/to/profile node scripts/link.mjs
//
// Starts the session with the same settings the server uses, writes the QR to
// <dir>/qr.png (and an auto-refreshing <dir>/qr.html), and prints the session state every
// few seconds until it is ready or the timeout passes. Scan with the phone:
// WhatsApp > Settings > Linked devices > Link a device. Nothing here reads or sends.

import { Session, STATES } from '../src/session.js';

const dir = process.env.WA_SESSION_DIR;
if (!dir) {
  console.error('set WA_SESSION_DIR to the profile directory the server will use');
  process.exit(2);
}

const s = new Session({
  dataDir: dir,
  chromePath: process.env.WA_CHROME || undefined,
  headless: process.env.WA_HEADLESS !== '0',
  startTimeoutMs: Number(process.env.WA_LINK_TIMEOUT_SEC || 600) * 1000,
});

let lastState = null;
const tick = setInterval(() => {
  const st = s.status();
  if (st.state !== lastState) {
    lastState = st.state;
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${st.state}` +
      (st.needs_qr ? `  ->  scan ${st.qr_png}   (or open ${st.qr_html})` : '') +
      (st.last_error ? `  (${st.last_error})` : ''));
  }
}, 2000);

try {
  await s.ensureReady();
  const st = s.status();
  console.log(`LINKED - session ready${st.phone ? ` as +${st.phone}` : ''}. Profile: ${dir}`);
  console.log('You can close this; the server will reuse the login.');
} catch (e) {
  console.error(`not linked: ${e.message}`);
  process.exitCode = 1;
} finally {
  clearInterval(tick);
  await s.close();
  if (s.status().state !== STATES.NOT_STARTED) process.exitCode ||= 1;
}
