const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

const { MemoryStore, UpstashStore, StoreError } = require('../../lib/manie/store')
const { rateLimit, refund, createLocalLimiter, normalizeIp } = require('../../lib/manie/ratelimit')
const { ipHash } = require('../../lib/manie/auth')
const quiet = () => {}

describe('normalizeIp', () => {
    it('keeps IPv4 as is and unwraps IPv4-mapped IPv6', () => {
        assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7')
        assert.equal(normalizeIp(' 203.0.113.7 '), '203.0.113.7')
        assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7')
        assert.equal(normalizeIp('::FFFF:203.0.113.7'), '203.0.113.7')
    })

    it('collapses IPv6 to its /64 prefix in expanded, lowercase form', () => {
        assert.equal(normalizeIp('2001:db8::1'), '2001:0db8:0000:0000::/64')
        assert.equal(normalizeIp('2001:DB8:0:0:1:2:3:4'), '2001:0db8:0000:0000::/64')
        assert.equal(normalizeIp('2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff'), '2001:0db8:aaaa:bbbb::/64')
        assert.equal(normalizeIp('::1'), '0000:0000:0000:0000::/64')
        assert.equal(normalizeIp('::'), '0000:0000:0000:0000::/64')
        assert.equal(normalizeIp('fe80::1%eth0'), 'fe80:0000:0000:0000::/64')
        assert.equal(normalizeIp('64:ff9b::203.0.113.7'), '0064:ff9b:0000:0000::/64')
    })

    it('maps empty or non-string input to one shared bucket and keeps opaque identifiers', () => {
        for (const v of [undefined, null, '', '   ', 42, {}]) assert.equal(normalizeIp(v), 'unknown')
        assert.equal(normalizeIp('Some-Opaque-Id'), 'some-opaque-id')
        assert.equal(normalizeIp('x'.repeat(300)).length, 128)
    })
})

describe('rateLimit', () => {
    let clock
    let store

    beforeEach(() => {
        clock = { now: 1_800_000_000_000 }
        store = new MemoryStore({ now: () => clock.now })
    })

    const limit = (key, opts) => rateLimit(store, key, { max: 3, windowSec: 60, log: quiet, ...opts })

    it('allows up to max with a decreasing remaining, then denies', async () => {
        const seen = []
        for (let i = 0; i < 5; i++) {
            const r = await limit('manie:rl:t:a')
            seen.push([r.allowed, r.remaining])
        }
        assert.deepEqual(seen, [[true, 2], [true, 1], [true, 0], [false, 0], [false, 0]])
    })

    it('reports limit and a retryAfterSec that tracks the remaining window', async () => {
        for (let i = 0; i < 3; i++) await limit('manie:rl:t:a')
        clock.now += 20_000
        const denied = await limit('manie:rl:t:a')
        assert.equal(denied.allowed, false)
        assert.equal(denied.limit, 3)
        assert.equal(denied.retryAfterSec, 40)
        const ok = await limit('manie:rl:t:b')
        assert.equal(ok.retryAfterSec, 0)
    })

    it('resets after the window expires (fixed window)', async () => {
        for (let i = 0; i < 4; i++) await limit('manie:rl:t:a')
        clock.now += 59_999
        assert.equal((await limit('manie:rl:t:a')).allowed, false)
        clock.now += 1
        const fresh = await limit('manie:rl:t:a')
        assert.equal(fresh.allowed, true)
        assert.equal(fresh.remaining, 2)
    })

    it('starts the TTL on the first hit and never extends it', async () => {
        await limit('manie:rl:t:a')
        assert.equal(await store.ttl('manie:rl:t:a'), 60)
        clock.now += 30_000
        await limit('manie:rl:t:a')
        assert.equal(await store.ttl('manie:rl:t:a'), 30)
    })

    it('keeps independent counters per key', async () => {
        for (let i = 0; i < 3; i++) await limit('manie:rl:t:a')
        assert.equal((await limit('manie:rl:t:a')).allowed, false)
        assert.equal((await limit('manie:rl:t:b')).allowed, true)
    })

    it('does not let denied attempts accumulate: the counter is rolled back', async () => {
        for (let i = 0; i < 10; i++) await limit('manie:rl:t:a')
        assert.equal(await store.get('manie:rl:t:a'), 3)
    })

    it('supports cost: all-or-nothing, and a denied big request does not burn the remaining budget', async () => {
        const o = { max: 60, windowSec: 3600 }
        assert.equal((await limit('manie:rl:t:c', { ...o, cost: 55 })).remaining, 5)
        const big = await limit('manie:rl:t:c', { ...o, cost: 20 })
        assert.equal(big.allowed, false)
        assert.equal(await store.get('manie:rl:t:c'), 55)
        const small = await limit('manie:rl:t:c', { ...o, cost: 5 })
        assert.equal(small.allowed, true)
        assert.equal(small.remaining, 0)
        assert.equal((await limit('manie:rl:t:c', { ...o, cost: 1 })).allowed, false)
    })

    it('enforces exactly max under concurrency', async () => {
        const results = await Promise.all(Array.from({ length: 100 }, () => limit('manie:rl:t:race', { max: 30 })))
        assert.equal(results.filter(r => r.allowed).length, 30)
        assert.equal(await store.get('manie:rl:t:race'), 30)
    })

    it('mirrors the submission policy: 60 per hour and 600 per day, per hashed IP', async () => {
        const hash = 'a'.repeat(32)
        let accepted = 0
        for (let i = 0; i < 70; i++) {
            const hourly = await rateLimit(store, `manie:rl:sub:h:${hash}`, { max: 60, windowSec: 3600, cost: 1, log: quiet })
            if (!hourly.allowed) continue
            const daily = await rateLimit(store, `manie:rl:sub:d:${hash}`, { max: 600, windowSec: 86400, cost: 1, log: quiet })
            if (daily.allowed) accepted++
        }
        assert.equal(accepted, 60)
        clock.now += 3600_000
        const next = await rateLimit(store, `manie:rl:sub:h:${hash}`, { max: 60, windowSec: 3600, log: quiet })
        assert.equal(next.allowed, true)
    })

    it('never writes a raw identifier into the store when keys come from ipHash', async () => {
        const ips = ['203.0.113.7', '198.51.100.23', '2001:db8:1:2::abcd']
        const env = { MANIE_TRUST_PROXY: '1', MANIE_HASH_SALT: 'unit-test-salt-0123456789' }
        for (const ip of ips) {
            const key = `manie:rl:sub:${ipHash({ headers: { 'x-forwarded-for': ip }, socket: {} }, env)}`
            await rateLimit(store, key, { max: 5, windowSec: 60, log: quiet })
        }
        const dump = JSON.stringify(store.snapshot())
        for (const ip of ips) assert.ok(!dump.includes(ip), `raw ${ip} leaked`)
        assert.ok(!dump.includes('2001'))
        assert.equal(store.snapshot().length, ips.length)
    })

    it('never recreates the counter without a TTL when it expires during the rollback (R1-06)', async () => {
        const key = 'manie:rl:t:ttl'
        const o = { max: 5, windowSec: 3600, cost: 5 }
        assert.equal((await limit(key, o)).allowed, true)
        const racing = new Proxy(store, {
            get(target, prop) {
                const value = target[prop]
                if (typeof value !== 'function') return value
                if (prop !== 'incr') return value.bind(target)
                return (k, opts) => {
                    if (opts && opts.by === -5) clock.now += 3_601_000
                    return target.incr(k, opts)
                }
            },
        })
        const denied = await rateLimit(racing, key, { ...o, log: quiet })
        assert.equal(denied.allowed, false)
        const ttl = await store.ttl(key)
        assert.ok(ttl > 0 && ttl <= 3600, `the counter must keep a TTL, got ${ttl}`)
        assert.equal(await store.get(key), 0, 'the credit created by the race is repaired')
        clock.now += 3_601_000
        assert.equal((await limit(key, o)).allowed, true, 'the bucket resets after its window')
    })

    it('re-applies the window to a counter that has no TTL (legacy or damaged keys)', async () => {
        await store.set('manie:rl:t:legacy', 9)
        assert.equal(await store.ttl('manie:rl:t:legacy'), -1)
        const denied = await limit('manie:rl:t:legacy')
        assert.equal(denied.allowed, false)
        assert.equal(await store.ttl('manie:rl:t:legacy'), 60)
    })

    it('refund keeps the window and never leaves a negative balance', async () => {
        await limit('manie:rl:t:r', { max: 10, cost: 4 })
        assert.equal(await refund(store, 'manie:rl:t:r', 4, 60), true)
        assert.equal(await store.get('manie:rl:t:r'), 0)
        assert.ok((await store.ttl('manie:rl:t:r')) > 0)
        clock.now += 61_000
        assert.equal(await refund(store, 'manie:rl:t:r', 4, 60), true)
        assert.equal(await store.get('manie:rl:t:r'), 0, 'an expired key is not turned into a credit')
        assert.ok((await store.ttl('manie:rl:t:r')) > 0)
        assert.equal(await refund({ incr: async () => { throw new StoreError('network', 'down') } }, 'k', 1, 60, quiet), false)
    })

    describe('argument validation', () => {
        it('rejects bad max, windowSec and cost with a RangeError', async () => {
            for (const bad of [0, -1, 1.5, '5', NaN, undefined, null]) {
                await assert.rejects(rateLimit(store, 'manie:rl:t:x', { max: bad, windowSec: 60 }), RangeError)
                await assert.rejects(rateLimit(store, 'manie:rl:t:x', { max: 3, windowSec: bad }), RangeError)
            }
            for (const bad of [0, -2, 1.5, '1', null]) {
                await assert.rejects(rateLimit(store, 'manie:rl:t:x', { max: 3, windowSec: 60, cost: bad }), RangeError)
            }
            await assert.rejects(rateLimit(store, 'manie:rl:t:x'), RangeError)
        })
    })

    describe('store failures', () => {
        const failing = {
            incr: async () => {
                throw new StoreError('network', 'down')
            },
        }

        it('fails open by default and flags degraded, without throwing', async () => {
            const logs = []
            const r = await rateLimit(failing, 'manie:rl:t:a', { max: 3, windowSec: 60, log: (...a) => logs.push(a.join(' ')) })
            assert.deepEqual(r, { allowed: true, remaining: 3, limit: 3, retryAfterSec: 0, degraded: true })
            assert.equal(logs.length, 1)
            assert.match(logs[0], /network/)
        })

        it('fails closed with failOpen: false', async () => {
            const r = await rateLimit(failing, 'manie:rl:t:a', { max: 3, windowSec: 60, failOpen: false, log: quiet })
            assert.deepEqual(r, { allowed: false, remaining: 0, limit: 3, retryAfterSec: 60, degraded: true })
        })

        it('treats a non-numeric counter, a synchronous throw, a missing store and odd rejections as failures', async () => {
            for (const s of [
                { incr: async () => 'abc' },
                { incr: () => { throw new Error('sync') } },
                { incr: async () => { throw undefined } },
                { incr: async () => NaN },
                {},
                null,
                undefined,
            ]) {
                const r = await rateLimit(s, 'manie:rl:t:a', { max: 3, windowSec: 60, log: quiet })
                assert.equal(r.degraded, true)
                assert.equal(r.allowed, true)
            }
        })

        it('still denies when the rollback or the ttl lookup fails', async () => {
            let calls = 0
            const s = {
                incr: async () => {
                    calls++
                    if (calls === 1) return 9
                    throw new StoreError('timeout', 'slow')
                },
                ttl: async () => {
                    throw new StoreError('timeout', 'slow')
                },
            }
            const logs = []
            const r = await rateLimit(s, 'manie:rl:t:a', { max: 3, windowSec: 60, log: (...a) => logs.push(a.join(' ')) })
            assert.equal(r.allowed, false)
            assert.equal(r.retryAfterSec, 60)
            assert.equal(r.degraded, undefined)
            assert.equal(logs.length, 1)
        })

        it('copes with a store that has no ttl method', async () => {
            const s = { incr: async () => 9 }
            const r = await rateLimit(s, 'manie:rl:t:a', { max: 3, windowSec: 60, log: quiet })
            assert.equal(r.allowed, false)
            assert.equal(r.retryAfterSec, 60)
        })

        it('works against a real UpstashStore whose transport is down (fails open)', async () => {
            const down = new UpstashStore({ url: 'https://kv.example.invalid', token: 'tok', fetch: async () => { throw new Error('ECONNRESET') }, timeoutMs: 100 })
            const r = await rateLimit(down, 'manie:rl:t:a', { max: 3, windowSec: 60, log: quiet })
            assert.equal(r.allowed, true)
            assert.equal(r.degraded, true)
        })
    })
})

describe('createLocalLimiter', () => {
    it('counts hits per key inside a window and resets afterwards', () => {
        let now = 1_000_000
        const limiter = createLocalLimiter({ max: 3, windowSec: 10, now: () => now })
        const seen = [1, 2, 3, 4].map(() => limiter.hit('a').allowed)
        assert.deepEqual(seen, [true, true, true, false])
        assert.equal(limiter.hit('b').allowed, true)
        assert.equal(limiter.hit('a').retryAfterSec, 10)
        now += 10_001
        assert.equal(limiter.hit('a').allowed, true)
    })

    it('remembers locks until they expire and stays bounded', () => {
        let now = 5_000
        const limiter = createLocalLimiter({ max: 1, windowSec: 1, maxKeys: 50, now: () => now })
        assert.equal(limiter.lockedFor('x'), 0)
        limiter.lock('x', 30)
        assert.equal(limiter.lockedFor('x'), 30)
        now += 29_000
        assert.equal(limiter.lockedFor('x'), 1)
        now += 2_000
        assert.equal(limiter.lockedFor('x'), 0)
        for (let i = 0; i < 500; i++) {
            limiter.hit(`k${i}`)
            limiter.lock(`l${i}`, 60)
        }
        let locked = 0
        for (let i = 0; i < 500; i++) if (limiter.lockedFor(`l${i}`)) locked++
        assert.ok(locked <= 50, `lock memo must stay bounded, kept ${locked}`)
    })

    it('rejects bad options', () => {
        assert.throws(() => createLocalLimiter({ max: 0, windowSec: 1 }), RangeError)
        assert.throws(() => createLocalLimiter({ max: 1 }), RangeError)
    })
})
