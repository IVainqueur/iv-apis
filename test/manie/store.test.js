const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { createStore, MemoryStore, UpstashStore, StoreError, RedisEmulator, normalizeKey } = require('../../lib/manie/store')

const TOKEN = 'tok_test_SECRET_0123456789'

function makeClock(start) {
    const clock = { now: start === undefined ? 1_800_000_000_000 : start }
    clock.fn = () => clock.now
    return clock
}

async function rejects(promise, code) {
    try {
        await promise
    } catch (err) {
        assert.ok(err instanceof StoreError, `expected StoreError, got ${err && err.name}: ${err && err.message}`)
        if (code) assert.equal(err.code, code)
        return err
    }
    assert.fail('expected the promise to reject')
}

describe('normalizeKey', () => {
    it('prefixes idempotently', () => {
        assert.equal(normalizeKey('shape:abc'), 'manie:shape:abc')
        assert.equal(normalizeKey('manie:shape:abc'), 'manie:shape:abc')
    })

    it('rejects bad keys', () => {
        for (const bad of ['', 'a\nb', 'x'.repeat(513), null, undefined, 42, {}]) {
            assert.throws(() => normalizeKey(bad), err => err instanceof StoreError && err.code === 'bad_key')
        }
    })
})

describe('MemoryStore', () => {
    let clock
    let store

    beforeEach(() => {
        clock = makeClock()
        store = new MemoryStore({ now: clock.fn })
    })

    it('round-trips JSON values and returns null for missing keys', async () => {
        const values = [{ a: 1, b: [1, 2, { c: null }] }, 'hello', 42, 0, true, false, null, [], {}, '', 'with "quotes" \n and unicode é']
        for (const [i, v] of values.entries()) {
            assert.equal(await store.set(`k${i}`, v), true)
            assert.deepEqual(await store.get(`k${i}`), v)
        }
        assert.equal(await store.get('missing'), null)
    })

    it('rejects values that cannot be serialised or are too large', async () => {
        await rejects(store.set('k', undefined), 'bad_value')
        await rejects(store.set('k', () => 1), 'bad_value')
        const cyclic = {}
        cyclic.self = cyclic
        await rejects(store.set('k', cyclic), 'bad_value')
        await rejects(store.set('k', 'x'.repeat(600 * 1024)), 'too_large')
    })

    it('stores everything under the manie: prefix', async () => {
        await store.set('plain', 1)
        await store.set('manie:explicit', 2)
        assert.deepEqual(await store.keys(), ['manie:explicit', 'manie:plain'])
        assert.equal(await store.get('manie:plain'), 1)
        assert.equal(await store.get('explicit'), 2)
    })

    it('honors ex TTLs using the injected clock', async () => {
        await store.set('t', 'v', { ex: 10 })
        assert.equal(await store.ttl('t'), 10)
        clock.now += 9_999
        assert.equal(await store.get('t'), 'v')
        assert.equal(await store.ttl('t'), 1)
        clock.now += 1
        assert.equal(await store.get('t'), null)
        assert.equal(await store.ttl('t'), -2)
        assert.equal(await store.exists('t'), false)
    })

    it('set without ex clears a previous TTL; nx does not overwrite', async () => {
        await store.set('t', 1, { ex: 5 })
        await store.set('t', 2)
        assert.equal(await store.ttl('t'), -1)
        assert.equal(await store.set('t', 3, { nx: true }), false)
        assert.equal(await store.get('t'), 2)
        assert.equal(await store.set('fresh', 3, { nx: true }), true)
    })

    it('validates ttl arguments', async () => {
        for (const ex of [0, -1, 1.5, '5', NaN, 315360001]) await rejects(store.set('k', 1, { ex }), 'bad_arg')
        await rejects(store.expire('k', 0), 'bad_arg')
        await rejects(store.expire('k'), 'bad_arg')
    })

    it('del, exists and expire', async () => {
        await store.set('a', 1)
        await store.set('b', 2)
        await store.set('c', 3)
        assert.equal(await store.exists('a'), true)
        assert.equal(await store.expire('a', 30), true)
        assert.equal(await store.expire('nope', 30), false)
        assert.equal(await store.del('a', 'b', 'nope'), 2)
        assert.equal(await store.del(['c']), 1)
        assert.equal(await store.del(), 0)
        assert.equal(await store.exists('a'), false)
    })

    describe('incr', () => {
        it('counts, sets the TTL on creation only, and resets after expiry', async () => {
            assert.equal(await store.incr('c', { ex: 60 }), 1)
            clock.now += 30_000
            assert.equal(await store.incr('c', { ex: 60 }), 2)
            assert.equal(await store.ttl('c'), 30)
            clock.now += 30_000
            assert.equal(await store.incr('c', { ex: 60 }), 1)
            assert.equal(await store.ttl('c'), 60)
        })

        it('supports by (including negative) and works without ex', async () => {
            assert.equal(await store.incr('n'), 1)
            assert.equal(await store.incr('n', { by: 9 }), 10)
            assert.equal(await store.incr('n', { by: -4 }), 6)
            assert.equal(await store.ttl('n'), -1)
            assert.equal(await store.get('n'), 6)
        })

        it('rejects non-integer increments and non-numeric values', async () => {
            await rejects(store.incr('n', { by: 1.5 }), 'bad_arg')
            await rejects(store.incr('n', { by: '2' }), 'bad_arg')
            await store.set('s', 'text')
            await rejects(store.incr('s'), 'redis')
        })

        it('is atomic under concurrent callers', async () => {
            const results = await Promise.all(Array.from({ length: 100 }, () => store.incr('race', { ex: 60 })))
            assert.deepEqual([...results].sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 1))
        })
    })

    describe('hashes', () => {
        it('hset/hget/hgetall with JSON values', async () => {
            assert.equal(await store.hset('h', { a: 1, b: { x: [1, 2] }, c: 'str' }), 3)
            assert.equal(await store.hset('h', { a: 2, d: null }), 1)
            assert.equal(await store.hget('h', 'a'), 2)
            assert.deepEqual(await store.hget('h', 'b'), { x: [1, 2] })
            assert.equal(await store.hget('h', 'nope'), null)
            assert.deepEqual(await store.hgetall('h'), { a: 2, b: { x: [1, 2] }, c: 'str', d: null })
        })

        it('skips undefined fields and treats an empty object as a no-op', async () => {
            assert.equal(await store.hset('h', { a: undefined }), 0)
            assert.equal(await store.hgetall('h'), null)
            assert.equal(await store.hset('h', { a: 1, b: undefined }), 1)
            assert.deepEqual(await store.hgetall('h'), { a: 1 })
        })

        it('hgetall returns null for a missing or emptied hash', async () => {
            assert.equal(await store.hgetall('none'), null)
            await store.hset('h', { a: 1, b: 2 })
            assert.equal(await store.hdel('h', 'a', 'zz'), 1)
            assert.equal(await store.hdel('h', ['b']), 1)
            assert.equal(await store.hgetall('h'), null)
            assert.equal(await store.exists('h'), false)
        })

        it('returns unparseable stored values as the raw string instead of throwing', async () => {
            await store._run(['HSET', 'manie:h', 'good', '{"a":1}', 'bad', '{"a":'])
            assert.deepEqual(await store.hgetall('h'), { good: { a: 1 }, bad: '{"a":' })
        })

        it('hincrby creates and increments', async () => {
            assert.equal(await store.hincrby('h', 'n'), 1)
            assert.equal(await store.hincrby('h', 'n', 4), 5)
            assert.equal(await store.hget('h', 'n'), 5)
        })

        it('is safe against prototype-polluting field names', async () => {
            await store._run(['HSET', 'manie:h', '__proto__', '{"polluted":true}', 'ok', '1'])
            const all = await store.hgetall('h')
            assert.equal(({}).polluted, undefined)
            assert.equal(all.polluted, undefined)
            assert.deepEqual(Object.keys(all).sort(), ['__proto__', 'ok'])
        })

        it('validates fields', async () => {
            await rejects(store.hset('h', 'nope'), 'bad_arg')
            await rejects(store.hset('h', [1]), 'bad_arg')
            await rejects(store.hget('h', ''), 'bad_arg')
            await rejects(store.hget('h', 'x'.repeat(257)), 'bad_arg')
        })
    })

    describe('sorted sets', () => {
        beforeEach(async () => {
            await store.zadd('z', 3, 'c')
            await store.zadd('z', 1, 'a')
            await store.zadd('z', 3, 'd')
            await store.zadd('z', 2, 'b')
        })

        it('zrange ascending and zrevrange descending with lexicographic tie-breaks', async () => {
            assert.deepEqual(await store.zrange('z', 0, -1), ['a', 'b', 'c', 'd'])
            assert.deepEqual(await store.zrevrange('z', 0, -1), ['d', 'c', 'b', 'a'])
            assert.deepEqual(await store.zrevrange('z', 0, 1), ['d', 'c'])
            assert.deepEqual(await store.zrevrange('z', -2, -1), ['b', 'a'])
            assert.deepEqual(await store.zrevrange('z', 10, 20), [])
            assert.deepEqual(await store.zrevrange('missing', 0, -1), [])
        })

        it('withScores returns member/score objects', async () => {
            assert.deepEqual(await store.zrevrange('z', 0, 1, { withScores: true }), [
                { member: 'd', score: 3 },
                { member: 'c', score: 3 },
            ])
        })

        it('zadd updates scores, zscore, zincrby, zcard, zrem', async () => {
            assert.equal(await store.zadd('z', 10, 'a'), 0)
            assert.equal(await store.zscore('z', 'a'), 10)
            assert.equal(await store.zscore('z', 'nope'), null)
            assert.equal(await store.zincrby('z', 2.5, 'b'), 4.5)
            assert.equal(await store.zcard('z'), 4)
            assert.equal(await store.zrem('z', 'a', 'b', 'nope'), 2)
            assert.deepEqual(await store.zrange('z', 0, -1), ['c', 'd'])
            await store.zrem('z', 'c', 'd')
            assert.equal(await store.exists('z'), false)
        })

        it('validates scores, members and ranges', async () => {
            await rejects(store.zadd('z', NaN, 'x'), 'bad_arg')
            await rejects(store.zadd('z', '1', 'x'), 'bad_arg')
            await rejects(store.zadd('z', 1, ''), 'bad_arg')
            await rejects(store.zadd('z', 1, {}), 'bad_arg')
            await rejects(store.zrem('z'), 'bad_arg')
            await rejects(store.zrange('z', 0.5, 1), 'bad_arg')
        })

        it('coerces numeric members to strings', async () => {
            await store.zadd('z', 1, 42)
            assert.equal(await store.zscore('z', '42'), 1)
        })
    })

    describe('sets', () => {
        it('sadd/smembers/srem/scard', async () => {
            assert.equal(await store.sadd('s', 'a', 'b', 'a'), 2)
            assert.equal(await store.sadd('s', ['c']), 1)
            assert.deepEqual((await store.smembers('s')).sort(), ['a', 'b', 'c'])
            assert.equal(await store.scard('s'), 3)
            assert.equal(await store.srem('s', 'a', 'zz'), 1)
            assert.equal(await store.srem('s', 'b', 'c'), 2)
            assert.deepEqual(await store.smembers('s'), [])
            assert.equal(await store.scard('s'), 0)
            assert.equal(await store.exists('s'), false)
        })

        it('requires at least one member', async () => {
            await rejects(store.sadd('s'), 'bad_arg')
            await rejects(store.srem('s'), 'bad_arg')
        })
    })

    describe('keys', () => {
        it('filters by prefix, skips expired keys, and escapes glob characters', async () => {
            await store.set('shape:a', 1)
            await store.set('shape:b', 1)
            await store.set('other:x', 1)
            await store.set('weird*', 1)
            await store.set('weirdo', 1)
            await store.set('gone', 1, { ex: 1 })
            clock.now += 2000
            assert.deepEqual(await store.keys('shape:'), ['manie:shape:a', 'manie:shape:b'])
            assert.deepEqual(await store.keys('weird*'), ['manie:weird*'])
            assert.ok(!(await store.keys()).includes('manie:gone'))
        })
    })

    it('reports WRONGTYPE as a StoreError', async () => {
        await store.set('k', 1)
        await rejects(store.hget('k', 'f'), 'redis')
        await rejects(store.sadd('k', 'm'), 'redis')
        await store.sadd('s', 'm')
        await rejects(store.get('s'), 'redis')
    })

    it('sweeps expired keys periodically so memory does not grow without bound', async () => {
        for (let i = 0; i < 300; i++) await store.set(`tmp${i}`, i, { ex: 1 })
        clock.now += 5000
        for (let i = 0; i < 300; i++) await store.get('unrelated')
        assert.ok(store.engine.data.size < 10, `still holding ${store.engine.data.size} entries`)
    })

    it('snapshot lists live entries only', async () => {
        await store.set('a', { x: 1 })
        await store.hset('h', { f: 1 })
        await store.sadd('s', 'm')
        await store.zadd('z', 2, 'm')
        await store.set('gone', 1, { ex: 1 })
        clock.now += 2000
        const snap = store.snapshot()
        assert.deepEqual(
            snap.map(e => [e.key, e.type]),
            [
                ['manie:a', 'string'],
                ['manie:h', 'hash'],
                ['manie:s', 'set'],
                ['manie:z', 'zset'],
            ],
        )
        assert.equal(snap[0].value, '{"x":1}')
        assert.deepEqual(snap[1].value, { f: '1' })
    })

    it('flags itself as non-persistent and not degraded', () => {
        assert.equal(store.kind, 'memory')
        assert.equal(store.persistent, false)
        assert.equal(store.isDegraded, false)
    })
})

describe('UpstashStore over the REST wire protocol', () => {
    let server
    let baseUrl
    let log
    let clock
    let engine
    let store

    function defaultHandler(req, res, text) {
        let payload
        try {
            payload = JSON.parse(text)
        } catch (err) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'ERR invalid JSON' }))
        }
        const run = args => {
            try {
                return { result: engine.execute(args) }
            } catch (err) {
                return { error: err.message }
            }
        }
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/pipeline') return res.end(JSON.stringify(payload.map(run)))
        if (req.url === '/') return res.end(JSON.stringify(run(payload)))
        res.statusCode = 404
        return res.end(JSON.stringify({ error: 'ERR not found' }))
    }

    before(async () => {
        server = http.createServer((req, res) => {
            const chunks = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => {
                const text = Buffer.concat(chunks).toString()
                log.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], text })
                const behavior = server.behavior || defaultHandler
                behavior(req, res, text)
            })
        })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        baseUrl = `http://127.0.0.1:${server.address().port}`
    })

    after(async () => {
        if (server.closeAllConnections) server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    })

    beforeEach(() => {
        log = []
        clock = makeClock()
        engine = new RedisEmulator({ now: clock.fn })
        server.behavior = null
        store = new UpstashStore({ url: `${baseUrl}/`, token: TOKEN, timeoutMs: 400 })
    })

    function lastBody() {
        return JSON.parse(log[log.length - 1].text)
    }

    it('sends POST with a JSON array body of strings and a bearer token', async () => {
        await store.set('k', { a: 1 })
        assert.equal(log.length, 1)
        assert.equal(log[0].method, 'POST')
        assert.equal(log[0].url, '/')
        assert.equal(log[0].auth, `Bearer ${TOKEN}`)
        assert.match(log[0].type, /application\/json/)
        assert.deepEqual(lastBody(), ['SET', 'manie:k', '{"a":1}'])
    })

    it('encodes every command exactly as Redis expects', async () => {
        const expectations = [
            [() => store.get('k'), ['GET', 'manie:k']],
            [() => store.set('k', 'v', { ex: 60 }), ['SET', 'manie:k', '"v"', 'EX', '60']],
            [() => store.set('k', 1, { ex: 60, nx: true }), ['SET', 'manie:k', '1', 'EX', '60', 'NX']],
            [() => store.del('a', 'b'), ['DEL', 'manie:a', 'manie:b']],
            [() => store.exists('a'), ['EXISTS', 'manie:a']],
            [() => store.expire('a', 5), ['EXPIRE', 'manie:a', '5']],
            [() => store.ttl('a'), ['TTL', 'manie:a']],
            [() => store.hset('h', { a: 1, b: 'x' }), ['HSET', 'manie:h', 'a', '1', 'b', '"x"']],
            [() => store.hget('h', 'a'), ['HGET', 'manie:h', 'a']],
            [() => store.hgetall('h'), ['HGETALL', 'manie:h']],
            [() => store.hdel('h', 'a', 'b'), ['HDEL', 'manie:h', 'a', 'b']],
            [() => store.hincrby('h', 'n', 3), ['HINCRBY', 'manie:h', 'n', '3']],
            [() => store.zadd('z', 2.5, 'm'), ['ZADD', 'manie:z', '2.5', 'm']],
            [() => store.zincrby('z', 1, 'm'), ['ZINCRBY', 'manie:z', '1', 'm']],
            [() => store.zscore('z', 'm'), ['ZSCORE', 'manie:z', 'm']],
            [() => store.zcard('z'), ['ZCARD', 'manie:z']],
            [() => store.zrange('z', 0, -1), ['ZRANGE', 'manie:z', '0', '-1']],
            [() => store.zrevrange('z', 0, 4, { withScores: true }), ['ZREVRANGE', 'manie:z', '0', '4', 'WITHSCORES']],
            [() => store.zrem('z', 'm', 'n'), ['ZREM', 'manie:z', 'm', 'n']],
            [() => store.sadd('s', 'a', 'b'), ['SADD', 'manie:s', 'a', 'b']],
            [() => store.smembers('s'), ['SMEMBERS', 'manie:s']],
            [() => store.srem('s', 'a'), ['SREM', 'manie:s', 'a']],
            [() => store.scard('s'), ['SCARD', 'manie:s']],
        ]
        for (const [call, wire] of expectations) {
            log.length = 0
            await call()
            assert.equal(log.length, 1, `one request for ${wire[0]}`)
            assert.equal(log[0].url, '/')
            assert.deepEqual(lastBody(), wire)
        }
    })

    it('incr with ex goes through /pipeline as SET NX then INCR; without ex it is a single INCR', async () => {
        assert.equal(await store.incr('c', { ex: 60 }), 1)
        assert.equal(log.length, 1)
        assert.equal(log[0].url, '/pipeline')
        assert.deepEqual(lastBody(), [
            ['SET', 'manie:c', '0', 'EX', '60', 'NX'],
            ['INCR', 'manie:c'],
        ])
        assert.equal(await store.incr('c', { ex: 60, by: 5 }), 6)
        assert.deepEqual(lastBody(), [
            ['SET', 'manie:c', '0', 'EX', '60', 'NX'],
            ['INCRBY', 'manie:c', '5'],
        ])
        log.length = 0
        assert.equal(await store.incr('plain'), 1)
        assert.equal(log[0].url, '/')
        assert.deepEqual(lastBody(), ['INCR', 'manie:plain'])
    })

    it('keys uses SCAN with an escaped MATCH pattern, never KEYS', async () => {
        for (let i = 0; i < 5; i++) await store.set(`shape:${i}`, i)
        await store.set('other', 1)
        log.length = 0
        assert.deepEqual(await store.keys('shape:'), ['manie:shape:0', 'manie:shape:1', 'manie:shape:2', 'manie:shape:3', 'manie:shape:4'])
        const commands = log.map(l => JSON.parse(l.text))
        assert.ok(commands.length >= 1)
        for (const c of commands) {
            assert.equal(c[0], 'SCAN')
            assert.equal(c[2], 'MATCH')
        }
        assert.equal(commands[0][3], 'manie:shape:*')
    })

    it('keys follows the cursor across pages', async () => {
        server.behavior = (req, res, text) => {
            const cmd = JSON.parse(text)
            res.setHeader('Content-Type', 'application/json')
            const cursor = cmd[1]
            if (cursor === '0') return res.end(JSON.stringify({ result: ['17', ['manie:a', 'manie:b']] }))
            assert.equal(cursor, '17')
            return res.end(JSON.stringify({ result: ['0', ['manie:c', 'manie:a']] }))
        }
        assert.deepEqual(await store.keys('manie:'), ['manie:a', 'manie:b', 'manie:c'])
    })

    it('behaves identically to MemoryStore for a mixed operation script', async () => {
        const mem = new MemoryStore({ now: clock.fn })
        async function script(s) {
            const out = []
            out.push(await s.set('a', { n: [1, 2] }, { ex: 100 }))
            out.push(await s.get('a'))
            out.push(await s.incr('c', { ex: 50 }), await s.incr('c', { ex: 50, by: 4 }), await s.incr('c', { by: -2 }))
            out.push(await s.hset('h', { x: 1, y: { z: 'q' } }), await s.hgetall('h'), await s.hget('h', 'y'))
            out.push(await s.hdel('h', 'x'), await s.hgetall('h'))
            out.push(await s.zadd('z', 5, 'five'), await s.zadd('z', 1, 'one'), await s.zadd('z', 5, 'cinq'))
            out.push(await s.zrevrange('z', 0, -1), await s.zrange('z', 0, 1, { withScores: true }), await s.zcard('z'))
            out.push(await s.sadd('s', 'p', 'q', 'p'), (await s.smembers('s')).sort(), await s.scard('s'), await s.srem('s', 'p'))
            out.push(await s.ttl('a'), await s.ttl('c'), await s.ttl('none'), await s.exists('a'), await s.del('a', 'none'))
            out.push(await s.keys('manie:'))
            out.push(await s.hgetall('missing'), await s.get('missing'))
            return out
        }
        assert.deepEqual(await script(store), await script(mem))
    })

    it('accepts the object form of HGETALL replies too', async () => {
        server.behavior = (req, res) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ result: { a: '1', b: '{"c":2}' } }))
        }
        assert.deepEqual(await store.hgetall('h'), { a: 1, b: { c: 2 } })
    })

    describe('failure modes', () => {
        function assertNoSecrets(err) {
            const dump = `${err.message} ${JSON.stringify(err)} ${err.stack}`
            assert.ok(!dump.includes(TOKEN), 'token must never appear in errors')
        }

        it('times out via AbortController and maps to StoreError(timeout)', async () => {
            const held = []
            server.behavior = (req, res) => held.push(res)
            const quick = new UpstashStore({ url: baseUrl, token: TOKEN, timeoutMs: 80 })
            const started = Date.now()
            const err = await rejects(quick.get('k'), 'timeout')
            assert.ok(Date.now() - started < 1500)
            assertNoSecrets(err)
            for (const res of held) res.destroy()
        })

        it('times out while the response body is still being read', async () => {
            server.behavior = (req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.write('{"result"')
            }
            const quick = new UpstashStore({ url: baseUrl, token: TOKEN, timeoutMs: 80 })
            await rejects(quick.get('k'), 'timeout')
        })

        it('maps a 500 with a JSON error body to StoreError(http) carrying the status', async () => {
            server.behavior = (req, res) => {
                res.statusCode = 500
                res.end(JSON.stringify({ error: 'ERR upstream exploded' }))
            }
            const err = await rejects(store.get('k'), 'http')
            assert.equal(err.status, 500)
            assert.match(err.message, /upstream exploded/)
            assertNoSecrets(err)
        })

        it('maps a 500 with an HTML body and a 401 to StoreError(http)', async () => {
            server.behavior = (req, res) => {
                res.statusCode = 500
                res.end('<html>oops</html>')
            }
            const err = await rejects(store.get('k'), 'http')
            assert.equal(err.status, 500)
            assert.ok(!err.message.includes('<html>'))
            server.behavior = (req, res) => {
                res.statusCode = 401
                res.end(JSON.stringify({ error: 'WRONGPASS invalid or missing auth token' }))
            }
            const err401 = await rejects(store.get('k'), 'http')
            assert.equal(err401.status, 401)
            assertNoSecrets(err401)
        })

        it('maps malformed or truncated JSON on a 200 to StoreError(protocol)', async () => {
            for (const body of ['not json', '{"result":', '', '<html></html>']) {
                server.behavior = (req, res) => res.end(body)
                await rejects(store.get('k'), 'protocol')
            }
        })

        it('maps a Redis error envelope to StoreError(redis)', async () => {
            server.behavior = (req, res) => res.end(JSON.stringify({ error: 'ERR value is not an integer or out of range' }))
            const err = await rejects(store.get('k'), 'redis')
            assert.match(err.message, /not an integer/)
        })

        it('maps envelopes without a result, or of the wrong shape, to StoreError(protocol)', async () => {
            for (const body of ['{}', '[]', 'null', '"x"', '42']) {
                server.behavior = (req, res) => res.end(body)
                await rejects(store.get('k'), 'protocol')
            }
        })

        it('rejects replies of the wrong type for typed operations', async () => {
            server.behavior = (req, res) => res.end(JSON.stringify({ result: 'OK' }))
            await rejects(store.scard('s'), 'protocol')
            await rejects(store.smembers('s'), 'protocol')
            await rejects(store.zrevrange('z', 0, 1), 'protocol')
            await rejects(store.zrevrange('z', 0, 1, { withScores: true }), 'protocol')
            await rejects(store.hgetall('h'), 'protocol')
            server.behavior = (req, res) => res.end(JSON.stringify({ result: ['a'] }))
            await rejects(store.zrevrange('z', 0, 1, { withScores: true }), 'protocol')
            await rejects(store.hgetall('h'), 'protocol')
        })

        it('rejects bad pipeline replies and surfaces per-command errors', async () => {
            server.behavior = (req, res) => res.end(JSON.stringify([{ result: 'OK' }]))
            await rejects(store.incr('c', { ex: 5 }), 'protocol')
            server.behavior = (req, res) => res.end(JSON.stringify({ result: 1 }))
            await rejects(store.incr('c', { ex: 5 }), 'protocol')
            server.behavior = (req, res) => res.end(JSON.stringify([{ result: 'OK' }, { error: 'ERR value is not an integer or out of range' }]))
            await rejects(store.incr('c', { ex: 5 }), 'redis')
            server.behavior = (req, res) => res.end(JSON.stringify([{ result: 'OK' }, { result: 'nope' }]))
            await rejects(store.incr('c', { ex: 5 }), 'protocol')
        })

        it('maps a refused connection to StoreError(network)', async () => {
            const tmp = http.createServer()
            await new Promise(resolve => tmp.listen(0, '127.0.0.1', resolve))
            const port = tmp.address().port
            await new Promise(resolve => tmp.close(resolve))
            const dead = new UpstashStore({ url: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 500 })
            const err = await rejects(dead.get('k'), 'network')
            assertNoSecrets(err)
        })

        it('refuses to follow redirects (the token must not leave the configured host)', async () => {
            server.behavior = (req, res) => {
                res.statusCode = 302
                res.setHeader('Location', 'http://127.0.0.1:9/steal')
                res.end()
            }
            await rejects(store.get('k'), 'network')
        })

        it('tracks isDegraded: true after a failure, false again after a success', async () => {
            assert.equal(store.isDegraded, false)
            server.behavior = (req, res) => {
                res.statusCode = 503
                res.end('{}')
            }
            await rejects(store.get('k'), 'http')
            assert.equal(store.isDegraded, true)
            server.behavior = null
            await store.get('k')
            assert.equal(store.isDegraded, false)
        })

        it('validates arguments before touching the network', async () => {
            await rejects(store.get(''), 'bad_key')
            await rejects(store.set('k', undefined), 'bad_value')
            await rejects(store.zadd('z', NaN, 'm'), 'bad_arg')
            assert.equal(log.length, 0)
        })
    })

    it('uses an injected fetch implementation and only reads global fetch lazily', async () => {
        const calls = []
        const fake = async (url, init) => {
            calls.push({ url, init })
            return { ok: true, status: 200, text: async () => JSON.stringify({ result: '"x"' }) }
        }
        const s = new UpstashStore({ url: 'https://example.invalid/', token: TOKEN, fetch: fake })
        assert.equal(await s.get('k'), 'x')
        assert.equal(calls[0].url, 'https://example.invalid')
        assert.equal(calls[0].init.redirect, 'error')
        assert.ok(calls[0].init.signal)
    })

    it('requires url and token', () => {
        assert.throws(() => new UpstashStore({}), err => err instanceof StoreError && err.code === 'config')
        assert.throws(() => new UpstashStore({ url: 'https://x' }), StoreError)
    })

    it('refuses a plain-http remote URL so the token is never sent in clear text', () => {
        for (const url of ['http://kv.example.com', 'ftp://kv.example.com', 'not a url', '']) {
            assert.throws(() => new UpstashStore({ url, token: TOKEN }), err => err instanceof StoreError && err.code === 'config' && !err.message.includes(TOKEN))
        }
        assert.doesNotThrow(() => new UpstashStore({ url: 'http://localhost:8079', token: TOKEN }))
    })
})

describe('createStore', () => {
    const quiet = (fn) => {
        const original = console.warn
        console.warn = () => {}
        try {
            return fn()
        } finally {
            console.warn = original
        }
    }

    it('prefers KV_REST_API_* over UPSTASH_REDIS_REST_*', () => {
        const s = createStore({
            KV_REST_API_URL: 'https://kv.example.com/',
            KV_REST_API_TOKEN: 'a',
            UPSTASH_REDIS_REST_URL: 'https://up.example.com',
            UPSTASH_REDIS_REST_TOKEN: 'b',
        })
        assert.ok(s instanceof UpstashStore)
        assert.equal(s.url, 'https://kv.example.com')
        assert.equal(s.token, 'a')
        assert.equal(s.persistent, true)
    })

    it('falls back to UPSTASH_REDIS_REST_* when the KV_* pair is incomplete', () => {
        const s = createStore({
            KV_REST_API_URL: 'https://kv.example.com',
            UPSTASH_REDIS_REST_URL: 'https://up.example.com',
            UPSTASH_REDIS_REST_TOKEN: 'b',
        })
        assert.ok(s instanceof UpstashStore)
        assert.equal(s.url, 'https://up.example.com')
    })

    it('uses MemoryStore when nothing (or nothing valid) is configured, and never throws', () => {
        quiet(() => {
            assert.ok(createStore({}) instanceof MemoryStore)
            assert.ok(createStore({ KV_REST_API_URL: 'https://x.example.com' }) instanceof MemoryStore)
            assert.ok(createStore({ KV_REST_API_URL: 'not a url', KV_REST_API_TOKEN: 't' }) instanceof MemoryStore)
            assert.ok(createStore({ KV_REST_API_URL: 'http://evil.example.com', KV_REST_API_TOKEN: 't' }) instanceof MemoryStore)
            assert.ok(createStore({ KV_REST_API_URL: 'ftp://x.example.com', KV_REST_API_TOKEN: 't' }) instanceof MemoryStore)
        })
    })

    it('allows plain http only for loopback hosts', () => {
        assert.ok(createStore({ KV_REST_API_URL: 'http://127.0.0.1:1234', KV_REST_API_TOKEN: 't' }) instanceof UpstashStore)
        assert.ok(createStore({ KV_REST_API_URL: 'http://localhost:1234', KV_REST_API_TOKEN: 't' }) instanceof UpstashStore)
    })

    it('forwards timeout and fetch options and warns (without values) only in production', () => {
        const fake = async () => ({})
        const s = createStore({ KV_REST_API_URL: 'https://kv.example.com', KV_REST_API_TOKEN: 'SECRETVALUE' }, { timeoutMs: 123, fetch: fake })
        assert.equal(s.timeoutMs, 123)
        assert.equal(s.fetchImpl, fake)
        const warnings = []
        const original = console.warn
        console.warn = (...a) => warnings.push(a.join(' '))
        try {
            createStore({ NODE_ENV: 'production' })
            createStore({})
        } finally {
            console.warn = original
        }
        assert.equal(warnings.length, 1)
        assert.ok(!warnings[0].includes('SECRETVALUE'))
    })

    it('defaults to process.env when called without arguments', () => {
        const saved = { a: process.env.KV_REST_API_URL, b: process.env.KV_REST_API_TOKEN, c: process.env.UPSTASH_REDIS_REST_URL, d: process.env.UPSTASH_REDIS_REST_TOKEN }
        delete process.env.KV_REST_API_URL
        delete process.env.KV_REST_API_TOKEN
        delete process.env.UPSTASH_REDIS_REST_URL
        delete process.env.UPSTASH_REDIS_REST_TOKEN
        try {
            assert.ok(quiet(() => createStore()) instanceof MemoryStore)
        } finally {
            for (const [k, v] of [['KV_REST_API_URL', saved.a], ['KV_REST_API_TOKEN', saved.b], ['UPSTASH_REDIS_REST_URL', saved.c], ['UPSTASH_REDIS_REST_TOKEN', saved.d]]) {
                if (v !== undefined) process.env[k] = v
            }
        }
    })
})
