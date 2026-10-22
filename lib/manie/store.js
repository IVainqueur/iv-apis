const { isPlainObject } = require('./_shared')

const KEY_PREFIX = 'manie:'
const MAX_KEY_LENGTH = 512
const MAX_VALUE_BYTES = 512 * 1024
const MAX_TTL_SEC = 315360000
const DEFAULT_TIMEOUT_MS = 5000
const SCAN_COUNT = 200
const SCAN_MAX_ROUNDS = 50
const SCAN_MAX_KEYS = 10000

class StoreError extends Error {
    constructor(code, message, extra) {
        super(message)
        this.name = 'StoreError'
        this.code = code
        if (extra && extra.status !== undefined) this.status = extra.status
        if (extra && extra.causeCode !== undefined) this.causeCode = extra.causeCode
    }
}

class RedisError extends Error {
    constructor(message) {
        super(message)
        this.name = 'RedisError'
    }
}

function setOwn(obj, key, value) {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

function normalizeKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || /[\u0000-\u001f]/.test(key)) {
        throw new StoreError('bad_key', 'invalid key')
    }
    return key.startsWith(KEY_PREFIX) ? key : KEY_PREFIX + key
}

function serialize(value) {
    let out
    try {
        out = JSON.stringify(value)
    } catch (err) {
        throw new StoreError('bad_value', 'value is not JSON-serialisable')
    }
    if (out === undefined) throw new StoreError('bad_value', 'value is not JSON-serialisable')
    if (Buffer.byteLength(out) > MAX_VALUE_BYTES) throw new StoreError('too_large', 'value too large')
    return out
}

function deserialize(raw) {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'string') return raw
    try {
        return JSON.parse(raw)
    } catch (err) {
        return raw
    }
}

function toMember(m) {
    if (typeof m === 'string' && m.length > 0 && m.length <= 1024) return m
    if (typeof m === 'number' && Number.isFinite(m)) return String(m)
    throw new StoreError('bad_arg', 'invalid member')
}

function toMembers(list) {
    const flat = list.flat()
    if (flat.length === 0) throw new StoreError('bad_arg', 'at least one member required')
    return flat.map(toMember)
}

function toField(f) {
    if (typeof f === 'string' && f.length > 0 && f.length <= 256) return f
    throw new StoreError('bad_arg', 'invalid hash field')
}

function toTtl(ex) {
    if (ex === undefined || ex === null) return undefined
    if (!Number.isInteger(ex) || ex < 1 || ex > MAX_TTL_SEC) throw new StoreError('bad_arg', 'invalid ttl')
    return ex
}

function toInt(n, name) {
    if (!Number.isSafeInteger(n)) throw new StoreError('bad_arg', `invalid ${name}`)
    return String(n)
}

function toScore(s) {
    if (typeof s !== 'number' || !Number.isFinite(s)) throw new StoreError('bad_arg', 'invalid score')
    return String(s)
}

function expectInt(v) {
    if (!Number.isSafeInteger(v)) throw new StoreError('protocol', 'unexpected reply type')
    return v
}

function expectArray(v) {
    if (!Array.isArray(v)) throw new StoreError('protocol', 'unexpected reply type')
    return v
}

function pairsToObject(result) {
    if (result === null || result === undefined) return null
    const out = {}
    if (Array.isArray(result)) {
        if (result.length % 2 !== 0) throw new StoreError('protocol', 'unexpected reply shape')
        for (let i = 0; i < result.length; i += 2) setOwn(out, String(result[i]), deserialize(result[i + 1]))
    } else if (isPlainObject(result)) {
        for (const k of Object.keys(result)) setOwn(out, k, deserialize(result[k]))
    } else {
        throw new StoreError('protocol', 'unexpected reply type')
    }
    return Object.keys(out).length ? out : null
}

function scoredPairs(result) {
    const arr = expectArray(result)
    if (arr.length % 2 !== 0) throw new StoreError('protocol', 'unexpected reply shape')
    const out = []
    for (let i = 0; i < arr.length; i += 2) out.push({ member: String(arr[i]), score: Number(arr[i + 1]) })
    return out
}

function globToRegExp(glob) {
    let src = ''
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]
        if (c === '\\' && i + 1 < glob.length) {
            src += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        } else if (c === '*') {
            src += '[\\s\\S]*'
        } else if (c === '?') {
            src += '[\\s\\S]'
        } else {
            src += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        }
    }
    return new RegExp(`^${src}$`)
}

function escapeGlob(s) {
    return s.replace(/[*?[\]\\]/g, '\\$&')
}

function parseRedisInt(str) {
    if (typeof str !== 'string' || !/^[+-]?\d+$/.test(str)) throw new RedisError('ERR value is not an integer or out of range')
    const n = Number(str)
    if (!Number.isSafeInteger(n)) throw new RedisError('ERR value is not an integer or out of range')
    return n
}

function parseRedisFloat(str) {
    const n = typeof str === 'string' && str.trim() !== '' ? Number(str) : NaN
    if (!Number.isFinite(n)) throw new RedisError('ERR value is not a valid float')
    return n
}

function clampRange(start, stop, len) {
    let s = start < 0 ? len + start : start
    let e = stop < 0 ? len + stop : stop
    if (s < 0) s = 0
    if (e >= len) e = len - 1
    if (len === 0 || s > e || s >= len) return null
    return [s, e]
}

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value'

class RedisEmulator {
    constructor(opts) {
        this.now = (opts && opts.now) || Date.now
        this.data = new Map()
        this.ops = 0
    }

    live(key, type) {
        const e = this.data.get(key)
        if (!e) return undefined
        if (e.expireAt !== undefined && e.expireAt <= this.now()) {
            this.data.delete(key)
            return undefined
        }
        if (type && e.type !== type) throw new RedisError(WRONGTYPE)
        return e
    }

    sweep() {
        for (const key of [...this.data.keys()]) this.live(key)
    }

    cleanup(key, entry) {
        const size = entry.type === 'string' ? 1 : entry.value.size
        if (size === 0) this.data.delete(key)
    }

    execute(args) {
        if (!Array.isArray(args) || args.length === 0) throw new RedisError('ERR empty command')
        for (const a of args) {
            if (typeof a !== 'string') throw new RedisError('ERR command arguments must be strings')
        }
        this.ops++
        if (this.ops % 500 === 0) this.sweep()
        const name = args[0].toUpperCase()
        const handler = HANDLERS[name]
        if (!handler) throw new RedisError(`ERR unknown command '${name}'`)
        return handler.call(this, args.slice(1))
    }

    incrBy(key, by) {
        const e = this.live(key, 'string')
        const next = (e ? parseRedisInt(e.value) : 0) + by
        if (!Number.isSafeInteger(next)) throw new RedisError('ERR increment or decrement would overflow')
        if (e) e.value = String(next)
        else this.data.set(key, { type: 'string', value: String(next), expireAt: undefined })
        return next
    }

    zrange(a, rev) {
        const [key, startS, stopS, ...opts] = a
        const withScores = opts.length === 1 && opts[0].toUpperCase() === 'WITHSCORES'
        if (opts.length > 0 && !withScores) throw new RedisError('ERR syntax error')
        const e = this.live(key, 'zset')
        if (!e) return []
        const sorted = [...e.value.entries()].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
        if (rev) sorted.reverse()
        const range = clampRange(parseRedisInt(startS), parseRedisInt(stopS), sorted.length)
        if (!range) return []
        const out = []
        for (const [member, score] of sorted.slice(range[0], range[1] + 1)) {
            out.push(member)
            if (withScores) out.push(String(score))
        }
        return out
    }
}

const HANDLERS = {
    GET([key]) {
        const e = this.live(key, 'string')
        return e ? e.value : null
    },
    SET([key, value, ...opts]) {
        let ex
        let nx = false
        for (let i = 0; i < opts.length; i++) {
            const o = opts[i].toUpperCase()
            if (o === 'EX') ex = parseRedisInt(opts[++i])
            else if (o === 'NX') nx = true
            else throw new RedisError('ERR syntax error')
        }
        if (ex !== undefined && ex <= 0) throw new RedisError('ERR invalid expire time in set')
        if (nx && this.live(key)) return null
        this.data.set(key, { type: 'string', value, expireAt: ex !== undefined ? this.now() + ex * 1000 : undefined })
        return 'OK'
    },
    DEL(keys) {
        let n = 0
        for (const k of keys) {
            if (this.live(k)) {
                this.data.delete(k)
                n++
            }
        }
        return n
    },
    EXISTS(keys) {
        return keys.filter(k => this.live(k)).length
    },
    EXPIRE([key, sec]) {
        const e = this.live(key)
        if (!e) return 0
        e.expireAt = this.now() + parseRedisInt(sec) * 1000
        return 1
    },
    TTL([key]) {
        const e = this.live(key)
        if (!e) return -2
        if (e.expireAt === undefined) return -1
        return Math.max(0, Math.ceil((e.expireAt - this.now()) / 1000))
    },
    INCR([key]) {
        return this.incrBy(key, 1)
    },
    INCRBY([key, by]) {
        return this.incrBy(key, parseRedisInt(by))
    },
    HSET([key, ...kv]) {
        if (kv.length === 0 || kv.length % 2 !== 0) throw new RedisError("ERR wrong number of arguments for 'hset' command")
        let e = this.live(key, 'hash')
        if (!e) {
            e = { type: 'hash', value: new Map(), expireAt: undefined }
            this.data.set(key, e)
        }
        let added = 0
        for (let i = 0; i < kv.length; i += 2) {
            if (!e.value.has(kv[i])) added++
            e.value.set(kv[i], kv[i + 1])
        }
        return added
    },
    HGET([key, field]) {
        const e = this.live(key, 'hash')
        return e && e.value.has(field) ? e.value.get(field) : null
    },
    HSETNX([key, field, value]) {
        let e = this.live(key, 'hash')
        if (e && e.value.has(field)) return 0
        if (!e) {
            e = { type: 'hash', value: new Map(), expireAt: undefined }
            this.data.set(key, e)
        }
        e.value.set(field, value)
        return 1
    },
    HGETALL([key]) {
        const e = this.live(key, 'hash')
        if (!e) return []
        const out = []
        for (const [f, v] of e.value) out.push(f, v)
        return out
    },
    HDEL([key, ...fields]) {
        const e = this.live(key, 'hash')
        if (!e) return 0
        let n = 0
        for (const f of fields) if (e.value.delete(f)) n++
        this.cleanup(key, e)
        return n
    },
    HINCRBY([key, field, by]) {
        const e0 = this.live(key, 'hash')
        const e = e0 || { type: 'hash', value: new Map(), expireAt: undefined }
        const next = (e.value.has(field) ? parseRedisInt(e.value.get(field)) : 0) + parseRedisInt(by)
        if (!Number.isSafeInteger(next)) throw new RedisError('ERR increment or decrement would overflow')
        e.value.set(field, String(next))
        if (!e0) this.data.set(key, e)
        return next
    },
    ZADD([key, ...sm]) {
        if (sm.length === 0 || sm.length % 2 !== 0) throw new RedisError("ERR wrong number of arguments for 'zadd' command")
        const pairs = []
        for (let i = 0; i < sm.length; i += 2) pairs.push([parseRedisFloat(sm[i]), sm[i + 1]])
        let e = this.live(key, 'zset')
        if (!e) {
            e = { type: 'zset', value: new Map(), expireAt: undefined }
            this.data.set(key, e)
        }
        let added = 0
        for (const [score, member] of pairs) {
            if (!e.value.has(member)) added++
            e.value.set(member, score)
        }
        return added
    },
    ZINCRBY([key, incr, member]) {
        const by = parseRedisFloat(incr)
        const e0 = this.live(key, 'zset')
        const e = e0 || { type: 'zset', value: new Map(), expireAt: undefined }
        const next = (e.value.get(member) || 0) + by
        e.value.set(member, next)
        if (!e0) this.data.set(key, e)
        return String(next)
    },
    ZSCORE([key, member]) {
        const e = this.live(key, 'zset')
        return e && e.value.has(member) ? String(e.value.get(member)) : null
    },
    ZCARD([key]) {
        const e = this.live(key, 'zset')
        return e ? e.value.size : 0
    },
    ZREM([key, ...members]) {
        const e = this.live(key, 'zset')
        if (!e) return 0
        let n = 0
        for (const m of members) if (e.value.delete(m)) n++
        this.cleanup(key, e)
        return n
    },
    ZRANGE(a) {
        return this.zrange(a, false)
    },
    ZREVRANGE(a) {
        return this.zrange(a, true)
    },
    SADD([key, ...members]) {
        if (members.length === 0) throw new RedisError("ERR wrong number of arguments for 'sadd' command")
        let e = this.live(key, 'set')
        if (!e) {
            e = { type: 'set', value: new Set(), expireAt: undefined }
            this.data.set(key, e)
        }
        let added = 0
        for (const m of members) {
            if (!e.value.has(m)) {
                e.value.add(m)
                added++
            }
        }
        return added
    },
    SREM([key, ...members]) {
        const e = this.live(key, 'set')
        if (!e) return 0
        let n = 0
        for (const m of members) if (e.value.delete(m)) n++
        this.cleanup(key, e)
        return n
    },
    SMEMBERS([key]) {
        const e = this.live(key, 'set')
        return e ? [...e.value] : []
    },
    SCARD([key]) {
        const e = this.live(key, 'set')
        return e ? e.value.size : 0
    },
    SCAN([cursor, ...opts]) {
        let match = null
        let count = 10
        for (let i = 0; i < opts.length; i++) {
            const o = opts[i].toUpperCase()
            if (o === 'MATCH') match = globToRegExp(opts[++i] || '')
            else if (o === 'COUNT') count = parseRedisInt(opts[++i])
            else throw new RedisError('ERR syntax error')
        }
        const start = parseRedisInt(cursor)
        const keys = [...this.data.keys()].filter(k => this.live(k)).sort()
        const end = Math.min(keys.length, start + count)
        const page = keys.slice(start, end).filter(k => !match || match.test(k))
        return [end >= keys.length ? '0' : String(end), page]
    },
}

class StoreBase {
    async _run() {
        throw new StoreError('not_implemented', 'store backend missing')
    }

    async _pipeline(commands) {
        const out = []
        for (const c of commands) out.push(await this._run(c))
        return out
    }

    async get(key) {
        return deserialize(await this._run(['GET', normalizeKey(key)]))
    }

    async set(key, value, opts) {
        const k = normalizeKey(key)
        const cmd = ['SET', k, serialize(value)]
        const ex = toTtl(opts && opts.ex)
        if (ex !== undefined) cmd.push('EX', String(ex))
        if (opts && opts.nx) cmd.push('NX')
        return (await this._run(cmd)) === 'OK'
    }

    async del(...keys) {
        const list = keys.flat()
        if (list.length === 0) return 0
        return expectInt(await this._run(['DEL', ...list.map(normalizeKey)]))
    }

    async exists(key) {
        return expectInt(await this._run(['EXISTS', normalizeKey(key)])) === 1
    }

    async expire(key, sec) {
        const ttl = toTtl(sec)
        if (ttl === undefined) throw new StoreError('bad_arg', 'invalid ttl')
        return expectInt(await this._run(['EXPIRE', normalizeKey(key), String(ttl)])) === 1
    }

    async ttl(key) {
        return expectInt(await this._run(['TTL', normalizeKey(key)]))
    }

    async incr(key, opts) {
        const k = normalizeKey(key)
        const ex = toTtl(opts && opts.ex)
        const by = opts && opts.by !== undefined ? opts.by : 1
        const cmds = []
        if (ex !== undefined) cmds.push(['SET', k, '0', 'EX', String(ex), 'NX'])
        cmds.push(by === 1 ? ['INCR', k] : ['INCRBY', k, toInt(by, 'increment')])
        if (cmds.length === 1) return expectInt(await this._run(cmds[0]))
        const results = await this._pipeline(cmds)
        return expectInt(results[results.length - 1])
    }

    async hset(key, obj) {
        const k = normalizeKey(key)
        if (!isPlainObject(obj)) throw new StoreError('bad_arg', 'hset expects an object')
        const cmd = ['HSET', k]
        for (const f of Object.keys(obj)) {
            if (obj[f] === undefined || typeof obj[f] === 'function' || typeof obj[f] === 'symbol') continue
            cmd.push(toField(f), serialize(obj[f]))
        }
        if (cmd.length === 2) return 0
        return expectInt(await this._run(cmd))
    }

    async hget(key, field) {
        return deserialize(await this._run(['HGET', normalizeKey(key), toField(field)]))
    }

    async hsetnx(key, field, value) {
        return expectInt(await this._run(['HSETNX', normalizeKey(key), toField(field), serialize(value)])) === 1
    }

    async hgetall(key) {
        return pairsToObject(await this._run(['HGETALL', normalizeKey(key)]))
    }

    async hdel(key, ...fields) {
        const list = fields.flat().map(toField)
        if (list.length === 0) return 0
        return expectInt(await this._run(['HDEL', normalizeKey(key), ...list]))
    }

    async hincrby(key, field, by) {
        return expectInt(await this._run(['HINCRBY', normalizeKey(key), toField(field), toInt(by === undefined ? 1 : by, 'increment')]))
    }

    async zadd(key, score, member) {
        return expectInt(await this._run(['ZADD', normalizeKey(key), toScore(score), toMember(member)]))
    }

    async zincrby(key, by, member) {
        const res = await this._run(['ZINCRBY', normalizeKey(key), toScore(by), toMember(member)])
        const n = Number(res)
        if (!Number.isFinite(n)) throw new StoreError('protocol', 'unexpected reply type')
        return n
    }

    async zscore(key, member) {
        const res = await this._run(['ZSCORE', normalizeKey(key), toMember(member)])
        return res === null ? null : Number(res)
    }

    async zcard(key) {
        return expectInt(await this._run(['ZCARD', normalizeKey(key)]))
    }

    async zrem(key, ...members) {
        return expectInt(await this._run(['ZREM', normalizeKey(key), ...toMembers(members)]))
    }

    async zrange(key, start, stop, opts) {
        return this._zrange('ZRANGE', key, start, stop, opts)
    }

    async zrevrange(key, start, stop, opts) {
        return this._zrange('ZREVRANGE', key, start, stop, opts)
    }

    async _zrange(cmd, key, start, stop, opts) {
        const withScores = Boolean(opts && opts.withScores)
        const args = [cmd, normalizeKey(key), toInt(start, 'start'), toInt(stop, 'stop')]
        if (withScores) args.push('WITHSCORES')
        const res = await this._run(args)
        if (withScores) return scoredPairs(res)
        return expectArray(res).map(String)
    }

    async sadd(key, ...members) {
        return expectInt(await this._run(['SADD', normalizeKey(key), ...toMembers(members)]))
    }

    async smembers(key) {
        return expectArray(await this._run(['SMEMBERS', normalizeKey(key)])).map(String)
    }

    async srem(key, ...members) {
        return expectInt(await this._run(['SREM', normalizeKey(key), ...toMembers(members)]))
    }

    async scard(key) {
        return expectInt(await this._run(['SCARD', normalizeKey(key)]))
    }

    async keys(prefix) {
        const p = normalizeKey(prefix === undefined || prefix === '' ? KEY_PREFIX : prefix)
        const found = new Set()
        let cursor = '0'
        for (let round = 0; round < SCAN_MAX_ROUNDS; round++) {
            const res = expectArray(await this._run(['SCAN', cursor, 'MATCH', `${escapeGlob(p)}*`, 'COUNT', String(SCAN_COUNT)]))
            if (res.length !== 2 || !Array.isArray(res[1])) throw new StoreError('protocol', 'unexpected reply shape')
            for (const k of res[1]) found.add(String(k))
            cursor = String(res[0])
            if (cursor === '0' || found.size >= SCAN_MAX_KEYS) break
        }
        return [...found].sort()
    }
}

class MemoryStore extends StoreBase {
    constructor(opts) {
        super()
        this.kind = 'memory'
        this.persistent = false
        this.isDegraded = false
        this.engine = new RedisEmulator({ now: opts && opts.now })
    }

    async _run(args) {
        try {
            return this.engine.execute(args)
        } catch (err) {
            if (err instanceof RedisError) throw new StoreError('redis', err.message)
            throw err
        }
    }

    flush() {
        this.engine.data.clear()
    }

    snapshot() {
        const out = []
        for (const key of [...this.engine.data.keys()].sort()) {
            const e = this.engine.live(key)
            if (!e) continue
            let value = e.value
            if (e.type === 'hash') value = Object.fromEntries(e.value)
            else if (e.type === 'set') value = [...e.value]
            else if (e.type === 'zset') value = Object.fromEntries(e.value)
            out.push({ key, type: e.type, value })
        }
        return out
    }
}

function truncate(s, n) {
    return s.length > n ? s.slice(0, n) : s
}

class UpstashStore extends StoreBase {
    constructor(opts) {
        super()
        if (!opts || typeof opts.url !== 'string' || typeof opts.token !== 'string') {
            throw new StoreError('config', 'url and token are required')
        }
        const url = parseKvUrl(opts.url)
        if (!url) throw new StoreError('config', 'url must be https (or http on a loopback host)')
        this.kind = 'upstash'
        this.persistent = true
        this.url = url
        this.token = opts.token
        this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
        this.fetchImpl = opts.fetch || null
        this.failures = 0
    }

    get isDegraded() {
        return this.failures > 0
    }

    async _request(path, body) {
        const doFetch = this.fetchImpl || globalThis.fetch
        if (typeof doFetch !== 'function') throw new StoreError('config', 'fetch is not available')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
            let res
            let text
            try {
                res = await doFetch(this.url + path, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                    redirect: 'error',
                })
                text = await res.text()
            } catch (err) {
                if (controller.signal.aborted || (err && err.name === 'AbortError')) {
                    throw new StoreError('timeout', `store request timed out after ${this.timeoutMs}ms`)
                }
                const causeCode = (err && err.cause && err.cause.code) || (err && err.code) || undefined
                throw new StoreError('network', 'store request failed', { causeCode })
            }
            let json
            try {
                json = JSON.parse(text)
            } catch (err) {
                json = undefined
            }
            if (!res.ok) {
                const detail = json && typeof json.error === 'string' ? `: ${truncate(json.error, 200)}` : ''
                throw new StoreError('http', `store responded ${res.status}${detail}`, { status: res.status })
            }
            if (json === undefined) throw new StoreError('protocol', 'store returned malformed JSON')
            return json
        } finally {
            clearTimeout(timer)
        }
    }

    async _track(promise) {
        try {
            const out = await promise
            this.failures = 0
            return out
        } catch (err) {
            this.failures++
            throw err
        }
    }

    _run(args) {
        return this._track(
            this._request('', args).then(json => {
                if (!isPlainObject(json)) throw new StoreError('protocol', 'unexpected reply envelope')
                if (json.error !== undefined && json.error !== null) {
                    throw new StoreError('redis', truncate(String(json.error), 200))
                }
                if (!('result' in json)) throw new StoreError('protocol', 'reply has no result')
                return json.result
            }),
        )
    }

    _pipeline(commands) {
        return this._track(
            this._request('/pipeline', commands).then(json => {
                if (!Array.isArray(json) || json.length !== commands.length) {
                    throw new StoreError('protocol', 'unexpected pipeline reply')
                }
                return json.map(item => {
                    if (!isPlainObject(item)) throw new StoreError('protocol', 'unexpected pipeline reply')
                    if (item.error !== undefined && item.error !== null) {
                        throw new StoreError('redis', truncate(String(item.error), 200))
                    }
                    if (!('result' in item)) throw new StoreError('protocol', 'reply has no result')
                    return item.result
                })
            }),
        )
    }
}

function loopbackHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function parseKvUrl(value) {
    if (typeof value !== 'string' || !value) return null
    let parsed
    try {
        parsed = new URL(value)
    } catch (err) {
        return null
    }
    const secure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopbackHost(parsed.hostname))
    return secure ? value.replace(/\/+$/, '') : null
}

function resolveUpstashConfig(env) {
    const pairs = [
        [env.KV_REST_API_URL, env.KV_REST_API_TOKEN],
        [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN],
    ]
    for (const [rawUrl, token] of pairs) {
        const url = parseKvUrl(rawUrl)
        if (url && typeof token === 'string' && token) return { url, token }
    }
    return null
}

function createStore(env, opts) {
    const e = env || process.env
    const options = opts || {}
    const cfg = resolveUpstashConfig(e)
    if (cfg) {
        return new UpstashStore({ url: cfg.url, token: cfg.token, timeoutMs: options.timeoutMs, fetch: options.fetch })
    }
    if (e.NODE_ENV === 'production') console.warn('[manie] KV is not configured, falling back to an in-memory store')
    return new MemoryStore({ now: options.now })
}

module.exports = {
    createStore,
    MemoryStore,
    UpstashStore,
    StoreError,
    RedisEmulator,
    KEY_PREFIX,
    normalizeKey,
    resolveUpstashConfig,
}
