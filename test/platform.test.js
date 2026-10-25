import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, resetDb, makeFakes, makeApp } from './helpers.js';
import { originMatcher } from '../src/utils/cors.js';
import { background } from '../src/utils/http.js';

let app;
beforeEach(async () => {
  await resetDb();
  app = makeApp(makeFakes());
});
after(() => pool.end());

describe('CORS', () => {
  const allowed = originMatcher([
    'http://localhost:5173',
    'https://fundisha-frontend.vercel.app',
    'https://fundisha-frontend-*-omarfarouqahmed05.vercel.app',
  ]);

  it('allows exact origins and Vercel preview URLs, and nothing that merely looks similar', () => {
    assert.ok(allowed('http://localhost:5173'));
    assert.ok(allowed('https://fundisha-frontend.vercel.app'));
    assert.ok(allowed('https://fundisha-frontend-62e4nwrhg-omarfarouqahmed05.vercel.app'));
    assert.ok(!allowed('https://fundisha-frontend-62e4nwrhg-someoneelse.vercel.app'));
    assert.ok(!allowed('https://fundisha-frontend-x.evil.com/-omarfarouqahmed05.vercel.app'));
    assert.ok(!allowed('https://fundisha-frontend-a.b-omarfarouqahmed05.vercel.app')); // * cannot cross a dot
    assert.ok(!allowed('http://localhost:5173.evil.com'));
    assert.ok(!allowed('https://evil.com'));
  });

  it('sends CORS headers only to allowed origins', async () => {
    const good = await app.get('/api/health').set('Origin', 'https://fundisha-frontend-abc123-omarfarouqahmed05.vercel.app');
    assert.equal(good.headers['access-control-allow-origin'], 'https://fundisha-frontend-abc123-omarfarouqahmed05.vercel.app');
    const bad = await app.get('/api/health').set('Origin', 'https://evil.example.com');
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  });
});

describe('background work', () => {
  it('never throws or rejects, even when the work fails', async () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    try {
      background(Promise.reject(new Error('mail server down')), 'test');
      background(Promise.resolve('fine'), 'test');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /mail server down/);
  });
});
