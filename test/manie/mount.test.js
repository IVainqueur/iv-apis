const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')

const { mountManie, NO_CORS_PATH } = require('../../lib/manie/mount')
const { createManieRouter } = require('../../routes/manie')
const { MemoryStore, TOKEN } = require('./helpers')

async function withHost(fn) {
    const app = express()
    mountManie(app, cors(), createManieRouter({ store: new MemoryStore(), env: { MANIE_ADMIN_TOKEN: TOKEN } }))
    app.use(bodyParser.json())
    app.use(bodyParser.urlencoded({ extended: true }))
    app.use(bodyParser.raw())
    app.get('/other', (req, res) => res.json({ ok: true }))
    app.use((err, req, res, next) => {
        res.status(err.status || 500).type('text/html').send(`<pre>${err.stack}</pre>`)
    })
    const server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    try {
        await fn((p, init) => fetch(url + p, init))
    } finally {
        await new Promise((resolve) => {
            server.close(() => resolve())
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        })
    }
}

describe('host wiring (LOG-1, R1-05 CORS)', () => {
    it('answers malformed JSON with the router JSON error and logs no body fragment', async () => {
        const captured = []
        const originals = {}
        for (const level of ['log', 'info', 'warn', 'error']) {
            originals[level] = console[level]
            console[level] = (...args) => captured.push(args.map(String).join(' '))
        }
        try {
            await withHost(async (call) => {
                const raw = '{"v":1,"items":[{"skeleton":"{N} RWF to Alice Uwase 0788123456 bal {N}","carrier":"mtn"},}'
                const res = await call('/manie/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })
                assert.equal(res.status, 400)
                assert.match(res.headers.get('content-type'), /^application\/json/)
                assert.deepEqual(await res.json(), { error: 'invalid_json' })
                await new Promise((resolve) => setImmediate(resolve))
            })
        } finally {
            Object.assign(console, originals)
        }
        const output = captured.join('\n')
        assert.ok(!/uwase|0788123456|SyntaxError|\.js:\d+/i.test(output), `logs must not echo the body: ${output.slice(0, 200)}`)
    })

    it('mounts the manie router before the host body parsers in app.js', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8')
        const mounted = source.indexOf('mountManie(')
        const parsed = source.indexOf('bodyParser.json()')
        assert.ok(mounted > 0 && parsed > 0 && mounted < parsed, 'mountManie must run before bodyParser.json()')
        assert.ok(!/app\.use\(cors\(\)\)/.test(source), 'cors must go through mountManie so submissions and admin stay CORS-free')
    })

    it('refuses cross-origin preflight for submissions and admin routes but keeps CORS elsewhere', async () => {
        await withHost(async (call) => {
            const preflight = (p) =>
                call(p, {
                    method: 'OPTIONS',
                    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
                })
            for (const p of ['/manie/submissions', '/manie/admin/api/stats', '/manie/admin', '/MANIE/Submissions', '/manie//submissions']) {
                const res = await preflight(p)
                assert.equal(res.headers.get('access-control-allow-origin'), null, p)
                assert.equal(res.headers.get('access-control-allow-methods'), null, p)
            }
            const post = await call('/manie/submissions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
                body: '{}',
            })
            assert.equal(post.headers.get('access-control-allow-origin'), null)

            const formats = await preflight('/manie/sms-formats')
            assert.equal(formats.headers.get('access-control-allow-origin'), '*')
            const other = await preflight('/other')
            assert.equal(other.headers.get('access-control-allow-origin'), '*')
        })
    })

    it('matches only the submission and admin prefixes', () => {
        for (const p of ['/manie/submissions', '/manie/submissions/', '/manie/admin', '/manie/admin/api/x', '/MANIE/ADMIN']) {
            assert.ok(NO_CORS_PATH.test(p), p)
        }
        for (const p of ['/manie/sms-formats', '/manie/banners', '/manie/administer', '/other/manie/admin']) {
            assert.ok(!NO_CORS_PATH.test(p), p)
        }
    })
})
