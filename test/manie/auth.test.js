const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { MemoryStore } = require('../../lib/manie/store')
const { normalizeIp } = require('../../lib/manie/ratelimit')
const { clientIp, ipHash, hashSalt, isStrongToken, requireAdmin, FAIL_MAX, ATTEMPT_MAX } = require('../../lib/manie/auth')

const TOKEN = 'a-long-random-admin-token-for-tests-123456'
const SALT = 'unit-test-salt-0123456789'

const reqOf = (headers = {}, remote = '198.51.100.9') => ({ headers, socket: { remoteAddress: remote } })

function fakeRes() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        set(k, v) {
            if (typeof k === 'object') Object.assign(this.headers, k)
            else this.headers[k] = v
            return this
        },
        removeHeader() {},
        status(code) {
            this.statusCode = code
            return this
        },
        json(body) {
            this.body = body
            return this
        },
    }
}

async function call(mw, req) {
    const res = fakeRes()
    let passed = false
    await mw(req, res, (err) => {
        if (err) throw err
        passed = true
    })
    return { status: passed ? 200 : res.statusCode, res, passed }
}

describe('clientIp (R1-08)', () => {
    it('ignores every forwarding header unless the deployment is trusted', () => {
        const req = reqOf({ 'x-forwarded-for': '9.9.9.9', 'x-vercel-forwarded-for': '8.8.8.8', 'x-real-ip': '7.7.7.7' })
        assert.equal(clientIp(req, {}), '198.51.100.9')
        assert.equal(clientIp(req, { MANIE_TRUST_PROXY: '0' }), '198.51.100.9')
    })

    it('reads the platform header only on Vercel', () => {
        const req = reqOf({ 'x-vercel-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '7.7.7.7' })
        assert.equal(clientIp(req, { VERCEL: '1' }), '203.0.113.7')
        assert.equal(clientIp(req, { MANIE_TRUST_PROXY: '1' }), '9.9.9.9', 'the Vercel header is client controlled off Vercel')
    })

    it('trusts the right-most X-Forwarded-For entry, never the left-most', () => {
        const env = { MANIE_TRUST_PROXY: '1' }
        assert.equal(clientIp(reqOf({ 'x-forwarded-for': '9.9.1.1, 203.0.113.7' }), env), '203.0.113.7')
        assert.equal(clientIp(reqOf({ 'x-forwarded-for': '203.0.113.7' }), env), '203.0.113.7')
        assert.equal(clientIp(reqOf({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.7' }), { ...env, MANIE_TRUSTED_HOPS: '2' }), '2.2.2.2')
        assert.equal(clientIp(reqOf({ 'x-forwarded-for': '203.0.113.7' }), { ...env, MANIE_TRUSTED_HOPS: '3' }), '198.51.100.9', 'fewer hops than configured: not trusted')
        assert.equal(clientIp(reqOf({ 'x-real-ip': '7.7.7.7' }), env), '198.51.100.9', 'x-real-ip alone is never believed')
    })

    it('uses a single operator-named header when configured', () => {
        const env = { MANIE_TRUST_PROXY: '1', MANIE_CLIENT_IP_HEADER: 'CF-Connecting-IP' }
        assert.equal(clientIp(reqOf({ 'cf-connecting-ip': '203.0.113.20', 'x-forwarded-for': '9.9.9.9' }), env), '203.0.113.20')
        assert.equal(clientIp(reqOf({ 'x-forwarded-for': '9.9.9.9' }), env), '198.51.100.9')
        assert.equal(clientIp(reqOf({ 'x-forwarded-for': '9.9.9.9' }), { ...env, MANIE_CLIENT_IP_HEADER: 'bad header!' }), '9.9.9.9')
    })

    it('falls back to the socket for values that are not IP addresses', () => {
        const env = { MANIE_TRUST_PROXY: '1' }
        for (const junk of ['not-an-ip', '999.1.1.1', '<script>', 'a'.repeat(300), '']) {
            assert.equal(clientIp(reqOf({ 'x-forwarded-for': junk }), env), '198.51.100.9', junk)
        }
        assert.equal(clientIp(reqOf({ 'x-forwarded-for': '2001:db8::7' }), env), '2001:db8::7')
        assert.equal(clientIp(reqOf({ 'x-forwarded-for': '::ffff:203.0.113.7' }), env), '203.0.113.7')
    })
})

describe('ipHash and the hash salt (R1-09, PRIV-4)', () => {
    const hmac = (key, ip) => crypto.createHmac('sha256', key).update(normalizeIp(ip)).digest('hex').slice(0, 32)

    it('keys the hash with MANIE_HASH_SALT only', () => {
        assert.equal(ipHash(reqOf(), { MANIE_HASH_SALT: SALT }), hmac(SALT, '198.51.100.9'))
        assert.equal(hashSalt({ MANIE_HASH_SALT: SALT }).configured, true)
    })

    it('never falls back to a public constant, the admin token or the old IP salt variable', () => {
        const hashed = ipHash(reqOf(), {})
        assert.notEqual(hashed, hmac('manie-ip-salt-v1', '198.51.100.9'))
        assert.notEqual(ipHash(reqOf(), { MANIE_ADMIN_TOKEN: TOKEN }), hmac(TOKEN, '198.51.100.9'))
        assert.notEqual(ipHash(reqOf(), { MANIE_IP_SALT: SALT }), hmac(SALT, '198.51.100.9'))
        assert.equal(hashSalt({ MANIE_ADMIN_TOKEN: TOKEN, MANIE_IP_SALT: SALT }).configured, false)
        assert.equal(hashSalt({ MANIE_HASH_SALT: 'short' }).configured, false)
        assert.equal(ipHash(reqOf(), {}), hashed, 'stable within a process')
    })

    it('warns once, without values, when production runs on the per-process salt', () => {
        const warnings = []
        const original = console.warn
        console.warn = (...a) => warnings.push(a.join(' '))
        try {
            hashSalt({ NODE_ENV: 'production' })
            hashSalt({ VERCEL: '1' })
            hashSalt({ NODE_ENV: 'production', MANIE_HASH_SALT: SALT })
        } finally {
            console.warn = original
        }
        assert.ok(warnings.length <= 1)
        assert.ok(!warnings.join(' ').includes(SALT))
    })
})

describe('admin token strength', () => {
    it('rejects short, low-variety and repeated-block tokens', () => {
        for (const weak of ['', 'short', 'x'.repeat(40), 'ab'.repeat(20), 'abcabcabcabcabcabcabcabc', '1234567890123456789012345', 'aaaaaaaabbbbbbbbaaaaaaaabbbbbbbb', undefined, 5]) {
            assert.equal(isStrongToken(weak), false, String(weak))
        }
        for (const strong of [TOKEN, crypto.randomBytes(24).toString('hex'), crypto.randomBytes(24).toString('base64url')]) {
            assert.equal(isStrongToken(strong), true)
        }
    })

    it('answers 503 admin_disabled for a weak configured token', async () => {
        const mw = requireAdmin({ store: new MemoryStore(), env: { MANIE_ADMIN_TOKEN: 'x'.repeat(40) } })
        const out = await call(mw, reqOf({ authorization: `Bearer ${'x'.repeat(40)}` }))
        assert.equal(out.status, 503)
        assert.equal(out.res.body.error, 'admin_disabled')
    })
})

describe('requireAdmin failed-attempt limiter (R1-07, REL-08)', () => {
    const env = { MANIE_ADMIN_TOKEN: TOKEN, MANIE_HASH_SALT: SALT }
    const withToken = (token) => reqOf({ authorization: `Bearer ${token}` })

    function slowStore(delayMs) {
        const inner = new MemoryStore()
        return new Proxy(inner, {
            get(target, prop) {
                const value = target[prop]
                if (typeof value !== 'function') return value
                return async (...args) => {
                    await new Promise((resolve) => setTimeout(resolve, delayMs))
                    return value.apply(target, args)
                }
            },
        })
    }

    it('numbers a concurrent burst of wrong guesses atomically, however slow the store is', async () => {
        const store = slowStore(20)
        const mw = requireAdmin({ store, env })
        const burst = []
        for (let i = 0; i < 400; i++) burst.push(call(mw, withToken(i === 350 ? TOKEN : `wrong-token-${String(i).padStart(4, '0')}-xxxxxxxxxxxx`)))
        const results = await Promise.all(burst)
        assert.equal(results[350].status, 200, 'the correct token is never throttled, however many wrong guesses surround it')
        const tally = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {})
        assert.equal(tally[401], FAIL_MAX)
        assert.equal(tally[200], 1)
        assert.equal(tally[429], 399 - FAIL_MAX)
    })

    it('lets the correct token through while the caller is throttled, without counting it', async () => {
        const store = new MemoryStore()
        const mw = requireAdmin({ store, env })
        for (let i = 0; i < 15; i++) {
            const out = await call(mw, withToken(`wrong-token-${i}-xxxxxxxxxxxxxxxx`))
            assert.equal(out.status, i < FAIL_MAX ? 401 : 429, `attempt ${i}`)
        }
        const ok = await call(mw, withToken(TOKEN))
        assert.equal(ok.status, 200, 'a neighbour on a shared address cannot lock the admin out')
        const key = (await store.keys('manie:authfail:'))[0]
        assert.equal(await store.get(key), 15, 'the successful attempt was never counted')
        const again = await call(mw, withToken(TOKEN))
        assert.equal(again.status, 200)
    })

    it('locks wrong guesses out after ATTEMPT_MAX attempts and then costs no KV commands', async () => {
        const inner = new MemoryStore()
        let calls = 0
        const store = new Proxy(inner, {
            get(target, prop) {
                const value = target[prop]
                if (typeof value !== 'function') return value
                return (...args) => {
                    calls++
                    return value.apply(target, args)
                }
            },
        })
        const mw = requireAdmin({ store, env })
        for (let i = 0; i < ATTEMPT_MAX; i++) await call(mw, withToken(`wrong-token-${i}-xxxxxxxxxxxxxxxx`))
        const locked = await call(mw, withToken('one-more-wrong-token-xxxxxxxxxxxxxxxx'))
        assert.equal(locked.status, 429)
        assert.ok(Number(locked.res.headers['Retry-After']) > 0)
        const before = calls
        for (let i = 0; i < 25; i++) assert.equal((await call(mw, withToken(`still-wrong-${i}-xxxxxxxxxxxxxxxx`))).status, 429)
        assert.equal((await call(mw, withToken(TOKEN))).status, 200, 'the admin is never locked out by wrong guesses from the same address (R2-ATK-4)')
        assert.equal(calls, before, 'neither a locked-out guess nor the correct token reaches the store')
        const other = await call(mw, reqOf({ authorization: `Bearer ${TOKEN}` }, '203.0.113.99'))
        assert.equal(other.status, 200)
    })

    it('keeps the admin in after 60 wrong guesses from a shared address and keeps throttling the guesses (R2-ATK-4)', async () => {
        const mw = requireAdmin({ store: new MemoryStore(), env })
        const statuses = []
        for (let i = 0; i < 60; i++) statuses.push((await call(mw, withToken(`wrong-token-${String(i).padStart(2, '0')}-xxxxxxxxxxxxxxxx`))).status)
        assert.deepEqual([...new Set(statuses)].sort(), [401, 429])
        assert.equal(statuses.filter((s) => s === 401).length, FAIL_MAX)
        for (let round = 0; round < 3; round++) {
            assert.equal((await call(mw, withToken(TOKEN))).status, 200)
            assert.equal((await call(mw, withToken(`wrong-again-${round}-xxxxxxxxxxxxxxxxxx`))).status, 429)
        }
        const tooLong = await call(mw, withToken(TOKEN + 'x'.repeat(600)))
        assert.equal(tooLong.status, 429, 'an oversized token is never compared and counts as a wrong guess')
    })

    it('does not count requests without a token and keeps bounding guesses when the store is down', async () => {
        const down = {
            incr: async () => {
                throw new Error('store down')
            },
        }
        const quiet = console.error
        console.error = () => {}
        try {
            const mw = requireAdmin({ store: down, env })
            for (let i = 0; i < 20; i++) assert.equal((await call(mw, reqOf({}))).status, 401)
            let blocked = 0
            for (let i = 0; i < ATTEMPT_MAX + 10; i++) {
                const out = await call(mw, withToken(`wrong-token-${i}-xxxxxxxxxxxxxxxx`))
                if (out.status === 429) blocked++
            }
            assert.ok(blocked >= 10, 'the in-memory fallback still throttles guesses')
        } finally {
            console.error = quiet
        }
    })
})
