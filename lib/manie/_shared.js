'use strict';

const crypto = require('node:crypto');
const vm = require('node:vm');

const VALID_TYPES = ['transfer', 'receive', 'payment', 'withdraw', 'deposit'];
const CAPTURE_ROLES = ['amount', 'fee', 'balance', 'secondParty', 'accountNumber', 'transactionId', 'agentName', 'agentNumber'];
const HINT_ROLES = ['amount', 'fee', 'balance', 'secondParty', 'accountNumber'];
const TIMESTAMP_PARSERS = ['iso8601', 'airtel-shortcode'];
const CARRIERS = ['mtn', 'airtel'];

// Ids that already exist in the base file or the KV store. Ids newly minted by
// the admin are held to the stricter MINTED_ID_RE.
const PATTERN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MINTED_ID_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;

const COUNT_SCRIPT = new vm.Script('new RegExp(__s + "|", __f).exec("").length - 1', {filename: 'manie-regex-count'});
const COUNT_TIMEOUT_MS = 100;

function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function sha256Hex(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// For trusted, already validated sources (the served config): no timeout that a busy
// process could trip, so a loaded server never drops a pattern by accident.
function countGroups(source, flags) {
    return new RegExp(`${source}|`, flags).exec('').length - 1;
}

// For admin-typed sources: compiled in a sandbox with a hard timeout.
function countGroupsSandboxed(source, flags) {
    const context = vm.createContext({__s: source, __f: flags}, {codeGeneration: {strings: false, wasm: false}});
    return COUNT_SCRIPT.runInContext(context, {timeout: COUNT_TIMEOUT_MS});
}

module.exports = {
    VALID_TYPES,
    CAPTURE_ROLES,
    HINT_ROLES,
    TIMESTAMP_PARSERS,
    CARRIERS,
    PATTERN_ID_RE,
    MINTED_ID_RE,
    isPlainObject,
    sha256Hex,
    countGroups,
    countGroupsSandboxed,
};
