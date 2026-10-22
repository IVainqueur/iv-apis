const crypto = require('node:crypto')
const net = require('node:net')
const { normalizeIp, createLocalLimiter } = require('./ratelimit')

const MIN_TOKEN_LENGTH = 24
const MIN_TOKEN_DISTINCT = 8
const MIN_SALT_LENGTH = 16
const MAX_PRESENTED_LENGTH = 512
const FAIL_MAX = 10
const ATTEMPT_MAX = 50
const FAIL_WINDOW_SEC = 15 * 60

let processSalt = null
let warnedSalt = false

function digest(value) {
    return crypto.createHash('sha256').update(String(value)).digest()
}

function tokenMatches(provided, expected) {
    return crypto.timingSafeEqual(digest(provided), digest(expected))
}

function isStrongToken(value) {
    if (typeof value !== 'string' || value.length < MIN_TOKEN_LENGTH) return false
    if (new Set(value).size < MIN_TOKEN_DISTINCT) return false
    for (let size = 1; size <= value.length / 2; size++) {
        if (value.length % size === 0 && value === value.slice(0, size).repeat(value.length / size)) return false
    }
    let steps = 0
    for (let i = 1; i < value.length; i++) {
        if (Math.abs(value.charCodeAt(i) - value.charCodeAt(i - 1)) === 1) steps++
    }
    return steps / (value.length - 1) <= 0.7
}

function bearerToken(req) {
    const header = req.headers && req.headers.authorization
    if (typeof header !== 'string') return null
    const m = /^Bearer[ \t]+(\S+)$/i.exec(header.trim())
    return m ? m[1] : null
}

function firstHeader(req, name) {
    const v = req.headers && req.headers[name]
    if (Array.isArray(v)) return v[0]
    return typeof v === 'string' ? v : ''
}

function validIp(value) {
    const ip = String(value || '').trim().replace(/^::ffff:/i, '')
    return net.isIP(ip) ? ip : ''
}

function positiveHops(value) {
    const n = Number(value)
    return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1
}

function isProduction(env) {
    const e = env || {}
    return Boolean(e.VERCEL || e.NODE_ENV === 'production')
}

// Only headers that the deployment itself overwrites are believed: the Vercel
// platform header on Vercel, an operator-named single header, or the entry of
// X-Forwarded-For that is MANIE_TRUSTED_HOPS proxies from the right. The leftmost
// entry and x-real-ip are client controlled and never used on their own.
function clientIp(req, env) {
    const e = env || {}
    let ip = ''
    if (e.VERCEL) {
        ip = validIp(firstHeader(req, 'x-vercel-forwarded-for').split(',')[0])
    } else if (e.MANIE_TRUST_PROXY === '1') {
        const named = typeof e.MANIE_CLIENT_IP_HEADER === 'string' ? e.MANIE_CLIENT_IP_HEADER.trim().toLowerCase() : ''
        if (/^[a-z0-9-]{1,64}$/.test(named)) {
            const parts = firstHeader(req, named).split(',')
            ip = validIp(parts[parts.length - 1])
        } else {
            const parts = firstHeader(req, 'x-forwarded-for').split(',').map(s => s.trim()).filter(Boolean)
            const hops = positiveHops(e.MANIE_TRUSTED_HOPS)
            if (parts.length >= hops) ip = validIp(parts[parts.length - hops])
        }
    }
    if (!ip) ip = String((req.socket && req.socket.remoteAddress) || req.ip || 'unknown').replace(/^::ffff:/i, '')
    return ip.slice(0, 64)
}

function hashSalt(env) {
    const e = env || {}
    if (typeof e.MANIE_HASH_SALT === 'string' && e.MANIE_HASH_SALT.length >= MIN_SALT_LENGTH) {
        return { salt: e.MANIE_HASH_SALT, configured: true }
    }
    if (!processSalt) processSalt = crypto.randomBytes(32).toString('hex')
    if (!warnedSalt && isProduction(e)) {
        warnedSalt = true
        console.warn('[manie] MANIE_HASH_SALT is not set (or shorter than 16 characters): using a per-process salt, rate limits will not hold across instances')
    }
    return { salt: processSalt, configured: false }
}

function ipHash(req, env) {
    const { salt } = hashSalt(env)
    return crypto.createHmac('sha256', salt).update(normalizeIp(clientIp(req, env))).digest('hex').slice(0, 32)
}

function stripCors(res) {
    res.removeHeader('Access-Control-Allow-Origin')
    res.removeHeader('Access-Control-Allow-Credentials')
    res.removeHeader('Access-Control-Expose-Headers')
}

function logAuthError(err) {
    console.error('[manie] auth limiter unavailable:', err && err.name ? err.name : 'error')
}

function requireAdmin({ store, env, local }) {
    const environment = env || {}
    const memo = local || createLocalLimiter({ max: ATTEMPT_MAX, windowSec: FAIL_WINDOW_SEC })
    return async function manieRequireAdmin(req, res, next) {
        try {
            res.set('Cache-Control', 'no-store')
            stripCors(res)

            const expected = environment.MANIE_ADMIN_TOKEN
            if (!isStrongToken(expected)) {
                return res.status(503).json({ error: 'admin_disabled' })
            }

            const presented = bearerToken(req)
            if (!presented) {
                res.set('WWW-Authenticate', 'Bearer realm="manie-admin"')
                return res.status(401).json({ error: 'unauthorized' })
            }

            // The constant-time comparison is pure CPU and costs no KV command, so it runs
            // first and a correct token always passes: a neighbour on a shared address who
            // burns the failure budget cannot lock the admin out. Only wrong tokens count
            // towards, and are blocked by, the per-address limiter.
            if (presented.length <= MAX_PRESENTED_LENGTH && tokenMatches(presented, expected)) {
                return next()
            }

            const failKey = `manie:authfail:${ipHash(req, environment)}`
            const blocked = memo.lockedFor(failKey)
            if (blocked) {
                res.set('Retry-After', String(blocked))
                return res.status(429).json({ error: 'too_many_attempts' })
            }

            // The attempt is reserved atomically, so a burst of concurrent guesses is
            // numbered by the store and only the first FAIL_MAX of them get a 401.
            let attempts
            try {
                attempts = Number(await store.incr(failKey, { ex: FAIL_WINDOW_SEC }))
            } catch (err) {
                logAuthError(err)
                attempts = NaN
            }
            if (!Number.isFinite(attempts)) {
                const fallback = memo.hit(`${failKey}:fallback`)
                attempts = fallback.allowed ? 1 : ATTEMPT_MAX + 1
            }
            if (attempts > ATTEMPT_MAX) {
                memo.lock(failKey, FAIL_WINDOW_SEC)
                res.set('Retry-After', String(FAIL_WINDOW_SEC))
                return res.status(429).json({ error: 'too_many_attempts' })
            }

            if (attempts > FAIL_MAX) {
                res.set('Retry-After', String(FAIL_WINDOW_SEC))
                return res.status(429).json({ error: 'too_many_attempts' })
            }
            res.set('WWW-Authenticate', 'Bearer realm="manie-admin"')
            return res.status(401).json({ error: 'unauthorized' })
        } catch (err) {
            return next(err)
        }
    }
}

module.exports = {
    requireAdmin,
    tokenMatches,
    bearerToken,
    clientIp,
    ipHash,
    hashSalt,
    isProduction,
    isStrongToken,
    stripCors,
    MIN_TOKEN_LENGTH,
    MIN_SALT_LENGTH,
    FAIL_MAX,
    ATTEMPT_MAX,
    FAIL_WINDOW_SEC,
}
