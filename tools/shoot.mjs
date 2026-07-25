#!/usr/bin/env node
/**
 * Deterministic screenshot harness for the visual-critic loop.
 *
 *   node tools/shoot.mjs [--out dir] [--shots a,b,c] [--w 1920] [--h 1080] [--headed]
 *
 * Boots the dev server if it is not already up, drives the game to a fixed set
 * of camera presets via window.__COD__, and writes one PNG per preset. Every
 * shot is taken from the same seed/time-of-day so successive runs are
 * pixel-comparable and a critic can judge changes rather than noise.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const OUT = path.resolve(ROOT, arg('out', 'shots'));
const W = parseInt(arg('w', '1920'), 10);
const H = parseInt(arg('h', '1080'), 10);
const PORT = parseInt(arg('port', '5173'), 10);
const URL = `http://localhost:${PORT}/`;
const WARMUP_MS = parseInt(arg('warmup', '6000'), 10);
const SETTLE_MS = parseInt(arg('settle', '1600'), 10);

/**
 * Camera presets. Each exercises a different part of the renderer so a critic
 * can catch a regression in one area without re-reviewing everything.
 *   pos/look are world-space; tod is 0..1 time of day.
 */
export const SHOTS = {
  establishing:  { pos: [26, 9.5, 34],  look: [0, 3, 0],     fov: 55, tod: 0.32, desc: 'Wide establishing shot of the whole map' },
  street:        { pos: [2.2, 1.68, 22], look: [1, 1.5, -10], fov: 70, tod: 0.32, desc: 'Eye-level down the main street, player POV' },
  interior:      { pos: [-11, 1.7, -6],  look: [4, 1.4, -3],  fov: 70, tod: 0.32, desc: 'Interior lighting, bounce and contact shadows' },
  weapon:        { pos: [2.2, 1.68, 14], look: [2.2, 1.6, 0], fov: 70, tod: 0.32, desc: 'Viewmodel hip-fire framing', viewmodel: true },
  ads:           { pos: [2.2, 1.68, 14], look: [2.2, 1.6, 0], fov: 45, tod: 0.32, desc: 'Aim-down-sights framing', viewmodel: true, ads: true },
  materials:     { pos: [-4, 1.5, -18],  look: [-4, 1.4, -26], fov: 60, tod: 0.32, desc: 'Close-up on wall/ground material detail' },
  goldenhour:    { pos: [26, 9.5, 34],   look: [0, 3, 0],     fov: 55, tod: 0.09, desc: 'Low-sun golden hour, long shadows, volumetrics' },
  night:         { pos: [2.2, 1.68, 22], look: [1, 1.5, -10], fov: 70, tod: 0.85, desc: 'Night lighting, artificial lights, bloom' },
  skyline:       { pos: [8, 2.0, 30],    look: [-6, 14, -30], fov: 65, tod: 0.32, desc: 'Sky, clouds, aerial perspective' },
  combat:        { pos: [6, 1.7, 6],     look: [-8, 1.6, -12], fov: 70, tod: 0.32, desc: 'Combat framing with AI and FX', viewmodel: true, action: true },
};

async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let server = null;
  if (!(await waitForServer(URL, 1200))) {
    server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT, stdio: 'ignore', detached: false,
    });
    if (!(await waitForServer(URL, 45000))) {
      console.error(JSON.stringify({ ok: false, error: 'dev server failed to start' }));
      server?.kill();
      process.exit(1);
    }
  }

  const browser = await chromium.launch({
    headless: !flag('headed'),
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-driver-bug-workarounds',
      '--enable-webgl-draft-extensions',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}\n${e.stack || ''}`));

  const result = { ok: true, shots: [], errors: consoleErrors, stats: null, renderer: null };

  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction('window.__READY__ === true', { timeout: 45000 });
  } catch (e) {
    result.ok = false;
    result.error = `boot failed: ${e.message}`;
    await page.screenshot({ path: path.join(OUT, '_boot-failure.png') }).catch(() => {});
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    server?.kill();
    process.exit(1);
  }

  result.renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const d = gl?.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });

  // Let streaming/compilation/TAA settle before the first capture.
  await page.waitForTimeout(WARMUP_MS);
  await page.evaluate(() => window.__COD__?.debug?.setVisible?.(false));
  await page.evaluate(() => document.getElementById('debug-overlay')?.style.setProperty('display', 'none'));

  const requested = arg('shots', '') ? arg('shots', '').split(',') : Object.keys(SHOTS);

  for (const name of requested) {
    const s = SHOTS[name];
    if (!s) continue;
    await page.evaluate((shot) => {
      const api = window.__COD__;
      if (!api) return;
      api.setTimeOfDay?.(shot.tod);
      api.setViewmodelVisible?.(!!shot.viewmodel);
      if (shot.ads) api.setADS?.(true); else api.setADS?.(false);
      if (shot.action) api.stageCombat?.();
      api.setCamera(shot.pos, shot.look, shot.fov);
    }, s);
    await page.waitForTimeout(SETTLE_MS);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    result.shots.push({ name, file, desc: s.desc });
  }

  result.stats = await page.evaluate(() => {
    const s = window.__COD__?.stats;
    return s ? { fps: Math.round(s.fps), drawCalls: s.drawCalls, triangles: s.triangles, programs: s.programs } : null;
  });
  result.errors = consoleErrors.slice(0, 40);

  await browser.close();
  if (server) { server.kill(); }

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (consoleErrors.length) process.exitCode = 0; // errors reported, not fatal
}

main().catch(async (e) => {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack }));
  process.exit(1);
});
