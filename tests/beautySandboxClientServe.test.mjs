import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountBeautySandboxClient, beautySandboxServeClientEnabled } from '../beautySandboxClientServe.js';
import {
  D8UI_API_ORIGIN,
  D8UI_HOSTNAME,
  PRODUCTION_API_ORIGIN,
  resolveSessionApiOrigin,
  sessionApiUrl,
} from '../client/src/lib/sessionApiOrigin.js';

function jsonNotFound(app) {
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path, method: req.method });
  });
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url };
}

test('sandbox SPA flag is explicit opt-in', () => {
  assert.equal(beautySandboxServeClientEnabled({}), false);
  assert.equal(beautySandboxServeClientEnabled({ BEAUTY_SANDBOX_SERVE_CLIENT: '' }), false);
  assert.equal(beautySandboxServeClientEnabled({ BEAUTY_SANDBOX_SERVE_CLIENT: '0' }), false);
  assert.equal(beautySandboxServeClientEnabled({ BEAUTY_SANDBOX_SERVE_CLIENT: '1' }), true);
});

test('d8ui Render service id enables SPA; production id and API-only do not', () => {
  assert.equal(
    beautySandboxServeClientEnabled({ RENDER_SERVICE_ID: 'srv-d8gn9h77f7vs73evmfgg' }),
    true,
  );
  assert.equal(
    beautySandboxServeClientEnabled({ RENDER_SERVICE_ID: 'srv-d6tmai24d50c73cdi0mg' }),
    false,
  );
  assert.equal(
    beautySandboxServeClientEnabled({
      RENDER_SERVICE_ID: 'srv-d8gn9h77f7vs73evmfgg',
      IFCDC_API_ONLY: '1',
    }),
    false,
  );
});

test('without the sandbox flag, unknown pages stay JSON 404 even if dist exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-spa-off-'));
  let server;
  try {
    await writeFile(join(dir, 'index.html'), '<!DOCTYPE html><html><body>IFCDC Barbers SPA</body></html>');
    const app = express();
    app.get('/api/beauty/catalog', (_req, res) => res.json({ products: [] }));
    mountBeautySandboxClient(app, { env: {}, distDir: dir });
    jsonNotFound(app);
    const ctx = await listen(app);
    server = ctx.server;
    const page = await fetch(`${ctx.url}/admin/beauty-supply`);
    assert.equal(page.status, 404);
    assert.match(page.headers.get('content-type') || '', /json/);
    assert.equal((await page.json()).error, 'not_found');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test('flag + dist serves admin/login HTML while API stays JSON and Founder auth is unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-spa-on-'));
  let server;
  try {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!DOCTYPE html><html><head><title>IFCDC Barbers</title></head><body id="root">SPA index</body></html>');
    const app = express();
    app.get('/api/beauty/catalog', (_req, res) => res.json({ products: [] }));
    app.get('/api/beauty/admin/catalog', (req, res) => {
      const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      if (!match) return res.status(401).json({ error: 'authentication_required' });
      if (match[1] !== 'founder') return res.status(403).json({ error: 'founder_required' });
      return res.json({ sellers: [], products: [] });
    });
    mountBeautySandboxClient(app, { env: { BEAUTY_SANDBOX_SERVE_CLIENT: '1' }, distDir: dir });
    jsonNotFound(app);
    const ctx = await listen(app);
    server = ctx.server;

    for (const path of ['/admin/beauty-supply', '/login', '/beauty-supply']) {
      const page = await fetch(`${ctx.url}${path}`);
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get('content-type') || '', /html/, path);
      const html = await page.text();
      assert.match(html, /<!DOCTYPE html>/i);
      assert.match(html, /SPA index|IFCDC Barbers/i);
    }

    const catalog = await fetch(`${ctx.url}/api/beauty/catalog`);
    assert.equal(catalog.status, 200);
    assert.match(catalog.headers.get('content-type') || '', /json/);
    assert.deepEqual(await catalog.json(), { products: [] });

    const unknownApi = await fetch(`${ctx.url}/api/does-not-exist`);
    assert.equal(unknownApi.status, 404);
    assert.match(unknownApi.headers.get('content-type') || '', /json/);
    assert.equal((await unknownApi.json()).error, 'not_found');

    const noAuth = await fetch(`${ctx.url}/api/beauty/admin/catalog`, { headers: { 'x-admin-key': 'secret' } });
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json()).error, 'authentication_required');

    const manager = await fetch(`${ctx.url}/api/beauty/admin/catalog`, { headers: { Authorization: 'Bearer manager' } });
    assert.equal(manager.status, 403);
    assert.equal((await manager.json()).error, 'founder_required');

    const founder = await fetch(`${ctx.url}/api/beauty/admin/catalog`, { headers: { Authorization: 'Bearer founder' } });
    assert.equal(founder.status, 200);
    assert.deepEqual(await founder.json(), { sellers: [], products: [] });
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test('flag without dist keeps JSON 404 for the admin page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-spa-empty-'));
  let server;
  try {
    const app = express();
    mountBeautySandboxClient(app, { env: { BEAUTY_SANDBOX_SERVE_CLIENT: '1' }, distDir: dir });
    jsonNotFound(app);
    const ctx = await listen(app);
    server = ctx.server;
    const page = await fetch(`${ctx.url}/admin/beauty-supply`);
    assert.equal(page.status, 404);
    assert.equal((await page.json()).error, 'not_found');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test('session wake/refresh origin stays on d8ui and never production when hosted there', () => {
  assert.equal(
    resolveSessionApiOrigin({ configuredBase: D8UI_API_ORIGIN, hostname: D8UI_HOSTNAME }),
    D8UI_API_ORIGIN,
  );
  assert.equal(resolveSessionApiOrigin({ configuredBase: '', hostname: D8UI_HOSTNAME }), '');
  assert.equal(
    resolveSessionApiOrigin({ configuredBase: PRODUCTION_API_ORIGIN, hostname: D8UI_HOSTNAME }),
    '',
  );
  assert.equal(
    sessionApiUrl('/api/auth/refresh', resolveSessionApiOrigin({ configuredBase: '', hostname: D8UI_HOSTNAME })),
    '/api/auth/refresh',
  );
  assert.equal(
    sessionApiUrl('/api/auth/refresh', resolveSessionApiOrigin({ configuredBase: D8UI_API_ORIGIN, hostname: D8UI_HOSTNAME })),
    `${D8UI_API_ORIGIN}/api/auth/refresh`,
  );
  assert.ok(!sessionApiUrl('/api/auth/refresh', resolveSessionApiOrigin({ configuredBase: '', hostname: D8UI_HOSTNAME })).includes('backend696.onrender.com'));
  assert.equal(
    resolveSessionApiOrigin({ configuredBase: '', hostname: 'ifcdcbarbersapp.com' }),
    PRODUCTION_API_ORIGIN,
  );
  assert.equal(
    resolveSessionApiOrigin({ configuredBase: D8UI_API_ORIGIN, hostname: 'localhost' }),
    D8UI_API_ORIGIN,
  );
});
