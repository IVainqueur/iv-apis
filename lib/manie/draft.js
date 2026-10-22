'use strict';

const {
    VALID_TYPES,
    CAPTURE_ROLES,
    sha256Hex16,
    tokenizeSkeleton,
    normalizeTokens,
    tokensToSkeleton,
    computeLayout,
    layoutOf,
    guessType,
    guessLocale,
    assignRoles,
    ambiguousWordSlots,
    buildPattern,
    groupOf,
    parseWordsAsLiteral,
    applyWordReplacements,
} = require('./_fields');
const {runGate} = require('./gate');

const CARRIERS = ['mtn', 'airtel'];

function invalid(code, message) {
    return Object.assign(new Error(message), {code});
}

function coerceNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
    return value;
}

function applyCaptureOverrides(captureMap, timestamp, override, notes) {
    if (!override || typeof override !== 'object') return timestamp;
    let nextTimestamp = timestamp;
    const touched = new Set();
    for (const [role, raw] of Object.entries(override)) {
        const removed = raw === null || raw === undefined || raw === '' || raw === 0 || raw === false;
        if (role === 'timestamp') {
            if (removed) nextTimestamp = undefined;
            else nextTimestamp = {parser: nextTimestamp ? nextTimestamp.parser : 'iso8601', group: coerceNumber(raw)};
            notes.push('timestamp group set by admin');
            continue;
        }
        if (!CAPTURE_ROLES.includes(role)) {
            notes.push(`ignored unknown captureMap role "${role}"`);
            continue;
        }
        touched.add(role);
        if (removed) {
            delete captureMap[role];
            notes.push(`${role} capture removed by admin`);
        } else {
            captureMap[role] = coerceNumber(raw);
            notes.push(`${role} group set to ${JSON.stringify(raw)} by admin`);
        }
    }
    const claimed = new Set(Array.from(touched).filter(r => captureMap[r] !== undefined).map(r => captureMap[r]));
    for (const role of Object.keys(captureMap)) {
        if (!touched.has(role) && claimed.has(captureMap[role])) {
            delete captureMap[role];
            notes.push(`${role} capture dropped because an admin edit claimed its group`);
        }
    }
    return nextTimestamp;
}

function applyTimestampOverride(timestamp, override, notes) {
    if (override === undefined) return timestamp;
    if (override === null) {
        notes.push('timestamp removed by admin');
        return undefined;
    }
    if (typeof override !== 'object') return timestamp;
    const next = {...(timestamp || {parser: 'iso8601'})};
    if (override.group !== undefined) next.group = coerceNumber(override.group);
    if (typeof override.parser === 'string') next.parser = override.parser;
    notes.push('timestamp edited by admin');
    return next;
}

function scoreConfidence(byRole, typeGuess, hasBalance, conflicts) {
    const values = Object.values(byRole).map(r => r.confidence);
    if (!byRole.amount) return 0.1;
    let score = values.reduce((a, b) => a + b, 0) / values.length;
    if (typeGuess.defaulted) score -= 0.1;
    if (!hasBalance) score -= 0.05;
    score -= 0.1 * Math.min(conflicts || 0, 3);
    return Math.round(Math.min(0.99, Math.max(0.05, score)) * 100) / 100;
}

function draftFromShape(shape, overrides, opts) {
    const ov = overrides && typeof overrides === 'object' ? overrides : {};
    const options = opts && typeof opts === 'object' ? opts : {};
    if (!shape || typeof shape !== 'object') throw invalid('invalid_shape', 'shape must be an object');

    const parsed = tokenizeSkeleton(shape.skeleton);
    if (!parsed.ok) throw invalid('invalid_skeleton', `invalid skeleton: ${parsed.reason}`);
    const carrier = typeof shape.carrier === 'string' ? shape.carrier.toLowerCase() : '';
    if (!CARRIERS.includes(carrier)) throw invalid('invalid_carrier', 'carrier must be "mtn" or "airtel"');

    const notes = [];
    const originalTokens = parsed.tokens;
    const replacements = parseWordsAsLiteral(ov.wordsAsLiteral, originalTokens, notes);
    const tokens = normalizeTokens(applyWordReplacements(originalTokens, replacements));
    if (replacements.size) notes.push(`${replacements.size} word slot(s) turned into literal text by admin`);

    const typeGuess = guessType(tokens);
    let type = typeGuess.type;
    if (typeof ov.type === 'string' && ov.type) {
        type = ov.type;
        notes.push(`type set to "${ov.type}" by admin (guess was "${typeGuess.type}")`);
    } else {
        notes.push(`type "${type}" from ${typeGuess.reason}`);
    }

    const {byRole, notes: roleNotes, conflicts} = assignRoles(tokens, type, shape.hintVotes);
    notes.push(...roleNotes);

    const layout = computeLayout(tokens);
    const pattern = buildPattern(tokens);

    const captureMap = {};
    for (const role of CAPTURE_ROLES) {
        const group = groupOf(layout.slots, byRole[role]);
        if (group) captureMap[role] = group;
    }
    let timestamp;
    if (byRole.timestamp) {
        const group = groupOf(layout.slots, byRole.timestamp);
        if (group) timestamp = {group, parser: byRole.timestamp.parser};
    }

    if (byRole.timestamp && byRole.timestamp.parser === 'airtel-shortcode') {
        notes.push(`Airtel TID rule: group ${timestamp.group} is the full TID, read both as the transaction id and (airtel-shortcode) as the timestamp`);
    }

    timestamp = applyCaptureOverrides(captureMap, timestamp, ov.captureMap, notes);
    timestamp = applyTimestampOverride(timestamp, ov.timestamp, notes);

    if (!captureMap.amount) notes.push('no amount slot found: the app needs an amount capture');
    if (!captureMap.transactionId && !(timestamp && timestamp.group)) {
        notes.push('shape has no timestamp or transaction id, the app rejects patterns without one');
    }
    if (!captureMap.balance) notes.push('no balance slot found');
    if (layout.groupCount > 20) notes.push(`${layout.groupCount} capture groups, above the limit of 20`);
    for (const slot of ambiguousWordSlots(tokensToSkeleton(tokens), captureMap)) {
        notes.push(`word slot ${slot.slotNo} needs a literal: a single unknown word would match any text (add it with wordsAsLiteral)`);
    }

    const shapeId = typeof shape.shapeId === 'string' && /^[0-9a-f]{16}$/.test(shape.shapeId) ? shape.shapeId : sha256Hex16(shape.skeleton);
    const revision = Number.isInteger(shape.revision) && shape.revision > 1 ? shape.revision : 1;
    const id = typeof ov.id === 'string' && ov.id ? ov.id : `auto-${carrier}-${type}-${shapeId.slice(0, 8)}${revision > 1 ? `-r${revision}` : ''}`;

    const sourceShape = {shapeId, skeleton: shape.skeleton, count: Number.isFinite(Number(shape.count)) ? Number(shape.count) : 1};
    if (replacements.size) sourceShape.synthSkeleton = tokensToSkeleton(tokens);
    if (typeof ov.type === 'string' && ov.type) sourceShape.typeConfirmed = true;
    // Only the admin confirms a mapping that the text does not settle; a device vote never does.
    const edited = role => ov.captureMap && typeof ov.captureMap === 'object' && role in ov.captureMap;
    if (['secondParty', 'agentName'].some(edited)) sourceShape.nameConfirmed = true;
    if (edited('amount')) sourceShape.amountConfirmed = true;

    const tags = [type];
    if (carrier === 'airtel') tags.push('airtel');

    const draft = {
        id,
        carrier,
        locale: guessLocale(tokens, shape.locale),
        type,
        pattern,
        flags: 'i',
        captureMap,
        ...(timestamp ? {timestamp} : {}),
        tags,
        status: 'pending_review',
        sourceShape,
        confidence: scoreConfidence(byRole, typeGuess, !!captureMap.balance, conflicts.length),
        notes,
    };

    if (options.gate !== false) {
        draft.gate = runGate(draft, {existingPatterns: options.existingPatterns || []});
    }
    return draft;
}

function describeLayout(skeleton) {
    const layout = layoutOf(skeleton);
    if (!layout) return null;
    return {
        groupCount: layout.groupCount,
        slots: layout.slots.map(({ordinal, slotNo, kind, group}) => ({ordinal, slotNo, kind, group})),
    };
}

function describeDraft(draft) {
    const shape = draft && draft.sourceShape;
    const skeleton = shape && (shape.synthSkeleton || shape.skeleton);
    const layout = describeLayout(skeleton);
    if (!layout) return null;
    const rolesByGroup = new Map();
    const add = (group, role) => rolesByGroup.set(group, [...(rolesByGroup.get(group) || []), role]);
    for (const [role, group] of Object.entries((draft && draft.captureMap) || {})) add(Number(group), role);
    if (draft.timestamp && draft.timestamp.group !== undefined) add(Number(draft.timestamp.group), 'timestamp');
    return {
        groupCount: layout.groupCount,
        slots: layout.slots.map(slot => {
            const roles = slot.group ? rolesByGroup.get(slot.group) || [] : [];
            return {...slot, role: roles[0] || null, roles};
        }),
    };
}

module.exports = {draftFromShape, describeLayout, describeDraft, VALID_TYPES, CARRIERS};
