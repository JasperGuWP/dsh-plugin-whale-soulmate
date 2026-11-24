// Weather fallback: works without the host's web-search provider (WEB_PROVIDER_ERROR).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSoulmateHome, saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import { weatherTools } from '../packages/soulmate-core/tools/weather-tools.mjs';

const identityTool = (def) => def;
const mockFetch = (calls) => async (url) => {
  calls.push(String(url));
  if (String(url).includes('geocoding-api')) {
    return { ok: true, json: async () => ({ results: [{ name: '杭州', admin1: '浙江', country: '中国', latitude: 30.3, longitude: 120.2 }] }) };
  }
  return {
    ok: true,
    json: async () => ({
      current: { temperature_2m: 12.4, apparent_temperature: 10.1, relative_humidity_2m: 66, weather_code: 3, wind_speed_10m: 8 },
      daily: {
        time: ['2026-11-24', '2026-11-25'],
        weather_code: [3, 61],
        temperature_2m_min: [8.2, 7.6],
        temperature_2m_max: [15.9, 14.1],
        precipitation_probability_max: [10, 80],
      },
    }),
  };
};

test('weather: uses the configured city and returns a spoken-ready summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-weather-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, { persona: { city: '杭州' } });
    const calls = [];
    const [tool] = weatherTools({ makeTool: identityTool, home, cfg: { fetch: mockFetch(calls) } });
    const res = await tool.run({});
    assert.equal(res.ok, true);
    assert.equal(res.city, '杭州·浙江·中国');
    assert.equal(res.now.temp, 12);
    assert.match(res.summary, /现在阴，12°C/);
    assert.match(res.summary, /11-25 小雨 8~14°C 降雨80%/);
    assert.ok(calls.every((u) => !u.includes('key=')), 'no api key in requests');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('weather: no city → asks for one instead of guessing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-weather2-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    const [tool] = weatherTools({ makeTool: identityTool, home, cfg: { fetch: mockFetch([]) } });
    const res = await tool.run({});
    assert.equal(res.ok, false);
    assert.match(res.error, /需要城市/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('weather: explicit city argument wins; network failures surface honestly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-weather3-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const [tool] = weatherTools({ makeTool: identityTool, home, cfg: { fetch: failing } });
    const res = await tool.run({ city: '北京' });
    assert.equal(res.ok, false);
    assert.match(res.error, /天气查询失败/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('weather: extensions.weatherEnabled=false disables all network use', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-weather4-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, { persona: { city: '杭州' }, extensions: { weatherEnabled: false } });
    let called = 0;
    const [tool] = weatherTools({ makeTool: identityTool, home, cfg: { fetch: async () => { called += 1; throw new Error('should not fetch'); } } });
    const res = await tool.run({});
    assert.equal(res.ok, false);
    assert.match(res.error, /已.*关闭/);
    assert.equal(called, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
