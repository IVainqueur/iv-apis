const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { startServer, submission, TOKEN, MemoryStore } = require('./helpers')
const { shapeId: rawShapeId, canonicalSkeleton } = require('../../lib/manie/anonymize')
const { K, LIMITS, RATE_LIMITS } = require('../../routes/manie')
const { ipHash } = require('../../lib/manie/auth')
const { TID_REGEX } = require('../../lib/manie/_fields')

const shapeId = (skeleton, carrier = 'mtn') => rawShapeId(canonicalSkeleton(skeleton), carrier)
const SALT = 'hardening-salt-0123456789abcdef'
const PROXY_ENV = { MANIE_ADMIN_TOKEN: TOKEN, MANIE_TRUST_PROXY: '1', MANIE_HASH_SALT: SALT }
const NOVEL = 'Dear customer {N} RWF has been moved to {W+} ({PH}) on {TS}. Fee: {N} RWF. Balance: {N} RWF.'
const NOVEL_WORDS = ['moved']
const TRANSFER = 'You have transferred {N} RWF to {W+} ({PH}) on {TS}. Fee was {N} RWF. Your new balance: {N} RWF.'

async function withServer(options, fn) {
    const server = await startServer(options)
    try {
        await fn(server)
    } finally {
        await server.close()
    }
}

const item = (skeleton = NOVEL, extra = {}) => Object.assign({ skeleton, carrier: 'mtn' }, extra)
const ip = (n) => ({ 'X-Forwarded-For': `203.0.113.${n}` })

async function seedVocab(s) {
    assert.equal((await s.admin('POST', '/vocab', { add: NOVEL_WORDS })).status, 200)
}

async function pending(s) {
    const res = await s.admin('GET', '/pending?limit=100')
    assert.equal(res.status, 200, res.text)
    return res.json
}

class CountingStore extends MemoryStore {
    constructor() {
        super()
        this.log = []
    }

    async _run(args) {
        this.log.push(args[0])
        return super._run(args)
    }
}

class PersistentStore extends MemoryStore {
    constructor() {
        super()
        this.persistent = true
        this.kind = 'test-persistent'
    }
}

function latencyStore(ms, inner = new MemoryStore()) {
    return new Proxy(inner, {
        get(target, prop) {
            const value = target[prop]
            if (typeof value !== 'function') return value
            return async (...args) => {
                await new Promise((resolve) => setTimeout(resolve, ms))
                return value.apply(target, args)
            }
        },
    })
}

function failingOnce(match) {
    const inner = new MemoryStore()
    const state = { armed: false, fired: 0 }
    const store = new Proxy(inner, {
        get(target, prop) {
            const value = target[prop]
            if (typeof value !== 'function') return value
            return (...args) => {
                if (state.armed && match(String(prop), args)) {
                    state.armed = false
                    state.fired++
                    return Promise.reject(new Error('store down'))
                }
                return value.apply(target, args)
            }
        },
    })
    return { store, state }
}

function quiet(fn) {
    return async (...args) => {
        const original = console.error
        console.error = () => {}
        try {
            return await fn(...args)
        } finally {
            console.error = original
        }
    }
}

describe('KV cost of public and rejected traffic (R1-03)', () => {
    it('serves cache-busted config requests from memory after the first load', async () => {
        const store = new CountingStore()
        await withServer({ store, servedTtlMs: 30000 }, async (s) => {
            assert.equal((await s.request('GET', '/manie/sms-formats')).status, 200)
            const afterFirst = store.log.length
            assert.ok(afterFirst <= 4, `first load used ${afterFirst} commands`)
            for (let i = 0; i < 20; i++) {
                const res = await s.request('GET', `/manie/sms-formats?cb=${i}`)
                assert.equal(res.status, 200)
            }
            assert.equal(store.log.length, afterFirst, '20 cache-busted GETs must not touch KV')
        })
    })

    it('a caller who exhausted the submission budget costs no KV commands afterwards', async () => {
        const store = new CountingStore()
        await withServer({ env: PROXY_ENV, store, servedTtlMs: 30000 }, async (s) => {
            await seedVocab(s)
            const batch = submission(Array.from({ length: LIMITS.maxItems }, () => item()))
            for (let i = 0; i < RATE_LIMITS.perIpPerHour / LIMITS.maxItems; i++) assert.equal((await s.submit(batch, ip(7))).status, 202, `batch ${i}`)
            const limited = await s.submit(submission([item()]), ip(7))
            assert.equal(limited.status, 429)
            const before = store.log.length
            for (let i = 0; i < 25; i++) {
                const res = await s.submit(submission([item()]), ip(7))
                assert.equal(res.status, 429)
                assert.ok(Number(res.headers.get('retry-after')) > 0)
            }
            assert.equal(store.log.length, before, 'blocked callers must be refused from memory')
            assert.equal((await s.submit(submission([item()]), ip(8))).status, 202, 'other callers are unaffected')
        })
    })

    it('a budget that still has room is not turned into a lock by one oversized request', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const hash = ipHash({ headers: { 'x-forwarded-for': '203.0.113.9' }, socket: {} }, PROXY_ENV)
            await s.store.incr(K.rlHour(hash), { ex: 3600, by: RATE_LIMITS.perIpPerHour - 20 })
            assert.equal((await s.submit(submission(Array.from({ length: 10 }, () => item())), ip(9))).status, 202)
            const tooBig = await s.submit(submission(Array.from({ length: 20 }, () => item())), ip(9))
            assert.equal(tooBig.status, 429, '10 left, 20 asked for')
            const small = await s.submit(submission(Array.from({ length: LIMITS.maxItems - 10 }, () => item())), ip(9))
            assert.equal(small.status, 202, 'the 10 items that are left are still usable')
            assert.equal((await s.submit(submission([item()]), ip(9))).status, 429, 'now the budget is gone')
        })
    })

    it('a bad-token flood stops costing KV commands once the caller is locked out', async () => {
        const store = new CountingStore()
        await withServer({ env: PROXY_ENV, store }, async (s) => {
            for (let i = 0; i < 60; i++) {
                await s.request('GET', '/manie/admin/api/stats', { token: `wrong-token-${i}-xxxxxxxxxxxxxxxxxxxx`, headers: ip(20) })
            }
            const before = store.log.length
            for (let i = 0; i < 30; i++) {
                const res = await s.request('GET', '/manie/admin/api/stats', { token: `still-wrong-${i}-xxxxxxxxxxxxxxxxxxx`, headers: ip(20) })
                assert.equal(res.status, 429)
            }
            assert.equal(store.log.length, before)
        })
    })
})

describe('pending queue abuse (R1-05, REL-04)', () => {
    it('case variants of one skeleton are one shape', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const variants = [NOVEL, NOVEL.toUpperCase(), NOVEL.replace('Dear customer', 'DEAR Customer').replace('RWF', 'rwf')]
            for (let i = 0; i < variants.length; i++) assert.equal((await s.submit(submission([item(variants[i])]), ip(30 + i))).status, 202)
            const { shapes, total } = await pending(s)
            assert.equal(total, 1)
            assert.equal(shapes[0].skeleton, canonicalSkeleton(NOVEL))
            assert.equal(shapes[0].voters, 3)
        })
    })

    it('one source can open at most RATE_LIMITS.newShapesPerIpPerDay new shapes a day, and the rest are reported as discarded, not accepted', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const cap = RATE_LIMITS.newShapesPerIpPerDay
            const items = Array.from({ length: cap + 2 }, (_, i) => item(`${NOVEL}${'!'.repeat(i + 1)}`))
            const totals = { accepted: 0, deduped: 0, discarded: 0 }
            for (let from = 0; from < items.length; from += LIMITS.maxItems) {
                const res = await s.submit(submission(items.slice(from, from + LIMITS.maxItems)), ip(40))
                assert.equal(res.status, 202, res.text)
                assert.deepEqual(Object.keys(res.json).sort(), ['accepted', 'deduped', 'discarded'])
                for (const key of Object.keys(totals)) totals[key] += res.json[key]
            }
            assert.deepEqual(totals, { accepted: cap, deduped: 0, discarded: 2 }, 'the two items over the allowance were not stored and are not counted as accepted')
            assert.equal((await pending(s)).total, cap)
            const again = await s.submit(submission([item(`${NOVEL}${'?'.repeat(3)}`)]), ip(40))
            assert.deepEqual(again.json, { accepted: 0, deduped: 0, discarded: 1 }, 'the daily allowance is spent')
            assert.deepEqual((await s.submit(submission([item(`${NOVEL}${'?'.repeat(3)}`)]), ip(41))).json, { accepted: 1, deduped: 0, discarded: 0 }, 'a different source can still open it')
            const known = await s.submit(submission([item(`${NOVEL}!`)]), ip(40))
            assert.deepEqual(known.json, { accepted: 1, deduped: 1, discarded: 0 }, 'a shape that already exists can still be reported by a source over its allowance')
        })
    })

    it('ranks by distinct sources, not by the count a device declares', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const loud = `${NOVEL}!`
            const quiet = `${NOVEL}?`
            assert.equal((await s.submit(submission([item(loud, { count: 50 })]), ip(50))).status, 202)
            for (const n of [51, 52, 53]) assert.equal((await s.submit(submission([item(quiet, { count: 1 })]), ip(n))).status, 202)
            const { shapes } = await pending(s)
            assert.deepEqual(shapes.map((x) => x.shapeId), [shapeId(quiet), shapeId(loud)])
            assert.deepEqual(shapes.map((x) => x.count), [3, 1])
        })
    })

    it('the same source counts once per shape per day, whatever it sends', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            for (let i = 0; i < 4; i++) await s.submit(submission([item(NOVEL, { count: 50, hints: [{ slot: 1, role: 'amount' }] })]), ip(60))
            const shape = (await pending(s)).shapes[0]
            assert.equal(shape.count, 1)
            assert.equal(shape.voters, 1)
            assert.deepEqual(shape.hintVotes, { 1: { amount: 1 } })
        })
    })

    it('a full queue still takes a new shape by evicting the oldest, lowest-ranked one, and reports it', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            for (let i = 0; i < LIMITS.maxPending; i++) await s.store.zadd(K.pending, 2 + i / 1e9 + 0.0178, `f${String(i).padStart(15, '0')}`)
            const res = await s.submit(submission([item()]), ip(70))
            assert.deepEqual(res.json, { accepted: 1, deduped: 0, discarded: 0 })
            assert.equal(await s.store.zcard(K.pending), LIMITS.maxPending)
            assert.ok(await s.store.hgetall(K.shape(shapeId(NOVEL))), 'the new shape exists')
            assert.equal(await s.store.zscore(K.pending, `f${'0'.repeat(15)}`), null, 'the oldest lowest-ranked entry was evicted')
            assert.equal((await s.admin('GET', '/stats')).json.evicted, 1)
        })
    })

    it('shapes backed by several sources are never evicted by newcomers, which are reported as dropped', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            for (let i = 0; i < LIMITS.maxPending; i++) await s.store.zadd(K.pending, 6.0178, `e${String(i).padStart(15, '0')}`)
            const res = await s.submit(submission([item()]), ip(80))
            assert.deepEqual(res.json, { accepted: 0, deduped: 0, discarded: 1 }, 'a dropped shape is neither created nor accepted')
            assert.equal(await s.store.zcard(K.pending), LIMITS.maxPending)
            assert.equal(await s.store.hgetall(K.shape(shapeId(NOVEL))), null)
            assert.equal(await s.store.zscore(K.pending, `e${'0'.repeat(15)}`), 6.0178)
            assert.equal((await s.admin('GET', '/stats')).json.evicted, 1)
        })
    })

    it('strips CORS headers from submissions even behind a host that applies cors() globally', async () => {
        await withServer({ cors: true, env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const res = await s.request('POST', '/manie/submissions', {
                body: submission([item()]),
                headers: { Origin: 'https://evil.example', ...ip(90) },
            })
            assert.equal(res.status, 202)
            assert.equal(res.headers.get('access-control-allow-origin'), null)
        })
    })
})

describe('unsafe configuration fails closed (R1-09, REL-05, OPS-1, PRIV-4)', () => {
    const PROD = { VERCEL: '1', NODE_ENV: 'production', MANIE_ADMIN_TOKEN: TOKEN, MANIE_HASH_SALT: SALT, MANIE_TRUST_PROXY: '0' }

    it('production on an in-memory store refuses submissions and admin writes, and says so', async () => {
        await quiet(() =>
            withServer({ env: PROD }, async (s) => {
                const sub = await s.submit(submission([item()]))
                assert.equal(sub.status, 503)
                assert.equal(sub.json.error, 'storage_not_configured')
                for (const [path, body] of [
                    ['/shape/0123456789abcdef/approve', { draft: {} }],
                    ['/shape/0123456789abcdef/reject', {}],
                    ['/shape/0123456789abcdef/reopen', {}],
                    ['/approved/mtn-token-payment-v1/disable', {}],
                    ['/approved/mtn-token-payment-v1/enable', {}],
                    ['/vocab', { add: ['remitted'] }],
                ]) {
                    const res = await s.admin('POST', path, body)
                    assert.equal(res.status, 503, path)
                    assert.equal(res.json.error, 'storage_not_configured', path)
                }
                assert.equal(await s.store.scard(K.vocab), 0, 'nothing was written')
                const stats = await s.admin('GET', '/stats')
                assert.equal(stats.status, 200)
                assert.equal(stats.json.storage.persistent, false)
                assert.equal(stats.json.storage.ready, false)
                const config = await s.request('GET', '/manie/sms-formats')
                assert.equal(config.status, 503, 'a base-only config is a 200 that devices apply as the truth, so production without a store refuses')
                assert.equal(config.headers.get('x-manie-degraded'), 'storage')
                assert.equal(config.headers.get('cache-control'), 'no-store')
                assert.ok(Number(config.headers.get('retry-after')) > 0)
                assert.equal(config.json.patterns, undefined)
            })
        )()
    })

    it('a persistent store without a hash salt disables submissions but not the admin', async () => {
        await quiet(() =>
            withServer({ env: { ...PROD, MANIE_HASH_SALT: undefined }, store: new PersistentStore() }, async (s) => {
                const sub = await s.submit(submission([item()]))
                assert.equal(sub.status, 503)
                assert.equal(sub.json.error, 'hash_salt_not_configured')
                assert.equal((await s.admin('GET', '/stats')).status, 200)
                assert.equal((await s.admin('POST', '/vocab', { add: ['remitted'] })).status, 200)
            })
        )()
    })

    it('production with a persistent store and a salt works normally', async () => {
        await withServer({ env: PROD, store: new PersistentStore() }, async (s) => {
            assert.equal((await s.admin('POST', '/vocab', { add: NOVEL_WORDS })).status, 200)
            assert.equal((await s.submit(submission([item()]))).status, 202)
            assert.equal((await s.admin('GET', '/stats')).json.storage.persistent, true)
        })
    })

    it('outside production the in-memory store and the per-process salt keep working', async () => {
        await withServer({ env: { MANIE_ADMIN_TOKEN: TOKEN } }, async (s) => {
            await seedVocab(s)
            assert.equal((await s.submit(submission([item()]))).status, 202)
            const keys = s.store.snapshot().map((e) => e.key)
            assert.ok(keys.some((k) => /^manie:rl:sub:h:[0-9a-f]{32}$/.test(k)))
        })
    })
})

describe('storage latency and outages (REL-06)', () => {
    class HangingStore extends MemoryStore {
        async _run() {
            return new Promise(() => {})
        }
    }

    it('a hanging KV answers 503 quickly and then fails fast instead of stacking timeouts', async () => {
        await quiet(() =>
            withServer({ store: new HangingStore(), guard: { callTimeoutMs: 40, openMs: 60000 } }, async (s) => {
                const started = Date.now()
                const first = await s.submit(submission([item()]))
                assert.equal(first.status, 503)
                assert.ok(Date.now() - started < 1500, `first failure took ${Date.now() - started} ms`)
                const second = Date.now()
                const results = await Promise.all([s.submit(submission([item()])), s.request('GET', '/manie/sms-formats'), s.admin('GET', '/stats')])
                assert.deepEqual(results.map((r) => r.status), [503, 503, 503])
                assert.ok(Date.now() - second < 300, `the open circuit must answer at once, took ${Date.now() - second} ms`)
            })
        )()
    })

    it('a slow KV cannot hold a request past its deadline', async () => {
        await quiet(() =>
            withServer({ store: latencyStore(120), guard: { callTimeoutMs: 1000 }, publicBudgetMs: 300 }, async (s) => {
                const started = Date.now()
                const res = await s.submit(submission([item()]))
                assert.equal(res.status, 503)
                assert.ok(Date.now() - started < 1200, `request took ${Date.now() - started} ms`)
            })
        )()
    })

    it('processes the items of one batch in parallel', async () => {
        await withServer({ env: PROXY_ENV, store: latencyStore(40) }, async (s) => {
            await seedVocab(s)
            const items = Array.from({ length: 20 }, (_, i) => item(`${NOVEL}${'!'.repeat(i + 1)}`))
            const started = Date.now()
            const res = await s.submit(submission(items), ip(100))
            const elapsed = Date.now() - started
            assert.equal(res.status, 202)
            assert.ok(elapsed < 1500, `20 items took ${elapsed} ms (sequential processing needs more than 2.4 s)`)
        })
    })
})

describe('concurrent updates are not lost (REL-07)', () => {
    it('20 simultaneous sources produce 20 sightings, 20 voters and 20 hint votes', async () => {
        await withServer({ env: PROXY_ENV, store: latencyStore(3) }, async (s) => {
            await seedVocab(s)
            const results = await Promise.all(
                Array.from({ length: 20 }, (_, i) => s.submit(submission([item(NOVEL, { hints: [{ slot: 1, role: 'amount' }] })]), ip(110 + i)))
            )
            for (const res of results) assert.equal(res.status, 202, res.text)
            assert.equal(results.filter((r) => r.json.deduped === 0).length, 1, 'exactly one request created the shape')
            const shape = (await pending(s)).shapes[0]
            assert.equal(shape.count, 20)
            assert.equal(shape.voters, 20)
            assert.deepEqual(shape.hintVotes, { 1: { amount: 20 } })
            assert.equal(Object.values(shape.perDayCounts).reduce((a, b) => a + b, 0), 20)
            assert.equal((await s.admin('GET', '/stats')).json.submissions24h, 20)
            assert.equal(await s.store.zscore(K.pending, shapeId(NOVEL)) >= 20, true, 'the queue score follows the voters')
        })
    })
})

describe('approve is resumable and race-safe (REL-03)', () => {
    async function drafted(s) {
        await seedVocab(s)
        await s.submit(submission([item()]), ip(120))
        const id = shapeId(NOVEL)
        const redraft = await s.admin('POST', `/shape/${id}/redraft`, { type: 'transfer' })
        assert.equal(redraft.status, 200, redraft.text)
        assert.equal(redraft.json.gate.ok, true, JSON.stringify(redraft.json.gate.checks.filter((c) => !c.ok)))
        return { id, draft: redraft.json.draft }
    }

    it('a failure after the pattern was written leaves a resumable approval, and a retry finishes it', async () => {
        const { store, state } = failingOnce((method, args) => method === 'hset' && args[1] && args[1].status === 'approved')
        await quiet(() =>
            withServer({ env: PROXY_ENV, store }, async (s) => {
                const { id, draft } = await drafted(s)
                state.armed = true
                const first = await s.admin('POST', `/shape/${id}/approve`, { draft })
                assert.equal(first.status, 503)
                assert.equal(state.fired, 1)
                const served = (await s.request('GET', '/manie/sms-formats')).json
                const live = served.patterns.filter((p) => p.id.startsWith('auto-'))
                assert.equal(live.length, 1, 'the pattern was written before the failure')
                const view = (await s.admin('GET', `/shape/${id}`)).json.shape
                assert.equal(view.status, 'approving')
                assert.equal((await pending(s)).total, 1, 'the shape stays in the queue so that it can be retried')

                const retry = await s.admin('POST', `/shape/${id}/approve`, { draft })
                assert.equal(retry.status, 200, retry.text)
                assert.equal(retry.json.id, live[0].id)
                assert.equal((await s.admin('GET', '/approved')).json.approved.length, 1)
                assert.equal((await s.admin('GET', `/shape/${id}`)).json.shape.status, 'approved')
                assert.equal((await pending(s)).total, 0)
                assert.equal((await s.admin('GET', '/stats')).json.approved, 1)
            })
        )()
    })

    it('rejecting a half-approved shape takes its pattern out of service', async () => {
        const { store, state } = failingOnce((method, args) => method === 'hset' && args[1] && args[1].status === 'approved')
        await quiet(() =>
            withServer({ env: PROXY_ENV, store }, async (s) => {
                const { id, draft } = await drafted(s)
                state.armed = true
                assert.equal((await s.admin('POST', `/shape/${id}/approve`, { draft })).status, 503)
                assert.equal((await s.request('GET', '/manie/sms-formats')).json.patterns.filter((p) => p.id.startsWith('auto-')).length, 1)
                const rejected = await s.admin('POST', `/shape/${id}/reject`, { reason: 'changed my mind' })
                assert.equal(rejected.status, 200)
                assert.equal((await s.request('GET', '/manie/sms-formats')).json.patterns.filter((p) => p.id.startsWith('auto-')).length, 0)
                const view = (await s.admin('GET', `/shape/${id}`)).json.shape
                assert.equal(view.status, 'rejected')
            })
        )()
    })

    it('two simultaneous approvals of one shape with different ids publish exactly one pattern', async () => {
        await withServer({ env: PROXY_ENV, store: latencyStore(4) }, async (s) => {
            const { id, draft } = await drafted(s)
            const results = await Promise.all([
                s.admin('POST', `/shape/${id}/approve`, { draft: { ...draft, id: 'auto-tab-one' } }),
                s.admin('POST', `/shape/${id}/approve`, { draft: { ...draft, id: 'auto-tab-two' } }),
            ])
            assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
            const loser = results.find((r) => r.status === 409)
            assert.ok(['approve_in_progress', 'already_approved'].includes(loser.json.error), loser.text)
            const approved = (await s.admin('GET', '/approved')).json.approved
            assert.equal(approved.length, 1)
            assert.equal((await s.request('GET', '/manie/sms-formats')).json.patterns.filter((p) => p.id.startsWith('auto-')).length, 1)
        })
    })

    it('a second approval with the same id but a different draft is refused, never an overwrite', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            const { id, draft } = await drafted(s)
            assert.equal((await s.admin('POST', `/shape/${id}/approve`, { draft: { ...draft, id: 'auto-shared-one' } })).status, 200)
            const other = NOVEL.replace('Dear customer', 'Thank customer')
            assert.equal((await s.submit(submission([item(other)]), ip(121))).json.deduped, 0)
            const clash = await s.admin('POST', `/shape/${shapeId(other)}/approve`, { draft: { ...draft, id: 'auto-shared-one', pattern: `${draft.pattern}.*` } })
            assert.equal(clash.status, 409)
            assert.equal(clash.json.error, 'id_conflict')
            const served = (await s.request('GET', '/manie/sms-formats')).json.patterns.find((p) => p.id === 'auto-shared-one')
            assert.equal(served.pattern, draft.pattern)
        })
    })
})

describe('a wrongly approved shape can be corrected (REL-09)', () => {
    it('disable, reopen, redraft and approve again under a new id', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            await s.submit(submission([item()]), ip(130))
            const id = shapeId(NOVEL)
            const draft1 = (await s.admin('POST', `/shape/${id}/redraft`, { type: 'transfer' })).json.draft
            const first = await s.admin('POST', `/shape/${id}/approve`, { draft: draft1 })
            assert.equal(first.status, 200)
            const firstId = first.json.id

            assert.equal((await s.admin('POST', `/shape/${id}/reopen`)).json.error, 'pattern_live', 'a live pattern must be disabled first')
            assert.equal((await s.admin('POST', `/approved/${firstId}/disable`)).status, 200)
            assert.equal((await s.admin('POST', `/shape/${id}/approve`, { draft: draft1 })).status, 409, 'approving is still not possible before reopening')

            const reopened = await s.admin('POST', `/shape/${id}/reopen`)
            assert.equal(reopened.status, 200, reopened.text)
            assert.equal(reopened.json.revision, 2)
            assert.equal((await pending(s)).total, 1)
            assert.equal((await s.admin('POST', `/shape/${id}/reopen`)).json.error, 'already_pending')
            assert.equal((await s.admin('GET', '/stats')).json.approved, 0)

            const redraft = await s.admin('POST', `/shape/${id}/redraft`, { type: 'receive' })
            assert.equal(redraft.status, 200)
            assert.match(redraft.json.draft.id, /-r2$/, 'the new draft cannot collide with the disabled pattern')
            const second = await s.admin('POST', `/shape/${id}/approve`, { draft: redraft.json.draft })
            assert.equal(second.status, 200, second.text)
            assert.notEqual(second.json.id, firstId)
            const served = (await s.request('GET', '/manie/sms-formats')).json.patterns
            assert.ok(served.some((p) => p.id === second.json.id))
            assert.ok(!served.some((p) => p.id === firstId), 'the disabled pattern stays disabled')
            const view = (await s.admin('GET', `/shape/${id}`)).json.shape
            assert.deepEqual(view.previousApprovedIds, [firstId])
        })
    })

    it('a rejected shape can be reopened too, and a missing shape is a 404', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            await s.submit(submission([item()]), ip(131))
            const id = shapeId(NOVEL)
            await s.admin('POST', `/shape/${id}/reject`, { reason: 'wrong' })
            assert.equal((await s.admin('POST', `/shape/${id}/reopen`)).status, 200)
            assert.equal((await pending(s)).total, 1)
            assert.equal((await s.admin('POST', `/shape/${'0'.repeat(16)}/reopen`)).status, 404)
        })
    })
})

describe('cached drafts follow the code that produced them (REL-11)', () => {
    it('a cached draft and gate written by other code are rebuilt on the next listing', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            await s.submit(submission([item()]), ip(140))
            const id = shapeId(NOVEL)
            const fresh = (await pending(s)).shapes[0]
            const stale = JSON.parse(JSON.stringify(fresh.draft))
            delete stale.captureMap.balance
            const staleGate = { ok: true, checks: fresh.gate.checks.map((c) => ({ ...c, ok: true })) }
            const key = K.shape(id)
            const current = (await s.store.hgetall(key)).gateHash
            assert.match(current, /^[0-9a-f]{64}:[0-9a-f]{8}$/, 'the cache key carries the code version')
            await s.store.hset(key, { draft: stale, gate: staleGate, gateHash: current.replace(/:[0-9a-f]{8}$/, ':deadbeef'), draftCode: 'deadbeef' })
            const listed = (await pending(s)).shapes[0]
            assert.ok(listed.draft.captureMap.balance, 'the draft was regenerated')
            assert.equal(listed.gate.ok, fresh.gate.ok)
            assert.deepEqual(listed.gate.checks.map((c) => c.ok), fresh.gate.checks.map((c) => c.ok))
            const detail = (await s.admin('GET', `/shape/${id}`)).json.shape
            assert.ok(detail.draft.captureMap.balance)
        })
    })
})

describe('the vocabulary endpoint (REL-12, PRIV-1)', () => {
    it('keeps the served vocabulary current even when the change timestamp cannot be written', async () => {
        const { store, state } = failingOnce((method, args) => method === 'set' && args[0] === 'manie:served:changedAt')
        await quiet(() =>
            withServer({ store }, async (s) => {
                const before = (await s.request('GET', '/manie/sms-formats')).json
                state.armed = true
                const res = await s.admin('POST', '/vocab', { add: ['remitted'] })
                assert.equal(res.status, 200, res.text)
                assert.equal(state.fired, 1)
                const after = (await s.request('GET', '/manie/sms-formats')).json
                assert.ok(after.vocabulary.includes('remitted'))
                assert.notEqual(after.version, before.version)
            })
        )()
    })

    it('refuses given names and spelled-out digits unless forced', async () => {
        await withServer({}, async (s) => {
            for (const word of ['grace', 'Joy', 'WILL', 'neza', 'one']) {
                const res = await s.admin('POST', '/vocab', { add: [word] })
                assert.equal(res.status, 409, word)
                assert.equal(res.json.error, 'restricted_word')
                assert.deepEqual(res.json.words, [word.toLowerCase()])
            }
            assert.deepEqual((await s.admin('GET', '/vocab')).json.words, [])
            assert.ok(!(await s.request('GET', '/manie/sms-formats')).json.vocabulary.includes('grace'))
            const mixed = await s.admin('POST', '/vocab', { add: ['remitted', 'grace'] })
            assert.equal(mixed.status, 409, 'one restricted word refuses the whole request')
            assert.deepEqual((await s.admin('GET', '/vocab')).json.words, [])
            const forced = await s.admin('POST', '/vocab', { add: ['grace'], force: true })
            assert.equal(forced.status, 200)
            assert.deepEqual(forced.json.words, ['grace'])
            assert.equal((await s.admin('POST', '/vocab', { add: ['remitted'], force: 'yes' })).status, 400)
            assert.equal((await s.admin('POST', '/vocab', { remove: ['grace'] })).status, 200, 'removing never needs force')
        })
    })
})

describe('free text in submissions is held to the same standard as skeletons (PRIV-3)', () => {
    const post = (s, app, extra = {}) =>
        s.submit({ v: 1, items: [item(NOVEL, extra)], app })

    it('rejects names, numbers and phone-like digits in app.version', async () => {
        await withServer({}, async (s) => {
            await seedVocab(s)
            for (const version of ['Alice Uwase 0788123456', '078.812.345', '0788123456', '12.34.56+7890123', 'x'.repeat(33), '1.0.4-beta', '1', '1.0.4 (33', '']) {
                const res = await post(s, { version, platform: 'android' })
                assert.equal(res.status, 400, JSON.stringify(version))
            }
            assert.equal((await pending(s)).total, 0)
            for (const version of ['1.0.4', '0.0.33', '12.34.567', '1.0.4 (33)', '1.0.4+33', '1.2.3.4']) {
                assert.equal((await post(s, { version, platform: 'ios' }, { skeleton: `${NOVEL}${'!'.repeat(version.length)}` })).status, 202, version)
            }
        })
    })

    it('accepts only real locales', async () => {
        await withServer({}, async (s) => {
            await seedVocab(s)
            const app = { version: '1.0.4', platform: 'android' }
            for (const locale of ['uwa-Mana', 'Alice', 'en-RWAN', 'en_RW', 'xx', 'en-R', 'rw-RW-x']) {
                assert.equal((await post(s, app, { locale })).status, 400, locale)
            }
            let i = 0
            for (const locale of ['en', 'rw', 'fr', 'sw', 'en-RW', 'rw-RW', 'fr-rw']) {
                i += 1
                assert.equal((await post(s, app, { locale, skeleton: `${NOVEL}${'!'.repeat(i)}` })).status, 202, locale)
            }
        })
    })
})

describe('device hint numbering follows the server-side rewrite (HINT-1)', () => {
    it('hints are renumbered when the server rewrites a word the device knew, and dropped when their slot merged', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            const skeleton = 'Paid {N} RWF at shop {N} fee {N} RWF balance {N} RWF'
            const res = await s.submit(
                submission([
                    item(skeleton, { hints: [{ slot: 1, role: 'amount' }, { slot: 3, role: 'fee' }, { slot: 4, role: 'balance' }] }),
                ]),
                ip(150)
            )
            assert.equal(res.status, 202)
            const shape = (await pending(s)).shapes[0]
            assert.equal(shape.skeleton, 'paid {N} rwf at {W} {N} fee {N} rwf balance {N} rwf')
            assert.deepEqual(shape.hintVotes, { 1: { amount: 1 }, 4: { fee: 1 }, 5: { balance: 1 } })

            const merged = await s.submit(
                submission([item('Paid {N} RWF at {W} shop {N} RWF', { hints: [{ slot: 2, role: 'secondParty' }, { slot: 3, role: 'balance' }] })]),
                ip(151)
            )
            assert.equal(merged.status, 202)
            const second = (await pending(s)).shapes.find((x) => x.skeleton === 'paid {N} rwf at {W+} {N} rwf')
            assert.deepEqual(second.hintVotes, { 3: { balance: 1 } }, 'the merged {W+} slot lost its hint, the number after it was renumbered')
        })
    })
})

describe('hints are advisory (R1-02, R1-SERVED-6)', () => {
    const RECEIVE = 'You have received {N} RWF from {W+} at {TS} Balance: {N} RWF'

    it('five items with swapped hints in one request count as one vote and cannot swap the roles', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await seedVocab(s)
            const honest = [{ slot: 1, role: 'amount' }, { slot: 3, role: 'balance' }]
            const swapped = [{ slot: 1, role: 'balance' }, { slot: 3, role: 'amount' }]
            assert.equal((await s.submit(submission([item(RECEIVE, { hints: honest })]), ip(160))).status, 202)
            const attack = await s.submit(submission(Array.from({ length: 5 }, () => item(RECEIVE, { hints: swapped }))), ip(161))
            assert.deepEqual(attack.json, { accepted: 5, deduped: 5, discarded: 0 })
            const shape = (await pending(s)).shapes[0]
            assert.deepEqual(shape.hintVotes, { 1: { amount: 1, balance: 1 }, 3: { balance: 1, amount: 1 } })
            const { layout } = { layout: require('../../lib/manie/_fields').layoutOf(canonicalSkeleton(RECEIVE)) }
            const group = (n) => layout.slots.find((x) => x.slotNo === n).group
            assert.equal(shape.draft.captureMap.balance, group(3), 'the text says "Balance:" right before slot 3')
            assert.equal(shape.draft.captureMap.amount, group(1))
            assert.ok(shape.gate.checks.find((c) => c.name === 'role-keywords').ok)
        })
    })

    it('three sources voting for swapped roles still give the amount that the text announces', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            const swapped = [{ slot: 1, role: 'balance' }, { slot: 5, role: 'amount' }]
            for (const n of [170, 171, 172]) assert.equal((await s.submit(submission([item(TRANSFER, { hints: swapped })]), ip(n))).status, 202)
            const shape = (await pending(s)).shapes[0]
            assert.equal(shape.hintVotes[1].balance, 3)
            assert.equal(shape.draft.type, 'transfer')
            const approve = await s.admin('POST', `/shape/${shape.shapeId}/approve`, { draft: shape.draft })
            assert.equal(approve.status, 200, approve.text)
            const served = (await s.request('GET', '/manie/sms-formats')).json.patterns.find((p) => p.id === approve.json.id)
            const probe = await s.admin('POST', '/test', {
                pattern: served.pattern,
                flags: served.flags,
                captureMap: served.captureMap,
                timestamp: served.timestamp,
                message: 'You have transferred 5,000 RWF to Alice Bob (250780000001) on 2026-04-11 14:30:05. Fee was 100 RWF. Your new balance: 12,000 RWF.',
            })
            assert.equal(probe.json.matched, true)
            assert.equal(probe.json.fields.amount, 5000)
            assert.equal(probe.json.fields.balance, 12000)
        })
    })
})

describe('approvable drafts cannot classify reversed notices as payments (R1-SERVED-1)', () => {
    const STATUS = 'Your payment of {N} RWF to {W+} has been {W}. Fee was {N} RWF. Your new balance: {N} RWF. {TS}'

    it('an unknown status word blocks approval until it is made literal, and the reversed notice stays unmatched', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            await s.submit(submission([item(STATUS)]), ip(180))
            const id = shapeId(STATUS)
            const listed = (await pending(s)).shapes[0]
            assert.equal(listed.gate.ok, false)
            assert.equal(listed.gate.checks.find((c) => c.name === 'word-slots').ok, false)
            const blocked = await s.admin('POST', `/shape/${id}/approve`, { draft: { ...listed.draft, type: 'payment' } })
            assert.equal(blocked.status, 422)
            assert.equal(blocked.json.error, 'gate_failed')

            const redraft = await s.admin('POST', `/shape/${id}/redraft`, { type: 'payment', wordsAsLiteral: ['2: authorised'] })
            assert.equal(redraft.status, 200, redraft.text)
            assert.equal(redraft.json.gate.ok, true, JSON.stringify(redraft.json.gate.checks.filter((c) => !c.ok)))
            const approve = await s.admin('POST', `/shape/${id}/approve`, { draft: redraft.json.draft })
            assert.equal(approve.status, 200, approve.text)
            const served = (await s.request('GET', '/manie/sms-formats')).json.patterns.find((p) => p.id === approve.json.id)
            const run = (message) =>
                s.admin('POST', '/test', { pattern: served.pattern, flags: served.flags, captureMap: served.captureMap, timestamp: served.timestamp, message })
            const good = 'Your payment of 5,000 RWF to ACME SHOP has been authorised. Fee was 0 RWF. Your new balance: 12,000 RWF. 2026-04-11 14:30:05'
            assert.equal((await run(good)).json.matched, true)
            assert.equal((await run(good.replace('authorised', 'reversed'))).json.matched, false)
        })
    })

    it('reversal, denial and failure-marker notices never enter the queue', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            const notices = [
                'Your payment of {N} RWF to {W+} has been reversed. Fee was {N} RWF. Your new balance: {N} RWF. {TS}',
                'Your request to transfer {N} RWF to {W+} ({PH}) was denied',
                '*{N}*TID {TID}*F* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#',
                'Use code {N} to confirm payment of {N} RWF to {W+}. Your new balance: {N} RWF',
            ]
            const res = await s.submit(submission(notices.map((n) => item(n))), ip(181))
            assert.equal(res.status, 202)
            assert.deepEqual(res.json, { accepted: 0, deduped: 0, discarded: 4 })
            assert.equal((await pending(s)).total, 0)
        })
    })
})

describe('Airtel drafts need no operator switch: one full-TID group is both transaction id and timestamp (R1-SERVED-2, option B)', () => {
    const AIRTEL = '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#'

    async function airtelDraft(s) {
        await s.submit(submission([{ skeleton: AIRTEL, carrier: 'airtel' }]), ip(190))
        const id = shapeId(AIRTEL, 'airtel')
        const redraft = await s.admin('POST', `/shape/${id}/redraft`, { type: 'transfer' })
        return { id, redraft }
    }

    it('passes the gate and is approved with no environment switch, and the served pattern shares one group', async () => {
        await withServer({ env: { MANIE_ADMIN_TOKEN: TOKEN, MANIE_TRUST_PROXY: '1' } }, async (s) => {
            const { id, redraft } = await airtelDraft(s)
            assert.equal(redraft.status, 200)
            assert.equal(redraft.json.gate.ok, true, JSON.stringify(redraft.json.gate.checks.filter((c) => !c.ok)))
            assert.equal(redraft.json.draft.timestamp.group, redraft.json.draft.captureMap.transactionId)
            const approve = await s.admin('POST', `/shape/${id}/approve`, { draft: redraft.json.draft })
            assert.equal(approve.status, 200, approve.text)
            const served = (await s.request('GET', '/manie/sms-formats')).json.patterns.find((p) => p.id === approve.json.id)
            assert.equal(served.timestamp.parser, 'airtel-shortcode')
            assert.equal(served.timestamp.group, served.captureMap.transactionId)
            const stats = (await s.admin('GET', '/stats')).json
            assert.equal('airtelShortcode' in stats, false, 'the switch and its stats field are gone')
        })
    })

    it('a nested-group draft (timestamp on an inner prefix-less group) is refused: released builds would read it as an invalid date', async () => {
        await withServer({ env: { MANIE_ADMIN_TOKEN: TOKEN, MANIE_TRUST_PROXY: '1' } }, async (s) => {
            const { id, redraft } = await airtelDraft(s)
            const draft = redraft.json.draft
            const tidGroup = draft.captureMap.transactionId
            const nested = draft.pattern.replace(TID_REGEX, '([A-Za-z]{2}(\\d+\\.\\d+)\\.[A-Za-z]\\d+)')
            assert.notEqual(nested, draft.pattern)
            const shift = (n) => (n > tidGroup ? n + 1 : n)
            const captureMap = Object.fromEntries(Object.entries(draft.captureMap).map(([k, v]) => [k, shift(v)]))
            const attempt = { ...draft, pattern: nested, captureMap, timestamp: { group: tidGroup + 1, parser: 'airtel-shortcode' } }
            const approve = await s.admin('POST', `/shape/${id}/approve`, { draft: attempt })
            assert.equal(approve.status, 422, approve.text)
            assert.equal(approve.json.error, 'gate_failed')
            const self = approve.json.gate.checks.find((c) => c.name === 'self-match')
            assert.equal(self.ok, false)
            assert.match(self.detail, /no two-letter prefix/)
        })
    })
})

describe('server-side coverage check cannot be used to burn the event loop (REL-01)', () => {
    it('still drops a shape that an active pattern covers, within the time budget', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            const covered = '{N} RWF transferred to {W+}({PH}) at {TS}. Fee was: {N} RWF. New balance: {N} RWF'
            const res = await s.submit(submission([item(covered)]), ip(201))
            assert.deepEqual(res.json, { accepted: 0, deduped: 0, discarded: 1 })
            assert.equal((await pending(s)).total, 0)
        })
    })

    it('20 crafted skeletons that make the slow built-ins backtrack are answered in bounded time', async () => {
        await withServer({ env: PROXY_ENV }, async (s) => {
            const unit = '{N} RWF transferred to ({N}) at {N} Fee : {N} RWF '
            const words = ['sent', 'paid', 'received', 'transferred', 'withdrawn', 'deposit', 'airtime', 'bought', 'purchase', 'agent']
            const items = []
            for (let i = 0; i < 20; i++) {
                const prefix = `${words[i % words.length]} ${words[Math.floor(i / words.length) + 1] || 'to'} `
                const skeleton = `${prefix}${unit.repeat(7)}`.trim().slice(0, 399)
                items.push(item(skeleton))
            }
            const started = Date.now()
            const res = await s.submit(submission(items), ip(200))
            const elapsed = Date.now() - started
            assert.equal(res.status, 202, res.text)
            assert.ok(elapsed < 2000, `the request kept the process busy for ${elapsed} ms`)
            const probe = Date.now()
            assert.equal((await s.request('GET', '/manie/sms-formats')).status, 200)
            assert.ok(Date.now() - probe < 500, 'other requests are served right away')
        })
    })
})
