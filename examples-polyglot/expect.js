// expect.js — the part of Jest's `expect` these exercises use, on node:assert, for `node --test`.
// Freezes node:assert and takes every built-in it calls at load, before the solution is imported,
// so a solution that patches them later does not change how its tests are checked.
import assert from 'node:assert';
import strict from 'node:assert/strict';
import { inspect, isDeepStrictEqual } from 'node:util';

Object.freeze(assert);
Object.freeze(strict);

const { AssertionError } = assert;
const { apply } = Reflect;
const { is, keys, freeze } = Object;
const hasOwn = Object.prototype.hasOwnProperty;
const toString = Object.prototype.toString;
const getTime = Date.prototype.getTime;
const includes = String.prototype.includes;
const exec = RegExp.prototype.exec;
const hasInstance = Function.prototype[Symbol.hasInstance];
const Str = String;

const fail = (message) => { throw new AssertionError({ message }); };
const tag = (x) => apply(toString, x, []);
const show = (x) => inspect(x, { depth: 4 });

/** Own enumerable keys whose value is not undefined: Jest's toEqual ignores the rest. */
const defined = (o) => {
  const all = keys(o), out = [];
  for (let i = 0; i < all.length; i++) if (o[all[i]] !== undefined) out[out.length] = all[i];
  return out;
};

/** Jest's toEqual: no prototype check, undefined properties ignored, errors by message, dates by time. */
const equal = (a, b) => {
  if (is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const t = tag(a);
  if (t !== tag(b)) return false;
  if (t === '[object Error]') return is(a.message, b.message);
  if (t === '[object Date]') return is(apply(getTime, a, []), apply(getTime, b, []));
  if (t !== '[object Object]' && t !== '[object Array]') return isDeepStrictEqual(a, b);
  if (t === '[object Array]' && a.length !== b.length) return false;
  const ka = defined(a), kb = defined(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (!apply(hasOwn, b, [ka[i]]) || !equal(a[ka[i]], b[ka[i]])) return false;
  return true;
};

const matches = (re, s) => apply(exec, re, [s]) !== null;

/** Each takes the received value and the arguments, and returns [pass, what was expected]. */
const MATCHERS = freeze({
  __proto__: null,
  toBe: (a, x) => [is(a, x[0]), `${show(a)} to be ${show(x[0])}`],
  toEqual: (a, x) => [equal(a, x[0]), `${show(a)} to equal ${show(x[0])}`],
  toBeNull: (a) => [a === null, `${show(a)} to be null`],
  toBeUndefined: (a) => [a === undefined, `${show(a)} to be undefined`],
  toBeDefined: (a) => [a !== undefined, `${show(a)} to be defined`],
  toBeInstanceOf: (a, x) => [apply(hasInstance, x[0], [a]), `${show(a)} to be an instance of ${show(x[0])}`],
  toMatch: (a, x) => {
    if (typeof a !== 'string') fail(`toMatch: received ${show(a)}, not a string`);
    return [typeof x[0] === 'string' ? apply(includes, a, [x[0]]) : matches(x[0], a), `${show(a)} to match ${show(x[0])}`];
  },
  toBeCloseTo: (a, x) => {
    const b = x[0], digits = x.length > 1 ? x[1] : 2;
    if (typeof a !== 'number' || typeof b !== 'number') fail(`toBeCloseTo: received ${show(a)} and ${show(b)}, not numbers`);
    const d = b - a;
    return [a === b || (d < 0 ? -d : d) < 10 ** -digits / 2, `${show(a)} to be close to ${show(b)} (${digits} digits)`];
  },
  // toThrow(), toThrow(substring), toThrow(RegExp), toThrow(new Error(message)) with the message exactly equal.
  toThrow: (fn, x) => {
    if (typeof fn !== 'function') fail(`toThrow: received ${show(fn)}, not a function`);
    let threw = false, e;
    try { apply(fn, undefined, []); } catch (err) { threw = true; e = err; }
    const message = e !== null && e !== undefined && typeof e.message === 'string' ? e.message : Str(e);
    const want = x[0];
    const what = threw ? `a throw with ${show(message)}` : 'no throw';
    if (want === undefined) return [threw, `a throw, got ${what}`];
    if (typeof want === 'string') return [threw && apply(includes, message, [want]), `a throw including ${show(want)}, got ${what}`];
    if (tag(want) === '[object RegExp]') return [threw && matches(want, message), `a throw matching ${show(want)}, got ${what}`];
    if (tag(want) === '[object Error]') return [threw && message === want.message, `a throw with ${show(want.message)}, got ${what}`];
    return fail(`toThrow: unsupported argument ${show(want)}`);
  },
});

const check = (name, received, args, not) => {
  const r = MATCHERS[name](received, args);
  if (r[0] === not) fail(`expected ${not ? 'not ' : ''}${r[1]}`);
};

/** mode: '' checks the value, 'resolves'/'rejects' wait for it and check what it settled with. */
const matchers = (actual, not, mode) => {
  const o = {};
  for (const name in MATCHERS) {
    o[name] = (...args) => {
      if (mode === '') return check(name, actual, args, not);
      return (async () => {
        let value;
        try { value = await actual; } catch (e) {
          if (mode === 'rejects') return check(name, e, args, not);
          fail(`expected ${show(actual)} to resolve, it rejected with ${show(e)}`);
        }
        if (mode === 'rejects') fail(`expected ${show(actual)} to reject, it resolved with ${show(value)}`);
        return check(name, value, args, not);
      })();
    };
  }
  return o;
};

export function expect(actual) {
  const o = matchers(actual, false, '');
  o.not = matchers(actual, true, '');
  o.resolves = matchers(actual, false, 'resolves');
  o.resolves.not = matchers(actual, true, 'resolves');
  o.rejects = matchers(actual, false, 'rejects');
  o.rejects.not = matchers(actual, true, 'rejects');
  return o;
}
