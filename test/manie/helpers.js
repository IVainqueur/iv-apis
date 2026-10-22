const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.join(__dirname, '..', '..')

const express = require('express')
const { MemoryStore } = require('../../lib/manie/store')
const { createManieRouter } = require('../../routes/manie')

const TOKEN = 'test-admin-token-0123456789-abcdefghij'
const BASE_FILE = path.join(ROOT, 'assets', 'manie', 'sms-formats.json')

function loadBaseConfig() {
    return JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'))
}

async function startServer(options = {}) {
    const store = options.store || new MemoryStore()
    const env = options.env || { MANIE_ADMIN_TOKEN: TOKEN }
    const app = express()
    if (options.cors) app.use(require('cors')())
    if (options.hostParser) app.use(express.json({ limit: '100kb' }))
    app.use(
        '/manie',
        createManieRouter({
            store,
            env,
            base: options.base,
            now: options.now,
            servedTtlMs: options.servedTtlMs === undefined ? 0 : options.servedTtlMs,
            guard: options.guard,
            builtInIds: options.builtInIds,
            publicBudgetMs: options.publicBudgetMs,
        })
    )
    const server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}`

    async function request(method, urlPath, opts = {}) {
        const headers = Object.assign({}, opts.headers)
        if (opts.token) headers.Authorization = `Bearer ${opts.token}`
        let body
        if (opts.raw !== undefined) {
            body = opts.raw
        } else if (opts.body !== undefined) {
            body = JSON.stringify(opts.body)
            if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
        }
        const res = await fetch(url + urlPath, { method, headers, body })
        const text = await res.text()
        let json = null
        try {
            json = JSON.parse(text)
        } catch (err) {
            json = null
        }
        return { status: res.status, headers: res.headers, text, json }
    }

    const admin = (method, urlPath, body, token = TOKEN) =>
        request(method, `/manie/admin/api${urlPath}`, { token, body: method === 'GET' ? undefined : body || {} })

    return {
        url,
        store,
        env,
        request,
        admin,
        submit: (body, headers) => request('POST', '/manie/submissions', { body, headers }),
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve())
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            }),
    }
}

const SUBMISSION_APP = { version: '1.0.4', platform: 'android' }

function submission(items) {
    return { v: 1, items, app: SUBMISSION_APP }
}

module.exports = { startServer, loadBaseConfig, submission, TOKEN, SUBMISSION_APP, MemoryStore }
