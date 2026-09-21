function serializeReply(message) {
    if (!message) return null;

    return {
        id: message.id,
        sender: message.sender_username,
        text: message.content || ''
    };
}

function normalizeReactions(rawReactions = []) {
    if (!Array.isArray(rawReactions) || !rawReactions.length) return [];

    // If already aggregated [{ emoji, count, users }]
    if (rawReactions[0] && typeof rawReactions[0].count === 'number') {
        return rawReactions.map(r => ({
            emoji: r.emoji,
            count: Number(r.count) || 0,
            users: Array.isArray(r.users) ? [...new Set(r.users)] : [],
            ...(Array.isArray(r.details) ? { details: r.details } : {})
        })).filter(r => r.count > 0);
    }

    // If raw list of { emoji, username }
    const map = new Map();
    for (const r of rawReactions) {
        if (!r || !r.emoji) continue;
        const emoji = r.emoji;
        const user = r.username || r.sender_username;
        if (!map.has(emoji)) {
            map.set(emoji, { emoji, count: 0, users: [], details: [] });
        }
        const item = map.get(emoji);
        item.count += 1;
        if (user && !item.users.includes(user)) {
            item.users.push(user);
        }
        if (user && (r.created_at || r.reactedAt)) {
            item.details.push({
                username: user,
                reactedAt: r.created_at || r.reactedAt
            });
        }
    }
    return Array.from(map.values()).map(item => {
        if (!item.details.length) delete item.details;
        return item;
    });
}

function normalizeSeenReceipts(receipts = []) {
    const seenBy = [];
    const seenDetails = [];

    for (const receipt of Array.isArray(receipts) ? receipts : []) {
        const username = typeof receipt === 'string'
            ? receipt
            : receipt?.username;
        if (!username || seenBy.includes(username)) continue;
        seenBy.push(username);
        const seenAt = typeof receipt === 'object'
            ? receipt.seen_at || receipt.seenAt
            : null;
        if (seenAt) seenDetails.push({ username, seenAt });
    }

    return { seenBy, seenDetails };
}

function serializeMessage(message, reply = null, seenBy = [], reactions = []) {
    const value = typeof message.get === 'function'
        ? message.get({ plain: true })
        : message;
    const isLegacyVoice = value.type === 'music'
        && value.section === 'main'
        && value.file_mime === 'audio/webm';
    const type = isLegacyVoice ? 'voice' : value.type;

    const seen = normalizeSeenReceipts(seenBy);

    return {
        id: value.id,
        chat_id: value.chat_id,
        sender: value.sender_username,
        type,
        content: value.content,
        reply: serializeReply(reply),
        file: value.file_path
            ? {
                path: value.file_path,
                name: type === 'voice' ? null : value.file_name,
                size: value.file_size,
                mime: value.file_mime
            }
            : null,
        createdAt: value.created_at,
        editedAt: value.edited_at || null,
        isPinned: Boolean(value.pinned_at),
        pinnedAt: value.pinned_at || null,
        pinnedBy: value.pinned_by || null,
        // Sections used to represent three independent conversations. They are
        // now kept only as a database compatibility detail; the public API has
        // one canonical message stream.
        section: 'main',
        seenBy: seen.seenBy,
        seenDetails: seen.seenDetails,
        reactions: normalizeReactions(reactions && reactions.length ? reactions : value.reactions)
    };
}

module.exports = {
    serializeMessage,
    serializeReply,
    normalizeReactions,
    normalizeSeenReceipts
};
