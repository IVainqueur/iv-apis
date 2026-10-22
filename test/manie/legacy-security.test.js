const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..')

// The hardening of the legacy /zipped route is NOT part of this branch (the owner chose to
// isolate the new routes only, and routes/zipped.js is untouched). It lives in a patch that
// is offered separately. These checks exist so that the patch stays proven: they run against
// a temporary copy of routes/zipped.js with the patch applied, and only when asked to.
const PATCH_FILE =
    process.env.MANIE_TEST_ZIPPED_PATCH_FILE ||
    '/private/tmp/claude-501/-Users-ivainqueur--claude-spares-spare-kXvGEV/cea600b6-9b07-4a39-a7f3-2cf6f745325b/scratchpad/zipped-hardening.patch'
const SKIP =
    process.env.MANIE_TEST_ZIPPED_PATCH === '1'
        ? false
        : 'legacy /zipped hardening is intentionally not applied on this branch (owner decision: isolate only); set MANIE_TEST_ZIPPED_PATCH=1 to run these checks against a temp copy of routes/zipped.js with zipped-hardening.patch applied (MANIE_TEST_ZIPPED_PATCH_FILE overrides the patch location)'

function buildSandbox() {
    assert.ok(fs.existsSync(PATCH_FILE), `MANIE_TEST_ZIPPED_PATCH=1 needs the patch file at ${PATCH_FILE}`)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manie-zipped-'))
    fs.mkdirSync(path.join(dir, 'routes'))
    fs.mkdirSync(path.join(dir, 'tmp', 'validFolder1234567890'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'routes', 'zipped.js'), path.join(dir, 'routes', 'zipped.js'))
    execFileSync('patch', ['-p1', '-s', '-d', dir, '-i', PATCH_FILE], { stdio: 'pipe' })
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
    fs.writeFileSync(path.join(dir, '.env'), 'CANARY_SECRET=do-not-leak\n')
    fs.writeFileSync(path.join(dir, 'tmp', 'validFolder1234567890', 'ok.zip'), 'PK-not-really-a-zip')
    return dir
}

describe('legacy /zipped/download path traversal (R1-01), against the patched copy of routes/zipped.js', { skip: SKIP }, () => {
    let sandbox
    let server
    let base

    before(async () => {
        sandbox = buildSandbox()
        const express = require('express')
        const app = express()
        app.use('/zipped', require(path.join(sandbox, 'routes', 'zipped.js')))
        server = http.createServer(app)
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        base = `http://127.0.0.1:${server.address().port}`
    })

    after(async () => {
        if (server) {
            await new Promise((resolve) => {
                server.close(() => resolve())
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            })
        }
        if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true })
    })

    const get = async (urlPath) => {
        const res = await fetch(base + urlPath)
        return { status: res.status, text: await res.text() }
    }

    it('never serves or deletes anything outside tmp/', async () => {
        const attempts = [
            '/zipped/download/..%2F..%2Fapp/.env?filename=x',
            '/zipped/download/..%2F/.env?filename=x',
            '/zipped/download/..%2F..%2F/.env',
            '/zipped/download/validFolder1234567890/..%2F..%2F.env',
            '/zipped/download/validFolder1234567890/..%2Fvalid.zip',
            '/zipped/download/..%2Froutes/zipped.js',
            '/zipped/download/%2e%2e%2f%2e%2e/.env',
            '/zipped/download/validFolder1234567890/..%5C..%5C.env',
            '/zipped/download/validFolder1234567890/%00.zip',
        ]
        for (const attempt of attempts) {
            const res = await get(attempt)
            assert.ok(res.status >= 400, `${attempt} answered ${res.status}`)
            assert.ok(!res.text.includes('do-not-leak'), `${attempt} leaked the canary`)
        }
        assert.ok(fs.existsSync(path.join(sandbox, '.env')), 'sandbox root must survive')
        assert.ok(fs.existsSync(path.join(sandbox, 'routes', 'zipped.js')))
        assert.ok(fs.existsSync(path.join(sandbox, 'tmp', 'validFolder1234567890', 'ok.zip')), 'valid folder untouched by failed attempts')
    })

    it('rejects non-zip file names even inside a valid folder', async () => {
        fs.writeFileSync(path.join(sandbox, 'tmp', 'validFolder1234567890', 'secret.txt'), 'inside-tmp')
        const res = await get('/zipped/download/validFolder1234567890/secret.txt')
        assert.equal(res.status, 404)
        assert.ok(!res.text.includes('inside-tmp'))
    })

    it('still downloads a legitimate zip once and removes its folder afterwards', async () => {
        const res = await get('/zipped/download/validFolder1234567890/ok.zip?filename=bundle')
        assert.equal(res.status, 200)
        assert.equal(res.text, 'PK-not-really-a-zip')
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.ok(!fs.existsSync(path.join(sandbox, 'tmp', 'validFolder1234567890')), 'folder is cleaned up after download')
        assert.ok(fs.existsSync(path.join(sandbox, 'tmp')))
        assert.ok(fs.existsSync(path.join(sandbox, '.env')))
    })
})
