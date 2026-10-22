const { AsyncLocalStorage } = require('node:async_hooks')
const { StoreError } = require('./store')

const requestScope = new AsyncLocalStorage()

const METHODS = [
    'get', 'set', 'del', 'exists', 'expire', 'ttl', 'incr',
    'hset', 'hsetnx', 'hget', 'hgetall', 'hdel', 'hincrby',
    'zadd', 'zincrby', 'zscore', 'zcard', 'zrem', 'zrange', 'zrevrange',
    'sadd', 'smembers', 'srem', 'scard', 'keys',
]
const LOGIC_ERROR_CODES = new Set(['bad_key', 'bad_value', 'too_large', 'bad_arg', 'config', 'not_implemented', 'redis'])

function isInfrastructureFailure(err) {
    if (err instanceof StoreError) return !LOGIC_ERROR_CODES.has(err.code)
    return true
}

function race(promise, ms) {
    let timer
    promise.catch(() => {})
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new StoreError('timeout', `store call exceeded ${ms}ms`)), Math.max(1, ms))
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Wraps a store so that every call (a) honours the deadline of the request that
// issued it, (b) is cut off after callTimeoutMs, and (c) fails fast for openMs once
// failureThreshold consecutive calls failed, instead of stacking 5 s timeouts.
function createGuardedStore(store, options = {}) {
    const callTimeoutMs = options.callTimeoutMs || 3000
    const failureThreshold = options.failureThreshold || 3
    const openMs = options.openMs === undefined ? 5000 : options.openMs
    const now = options.now || Date.now
    const state = { failures: 0, openUntil: 0 }
    const guarded = {
        get persistent() {
            return store.persistent
        },
        get kind() {
            return store.kind
        },
        get isOpen() {
            return state.openUntil > now()
        },
        reset() {
            state.failures = 0
            state.openUntil = 0
        },
        runWithDeadline(ms, fn) {
            return requestScope.run({ deadline: now() + ms }, fn)
        },
        raw: store,
    }
    for (const name of METHODS) {
        if (typeof store[name] !== 'function') continue
        guarded[name] = async (...args) => {
            const t = now()
            if (state.openUntil > t) throw new StoreError('circuit_open', 'storage is temporarily unavailable')
            let budget = callTimeoutMs
            const scope = requestScope.getStore()
            if (scope && scope.deadline) {
                budget = Math.min(budget, scope.deadline - t)
                if (budget <= 0) throw new StoreError('timeout', 'request deadline exceeded')
            }
            try {
                const result = await race(Promise.resolve().then(() => store[name](...args)), budget)
                state.failures = 0
                return result
            } catch (caught) {
                const err = caught instanceof StoreError ? caught : new StoreError('network', 'store call failed')
                if (isInfrastructureFailure(err)) {
                    state.failures += 1
                    if (state.failures >= failureThreshold) state.openUntil = now() + openMs
                }
                throw err
            }
        }
    }
    return guarded
}

module.exports = { createGuardedStore, isInfrastructureFailure }
