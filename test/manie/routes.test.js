const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { startServer, loadBaseConfig, submission, TOKEN, MemoryStore } = require('./helpers')
const { shapeId: rawShapeId, canonicalSkeleton } = require('../../lib/manie/anonymize')
const { ipHash } = require('../../lib/manie/auth')
const { isNoiseSkeleton, NOISE_WORDS } = require('../../lib/manie/noise')
const { K, LIMITS, RATE_LIMITS } = require('../../routes/manie')

const shapeId = (skeleton, carrier = 'mtn') => rawShapeId(canonicalSkeleton(skeleton), carrier)

const NOVEL = 'Dear customer {N} RWF has been moved to {W+} ({PH}) on {TS}. Fee: {N} RWF. Balance: {N} RWF.'
const NOVEL_WORDS = ['dear', 'customer', 'has', 'been', 'moved', 'to', 'on', 'fee', 'balance', 'rwf']
const NOVEL_MESSAGE = 'Dear customer 5000 RWF has been moved to Alice Bob (250788123456) on 2026-04-11 14:30:55. Fee: 100 RWF. Balance: 20000 RWF.'
const PROXY_ENV = { MANIE_ADMIN_TOKEN: TOKEN, MANIE_TRUST_PROXY: '1', MANIE_HASH_SALT: 'routes-test-salt-0123456789abcdef' }

async function withServer(options, fn) {
    if (typeof options === 'function') {
        fn = options
        options = {}
    }
    const server = await startServer(options)
    try {
        await fn(server)
    } finally {
        await server.close()
    }
}

async function seedVocab(s) {
    const res = await s.admin('POST', '/vocab', { add: NOVEL_WORDS })
    assert.equal(res.status, 200)
}

function itemOf(skeleton = NOVEL, extra = {}) {
    return Object.assign({ skeleton, carrier: 'mtn' }, extra)
}

function failingStore(failing) {
    const inner = new MemoryStore()
    return new Proxy(inner, {
        get(target, prop) {
            const value = target[prop]
            if (typeof value !== 'function') return value
            return (...args) => {
                if (failing(String(prop), args)) return Promise.reject(new Error('store down'))
                return value.apply(target, args)
            }
        },
    })
}

function assertErrorShape(res) {
    assert.ok(res.json && typeof res.json.error === 'string', `expected JSON error, got: ${res.text.slice(0, 120)}`)
    assert.ok(Object.keys(res.json).every((k) => ['error', 'detail', 'index', 'gate'].includes(k)))
    assert.ok(!/\.js:\d+/.test(res.text), 'no stack trace in error body')
}

function mulberry32(seed) {
    let a = seed
    return () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

async function pendingShapes(s) {
    const res = await s.admin('GET', '/pending?limit=50')
    assert.equal(res.status, 200)
    return res.json
}

describe('GET /manie/sms-formats', () => {
    it('serves the base patterns unchanged plus vocabulary and contentHash', async () => {
        await withServer(async (s) => {
            const base = loadBaseConfig()
            const res = await s.request('GET', '/manie/sms-formats')
            assert.equal(res.status, 200)
            assert.match(res.headers.get('content-type'), /^application\/json/)
            assert.match(res.json.version, /^regex-v\d{8}-[0-9a-f]{8}$/)
            assert.equal(res.json.defaultLocale, base.defaultLocale)
            assert.ok(Array.isArray(res.json.vocabulary) && res.json.vocabulary.length > 0)
            assert.match(res.json.contentHash, /^[0-9a-f]{64}$/)
            assert.equal(res.json.patterns.length, base.patterns.length)
            for (const original of base.patterns) {
                const served = res.json.patterns.find((p) => p.id === original.id)
                assert.deepEqual(served, original, `pattern ${original.id} must stay byte-identical`)
            }
        })
    })

    it('sets ETag, Cache-Control and answers 304 on a matching If-None-Match', async () => {
        await withServer(async (s) => {
            const first = await s.request('GET', '/manie/sms-formats')
            const etag = first.headers.get('etag')
            assert.equal(etag, `"${first.json.contentHash}"`)
            assert.equal(first.headers.get('cache-control'), 'public, max-age=0, s-maxage=300, stale-while-revalidate=600')
            assert.equal(first.headers.get('x-manie-degraded'), null)

            const second = await s.request('GET', '/manie/sms-formats', { headers: { 'If-None-Match': etag } })
            assert.equal(second.status, 304)
            assert.equal(second.text, '')
            assert.equal(second.headers.get('etag'), etag)

            const weak = await s.request('GET', '/manie/sms-formats', { headers: { 'If-None-Match': `W/${etag}` } })
            assert.equal(weak.status, 304)

            const stale = await s.request('GET', '/manie/sms-formats', { headers: { 'If-None-Match': '"deadbeef"' } })
            assert.equal(stale.status, 200)
        })
    })

    it('keeps version and fetchedAt stable between requests while nothing changes', async () => {
        await withServer(async (s) => {
            const a = (await s.request('GET', '/manie/sms-formats')).json
            const b = (await s.request('GET', '/manie/sms-formats')).json
            assert.equal(a.version, b.version)
            assert.equal(a.fetchedAt, b.fetchedAt)
            assert.equal(a.contentHash, b.contentHash)
        })
    })

    it('answers 503 with Retry-After and no caching when the store is down and nothing good is known (R1-04, REL-02)', async () => {
        const store = failingStore(() => true)
        await withServer({ store }, async (s) => {
            const res = await s.request('GET', '/manie/sms-formats')
            assert.equal(res.status, 503)
            assert.equal(res.json.error, 'config_unavailable')
            assert.equal(res.headers.get('x-manie-degraded'), 'kv')
            assert.equal(res.headers.get('cache-control'), 'no-store')
            assert.ok(Number(res.headers.get('retry-after')) > 0)
            assert.equal(res.json.patterns, undefined, 'a base-only config must never be served as if it were current')
        })
    })

    it('answers HEAD without a body', async () => {
        await withServer(async (s) => {
            const res = await s.request('HEAD', '/manie/sms-formats')
            assert.equal(res.status, 200)
            assert.equal(res.text, '')
        })
    })
})

describe('POST /manie/submissions', () => {
    it('accepts a shape, answers with counts only and merges repeats', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const ip = (n) => ({ 'X-Forwarded-For': `203.0.113.${n}` })
            const first = await s.submit(submission([itemOf(NOVEL, { count: 2, hints: [{ slot: 1, role: 'amount' }] })]), ip(1))
            assert.equal(first.status, 202)
            assert.deepEqual(first.json, { accepted: 1, deduped: 0, discarded: 0 })

            const second = await s.submit(submission([itemOf(NOVEL, { hints: [{ slot: 1, role: 'amount' }, { slot: 19, role: 'fee' }] })]), ip(2))
            assert.equal(second.status, 202)
            assert.deepEqual(second.json, { accepted: 1, deduped: 1, discarded: 0 })

            const again = await s.submit(submission([itemOf(NOVEL, { count: 50, hints: [{ slot: 1, role: 'balance' }] })]), ip(2))
            assert.deepEqual(again.json, { accepted: 1, deduped: 1, discarded: 0 })

            const { shapes, total } = await pendingShapes(s)
            assert.equal(total, 1)
            assert.equal(shapes.length, 1)
            const shape = shapes[0]
            assert.equal(shape.skeleton, canonicalSkeleton(NOVEL))
            assert.equal(shape.shapeId, shapeId(NOVEL))
            assert.equal(shape.carrier, 'mtn')
            assert.equal(shape.status, 'pending')
            assert.equal(shape.count, 2, 'one sighting per source and day, whatever count the device declares')
            assert.equal(shape.voters, 2)
            assert.deepEqual(shape.appVersions, ['1.0.4'])
            assert.deepEqual(shape.hintVotes, { 1: { amount: 2 } }, 'one hint vote per source: the repeat from the same source was ignored')
            assert.ok(shape.firstSeen && shape.lastSeen)
            assert.equal(Object.values(shape.perDayCounts).reduce((a, b) => a + b, 0), 2)
        })
    })

    it('works behind a host that already parsed the JSON body', async () => {
        await withServer({ hostParser: true }, async (s) => {
            await seedVocab(s)
            const res = await s.submit(submission([itemOf()]))
            assert.equal(res.status, 202)
        })
    })

    it('rejects the whole request with pii_guard and the offending index', async () => {
        await withServer(async (s) => {
            await seedVocab(s)
            const cases = [
                'You sent 5000 RWF',
                'Dear customer {N} RWF <script>',
                'Dear customer {N} RWF {BAD}',
                'Dear customer {N} RWF é',
                'Dear customer 250788123456',
            ]
            for (const bad of cases) {
                const res = await s.submit(submission([itemOf(NOVEL), itemOf(bad)]))
                assert.equal(res.status, 400, bad)
                assert.deepEqual(res.json, { error: 'pii_guard', index: 1 })
            }
            const { total } = await pendingShapes(s)
            assert.equal(total, 0, 'nothing from a rejected request may be stored')
        })
    })

    it('rewrites out-of-vocabulary words server-side instead of storing them', async () => {
        await withServer(async (s) => {
            const res = await s.submit(submission([itemOf('Dear Zxqvbn Alice moved {N} RWF to {W+}')]))
            assert.equal(res.status, 202)
            const dump = JSON.stringify(s.store.snapshot()).toLowerCase()
            assert.ok(!dump.includes('zxqvbn'))
            assert.ok(!dump.includes('alice'))
        })
    })

    it('drops OTP, PIN and failed-transaction notices without storing them', async () => {
        await withServer(async (s) => {
            await s.admin('POST', '/vocab', { add: ['your', 'otp', 'is', 'do', 'not', 'share', 'failed', 'transaction', 'of', 'pin', 'code'] })
            const noisy = [
                'Your OTP is {N} do not share',
                'Your transaction of {N} RWF has failed',
                'Your PIN code is {N}',
            ]
            const res = await s.submit(submission(noisy.map((t) => itemOf(t))))
            assert.equal(res.status, 202)
            assert.deepEqual(res.json, { accepted: 0, deduped: 0, discarded: 3 }, 'not stored, so not accepted')
            const { total } = await pendingShapes(s)
            assert.equal(total, 0)
        })
    })

    it('does not queue shapes that an active served pattern already parses', async () => {
        await withServer(async (s) => {
            const res = await s.submit(
                submission([itemOf('{N} RWF transferred to {W+}({PH}) at {TS}. Fee was: {N} RWF. New balance: {N} RWF')])
            )
            assert.equal(res.status, 202)
            assert.deepEqual(res.json, { accepted: 0, deduped: 0, discarded: 1 })
            const { total } = await pendingShapes(s)
            assert.equal(total, 0)
        })
    })

    it('counts every submitted item once: accepted + discarded = items sent, and accepted - deduped = new shapes', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            await s.admin('POST', '/vocab', { add: ['your', 'otp', 'is', 'do', 'not', 'share'] })
            const covered = '{N} RWF transferred to {W+}({PH}) at {TS}. Fee was: {N} RWF. New balance: {N} RWF'
            const items = [itemOf(NOVEL), itemOf(NOVEL), itemOf(`${NOVEL}!`), itemOf('Your OTP is {N} do not share'), itemOf(covered)]
            const first = await s.submit(submission(items), { 'X-Forwarded-For': '203.0.113.31' })
            assert.equal(first.status, 202)
            assert.deepEqual(first.json, { accepted: 3, deduped: 1, discarded: 2 }, 'two new shapes (one of them sent twice), one OTP, one covered')
            assert.equal(first.json.accepted + first.json.discarded, items.length)
            assert.equal(first.json.accepted - first.json.deduped, (await pendingShapes(s)).total)
            const second = await s.submit(submission(items), { 'X-Forwarded-For': '203.0.113.32' })
            assert.deepEqual(second.json, { accepted: 3, deduped: 3, discarded: 2 }, 'everything stored now merges into existing shapes')
            assert.equal((await pendingShapes(s)).total, 2)
        })
    })

    it('validates the body strictly', async () => {
        await withServer(async (s) => {
            const item = itemOf()
            const bodies = {
                'missing v': { items: [item], app: { version: '1.0.0', platform: 'ios' } },
                'wrong v': { v: 2, items: [item], app: { version: '1.0.0', platform: 'ios' } },
                'unknown top key': { v: 1, items: [item], app: { version: '1.0.0', platform: 'ios' }, extra: 1 },
                'no items': { v: 1, items: [], app: { version: '1.0.0', platform: 'ios' } },
                'too many items': { v: 1, items: Array.from({ length: 21 }, () => item), app: { version: '1.0.0', platform: 'ios' } },
                'items not array': { v: 1, items: 'x', app: { version: '1.0.0', platform: 'ios' } },
                'missing app': { v: 1, items: [item] },
                'bad platform': { v: 1, items: [item], app: { version: '1.0.0', platform: 'windows' } },
                'bad version': { v: 1, items: [item], app: { version: '<b>', platform: 'ios' } },
                'unknown carrier': { v: 1, items: [itemOf(NOVEL, { carrier: 'tigo' })], app: { version: '1.0.0', platform: 'ios' } },
                'unknown item key': { v: 1, items: [itemOf(NOVEL, { note: 'x' })], app: { version: '1.0.0', platform: 'ios' } },
                'count zero': { v: 1, items: [itemOf(NOVEL, { count: 0 })], app: { version: '1.0.0', platform: 'ios' } },
                'count too high': { v: 1, items: [itemOf(NOVEL, { count: 51 })], app: { version: '1.0.0', platform: 'ios' } },
                'count float': { v: 1, items: [itemOf(NOVEL, { count: 1.5 })], app: { version: '1.0.0', platform: 'ios' } },
                'bad locale': { v: 1, items: [itemOf(NOVEL, { locale: 'en_RW!' })], app: { version: '1.0.0', platform: 'ios' } },
                'bad hint role': { v: 1, items: [itemOf(NOVEL, { hints: [{ slot: 1, role: 'password' }] })], app: { version: '1.0.0', platform: 'ios' } },
                'bad hint slot': { v: 1, items: [itemOf(NOVEL, { hints: [{ slot: 0, role: 'amount' }] })], app: { version: '1.0.0', platform: 'ios' } },
                'skeleton too long': { v: 1, items: [itemOf('a'.repeat(401))], app: { version: '1.0.0', platform: 'ios' } },
                'skeleton empty': { v: 1, items: [itemOf('')], app: { version: '1.0.0', platform: 'ios' } },
                'skeleton not string': { v: 1, items: [{ skeleton: { a: 1 }, carrier: 'mtn' }], app: { version: '1.0.0', platform: 'ios' } },
                'array body': [1, 2, 3],
            }
            for (const [name, body] of Object.entries(bodies)) {
                const res = await s.submit(body)
                assert.equal(res.status, 400, name)
                assertErrorShape(res)
            }
        })
    })

    it('rejects non-JSON and malformed bodies', async () => {
        await withServer(async (s) => {
            const text = await s.request('POST', '/manie/submissions', { raw: 'v=1', headers: { 'Content-Type': 'text/plain' } })
            assert.equal(text.status, 400)
            assertErrorShape(text)
            const broken = await s.request('POST', '/manie/submissions', { raw: '{"v":1,', headers: { 'Content-Type': 'application/json' } })
            assert.equal(broken.status, 400)
            assert.equal(broken.json.error, 'invalid_json')
            const huge = await s.request('POST', '/manie/submissions', { raw: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }), headers: { 'Content-Type': 'application/json' } })
            assert.equal(huge.status, 413)
            assert.equal(huge.json.error, 'payload_too_large')
        })
    })

    it('enforces its own 16 KB limit', async () => {
        await withServer(async (s) => {
            const body = { v: 1, items: [itemOf()], app: { version: '1.0.0', platform: 'ios' }, pad: 'x'.repeat(17000) }
            const res = await s.submit(body)
            assert.equal(res.status, 413)
            assert.equal(res.json.error, 'payload_too_large')
        })
    })

    it('refuses prototype-pollution keys anywhere in the body', async () => {
        await withServer(async (s) => {
            const app = '{"version":"1.0.0","platform":"ios"}'
            const item = JSON.stringify(itemOf())
            const payloads = [
                `{"v":1,"items":[${item}],"app":${app},"__proto__":{"polluted":true}}`,
                `{"v":1,"items":[{"skeleton":"x","carrier":"mtn","constructor":{"prototype":{"polluted":true}}}],"app":${app}}`,
                `{"v":1,"items":[${item}],"app":{"version":"1.0.0","platform":"ios","prototype":1}}`,
            ]
            for (const raw of payloads) {
                const res = await s.request('POST', '/manie/submissions', { raw, headers: { 'Content-Type': 'application/json' } })
                assert.equal(res.status, 400)
                assertErrorShape(res)
            }
            assert.equal({}.polluted, undefined)
        })
    })

    it('rate limits per IP hash and never stores the raw IP', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const batch = submission(Array.from({ length: LIMITS.maxItems }, () => itemOf()))
            const ipA = { 'X-Forwarded-For': '203.0.113.7' }
            const allowedBatches = RATE_LIMITS.perIpPerHour / LIMITS.maxItems
            for (let i = 0; i < allowedBatches; i++) {
                const res = await s.submit(batch, ipA)
                assert.equal(res.status, 202, `request ${i}`)
            }
            const limited = await s.submit(batch, ipA)
            assert.equal(limited.status, 429)
            assert.equal(limited.json.error, 'rate_limited')
            assert.ok(Number(limited.headers.get('retry-after')) > 0)
            assert.equal(limited.text.includes('203.0.113.7'), false)

            const other = await s.submit(batch, { 'X-Forwarded-For': '203.0.113.8' })
            assert.equal(other.status, 202)

            const dump = JSON.stringify(s.store.snapshot())
            assert.ok(!dump.includes('203.0.113'), 'raw IP must not be stored')
            const keys = s.store.snapshot().map((e) => e.key)
            assert.ok(keys.some((k) => k.startsWith('manie:rl:sub:h:')))
            assert.ok(keys.some((k) => k.startsWith('manie:rl:sub:d:')))
        })
    })

    it('enforces the daily budget and refunds the hourly counter on denial', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const fakeReq = { headers: { 'x-forwarded-for': '198.51.100.9' }, socket: {} }
            const hash = ipHash(fakeReq, PROXY_ENV)
            await s.store.incr(K.rlDay(hash), { ex: 86400, by: RATE_LIMITS.perIpPerDay - 5 })
            const headers = { 'X-Forwarded-For': '198.51.100.9' }
            const denied = await s.submit(submission(Array.from({ length: 10 }, () => itemOf())), headers)
            assert.equal(denied.status, 429)
            assert.ok(Number(denied.headers.get('retry-after')) > 0)
            const allowed = await s.submit(submission(Array.from({ length: 5 }, () => itemOf())), headers)
            assert.equal(allowed.status, 202)
            assert.equal(await s.store.get(K.rlHour(hash)), 5)
        })
    })

    it('has the loosened limits of the owner decision: 600 items/hour and 3000/day per address, 100 new shapes/day, 30000 items/day overall', () => {
        assert.deepEqual(RATE_LIMITS, {
            perIpPerHour: 600,
            perIpPerDay: 3000,
            newShapesPerIpPerDay: 100,
            globalPerDay: 30000,
            localRequestsPer10Min: 120,
        })
        assert.ok(Object.isFrozen(RATE_LIMITS), 'one place, not changeable at run time')
        assert.ok(RATE_LIMITS.localRequestsPer10Min * 6 >= RATE_LIMITS.perIpPerHour / LIMITS.maxItems, 'the per-instance pre-filter never refuses a caller who is within the item budget')
    })

    describe('global daily cap', () => {
        const DAY = '2026-10-22'
        const NOON = Date.parse(`${DAY}T20:00:00Z`)
        const globalKey = K.rlGlobal(DAY.replace(/-/g, ''))
        const fakeHash = (ipAddress) => ipHash({ headers: { 'x-forwarded-for': ipAddress }, socket: {} }, PROXY_ENV)

        it('keys the counter by UTC date, expires it at the next UTC midnight, and answers 429 with Retry-After once it is spent', async () => {
            const clock = { t: NOON }
            await withServer({ env: PROXY_ENV, now: () => new Date(clock.t) }, async (s) => {
                await seedVocab(s)
                assert.equal(globalKey, 'manie:rl:global:20261022')
                const ipA = { 'X-Forwarded-For': '203.0.113.50' }
                assert.equal((await s.submit(submission([itemOf()]), ipA)).status, 202)
                assert.equal(await s.store.get(globalKey), 1)
                const ttl = await s.store.ttl(globalKey)
                assert.ok(ttl > 4 * 3600 - 10 && ttl <= 4 * 3600, `the counter lives until midnight UTC, ttl ${ttl}`)

                await s.store.incr(globalKey, { by: RATE_LIMITS.globalPerDay - 1 - 3 })
                const tooMany = await s.submit(submission(Array.from({ length: 5 }, () => itemOf())), { 'X-Forwarded-For': '203.0.113.51' })
                assert.equal(tooMany.status, 429)
                assert.equal(tooMany.json.error, 'rate_limited')
                const retryAfter = Number(tooMany.headers.get('retry-after'))
                assert.ok(retryAfter > 4 * 3600 - 10 && retryAfter <= 4 * 3600, `Retry-After points at the next UTC midnight, got ${retryAfter}`)
                assert.equal(await s.store.get(globalKey), RATE_LIMITS.globalPerDay - 3, 'the refused request did not use any of the global budget')
                const hash = fakeHash('203.0.113.51')
                assert.equal(Number((await s.store.get(K.rlHour(hash))) || 0), 0, 'and the address got its own allowance back')
                assert.equal(Number((await s.store.get(K.rlDay(hash))) || 0), 0)
                assert.equal(await s.store.hgetall(K.shape(shapeId(NOVEL))).then((r) => (r ? r.count : 0)), 1, 'nothing from the refused request was stored')

                const fits = await s.submit(submission(Array.from({ length: 3 }, () => itemOf())), { 'X-Forwarded-For': '203.0.113.52' })
                assert.equal(fits.status, 202, 'a request that still fits is served')
                assert.equal(await s.store.get(globalKey), RATE_LIMITS.globalPerDay)
                const spent = await s.submit(submission([itemOf()]), { 'X-Forwarded-For': '203.0.113.53' })
                assert.equal(spent.status, 429)
                assert.ok(Number(spent.headers.get('retry-after')) > 0)

                clock.t = Date.parse('2026-10-23T00:00:05Z')
                const nextDay = await s.submit(submission([itemOf()]), { 'X-Forwarded-For': '203.0.113.54' })
                assert.equal(nextDay.status, 202, 'a new UTC day starts a new counter')
                assert.equal(await s.store.get('manie:rl:global:20261023'), 1)
            })
        })

        it('is counted after the per-address limits: an address over its own limit never spends the global budget', async () => {
            await withServer({ env: PROXY_ENV, now: () => new Date(NOON) }, async (s) => {
                await seedVocab(s)
                const hash = fakeHash('203.0.113.60')
                await s.store.incr(K.rlHour(hash), { ex: 3600, by: RATE_LIMITS.perIpPerHour })
                const res = await s.submit(submission([itemOf()]), { 'X-Forwarded-For': '203.0.113.60' })
                assert.equal(res.status, 429)
                assert.equal(await s.store.get(globalKey), null, 'the global counter was never touched')
            })
        })

        it('stops costing store commands once the global cap is known to be spent on this instance', async () => {
            const log = []
            const inner = new MemoryStore()
            const store = new Proxy(inner, {
                get(target, prop) {
                    const value = target[prop]
                    if (typeof value !== 'function') return value
                    return (...args) => {
                        log.push(String(prop))
                        return value.apply(target, args)
                    }
                },
            })
            await withServer({ env: PROXY_ENV, store, servedTtlMs: 30000, now: () => new Date(NOON) }, async (s) => {
                await seedVocab(s)
                await store.incr(globalKey, { ex: 4 * 3600, by: RATE_LIMITS.globalPerDay })
                const first = await s.submit(submission([itemOf()]), { 'X-Forwarded-For': '203.0.113.70' })
                assert.equal(first.status, 429)
                const before = log.length
                for (let i = 0; i < 10; i++) {
                    const res = await s.submit(submission([itemOf()]), { 'X-Forwarded-For': `203.0.113.${71 + i}` })
                    assert.equal(res.status, 429)
                    assert.ok(Number(res.headers.get('retry-after')) > 0)
                }
                assert.equal(log.length, before, 'refused from memory')
            })
        })

        it('fails open when the store cannot count (the public endpoint keeps working)', async () => {
            const store = failingStore((method, args) => method === 'incr' && String(args[0]).startsWith('manie:rl:global:'))
            await withServer({ env: PROXY_ENV, store, now: () => new Date(NOON) }, async (s) => {
                await seedVocab(s)
                const res = await s.submit(submission([itemOf()]), { 'X-Forwarded-For': '203.0.113.90' })
                assert.equal(res.status, 202)
            })
        })
    })

    it('answers 503 when storage fails instead of crashing', async () => {
        const store = failingStore((method) => method === 'hset')
        await withServer({ store }, async (s) => {
            const res = await s.submit(submission([itemOf('Dear {W+} moved {N} RWF')]))
            assert.equal(res.status, 503)
            assert.equal(res.json.error, 'storage_unavailable')
            assertErrorShape(res)
        })
    })

    it('still accepts a submission when only the stats counter fails', async () => {
        const store = failingStore((method, args) => method === 'incr' && String(args[0]).startsWith('manie:stats:'))
        await withServer({ store }, async (s) => {
            await seedVocab(s)
            const res = await s.submit(submission([itemOf()]))
            assert.equal(res.status, 202)
            assert.equal((await pendingShapes(s)).total, 1)
        })
    })

    it('caps the pending queue at 2000 shapes and drops the lowest counts', async () => {
        await withServer(async (s) => {
            await seedVocab(s)
            for (let i = 0; i < 2000; i++) await s.store.zadd(K.pending, 5, `f${String(i).padStart(15, '0')}`)
            const res = await s.submit(submission([itemOf()]))
            assert.equal(res.status, 202)
            assert.equal(await s.store.zcard(K.pending), 2000)
            assert.equal(await s.store.hgetall(K.shape(shapeId(NOVEL))), null, 'the lowest-count shape is evicted')
        })
    })
})

describe('admin authentication', () => {
    it('answers 503 on every admin API route when the token is unset or too short', async () => {
        for (const env of [{}, { MANIE_ADMIN_TOKEN: '' }, { MANIE_ADMIN_TOKEN: 'short-token' }, { MANIE_ADMIN_TOKEN: 'x'.repeat(23) }]) {
            await withServer({ env }, async (s) => {
                for (const [method, path] of [
                    ['GET', '/pending'],
                    ['GET', '/stats'],
                    ['GET', '/vocab'],
                    ['POST', '/test'],
                ]) {
                    const res = await s.request(method, `/manie/admin/api${path}`, { token: 'x'.repeat(40), body: method === 'POST' ? {} : undefined })
                    assert.equal(res.status, 503, `${method} ${path}`)
                    assert.equal(res.json.error, 'admin_disabled')
                    assert.equal(res.headers.get('cache-control'), 'no-store')
                }
            })
        }
    })

    it('answers 401 for a missing or wrong token and never leaks CORS headers', async () => {
        await withServer({ cors: true }, async (s) => {
            const missing = await s.request('GET', '/manie/admin/api/stats', { headers: { Origin: 'https://evil.example' } })
            assert.equal(missing.status, 401)
            assert.equal(missing.headers.get('cache-control'), 'no-store')
            assert.equal(missing.headers.get('access-control-allow-origin'), null)
            assert.match(missing.headers.get('www-authenticate'), /^Bearer/)

            for (const header of ['Bearer wrong-token-wrong-token-wrong-token', 'Basic abc', TOKEN, 'Bearer', `Bearer ${TOKEN}x`]) {
                const res = await s.request('GET', '/manie/admin/api/stats', { headers: { Authorization: header, Origin: 'https://evil.example' } })
                assert.equal(res.status, 401, header)
                assert.equal(res.headers.get('access-control-allow-origin'), null)
            }

            const ok = await s.request('GET', '/manie/admin/api/stats', { token: TOKEN, headers: { Origin: 'https://evil.example' } })
            assert.equal(ok.status, 200)
            assert.equal(ok.headers.get('access-control-allow-origin'), null)
            assert.equal(ok.headers.get('cache-control'), 'no-store')

            const pub = await s.request('GET', '/manie/sms-formats')
            assert.equal(pub.headers.get('access-control-allow-origin'), '*', 'public routes keep the host CORS policy')
        })
    })

    it('throttles an IP after 10 failed attempts but still lets the right token through (REL-08)', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            const attacker = { 'X-Forwarded-For': '192.0.2.50' }
            for (let i = 0; i < 10; i++) {
                const res = await s.request('GET', '/manie/admin/api/stats', { token: `wrong-token-number-${i}-xxxxxxxxxxxx`, headers: attacker })
                assert.equal(res.status, 401, `attempt ${i}`)
            }
            const throttled = await s.request('GET', '/manie/admin/api/stats', { token: 'wrong-token-number-11-xxxxxxxxxxxx', headers: attacker })
            assert.equal(throttled.status, 429)
            assert.ok(Number(throttled.headers.get('retry-after')) > 0)

            const admin = await s.request('GET', '/manie/admin/api/stats', { token: TOKEN, headers: attacker })
            assert.equal(admin.status, 200, 'a valid token is never locked out by guesses from a shared address')

            const keys = s.store.snapshot().map((e) => e.key)
            assert.ok(keys.some((k) => k.startsWith('manie:authfail:')))
            assert.ok(!JSON.stringify(s.store.snapshot()).includes('192.0.2.50'))
        })
    })

    it('does not count requests without a token as failed attempts', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            const headers = { 'X-Forwarded-For': '192.0.2.60' }
            for (let i = 0; i < 15; i++) {
                const res = await s.request('GET', '/manie/admin/api/stats', { headers })
                assert.equal(res.status, 401)
            }
            const ok = await s.request('GET', '/manie/admin/api/stats', { token: TOKEN, headers })
            assert.equal(ok.status, 200)
        })
    })

    it('does not log the token or the Authorization header', async () => {
        const captured = []
        const originals = {}
        for (const level of ['log', 'info', 'warn', 'error']) {
            originals[level] = console[level]
            console[level] = (...args) => captured.push(args.map(String).join(' '))
        }
        try {
            await withServer(async (s) => {
                await s.request('GET', '/manie/admin/api/stats', { token: 'wrong-token-wrong-token-wrong-token' })
                await s.request('GET', '/manie/admin/api/stats', { token: TOKEN })
                await s.request('POST', '/manie/admin/api/test', { token: TOKEN, raw: '{bad', headers: { 'Content-Type': 'application/json' } })
            })
        } finally {
            Object.assign(console, originals)
        }
        const output = captured.join('\n')
        assert.ok(!output.includes(TOKEN))
        assert.ok(!output.includes('wrong-token-wrong-token'))
        assert.ok(!/bearer/i.test(output))
    })

    it('serves an authenticated JSON 404 for unknown admin API paths', async () => {
        await withServer(async (s) => {
            const res = await s.request('GET', '/manie/admin/api/nope', { token: TOKEN })
            assert.equal(res.status, 404)
            assert.equal(res.json.error, 'not_found')
            const anon = await s.request('GET', '/manie/admin/api/nope')
            assert.equal(anon.status, 401)
        })
    })
})

describe('GET /manie/admin (page)', () => {
    it('serves HTML with a strict CSP and no caching, without requiring a token', async () => {
        await withServer({ cors: true }, async (s) => {
            const res = await s.request('GET', '/manie/admin')
            assert.equal(res.status, 200)
            assert.match(res.headers.get('content-type'), /^text\/html/)
            assert.equal(res.headers.get('cache-control'), 'no-store')
            assert.equal(res.headers.get('x-frame-options'), 'DENY')
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
            assert.equal(res.headers.get('access-control-allow-origin'), null)
            const csp = res.headers.get('content-security-policy')
            assert.match(csp, /default-src 'none'/)
            assert.match(csp, /frame-ancestors 'none'/)
            assert.match(csp, /connect-src 'self'/)
            assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'scripts must be nonce-gated')
            const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1]
            for (const tag of res.text.match(/<(script|style)\b[^>]*>/gi) || []) {
                assert.ok(tag.includes(`nonce="${nonce}"`), `${tag} must carry the nonce`)
            }
            const again = await s.request('GET', '/manie/admin')
            assert.notEqual(/script-src 'nonce-([^']+)'/.exec(again.headers.get('content-security-policy'))[1], nonce)
        })
    })

    it('still answers 200 on the page when the admin token is not configured', async () => {
        await withServer({ env: {} }, async (s) => {
            const res = await s.request('GET', '/manie/admin')
            assert.equal(res.status, 200)
        })
    })
})

describe('admin lifecycle', () => {
    async function submitAndRedraft(s, skeleton = NOVEL) {
        await seedVocab(s)
        const sub = await s.submit(submission([itemOf(skeleton, { count: 3 })]))
        assert.equal(sub.status, 202)
        const id = shapeId(skeleton)
        const redraft = await s.admin('POST', `/shape/${id}/redraft`, { type: 'transfer' })
        assert.equal(redraft.status, 200, redraft.text)
        return { id, draft: redraft.json.draft, gate: redraft.json.gate }
    }

    it('lists pending shapes with cached draft and gate, and paginates', async () => {
        await withServer(async (s) => {
            await seedVocab(s)
            const variants = [`${NOVEL}!`, `${NOVEL}!!`, `${NOVEL}?`]
            for (const v of variants) assert.equal((await s.submit(submission([itemOf(v)]))).status, 202)
            const page1 = (await s.admin('GET', '/pending?limit=2')).json
            assert.equal(page1.total, 3)
            assert.equal(page1.shapes.length, 2)
            assert.equal(page1.nextCursor, '2')
            for (const shape of page1.shapes) {
                assert.ok(shape.draft && shape.draft.pattern, 'draft is present')
                assert.ok(shape.gate && Array.isArray(shape.gate.checks), 'gate result is present')
            }
            const page2 = (await s.admin('GET', `/pending?limit=2&cursor=${page1.nextCursor}`)).json
            assert.equal(page2.shapes.length, 1)
            assert.equal(page2.nextCursor, null)
            const seen = new Set([...page1.shapes, ...page2.shapes].map((x) => x.shapeId))
            assert.equal(seen.size, 3)

            const bogus = await s.admin('GET', '/pending?limit=abc&cursor=-5')
            assert.equal(bogus.status, 200)
            const detail = await s.admin('GET', `/shape/${page1.shapes[0].shapeId}`)
            assert.equal(detail.status, 200)
            assert.equal(detail.json.shape.skeleton, page1.shapes[0].skeleton)
            assert.equal((await s.admin('GET', '/shape/not-a-shape-id')).status, 404)
            assert.equal((await s.admin('GET', `/shape/${'0'.repeat(16)}`)).status, 404)
        })
    })

    it('approves a drafted shape, serves it, and honours the kill switch', async () => {
        await withServer(async (s) => {
            const { id, draft, gate } = await submitAndRedraft(s)
            assert.equal(gate.ok, true, JSON.stringify(gate))

            const before = (await s.request('GET', '/manie/sms-formats')).json

            const approve = await s.admin('POST', `/shape/${id}/approve`, { draft })
            assert.equal(approve.status, 200, approve.text)
            const patternId = approve.json.id
            assert.match(patternId, /^[a-z0-9][a-z0-9-]{2,60}$/)
            assert.equal(approve.json.pattern.status, 'active')

            const after = (await s.request('GET', '/manie/sms-formats')).json
            assert.notEqual(after.version, before.version)
            assert.notEqual(after.contentHash, before.contentHash)
            assert.ok(after.fetchedAt >= before.fetchedAt)
            assert.equal(after.patterns.length, before.patterns.length + 1)
            const served = after.patterns.find((p) => p.id === patternId)
            assert.ok(served, 'approved pattern is served')
            assert.equal(served.type, 'transfer')
            assert.equal(served.carrier, 'mtn')
            assert.equal(served.status, 'active')
            assert.ok(Number.isInteger(served.captureMap.amount))
            assert.deepEqual(
                before.patterns.map((p) => p.id),
                after.patterns.filter((p) => p.id !== patternId).map((p) => p.id)
            )
            const etag = (await s.request('GET', '/manie/sms-formats')).headers.get('etag')
            assert.equal(etag, `"${after.contentHash}"`)

            const probe = await s.admin('POST', '/test', {
                pattern: served.pattern,
                flags: served.flags,
                captureMap: served.captureMap,
                timestamp: served.timestamp,
                message: NOVEL_MESSAGE,
            })
            assert.equal(probe.status, 200, probe.text)
            assert.equal(probe.json.matched, true)
            assert.equal(probe.json.timedOut, false)

            const shape = (await s.admin('GET', `/shape/${id}`)).json.shape
            assert.equal(shape.status, 'approved')
            assert.equal(shape.approvedId, patternId)
            assert.equal((await pendingShapes(s)).total, 0)

            const again = await s.admin('POST', `/shape/${id}/approve`, { draft })
            assert.equal(again.status, 409)

            const resubmit = await s.submit(submission([itemOf(NOVEL, { count: 2 })]))
            assert.deepEqual(resubmit.json, { accepted: 1, deduped: 1, discarded: 0 })
            assert.equal((await pendingShapes(s)).total, 0, 'approved shapes never return to the queue')
            assert.equal((await s.admin('GET', `/shape/${id}`)).json.shape.count, 1, 'the same source counts once per day')

            const listed = (await s.admin('GET', '/approved')).json
            const row = listed.approved.find((p) => p.id === patternId)
            assert.equal(row.enabled, true)

            const off = await s.admin('POST', `/approved/${patternId}/disable`)
            assert.equal(off.status, 200)
            assert.equal(off.json.enabled, false)
            const disabled = (await s.request('GET', '/manie/sms-formats')).json
            assert.ok(!disabled.patterns.some((p) => p.id === patternId), 'kill switch removes the pattern at once')
            assert.notEqual(disabled.contentHash, after.contentHash)
            assert.equal(disabled.patterns.length, before.patterns.length)
            assert.equal((await s.admin('GET', '/approved')).json.approved.find((p) => p.id === patternId).enabled, false)

            const on = await s.admin('POST', `/approved/${patternId}/enable`)
            assert.equal(on.status, 200)
            const enabled = (await s.request('GET', '/manie/sms-formats')).json
            assert.ok(enabled.patterns.some((p) => p.id === patternId))

            assert.equal((await s.admin('POST', '/approved/does-not-exist-anywhere/disable')).status, 404)
            assert.equal((await s.admin('POST', '/approved/Bad_ID!/disable')).status, 404)

            const stats = (await s.admin('GET', '/stats')).json
            assert.equal(stats.pending, 0)
            assert.equal(stats.approved, 1)
            assert.equal(stats.rejected, 0)
            assert.equal(stats.submissions24h, 2)
        })
    })

    it('can disable and re-enable a pattern that only exists in the served base file', async () => {
        await withServer(async (s) => {
            const base = loadBaseConfig()
            const target = 'mtn-token-payment-v1'
            const original = base.patterns.find((p) => p.id === target)
            assert.ok(original, 'the remote-only base pattern exists')
            assert.equal((await s.admin('POST', `/approved/${target}/disable`)).status, 200)
            const off = (await s.request('GET', '/manie/sms-formats')).json
            assert.ok(!off.patterns.some((p) => p.id === target))
            assert.equal(off.patterns.length, base.patterns.length - 1)
            assert.equal((await s.admin('POST', `/approved/${target}/enable`)).status, 200)
            const on = (await s.request('GET', '/manie/sms-formats')).json
            assert.deepEqual(on.patterns.find((p) => p.id === target), original)
        })
    })

    it('refuses to pretend that the kill switch removes a pattern compiled into the app (R1-SERVED-7)', async () => {
        await withServer(async (s) => {
            const before = (await s.request('GET', '/manie/sms-formats')).json
            const res = await s.admin('POST', '/approved/mtn-transfer-v1/disable')
            assert.equal(res.status, 409)
            assert.equal(res.json.error, 'builtin_pattern')
            const after = (await s.request('GET', '/manie/sms-formats')).json
            assert.equal(after.contentHash, before.contentHash, 'nothing changed')
            assert.equal((await s.admin('POST', '/approved/mtn-transfer-v1/enable')).status, 200, 'enabling stays possible to undo an older switch-off')
        })
    })

    it('can switch off a base pattern whose id does not follow the usual naming (REL-10)', async () => {
        const base = loadBaseConfig()
        const odd = { ...JSON.parse(JSON.stringify(base.patterns[0])), id: 'MTN_Transfer.v1' }
        const long = { ...JSON.parse(JSON.stringify(base.patterns[1])), id: `base-${'x'.repeat(66)}` }
        const custom = { ...base, patterns: [odd, long, ...base.patterns.slice(2)] }
        await withServer({ base: custom, builtInIds: [] }, async (s) => {
            for (const id of [odd.id, long.id]) {
                const res = await s.admin('POST', `/approved/${id}/disable`)
                assert.equal(res.status, 200, id)
                assert.ok(!(await s.request('GET', '/manie/sms-formats')).json.patterns.some((p) => p.id === id))
            }
            assert.equal((await s.admin('POST', `/approved/${'y'.repeat(81)}/disable`)).status, 404)
        })
    })

    it('rejects a shape and never re-queues it', async () => {
        await withServer(async (s) => {
            await seedVocab(s)
            await s.submit(submission([itemOf()]))
            const id = shapeId(NOVEL)
            const res = await s.admin('POST', `/shape/${id}/reject`, { reason: 'duplicate of an existing format' })
            assert.equal(res.status, 200)
            assert.equal((await pendingShapes(s)).total, 0)
            const shape = (await s.admin('GET', `/shape/${id}`)).json.shape
            assert.equal(shape.status, 'rejected')
            assert.equal(shape.rejectReason, 'duplicate of an existing format')

            const again = await s.submit(submission([itemOf()]))
            assert.deepEqual(again.json, { accepted: 1, deduped: 1, discarded: 0 })
            assert.equal((await pendingShapes(s)).total, 0)
            assert.equal((await s.admin('GET', `/shape/${id}`)).json.shape.count, 1)

            assert.equal((await s.admin('GET', '/stats')).json.rejected, 1)
            assert.equal((await s.admin('POST', `/shape/${'0'.repeat(16)}/reject`, {})).status, 404)
            assert.equal((await s.admin('POST', `/shape/${id}/reject`, { reason: 5 })).status, 400)
            assert.equal((await s.admin('POST', `/shape/${id}/reject`, { reason: 'x', other: 1 })).status, 400)
        })
    })

    it('validates approve bodies strictly', async () => {
        await withServer(async (s) => {
            const { id, draft } = await submitAndRedraft(s)
            const post = (body) => s.admin('POST', `/shape/${id}/approve`, body)
            const cases = {
                'no draft': {},
                'extra top key': { draft, other: 1 },
                'unknown draft key': { draft: { ...draft, hacked: true } },
                'bad carrier': { draft: { ...draft, carrier: 'tigo' } },
                'bad type': { draft: { ...draft, type: 'refund' } },
                'bad id': { draft: { ...draft, id: 'Bad ID!' } },
                'short id': { draft: { ...draft, id: 'ab' } },
                'pattern not string': { draft: { ...draft, pattern: 5 } },
                'pattern too long': { draft: { ...draft, pattern: 'a'.repeat(LIMITS.maxPattern + 1) } },
                'flags junk': { draft: { ...draft, flags: 'xyz' } },
                'capture map junk': { draft: { ...draft, captureMap: { amount: 1, password: 2 } } },
                'capture group zero': { draft: { ...draft, captureMap: { amount: 0 } } },
                'timestamp junk': { draft: { ...draft, timestamp: { group: 2, parser: 'eval' } } },
                'tags junk': { draft: { ...draft, tags: ['ok', '<script>'] } },
                'locale junk': { draft: { ...draft, locale: 'english' } },
            }
            for (const [name, body] of Object.entries(cases)) {
                const res = await post(body)
                assert.equal(res.status, 400, name)
                assertErrorShape(res)
            }
            const pollute = await s.request('POST', `/manie/admin/api/shape/${id}/approve`, {
                token: TOKEN,
                raw: `{"draft":${JSON.stringify(draft)},"__proto__":{"x":1}}`,
                headers: { 'Content-Type': 'application/json' },
            })
            assert.equal(pollute.status, 400)
            const nested = await s.request('POST', `/manie/admin/api/shape/${id}/approve`, {
                token: TOKEN,
                raw: JSON.stringify({ draft: { ...draft, captureMap: JSON.parse('{"amount":1,"constructor":2}') } }),
                headers: { 'Content-Type': 'application/json' },
            })
            assert.equal(nested.status, 400)
            assert.equal((await s.admin('POST', `/shape/${'0'.repeat(16)}/approve`, { draft })).status, 404)
            assert.equal((await s.admin('POST', '/shape/zzz/approve', { draft })).status, 404)
            assert.equal((await pendingShapes(s)).total, 1, 'nothing was approved')
        })
    })

    it('never lets an approved id collide with a built-in or an earlier approval', async () => {
        await withServer(async (s) => {
            const { id, draft } = await submitAndRedraft(s)
            const base = loadBaseConfig()
            const clash = await s.admin('POST', `/shape/${id}/approve`, { draft: { ...draft, id: base.patterns[0].id } })
            assert.equal(clash.status, 409)
            assert.equal(clash.json.error, 'id_conflict')

            const variant = `${NOVEL}!`
            assert.equal((await s.submit(submission([itemOf(variant)]))).status, 202)

            const first = await s.admin('POST', `/shape/${id}/approve`, { draft: { ...draft, id: 'mtn-auto-unique-one' } })
            assert.equal(first.status, 200, first.text)
            assert.equal(first.json.id, 'mtn-auto-unique-one')

            const second = await s.admin('POST', `/shape/${shapeId(variant)}/approve`, { draft: { ...draft, id: 'mtn-auto-unique-one' } })
            assert.equal(second.status, 409)
            assert.equal(second.json.error, 'id_conflict')
        })
    })

    it('refuses to approve while the served config cannot be read', async () => {
        let down = false
        const store = failingStore((method, args) => down && method === 'hgetall' && args[0] === 'manie:approved')
        await withServer({ store }, async (s) => {
            const { id, draft } = await submitAndRedraft(s)
            down = true
            const res = await s.admin('POST', `/shape/${id}/approve`, { draft })
            assert.equal(res.status, 503)
            assert.equal(res.json.error, 'served_config_unavailable')
            down = false
            assert.equal((await pendingShapes(s)).total, 1)
        })
    })

    it('assigns an id when the draft has none', async () => {
        await withServer(async (s) => {
            const { id, draft } = await submitAndRedraft(s)
            const { id: _dropped, ...rest } = draft
            const res = await s.admin('POST', `/shape/${id}/approve`, { draft: rest })
            assert.equal(res.status, 200, res.text)
            assert.match(res.json.id, /^auto-(mtn|airtel)-[a-z]+-[0-9a-f]{8}$/)
            assert.ok(res.json.id.endsWith(id.slice(0, 8)))
        })
    })

    it('re-runs the gate server-side and ignores the gate result sent by the client', async () => {
        await withServer(async (s) => {
            const { id, draft } = await submitAndRedraft(s)
            const forged = { ok: true, checks: [{ name: 'all', ok: true, detail: 'trust me' }] }
            const attempts = {
                'does not compile': { ...draft, pattern: '(' },
                'nested quantifiers': {
                    ...draft,
                    pattern: '.*?((?:\\d+\\s?)*)\\sRWF.*?(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2})',
                    captureMap: { amount: 1 },
                    timestamp: { group: 2, parser: 'iso8601' },
                },
                'does not match its own skeleton': {
                    ...draft,
                    pattern: '.*?(\\d+)\\sRWF.*?nevergoingtomatch.*?(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2})',
                    captureMap: { amount: 1 },
                    timestamp: { group: 2, parser: 'iso8601' },
                },
                'no amount capture': { ...draft, captureMap: {} },
                'group beyond the regex': { ...draft, captureMap: { amount: 15 } },
            }
            const approvedBefore = (await s.admin('GET', '/approved')).json.approved.length
            for (const [name, attempt] of Object.entries(attempts)) {
                const res = await s.admin('POST', `/shape/${id}/approve`, { draft: { ...attempt, gate: forged } })
                assert.ok([400, 422].includes(res.status), `${name}: ${res.status} ${res.text.slice(0, 160)}`)
                assertErrorShape(res)
            }
            assert.equal((await s.admin('GET', '/approved')).json.approved.length, approvedBefore)
            assert.equal((await pendingShapes(s)).total, 1)
            const served = (await s.request('GET', '/manie/sms-formats')).json
            assert.equal(served.patterns.length, loadBaseConfig().patterns.length)
        })
    })

    it('uses the stored skeleton, not a client-supplied one, for the self-match check', async () => {
        await withServer(async (s) => {
            const { id, draft } = await submitAndRedraft(s)
            const res = await s.admin('POST', `/shape/${id}/approve`, {
                draft: {
                    ...draft,
                    sourceShape: '{N} RWF',
                    pattern: '.*?(\\d+)\\sRWF.*?nevergoingtomatch.*?(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2})',
                    captureMap: { amount: 1 },
                    timestamp: { group: 2, parser: 'iso8601' },
                },
            })
            assert.equal(res.status, 422)
            assert.equal(res.json.error, 'gate_failed')
        })
    })

    it('keeps the gate result out of the draft and exposes the source shape as an object', async () => {
        await withServer(async (s) => {
            const { id, draft, gate } = await submitAndRedraft(s)
            assert.equal(draft.gate, undefined)
            assert.ok(gate && Array.isArray(gate.checks))
            assert.equal(draft.sourceShape.skeleton, canonicalSkeleton(NOVEL))
            assert.equal(draft.sourceShape.shapeId, id)
            const listed = (await pendingShapes(s)).shapes[0]
            assert.equal(listed.draft.gate, undefined)
            assert.deepEqual(listed.gate, gate)
        })
    })

    it('applies redraft overrides the way the admin page sends them', async () => {
        await withServer(async (s) => {
            const { id, draft } = await submitAndRedraft(s)
            assert.ok(draft.captureMap.fee, 'the base draft finds a fee')

            const noFee = await s.admin('POST', `/shape/${id}/redraft`, { type: 'transfer', id: '', captureMap: { fee: 0 }, timestamp: draft.timestamp })
            assert.equal(noFee.status, 200, noFee.text)
            assert.equal(noFee.json.draft.captureMap.fee, undefined)
            assert.ok(noFee.json.draft.id.startsWith('auto-mtn-transfer-'))

            const noTimestamp = await s.admin('POST', `/shape/${id}/redraft`, { timestamp: null })
            assert.equal(noTimestamp.status, 200)
            assert.equal(noTimestamp.json.draft.timestamp, undefined)
            assert.equal(noTimestamp.json.gate.ok, false, 'a pattern without timestamp or transaction id is blocked')
        })
    })

    it('approves a draft whose word slots were turned into literals', async () => {
        await withServer(async (s) => {
            const { id } = await submitAndRedraft(s)
            const unconfirmed = await s.admin('POST', `/shape/${id}/redraft`, { type: 'transfer', wordsAsLiteral: ['1: Alice Bob'] })
            assert.equal(unconfirmed.status, 200, unconfirmed.text)
            assert.equal(unconfirmed.json.gate.ok, false, 'a literal that sits where a name stood is blocked until the admin confirms it (PRIV2-2)')
            assert.equal(unconfirmed.json.gate.checks.find((c) => c.name === 'name-slot').ok, false)
            const redraft = await s.admin('POST', `/shape/${id}/redraft`, { type: 'transfer', wordsAsLiteral: ['1: Alice Bob'], captureMap: { secondParty: null } })
            assert.equal(redraft.status, 200, redraft.text)
            assert.ok(redraft.json.draft.sourceShape.synthSkeleton, 'literal replacement is recorded')
            assert.equal(redraft.json.draft.sourceShape.nameConfirmed, true)
            assert.equal(redraft.json.gate.ok, true, JSON.stringify(redraft.json.gate))
            assert.match(redraft.json.draft.pattern, /Alice\[[^\]]*\]\+Bob/)
            const approve = await s.admin('POST', `/shape/${id}/approve`, { draft: redraft.json.draft })
            assert.equal(approve.status, 200, approve.text)
            const served = (await s.request('GET', '/manie/sms-formats')).json
            assert.ok(served.patterns.some((p) => p.id === approve.json.id))
        })
    })

    it('does not redraft or re-gate shapes that are already approved', async () => {
        await withServer(async (s) => {
            const { id, draft } = await submitAndRedraft(s)
            assert.equal((await s.admin('POST', `/shape/${id}/approve`, { draft })).status, 200)
            const detail = (await s.admin('GET', `/shape/${id}`)).json.shape
            assert.equal(detail.status, 'approved')
            assert.equal(detail.draft.pattern, draft.pattern)
            assert.equal((await s.admin('POST', `/shape/${id}/redraft`, { type: 'payment' })).status, 409)
        })
    })

    it('lists a full page of 100 drafts quickly', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            for (let batch = 0; batch < 10; batch++) {
                const items = Array.from({ length: 10 }, (_, i) => itemOf(`${NOVEL}${'!'.repeat(batch * 10 + i + 1)}`))
                const res = await s.submit(submission(items), { 'X-Forwarded-For': `203.0.113.${batch + 1}` })
                assert.equal(res.status, 202)
            }
            const started = Date.now()
            const res = await s.admin('GET', '/pending?limit=100')
            const elapsed = Date.now() - started
            assert.equal(res.status, 200)
            assert.equal(res.json.shapes.length, 100)
            assert.equal(res.json.nextCursor, null)
            assert.ok(res.json.shapes.every((x) => x.draft && x.gate), 'every shape has a draft and a gate result')
            assert.ok(elapsed < 5000, `first listing took ${elapsed} ms`)
            const again = Date.now()
            await s.admin('GET', '/pending?limit=100')
            assert.ok(Date.now() - again < elapsed + 500, 'cached drafts make the second listing no slower')
        })
    })

    it('redraft validates overrides and persists the new draft', async () => {
        await withServer(async (s) => {
            const { id } = await submitAndRedraft(s)
            const bad = [
                { type: 'refund' },
                { id: 'Bad Id' },
                { captureMap: { amount: 1, nope: 2 } },
                { timestamp: { group: 1, parser: 'x' } },
                { wordsAsLiteral: ['x'.repeat(61)] },
                { wordsAsLiteral: ['tab\there'] },
                { wordsAsLiteral: 'abc' },
                { other: 1 },
            ]
            for (const body of bad) {
                const res = await s.admin('POST', `/shape/${id}/redraft`, body)
                assert.equal(res.status, 400, JSON.stringify(body))
            }
            const res = await s.admin('POST', `/shape/${id}/redraft`, { type: 'payment' })
            assert.equal(res.status, 200)
            assert.equal(res.json.draft.type, 'payment')
            const stored = (await s.admin('GET', `/shape/${id}`)).json.shape
            assert.equal(stored.draft.type, 'payment')
            assert.equal((await s.admin('POST', `/shape/${'0'.repeat(16)}/redraft`, {})).status, 404)
        })
    })

    it('tests a pattern with a hard timeout and strict input limits', async () => {
        await withServer(async (s) => {
            const ok = await s.admin('POST', '/test', {
                pattern: '.*?(\\d+)\\sRWF',
                flags: 'i',
                captureMap: { amount: 1 },
                message: 'You paid 1500 RWF today',
            })
            assert.equal(ok.status, 200, ok.text)
            assert.equal(ok.json.matched, true)
            assert.equal(ok.json.timedOut, false)

            const miss = await s.admin('POST', '/test', { pattern: 'nothing', flags: 'i', captureMap: { amount: 1 }, message: 'abc' })
            assert.equal(miss.status, 200)
            assert.equal(miss.json.matched, false)

            const started = Date.now()
            const evil = await s.admin('POST', '/test', {
                pattern: '(a+)+$',
                flags: 'i',
                captureMap: { amount: 1 },
                message: `${'a'.repeat(60)}!`,
            })
            assert.ok(Date.now() - started < 4000, 'catastrophic patterns are cut off')
            assert.equal(evil.status, 200, evil.text)
            assert.equal(evil.json.timedOut, true)
            assert.equal(evil.json.matched, false)

            const invalid = await s.admin('POST', '/test', { pattern: '(', flags: 'i', captureMap: { amount: 1 }, message: 'abc' })
            assert.ok([200, 422].includes(invalid.status), `unexpected ${invalid.status}`)

            const cases = [
                { pattern: 'a', message: 'x'.repeat(2001) },
                { pattern: 'a'.repeat(LIMITS.maxPattern + 1), message: 'x' },
                { pattern: 'a', message: '' },
                { pattern: 'a', flags: 'gx', message: 'x' },
                { pattern: 'a', message: 'x', extra: 1 },
                { pattern: 5, message: 'x' },
                { pattern: 'a', message: 'x', captureMap: { amount: 'one' } },
            ]
            for (const body of cases) {
                const res = await s.admin('POST', '/test', body)
                assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80))
            }
        })
    })

    it('manages admin vocabulary with strict validation and surfaces it in the served config', async () => {
        await withServer(async (s) => {
            assert.deepEqual((await s.admin('GET', '/vocab')).json.words, [])
            const add = await s.admin('POST', '/vocab', { add: ['Blorptastic', 'quibbleword', 'blorptastic'] })
            assert.equal(add.status, 200)
            assert.deepEqual(add.json.words, ['blorptastic', 'quibbleword'])
            const served = (await s.request('GET', '/manie/sms-formats')).json
            assert.ok(served.vocabulary.includes('blorptastic'))
            assert.ok(served.vocabulary.includes('quibbleword'))

            const removed = await s.admin('POST', '/vocab', { remove: ['blorptastic'] })
            assert.deepEqual(removed.json.words, ['quibbleword'])
            assert.ok(!(await s.request('GET', '/manie/sms-formats')).json.vocabulary.includes('blorptastic'))

            const bad = [
                { add: ['abc1'] },
                { add: ['a'] },
                { add: ['x'.repeat(31)] },
                { add: ['two words'] },
                { add: 'word' },
                { add: [5] },
                { add: Array.from({ length: 51 }, (_, i) => `word${'abcdefghij'[i % 10]}${'abcdefghij'[Math.floor(i / 10)]}`) },
                {},
                { other: ['abc'] },
            ]
            for (const body of bad) {
                const res = await s.admin('POST', '/vocab', body)
                assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80))
            }
        })
    })

    it('reports stats', async () => {
        await withServer(async (s) => {
            const empty = (await s.admin('GET', '/stats')).json
            assert.deepEqual({ p: empty.pending, a: empty.approved, r: empty.rejected, s: empty.submissions24h }, { p: 0, a: 0, r: 0, s: 0 })
            await seedVocab(s)
            await s.submit(submission([itemOf()]))
            await s.submit(submission([itemOf(`${NOVEL}!`)]))
            const stats = (await s.admin('GET', '/stats')).json
            assert.equal(stats.pending, 2)
            assert.equal(stats.submissions24h, 2)
        })
    })

    it('answers admin errors as JSON without stack traces', async () => {
        await withServer(async (s) => {
            const res = await s.request('POST', '/manie/admin/api/test', { token: TOKEN, raw: '{bad', headers: { 'Content-Type': 'application/json' } })
            assert.equal(res.status, 400)
            assertErrorShape(res)
            assert.equal(res.headers.get('cache-control'), 'no-store')
            const anon = await s.request('POST', '/manie/admin/api/test', { raw: '{bad', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } })
            assert.equal(anon.status, 400)
            assert.equal(anon.headers.get('cache-control'), 'no-store')
            const big = await s.request('POST', '/manie/admin/api/test', {
                token: TOKEN,
                raw: JSON.stringify({ pattern: 'a', message: 'x', pad: 'y'.repeat(70 * 1024) }),
                headers: { 'Content-Type': 'application/json' },
            })
            assert.equal(big.status, 413)
            assertErrorShape(big)
        })
    })
})

describe('privacy fuzz', () => {
    it('never stores a digit, a character outside the allowed set or an out-of-vocabulary word, and never logs submissions', async () => {
        const captured = []
        const originals = {}
        for (const level of ['log', 'info', 'warn', 'error']) {
            originals[level] = console[level]
            console[level] = (...args) => captured.push(args.map(String).join(' '))
        }
        const canaries = ['Qwertyuiopasdf', 'Zxcvbnmlkjhg', 'Kamanzi', 'Uwimana', '0788123456', '250788123456', '5000', '12,500.50']
        let vocabulary = new Set()
        let storedDump = ''
        let shapes = []
        let outcomes = {}
        try {
            await withServer({ env: PROXY_ENV }, async (s) => {
                await seedVocab(s)
                vocabulary = new Set((await s.request('GET', '/manie/sms-formats')).json.vocabulary)
                const noiseWords = new Set(NOISE_WORDS)
                const known = [...vocabulary].filter((w) => w.length > 2 && !noiseWords.has(w) && !isNoiseSkeleton(`${w} {N} RWF`).noise)
                const rand = mulberry32(20261021)
                const pick = (list) => list[Math.floor(rand() * list.length)]
                const safeTokens = [
                    ...known.slice(0, 80),
                    '{N}', '{PH}', '{W+}', '{W}', '{TS}', '{TID}', '{URL}', '{EMAIL}',
                    'Qwertyuiopasdf', 'Zxcvbnmlkjhg', 'Kamanzi', 'Uwimana', 'Alice', 'Bob',
                    '.', ',', ':', '(', ')', '-', "'", '!', '%',
                ]
                const dangerousTokens = [
                    '0788123456', '250788123456', '5000', '12,500.50', '2026-04-11 14:30:55', 'ET123', 'A1B2',
                    '{BAD}', '{', '}', 'é', '日本', '\u0007', '😀', '<', '>', '$', '`', '\\', '|', '~', '^',
                    'https://pay.example.com/x?id=77', 'someone@example.com',
                ]
                const makeSkeleton = (dangerous) => {
                    const n = 1 + Math.floor(rand() * 14)
                    const parts = []
                    for (let i = 0; i < n; i++) {
                        parts.push(dangerous && rand() < 0.25 ? pick(dangerousTokens) : pick(safeTokens))
                    }
                    if (rand() < 0.85) parts.splice(Math.floor(rand() * (parts.length + 1)), 0, '{N}', 'RWF')
                    return parts.join(rand() < 0.8 ? ' ' : '')
                }
                outcomes = {}
                for (let i = 0; i < 400; i++) {
                    const count = 1 + Math.floor(rand() * 5)
                    const items = Array.from({ length: count }, () => itemOf(makeSkeleton(i % 2 === 0).slice(0, 400)))
                    const res = await s.submit(submission(items), { 'X-Forwarded-For': `10.${i >> 8}.${i & 255}.1` })
                    outcomes[res.status] = (outcomes[res.status] || 0) + 1
                    assert.ok([202, 400].includes(res.status), `unexpected ${res.status}: ${res.text.slice(0, 100)}`)
                    assertErrorShape(res.status === 400 ? res : { json: { error: 'x' }, text: '' })
                }
                for (let i = 0; i < 60; i++) {
                    const junk = String.fromCharCode(...Array.from({ length: 1 + Math.floor(rand() * 40) }, () => Math.floor(rand() * 0x2fff)))
                    const res = await s.submit(submission([itemOf(junk)]), { 'X-Forwarded-For': `11.0.${i}.1` })
                    assert.ok([202, 400].includes(res.status))
                }
                assert.ok(outcomes[202] > 20, `fuzz must exercise the accept path (${JSON.stringify(outcomes)})`)
                assert.ok(outcomes[400] > 20, `fuzz must exercise the reject path (${JSON.stringify(outcomes)})`)
                const snapshot = s.store.snapshot()
                storedDump = JSON.stringify(snapshot)
                shapes = snapshot
                    .filter((e) => e.key.startsWith('manie:shape:'))
                    .map((e) => JSON.parse(e.value.skeleton))
            })
        } finally {
            Object.assign(console, originals)
        }

        assert.ok(shapes.length > 10, `fuzz must have stored shapes to scan (${shapes.length}; ${JSON.stringify(outcomes)})`)
        for (const skeleton of shapes) {
            assert.ok(!/[0-9]/.test(skeleton), `digit in stored skeleton: ${skeleton}`)
            const stripped = skeleton.replace(/\{(?:N|PH|TS|TID|URL|EMAIL|W\+|W)\}/g, ' ')
            assert.ok(/^[A-Za-z .,:;()\-'\/!?%@#&*_=\[\]"+]*$/.test(stripped), `forbidden character in stored skeleton: ${skeleton}`)
            for (const word of stripped.match(/[A-Za-z][A-Za-z']*/g) || []) {
                assert.ok(vocabulary.has(word.toLowerCase()), `out-of-vocabulary word "${word}" in stored skeleton: ${skeleton}`)
            }
        }
        const lowerDump = storedDump.toLowerCase().replace(/[0-9a-f]{8,}/g, '#')
        for (const canary of canaries) {
            assert.ok(!lowerDump.includes(canary.toLowerCase()), `canary ${canary} reached storage`)
        }
        assert.ok(!/\b10\.\d+\.\d+\.1\b/.test(storedDump), 'raw IP reached storage')

        const output = captured.join('\n').toLowerCase()
        for (const canary of canaries) {
            assert.ok(!output.includes(canary.toLowerCase()), `canary ${canary} reached the logs`)
        }
        assert.ok(!output.includes(TOKEN.toLowerCase()))
    })
})
