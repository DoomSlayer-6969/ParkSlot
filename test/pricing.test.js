import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceFor, trafficLevel } from '../src/services/pricing.js';
import { congestionOf } from '../src/services/traffic.js';

// Explicit settings, so these tests don't depend on the environment.
const PRICING = {
  baseHourlyRate: 3000,
  trafficWeight: 1,
  capacityReferenceSlots: 20,
  capacityElasticity: 0.5,
  rounding: 100,
  minHourlyRate: 1000,
  maxHourlyRate: 20000,
};
const LEVELS = [0.15, 0.35, 0.6];
const price = (slots, congestion = null, overrides = {}) => priceFor({ slots, congestion }, { ...PRICING, ...overrides }, LEVELS);

test('a lot of the reference size with no traffic data costs the base rate', () => {
  const p = price(20);
  assert.equal(p.hourly_rate, 3000);
  assert.deepEqual(p.traffic, { level: 'unknown', congestion: null, multiplier: 1 });
  assert.deepEqual(p.capacity, { slots: 20, multiplier: 1 });
  assert.equal(p.base_rate, 3000);
});

test('more congestion around the lot raises the price, by TRAFFIC_PRICE_WEIGHT at most', () => {
  assert.equal(price(20, 0).hourly_rate, 3000);
  assert.equal(price(20, 0.5).hourly_rate, 4500);
  assert.equal(price(20, 1).hourly_rate, 6000); // standstill: 1 + weight
  assert.equal(price(20, 1, { trafficWeight: 0.25 }).hourly_rate, 3800); // 3750 rounded to 100
  assert.equal(price(20, 0.5).traffic.multiplier, 1.5);
  assert.ok(price(20, 0.2).hourly_rate < price(20, 0.4).hourly_rate);
});

test('smaller lots cost more and bigger lots less, by CAPACITY_PRICE_ELASTICITY', () => {
  assert.equal(price(5).hourly_rate, 6000); // (20/5)^0.5 = 2
  assert.equal(price(80).hourly_rate, 1500); // (20/80)^0.5 = 0.5
  assert.equal(price(5, null, { capacityElasticity: 0 }).hourly_rate, 3000); // lot size ignored
  assert.equal(price(5).capacity.multiplier, 2);
});

test('both factors combine, and the result is rounded and kept within the configured range', () => {
  assert.equal(price(5, 0.5).hourly_rate, 9000); // 3000 × 1.5 × 2
  assert.equal(price(19, 0.13).hourly_rate, 3500); // 3000 × 1.13 × 1.026 = 3477 → 3500
  assert.equal(price(1, 1).hourly_rate, 20000); // 3000 × 2 × 4.47 = 26833, capped
  assert.equal(price(260).hourly_rate, 1000); // 3000 × 0.28 = 832, floor
  assert.equal(price(0).capacity.slots, 0); // an empty lot doesn't divide by zero
});

test('traffic levels follow the TRAFFIC_LEVELS thresholds', () => {
  assert.deepEqual([0, 0.14, 0.15, 0.35, 0.59, 0.6, 1].map((c) => trafficLevel(c, LEVELS)),
    ['light', 'light', 'moderate', 'heavy', 'heavy', 'severe', 'severe']);
  assert.equal(trafficLevel(null, LEVELS), 'unknown');
});

test('congestion compares current speed with free-flow speed; a closed road counts as jammed', () => {
  assert.equal(congestionOf({ currentSpeed: 30, freeFlowSpeed: 60 }), 0.5);
  assert.equal(congestionOf({ currentSpeed: 70, freeFlowSpeed: 60 }), 0); // faster than usual
  assert.equal(congestionOf({ currentSpeed: 0, freeFlowSpeed: 60 }), 1);
  assert.equal(congestionOf({ currentSpeed: 60, freeFlowSpeed: 60, roadClosure: true }), 1);
});
