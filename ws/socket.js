const fs = require('fs/promises');
const path = require('path');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { Op } = require('sequelize');
const { v4: uuid } = require('uuid');
const { Message, ChatMember, MessageSeen, MessageReaction } = require('../models');
const { serializeMessage, normalizeReactions } = require('../utils/messageFactory');
const { containsMention } = require('../utils/mentions');

const rooms = new Map();
const PAGE_SIZE = 50;
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_WS_PAYLOAD = 64 * 1024;
const MESSAGE_RATE_WINDOW = 10_000;
const MESSAGE_RATE_LIMIT = 20;
const UPLOAD_DIRECTORY = path.resolve(__dirname, '../storage/uploads');

const HISTORY_FILTERS = Object.freeze({
    music: {
        type: 'music',
        [Op.not]: { section: 'main', file_mime: 'audio/webm' }
    },
    file: { type: 'file' }
});

function safeSend(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
}

function sendError(ws, code, message) {
    safeSend(ws, { event: 'error', error: { code, message } });
}

function broadcastToRoom(chatId, payload) {
    const clients = rooms.get(String(chatId));
    if (!clients) return;

    for (const client of clients) safeSend(client, payload);
}

function getOnlineMembers(clients = []) {
    return [...new Set(
        [...clients]
            .filter(client => client.readyState === WebSocket.OPEN)
            .map(client => client.user?.username)
            .filter(Boolean)
    )];
}

function broadcastPresence(chatId) {
    const clients = rooms.get(String(chatId));
    if (!clients?.size) return;

    const onlineMembers = getOnlineMembers(clients);

    const payload = {
        event: 'presence',
        data: {
            onlineCount: onlineMembers.length,
            onlineMembers
        }
    };
    for (const client of clients) safeSend(client, payload);
}

async function getReplyMap(messages, chatId) {
    const replyIds = [...new Set(messages.map(message => message.reply_to).filter(Boolean))];
    if (!replyIds.length) return new Map();

    const replies = await Message.findAll({
        where: { id: { [Op.in]: replyIds }, chat_id: chatId },
        attributes: ['id', 'sender_username', 'content'],
        raw: true
    });

    return new Map(replies.map(reply => [reply.id, reply]));
}

async function getSeenMap(messages) {
    const messageIds = messages.map(message => message.id).filter(Boolean);
    if (!messageIds.length) return new Map();

    const receipts = await MessageSeen.findAll({
        where: { message_id: { [Op.in]: messageIds } },
        attributes: ['message_id', 'username', 'seen_at'],
        raw: true
    });

    const seenMap = new Map();
    for (const receipt of receipts) {
        if (!seenMap.has(receipt.message_id)) seenMap.set(receipt.message_id, []);
        seenMap.get(receipt.message_id).push(receipt);
    }
    return seenMap;
}

async function getReactionsMap(messages) {
    const messageIds = messages.map(message => message.id).filter(Boolean);
    if (!messageIds.length) return new Map();

    const reactions = await MessageReaction.findAll({
        where: { message_id: { [Op.in]: messageIds } },
        attributes: ['message_id', 'emoji', 'username', 'created_at'],
        order: [['created_at', 'ASC']],
        raw: true
    });

    const reactionsMap = new Map();
    for (const r of reactions) {
        if (!reactionsMap.has(r.message_id)) reactionsMap.set(r.message_id, []);
        reactionsMap.get(r.message_id).push(r);
    }
    return reactionsMap;
}

async function serializeMessages(messages, chatId) {
    const replyMap = await getReplyMap(messages, chatId);
    const seenMap = await getSeenMap(messages);
    const reactionsMap = await getReactionsMap(messages);
    return messages.map(message => serializeMessage(
        message,
        replyMap.get(message.reply_to),
        seenMap.get(message.id) || [],
        reactionsMap.get(message.id) || []
    ));
}

function createCursor(message) {
    if (!message) return null;
    return { createdAt: message.created_at, id: message.id };
}

function applyCursor(where, cursor) {
    if (!cursor) return;
    const beforeDate = new Date(cursor.createdAt);
    if (Number.isNaN(beforeDate.getTime()) || typeof cursor.id !== 'string') {
            const error = new Error('Invalid history cursor');
            error.code = 'INVALID_CURSOR';
            throw error;
    }

    where[Op.or] = [
        { created_at: { [Op.lt]: beforeDate } },
        { created_at: beforeDate, id: { [Op.lt]: cursor.id } }
    ];
}

function buildHistoryWhere(chatId, cursor = null, filter = 'all') {
    const where = { chat_id: chatId };
    if (filter !== 'all') {
        const filterWhere = HISTORY_FILTERS[filter];
        if (!filterWhere) {
            const error = new Error('Invalid history filter');
            error.code = 'INVALID_FILTER';
            throw error;
        }
        Object.assign(where, filterWhere);
    }
    applyCursor(where, cursor);
    return where;
}

async function loadHistory(chatId, cursor = null, filter = 'all') {
    const where = buildHistoryWhere(chatId, cursor, filter);

    const messages = await Message.findAll({
        where,
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit: PAGE_SIZE + 1,
        raw: true
    });

    const hasMore = messages.length > PAGE_SIZE;
    if (hasMore) messages.pop();
    const nextCursor = createCursor(messages[messages.length - 1]);
    messages.reverse();
    return {
        messages: await serializeMessages(messages, chatId),
        hasMore,
        nextCursor
    };
}

function normalizePositions(value) {
    if (!value) return {};
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return {}; }
    }
    return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadInitialHistory(chatId, membership) {
    const positions = normalizePositions(membership.scroll_positions);

    // If a viewport save was interrupted (for example the tab closed quickly),
    // the latest seen receipt is still a reliable fallback anchor.
    if (!positions.main?.messageId) {
        const lastSeenMessage = await Message.findOne({
            where: { chat_id: chatId },
            include: [{
                model: MessageSeen,
                as: 'seenReceipts',
                where: { username: membership.username },
                attributes: [],
                required: true
            }],
            // Sequelize turns findOne + a hasMany include into a subquery. The
            // columns used by the outer ORDER BY must also be selected there.
            attributes: ['id', 'created_at'],
            order: [['created_at', 'DESC'], ['id', 'DESC']],
            raw: true
        });
        if (lastSeenMessage) {
            positions.main = { messageId: lastSeenMessage.id, offset: 0 };
        }
    }

    const [page, pinnedMessages, attentionMessageIds] = await Promise.all([
        loadHistory(chatId),
        Message.findAll({
            where: { chat_id: chatId, pinned_at: { [Op.ne]: null } },
            attributes: [
                'id', 'sender_username', 'type', 'content', 'file_name',
                'pinned_at', 'pinned_by'
            ],
            order: [['pinned_at', 'DESC']],
            limit: 100,
            raw: true
        }),
        loadAttentionMessageIds(chatId, membership.username)
    ]);

    const firstUnread = page.messages.find(message =>
        message.sender !== membership.username
        && !message.seenBy.includes(membership.username)
    );

    return {
        messages: page.messages,
        pinnedMessages: pinnedMessages.map(message => ({
            id: message.id,
            sender: message.sender_username,
            type: message.type,
            content: message.content,
            fileName: message.file_name,
            pinnedAt: message.pinned_at,
            pinnedBy: message.pinned_by
        })),
        positions: { main: positions.main },
        unreadMessageId: firstUnread?.id || null,
        attentionMessageIds,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore
    };
}

async function loadAttentionMessageIds(chatId, username) {
    const unreadMessages = await Message.findAll({
        where: {
            chat_id: chatId,
            sender_username: { [Op.ne]: username },
            '$seenReceipts.username$': null
        },
        include: [{
            model: MessageSeen,
            as: 'seenReceipts',
            where: { username },
            attributes: [],
            required: false
        }],
        attributes: ['id', 'content', 'reply_to', 'created_at'],
        order: [['created_at', 'ASC'], ['id', 'ASC']],
        subQuery: false,
        raw: true
    });

    const replyIds = [...new Set(unreadMessages.map(message => message.reply_to).filter(Boolean))];
    const ownReplyTargets = new Set();
    if (replyIds.length) {
        const targets = await Message.findAll({
            where: {
                id: { [Op.in]: replyIds },
                chat_id: chatId,
                sender_username: username
            },
            attributes: ['id'],
            raw: true
        });
        targets.forEach(message => ownReplyTargets.add(message.id));
    }

    return unreadMessages
        .filter(message => ownReplyTargets.has(message.reply_to) || containsMention(message.content, username))
        .map(message => message.id);
}

async function loadAttentionMessage(ws, chatId, messageId) {
    if (typeof messageId !== 'string') {
        return sendError(ws, 'INVALID_ATTENTION', 'message_id is required');
    }

    const message = await Message.findOne({
        where: { id: messageId, chat_id: chatId },
        raw: true
    });
    if (!message) return sendError(ws, 'MESSAGE_NOT_FOUND', 'Message was not found in this chat');

    const [serialized] = await serializeMessages([message], chatId);
    safeSend(ws, { event: 'attention_message', data: serialized });
}

async function markMessagesSeen(ws, chatId, messageIds) {
    if (!Array.isArray(messageIds)) return sendError(ws, 'INVALID_SEEN', 'message_ids must be an array');
    const uniqueIds = [...new Set(messageIds.filter(id => typeof id === 'string'))].slice(0, 100);
    if (!uniqueIds.length) return;

    const messages = await Message.findAll({
        where: {
            id: { [Op.in]: uniqueIds },
            chat_id: chatId,
            sender_username: { [Op.ne]: ws.user.username }
        },
        attributes: ['id'],
        raw: true
    });
    const validIds = messages.map(message => message.id);
    if (!validIds.length) return;

    const seenAt = new Date();
    await MessageSeen.bulkCreate(
        validIds.map(messageId => ({
            message_id: messageId,
            username: ws.user.username,
            seen_at: seenAt
        })),
        { ignoreDuplicates: true }
    );

    // Read the persisted values back so reconnects or a second tab never
    // replace the original receipt time with a newer client-side timestamp.
    const persistedReceipts = await MessageSeen.findAll({
        where: {
            message_id: { [Op.in]: validIds },
            username: ws.user.username
        },
        attributes: ['message_id', 'seen_at'],
        raw: true
    });

    broadcastToRoom(chatId, {
        event: 'messages_seen',
        data: {
            messageIds: validIds,
            username: ws.user.username,
            receipts: persistedReceipts.map(receipt => ({
                messageId: receipt.message_id,
                seenAt: receipt.seen_at
            }))
        }
    });
}

async function saveScrollPosition(ws, chatId, membership, payload) {
    const messageId = payload.message_id;
    const offset = Number(payload.offset);
    if (typeof messageId !== 'string' || !Number.isFinite(offset)) {
        return sendError(ws, 'INVALID_POSITION', 'Invalid scroll position');
    }

    const message = await Message.findOne({
        where: { id: messageId, chat_id: chatId },
        attributes: ['id'],
        raw: true
    });
    if (!message) return sendError(ws, 'INVALID_POSITION', 'Position message was not found');

    await membership.reload({ attributes: ['chat_id', 'username', 'scroll_positions'] });
    const position = {
        messageId,
        offset: Math.max(-10000, Math.min(10000, Math.round(offset)))
    };
    membership.scroll_positions = { main: position };
    membership.changed('scroll_positions', true);
    await membership.save();
}

function isRateLimited(ws) {
    const now = Date.now();
    ws.messageTimes = (ws.messageTimes || []).filter(time => now - time < MESSAGE_RATE_WINDOW);

    if (ws.messageTimes.length >= MESSAGE_RATE_LIMIT) return true;
    ws.messageTimes.push(now);
    return false;
}

async function validateUploadedFile(file) {
    if (!file || typeof file.path !== 'string') return null;

    const filename = path.basename(file.path);
    if (file.path !== `/uploads/${filename}` || !filename) return null;

    const absolutePath = path.resolve(UPLOAD_DIRECTORY, filename);
    if (!absolutePath.startsWith(`${UPLOAD_DIRECTORY}${path.sep}`)) return null;

    try {
        const stats = await fs.stat(absolutePath);
        if (!stats.isFile() || stats.size > MAX_FILE_SIZE) return null;

        return {
            path: file.path,
            name: typeof file.name === 'string'
                ? path.basename(file.name).slice(0, 255)
                : filename,
            size: stats.size,
            mime: typeof file.mime === 'string'
                ? file.mime.slice(0, 100)
                : 'application/octet-stream'
        };
    } catch {
        return null;
    }
}

async function createMessage(ws, chatId, payload) {
    if (isRateLimited(ws)) return sendError(ws, 'RATE_LIMITED', 'Too many messages');

    const type = payload.type || 'text';
    if (!['text', 'file', 'music', 'voice'].includes(type)) {
        return sendError(ws, 'INVALID_TYPE', 'Invalid message type');
    }

    // Re-read permissions for every send. This also prevents a removed member
    // from continuing to write through an already-open socket.
    const membership = await ChatMember.findOne({
        where: { chat_id: chatId, username: ws.user.username },
        attributes: ['can_send_messages', 'can_send_media']
    });
    if (!membership) {
        sendError(ws, 'MEMBERSHIP_REVOKED', 'You are no longer a member of this chat');
        return ws.close(4003, 'Forbidden');
    }
    const hasTextContent = typeof payload.content === 'string' && payload.content.trim().length > 0;
    if ((type === 'text' || hasTextContent) && !membership.can_send_messages) {
        return sendError(ws, 'MESSAGE_RESTRICTED', 'Your permission to send messages has been disabled by an admin');
    }
    if (type !== 'text' && !membership.can_send_media) {
        return sendError(ws, 'MEDIA_RESTRICTED', 'Your permission to send media has been disabled by an admin');
    }

    if (payload.content != null && typeof payload.content !== 'string') {
        return sendError(ws, 'INVALID_CONTENT', 'Message content must be a string');
    }

    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
    if (content.length > MAX_MESSAGE_LENGTH) {
        return sendError(ws, 'MESSAGE_TOO_LONG', 'Message is too long');
    }

    const file = await validateUploadedFile(payload.file);
    if ((type === 'file' || type === 'music' || type === 'voice') && !file) {
        return sendError(ws, 'INVALID_FILE', 'Upload the file before sending the message');
    }
    if (!content && !file) return sendError(ws, 'EMPTY_MESSAGE', 'Message cannot be empty');

    let reply = null;
    const replyId = payload.reply?.id;
    if (replyId) {
        reply = await Message.findOne({
            where: { id: replyId, chat_id: chatId },
            attributes: ['id', 'sender_username', 'content'],
            raw: true
        });
        if (!reply) {
            return sendError(ws, 'INVALID_REPLY', 'Reply message was not found in this chat');
        }
    }

    const message = await Message.create({
        id: uuid(),
        chat_id: chatId,
        sender_username: ws.user.username,
        type,
        content: content || null,
        reply_to: reply?.id || null,
        file_path: file?.path || null,
        file_name: file?.name || null,
        file_size: file?.size || null,
        file_mime: file?.mime || null,
        section: 'main'
    });

    broadcastToRoom(chatId, {
        event: 'message',
        data: serializeMessage(message, reply)
    });
}

async function handleReaction(ws, chatId, payload) {
    const messageId = payload.message_id;
    const emoji = payload.emoji;
    if (typeof messageId !== 'string' || typeof emoji !== 'string') {
        return sendError(ws, 'INVALID_REACTION', 'message_id and emoji are required');
    }

    const trimmedEmoji = emoji.trim();
    if (!trimmedEmoji || trimmedEmoji.length > 50) {
        return sendError(ws, 'INVALID_REACTION', 'Invalid emoji');
    }

    const message = await Message.findOne({
        where: { id: messageId, chat_id: chatId },
        attributes: ['id'],
        raw: true
    });
    if (!message) {
        return sendError(ws, 'MESSAGE_NOT_FOUND', 'Message was not found in this chat');
    }

    const existing = await MessageReaction.findOne({
        where: { message_id: messageId, username: ws.user.username }
    });

    let action = 'added';
    if (existing) {
        if (existing.emoji === trimmedEmoji) {
            await existing.destroy();
            action = 'removed';
        } else {
            existing.emoji = trimmedEmoji;
            existing.created_at = new Date();
            await existing.save();
        }
    } else {
        await MessageReaction.create({
            message_id: messageId,
            username: ws.user.username,
            emoji: trimmedEmoji
        });
    }

    const currentReactions = await MessageReaction.findAll({
        where: { message_id: messageId },
        attributes: ['emoji', 'username', 'created_at'],
        order: [['created_at', 'ASC']],
        raw: true
    });

    const normalized = normalizeReactions(currentReactions);

    broadcastToRoom(chatId, {
        event: 'message_reaction',
        data: {
            messageId,
            reactions: normalized,
            actionUser: ws.user.username,
            emoji: trimmedEmoji,
            action
        }
    });
}

async function handleMessage(ws, chatId, rawData) {
    let payload;
    try {
        payload = JSON.parse(rawData.toString());
    } catch {
        return sendError(ws, 'INVALID_JSON', 'Invalid JSON payload');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return sendError(ws, 'INVALID_PAYLOAD', 'Invalid payload');
    }

    if (payload.event === 'history') {
        // Initial history is pushed automatically after authentication.
        return;
    }

    if (payload.event === 'load_more') {
        try {
            const page = await loadHistory(chatId, payload.cursor || null, payload.filter || 'all');
            return safeSend(ws, {
                event: 'load_more',
                data: page.messages,
                filter: payload.filter || 'all',
                reset: Boolean(payload.reset),
                cursor: page.nextCursor,
                hasMore: page.hasMore
            });
        } catch (error) {
            if (error.code === 'INVALID_CURSOR' || error.code === 'INVALID_FILTER') {
                return sendError(ws, error.code, error.message);
            }
            throw error;
        }
    }

    if (payload.event === 'seen') {
        return markMessagesSeen(ws, chatId, payload.message_ids);
    }

    if (payload.event === 'load_attention') {
        return loadAttentionMessage(ws, chatId, payload.message_id);
    }

    if (payload.event === 'save_position') {
        return saveScrollPosition(ws, chatId, ws.membership, payload);
    }

    if (payload.event === 'reaction') {
        return handleReaction(ws, chatId, payload);
    }

    if (payload.event) return sendError(ws, 'UNKNOWN_EVENT', 'Unknown event');
    return createMessage(ws, chatId, payload);
}

function removeFromRoom(chatId, ws) {
    const clients = rooms.get(chatId);
    if (!clients) return;

    clients.delete(ws);
    if (!clients.size) {
        rooms.delete(chatId);
        return;
    }
    broadcastPresence(chatId);
}

function disconnectUserFromRoom(chatId, username, code = 4003, reason = 'Forbidden') {
    const clients = rooms.get(String(chatId));
    if (!clients) return;

    for (const client of [...clients]) {
        if (client.user?.username === username) client.close(code, reason);
    }
}

function initWebSocket(server) {
    const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: MAX_WS_PAYLOAD });

    wss.on('connection', async (ws, req) => {
        let chatId;
        ws.on('close', () => {
            if (chatId) removeFromRoom(chatId, ws);
        });
        ws.on('error', error => console.error('WebSocket error:', error));

        try {
            if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');

            const parsedUrl = new URL(req.url, 'http://localhost');
            const token = parsedUrl.searchParams.get('token');
            chatId = parsedUrl.searchParams.get('chat_id');

            if (!token) return ws.close(4001, 'No token');
            if (!chatId || chatId.length > 24) return ws.close(4003, 'Invalid chat');

            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (!decoded.username) return ws.close(4002, 'Invalid token');

            const membership = await ChatMember.findOne({
                where: { chat_id: chatId, username: decoded.username },
                attributes: ['chat_id', 'username', 'scroll_positions']
            });
            if (!membership) return ws.close(4003, 'Forbidden');
            if (ws.readyState !== WebSocket.OPEN) return;

            ws.user = { username: decoded.username };
            ws.membership = membership;
            ws.isAlive = true;
            ws.messageQueue = Promise.resolve();
            ws.on('pong', () => { ws.isAlive = true; });

            if (!rooms.has(chatId)) rooms.set(chatId, new Set());
            rooms.get(chatId).add(ws);

            const initialHistory = await loadInitialHistory(chatId, membership);
            safeSend(ws, {
                event: 'history',
                data: initialHistory.messages,
                pinnedMessages: initialHistory.pinnedMessages,
                positions: initialHistory.positions,
                unreadMessageId: initialHistory.unreadMessageId,
                attentionMessageIds: initialHistory.attentionMessageIds,
                cursor: initialHistory.nextCursor,
                hasMore: initialHistory.hasMore
            });
            broadcastPresence(chatId);

            ws.on('message', data => {
                ws.messageQueue = ws.messageQueue
                    .then(() => handleMessage(ws, chatId, data))
                    .catch(error => {
                        console.error('WS message error:', error);
                        sendError(ws, 'SERVER_ERROR', 'Server error');
                    });
            });
        } catch (error) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return ws.close(4002, 'Invalid token');
            }
            console.error('WS connection error:', error);
            return ws.close(1011, 'Server error');
        }
    });

    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (ws.isAlive === false) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, 30_000);

    wss.on('close', () => clearInterval(heartbeat));
    return wss;
}

module.exports = initWebSocket;
module.exports.broadcastToRoom = broadcastToRoom;
module.exports.disconnectUserFromRoom = disconnectUserFromRoom;
module.exports._pagination = { buildHistoryWhere, createCursor };
module.exports._presence = { getOnlineMembers };
module.exports._mentions = { loadAttentionMessageIds };
