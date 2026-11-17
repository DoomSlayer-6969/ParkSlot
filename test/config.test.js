import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

/** Loads src/config.js in a fresh process with only `env` set, and prints part of the config. */
function loadConfig(env, print = 'null') {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { config } = await import('./src/config.js'); console.log(JSON.stringify(${print}));`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return { ok: res.status === 0, value: res.status === 0 ? JSON.parse(res.stdout) : null, error: res.stderr };
}

test('settings come from the environment, with defaults', () => {
  const defaults = loadConfig({}, 'config.pricing').value;
  assert.equal(defaults.baseHourlyRate, 3000);
  const custom = loadConfig({ BASE_HOURLY_RATE: '4500', TRAFFIC_PRICE_WEIGHT: '0.5', HOLD_MINUTES: '5', TRAFFIC_LEVELS: '0.1,0.2,0.3' },
    '[config.pricing.baseHourlyRate, config.pricing.trafficWeight, config.holdMinutes, config.traffic.levelThresholds]').value;
  assert.deepEqual(custom, [4500, 0.5, 5, [0.1, 0.2, 0.3]]);
});

test('the traffic provider is TomTom when a key is set, and none otherwise', () => {
  assert.equal(loadConfig({}, 'config.traffic.provider').value, 'none');
  assert.equal(loadConfig({ TOMTOM_API_KEY: 'k' }, 'config.traffic.provider').value, 'tomtom');
  assert.equal(loadConfig({ TOMTOM_API_KEY: 'k', TRAFFIC_PROVIDER: 'none' }, 'config.traffic.provider').value, 'none');
});

test('invalid settings stop start-up with a message naming the variable', () => {
  const fails = (env, message) => {
    const res = loadConfig(env);
    assert.equal(res.ok, false, JSON.stringify(env));
    assert.match(res.error, message);
  };
  fails({ BASE_HOURLY_RATE: 'abc' }, /BASE_HOURLY_RATE must be a whole number at least 0 \(got "abc"\)/);
  fails({ BASE_HOURLY_RATE: '12.5' }, /BASE_HOURLY_RATE must be a whole number/);
  fails({ SEED_OCCUPANCY: '1.5' }, /SEED_OCCUPANCY must be a number at least 0 and at most 1/);
  fails({ TRAFFIC_PROVIDER: 'google' }, /TRAFFIC_PROVIDER must be one of: tomtom, none/);
  fails({ TRAFFIC_PROVIDER: 'tomtom' }, /needs TOMTOM_API_KEY/);
  fails({ TRAFFIC_LEVELS: '0.5,0.2,0.9' }, /TRAFFIC_LEVELS must be comma-separated increasing numbers/);
  fails({ MIN_HOURLY_RATE: '5000', MAX_HOURLY_RATE: '4000' }, /MAX_HOURLY_RATE must be at least MIN_HOURLY_RATE/);
  fails({ PORT: '70000' }, /PORT must be a whole number at least 0 and at most 65535/);
});
