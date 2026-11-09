const test = require('node:test');
const assert = require('node:assert/strict');
const { connectProfile, ensureDolphinApi } = require('./dolphin');

const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const noEndpoint = async () => null;
// Never let the suite reach (or launch) the real Dolphin Anty.
const apiUp = async () => ({ launched: false, coldStart: false });

test('already running without CDP requests explicit restart and never stops the profile', async () => {
  const calls = [];
  await assert.rejects(connectProfile('123456789', async url => {
    calls.push(url);
    return reply({ success: false, message: 'Profile ID 123456789 already running' }, 400);
  }, { readEndpoint: noEndpoint, ensureApi: apiUp }), { code: 'PROFILE_REQUIRES_RESTART' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/123456789/start?automation=1'));
});

test('reuses live CDP belonging to the requested profile without starting or stopping it', async () => {
  const calls = [];
  const result = await connectProfile('123', async url => {
    calls.push(url);
    return reply({ webSocketDebuggerUrl: 'ws://127.0.0.1:54321/devtools/browser/profile-123' });
  }, { readEndpoint: async () => ({ port: 54321, endpoint: '/devtools/browser/profile-123' }), ensureApi: apiUp });
  assert.equal(result.cdpUrl, 'http://127.0.0.1:54321');
  assert.deepEqual(calls, ['http://127.0.0.1:54321/json/version']);
});

test('stale port reused by another browser is rejected', async () => {
  const calls = [];
  await assert.rejects(connectProfile('123', async url => {
    calls.push(url);
    return url.endsWith('/json/version')
      ? reply({ webSocketDebuggerUrl: 'ws://127.0.0.1:54321/devtools/browser/another-profile' })
      : reply({ success: false, error: 'Profile ID 123 already running' }, 400);
  }, { readEndpoint: async () => ({ port: 54321, endpoint: '/devtools/browser/profile-123' }), ensureApi: apiUp }), { code: 'PROFILE_REQUIRES_RESTART' });
  assert.equal(calls.length, 2);
});

test('explicit restart stops only the requested profile and reconnects to its new port', async () => {
  const calls = [];
  const result = await connectProfile('123', async url => {
    calls.push(url);
    if (url.endsWith('/stop')) return reply({ success: true });
    if (url.endsWith('/start?automation=1')) return reply({ success: true, automation: { port: 54322 } });
    return reply({ webSocketDebuggerUrl: 'ws://127.0.0.1:54322/devtools/browser/new-session' });
  }, { restart: true, ensureApi: apiUp });
  assert.equal(result.cdpUrl, 'http://127.0.0.1:54322');
  assert.deepEqual(calls, [
    'http://127.0.0.1:3001/v1.0/browser_profiles/123/stop',
    'http://127.0.0.1:3001/v1.0/browser_profiles/123/start?automation=1',
    'http://127.0.0.1:54322/json/version',
  ]);
});

test('failed stop does not attempt to start another instance', async () => {
  const calls = [];
  await assert.rejects(connectProfile('123', async url => {
    calls.push(url);
    return reply({ success: false, message: 'access denied' }, 401);
  }, { restart: true, ensureApi: apiUp }));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/123/stop'));
});

// Fake clock: sleep advances time instantly.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; } };
}

test('launches Dolphin when its API is down and waits until it answers', async () => {
  const clock = fakeClock();
  const launched = [];
  const statuses = [];
  let probes = 0;
  const result = await ensureDolphinApi(async () => {
    if (++probes < 4) throw new TypeError('fetch failed');
    return reply({ success: false, error: 'invalid session token' }, 401);
  }, {
    ...clock,
    isRunning: async () => false,
    findExe: async () => 'C:\Program Files\Dolphin Anty\Dolphin Anty.exe',
    launch: async exe => { launched.push(exe); },
    onStatus: text => statuses.push(text),
  });
  assert.deepEqual(result, { launched: true, coldStart: true });
  assert.deepEqual(launched, ['C:\Program Files\Dolphin Anty\Dolphin Anty.exe']);
  assert.equal(probes, 4);
  assert.ok(statuses.some(s => s.includes('запускаю')));
});

test('does not launch a second copy when Dolphin is already starting', async () => {
  const clock = fakeClock();
  let probes = 0;
  const result = await ensureDolphinApi(async () => {
    if (++probes < 3) throw new TypeError('fetch failed');
    return reply({});
  }, {
    ...clock,
    isRunning: async () => true,
    findExe: async () => assert.fail('must not look for the exe'),
    launch: async () => assert.fail('must not launch'),
  });
  assert.deepEqual(result, { launched: false, coldStart: true });
});

test('API already up: nothing is checked or launched', async () => {
  const result = await ensureDolphinApi(async () => reply({}, 401), {
    isRunning: async () => assert.fail('must not check processes'),
    launch: async () => assert.fail('must not launch'),
  });
  assert.deepEqual(result, { launched: false, coldStart: false });
});

test('missing Dolphin install gives a clear error and launches nothing', async () => {
  await assert.rejects(ensureDolphinApi(async () => { throw new TypeError('fetch failed'); }, {
    isRunning: async () => false,
    findExe: async () => null,
    launch: async () => assert.fail('must not launch'),
  }), /browser\.dolphinPath/);
});

test('gives up when the API never answers', async () => {
  const clock = fakeClock();
  await assert.rejects(ensureDolphinApi(async () => { throw new TypeError('fetch failed'); }, {
    ...clock,
    timeoutMs: 5000,
    isRunning: async () => false,
    findExe: async () => 'dolphin.exe',
    launch: async () => {},
  }), /не ответил/);
  assert.ok(clock.now() >= 5000);
});

test('live CDP of the profile is reused without touching the Dolphin API', async () => {
  const result = await connectProfile('123', async () => reply({ webSocketDebuggerUrl: 'ws://127.0.0.1:54321/devtools/browser/p' }), {
    readEndpoint: async () => ({ port: 54321, endpoint: '/devtools/browser/p' }),
    ensureApi: async () => assert.fail('Dolphin API is not needed here'),
  });
  assert.equal(result.cdpUrl, 'http://127.0.0.1:54321');
});

test('after a cold start, transient /start failures are retried', async () => {
  const clock = fakeClock();
  const calls = [];
  let starts = 0;
  const result = await connectProfile('123', async url => {
    calls.push(url);
    if (url.endsWith('/start?automation=1')) {
      return ++starts === 1
        ? reply({ success: false, error: 'Subscription load discarded: the API token changed during the request' }, 500)
        : reply({ success: true, automation: { port: 58699 } });
    }
    return reply({ webSocketDebuggerUrl: 'ws://127.0.0.1:58699/devtools/browser/x' });
  }, { ...clock, readEndpoint: noEndpoint, ensureApi: async () => ({ launched: true, coldStart: true }) });
  assert.equal(result.cdpUrl, 'http://127.0.0.1:58699');
  assert.equal(starts, 2);
});

test('cold-start retries are time-bounded and surface the last error', async () => {
  const clock = fakeClock();
  let starts = 0;
  await assert.rejects(connectProfile('123', async () => {
    starts++;
    return reply({ success: false, error: 'invalid session token' }, 401);
  }, { ...clock, coldStartRetryMs: 10000, readEndpoint: noEndpoint, ensureApi: async () => ({ launched: true, coldStart: true }) }),
  /авторизацию/);
  assert.ok(starts > 1 && starts <= 7);
});

test('without a cold start, a /start failure is reported immediately', async () => {
  let starts = 0;
  await assert.rejects(connectProfile('123', async () => {
    starts++;
    return reply({ success: false, error: 'boom' }, 500);
  }, { readEndpoint: noEndpoint, ensureApi: apiUp }), /boom/);
  assert.equal(starts, 1);
});
