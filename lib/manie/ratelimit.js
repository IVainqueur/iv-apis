const net = require('node:net')

function ipv6Groups(addr) {
    let a = addr
    const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a)
    if (v4) {
        const hi = ((Number(v4[1]) << 8) | Number(v4[2])).toString(16)
        const lo = ((Number(v4[3]) << 8) | Number(v4[4])).toString(16)
        a = `${a.slice(0, v4.index)}${hi}:${lo}`
    }
    const halves = a.split('::')
    if (halves.length > 2) return null
    const head = halves[0] ? halves[0].split(':') : []
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
    let groups
    if (halves.length === 1) {
        groups = head
    } else {
        const fill = 8 - head.length - tail.length
        if (fill < 0) return null
        groups = [...head, ...new Array(fill).fill('0'), ...tail]
    }
    if (groups.length !== 8) return null
    return groups.map(g => g.padStart(4, '0'))
}

function normalizeIp(raw) {
    let s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!s) return 'unknown'
    const zone = s.indexOf('%')
    if (zone !== -1) s = s.slice(0, zone)
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
    if (mapped) s = mapped[1]
    if (net.isIPv4(s)) return s
    if (net.isIPv6(s)) {
        const groups = ipv6Groups(s)
        return groups ? `${groups.slice(0, 4).join(':')}::/64` : s
    }
    return s.slice(0, 128)
}

function positiveInt(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
    return value
}

const defaultWarn = (...args) => console.warn(...args)

// Decrement a fixed-window counter without ever leaving it without a TTL: the
// window is re-applied if the key expired between the INCR and the refund, and a
// counter that went negative in that race is brought back to zero.
async function refund(store, key, cost, windowSec, warn = defaultWarn) {
    try {
        const after = Number(await store.incr(key, { by: -cost, ex: windowSec }))
        if (Number.isFinite(after) && after < 0) await store.incr(key, { by: -after })
        return true
    } catch (err) {
        warn('[manie] rate limiter rollback failed:', (err && (err.code || err.name)) || 'error')
        return false
    }
}

async function rateLimit(store, key, opts) {
    const o = opts || {}
    const max = positiveInt(o.max, 'max')
    const windowSec = positiveInt(o.windowSec, 'windowSec')
    const cost = o.cost === undefined ? 1 : positiveInt(o.cost, 'cost')
    const failOpen = o.failOpen !== false
    const warn = typeof o.log === 'function' ? o.log : defaultWarn
    try {
        const count = Number(await store.incr(key, { ex: windowSec, by: cost }))
        if (!Number.isFinite(count)) throw new Error('counter is not numeric')
        if (count <= max) return { allowed: true, remaining: max - count, limit: max, retryAfterSec: 0 }

        let retryAfterSec = windowSec
        await refund(store, key, cost, windowSec, warn)
        try {
            const ttl = await store.ttl(key)
            if (ttl === -1) await store.expire(key, windowSec)
            else if (Number.isFinite(ttl) && ttl > 0) retryAfterSec = Math.min(ttl, windowSec)
        } catch (err) {
            retryAfterSec = windowSec
        }
        return { allowed: false, remaining: Math.max(0, max - (count - cost)), limit: max, retryAfterSec }
    } catch (err) {
        warn('[manie] rate limiter unavailable:', (err && (err.code || err.name)) || 'error')
        return failOpen
            ? { allowed: true, remaining: max, limit: max, retryAfterSec: 0, degraded: true }
            : { allowed: false, remaining: 0, limit: max, retryAfterSec: windowSec, degraded: true }
    }
}

// Per-instance, in-memory counters that sit in front of the KV limiters so that
// callers who are already blocked (or flooding) cost no KV commands at all.
function createLocalLimiter({ max, windowSec, maxKeys = 5000, now = Date.now } = {}) {
    const limit = positiveInt(max, 'max')
    const windowMs = positiveInt(windowSec, 'windowSec') * 1000
    const buckets = new Map()
    const locks = new Map()

    function prune(map, t) {
        if (map.size < maxKeys) return
        for (const [k, v] of map) {
            if ((v.resetAt !== undefined ? v.resetAt : v) <= t) map.delete(k)
        }
        while (map.size >= maxKeys) map.delete(map.keys().next().value)
    }

    return {
        hit(key, cost = 1) {
            const t = now()
            let b = buckets.get(key)
            if (!b || b.resetAt <= t) {
                prune(buckets, t)
                b = { count: 0, resetAt: t + windowMs }
                buckets.set(key, b)
            }
            b.count += cost
            if (b.count <= limit) return { allowed: true, retryAfterSec: 0 }
            return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - t) / 1000)) }
        },
        lock(key, seconds) {
            const t = now()
            prune(locks, t)
            locks.set(key, t + seconds * 1000)
        },
        lockedFor(key) {
            const until = locks.get(key)
            if (until === undefined) return 0
            const t = now()
            if (until <= t) {
                locks.delete(key)
                return 0
            }
            return Math.max(1, Math.ceil((until - t) / 1000))
        },
        clear() {
            buckets.clear()
            locks.clear()
        },
    }
}

module.exports = {
    rateLimit,
    refund,
    createLocalLimiter,
    normalizeIp,
}
