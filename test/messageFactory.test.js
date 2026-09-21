const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeMessage } = require('../utils/messageFactory');

test('serializeMessage exposes the stable API shape', () => {
    const result = serializeMessage({
        id: 'message-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'file',
        content: 'document',
        reply_to: 'reply-id',
        file_path: '/uploads/file.pdf',
        file_name: 'file.pdf',
        file_size: 42,
        file_mime: 'application/pdf',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        edited_at: null,
        pinned_at: new Date('2026-01-01T00:02:00.000Z'),
        pinned_by: 'mina',
        section: 'file'
    }, {
        id: 'reply-id',
        sender_username: 'ali',
        content: 'original'
    });

    assert.equal(result.sender, 'sara');
    assert.deepEqual(result.reply, {
        id: 'reply-id',
        sender: 'ali',
        text: 'original'
    });
    assert.deepEqual(result.file, {
        path: '/uploads/file.pdf',
        name: 'file.pdf',
        size: 42,
        mime: 'application/pdf'
    });
    assert.equal(result.section, 'main');
    assert.equal(result.isPinned, true);
    assert.equal(result.pinnedBy, 'mina');
    assert.equal(result.pinnedAt.toISOString(), '2026-01-01T00:02:00.000Z');
});

test('serializeMessage supports Sequelize model instances', () => {
    const plain = {
        id: 'message-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'text',
        content: 'hello',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        edited_at: new Date('2026-01-01T00:01:00.000Z'),
        section: 'main'
    };

    const result = serializeMessage({ get: () => plain });
    assert.equal(result.content, 'hello');
    assert.equal(result.file, null);
    assert.equal(result.reply, null);
    assert.equal(result.editedAt, plain.edited_at);
    assert.equal(result.isPinned, false);
    assert.equal(result.pinnedAt, null);
    assert.equal(result.pinnedBy, null);
});

test('serializeMessage includes unique per-user seen receipts', () => {
    const result = serializeMessage({
        id: 'message-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'text',
        content: 'hello',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        section: 'main'
    }, null, ['ali', 'ali', 'mina']);

    assert.deepEqual(result.seenBy, ['ali', 'mina']);
    assert.deepEqual(result.seenDetails, []);
});

test('serializeMessage exposes timestamps for seen receipts', () => {
    const seenAt = new Date('2026-01-01T00:05:00.000Z');
    const result = serializeMessage({
        id: 'message-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'text',
        content: 'hello',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        section: 'main'
    }, null, [{ username: 'ali', seen_at: seenAt }]);

    assert.deepEqual(result.seenBy, ['ali']);
    assert.deepEqual(result.seenDetails, [{ username: 'ali', seenAt }]);
});

test('serializeMessage hides voice filenames and upgrades legacy voice messages', () => {
    const result = serializeMessage({
        id: 'voice-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'music',
        content: null,
        file_path: '/uploads/recording.webm',
        file_name: 'Ù¾ÛØ§Ù ØµÙØªÛ.webm',
        file_size: 1024,
        file_mime: 'audio/webm',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        section: 'main'
    });

    assert.equal(result.type, 'voice');
    assert.equal(result.file.name, null);
    assert.equal(result.file.path, '/uploads/recording.webm');
});

test('serializeMessage keeps regular audio uploads as music in the main stream', () => {
    const result = serializeMessage({
        id: 'music-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'music',
        content: null,
        file_path: '/uploads/song.mp3',
        file_name: 'song.mp3',
        file_size: 2048,
        file_mime: 'audio/mpeg',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        section: 'main'
    });

    assert.equal(result.type, 'music');
    assert.equal(result.section, 'main');
    assert.equal(result.file.name, 'song.mp3');
});

test('serializeMessage normalizes raw reaction list and aggregates counts', () => {
    const rawReactions = [
        { emoji: '👍', username: 'ali' },
        { emoji: '👍', username: 'sara' },
        { emoji: '❤️', username: 'reza' }
    ];

    const result = serializeMessage({
        id: 'message-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'text',
        content: 'hello',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        section: 'main'
    }, null, [], rawReactions);

    assert.deepEqual(result.reactions, [
        { emoji: '👍', count: 2, users: ['ali', 'sara'] },
        { emoji: '❤️', count: 1, users: ['reza'] }
    ]);
});

test('serializeMessage exposes per-user reaction timestamps', () => {
    const reactedAt = new Date('2026-01-01T00:06:00.000Z');
    const result = serializeMessage({
        id: 'message-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'text',
        content: 'hello',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        section: 'main'
    }, null, [], [{ emoji: '👍', username: 'ali', created_at: reactedAt }]);

    assert.deepEqual(result.reactions[0].details, [{ username: 'ali', reactedAt }]);
});

test('serializeMessage supports already aggregated reactions', () => {
    const aggregated = [
        { emoji: '🔥', count: 3, users: ['ali', 'sara', 'omid'] }
    ];

    const result = serializeMessage({
        id: 'message-id',
        chat_id: 'chat-id',
        sender_username: 'sara',
        type: 'text',
        content: 'hello',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        section: 'main'
    }, null, [], aggregated);

    assert.deepEqual(result.reactions, aggregated);
});

test('normalizeReactions handles empty, invalid, and deduplication correctly', () => {
    const { normalizeReactions } = require('../utils/messageFactory');

    assert.deepEqual(normalizeReactions([]), []);
    assert.deepEqual(normalizeReactions(null), []);
    assert.deepEqual(normalizeReactions(undefined), []);

    const duplicateUsers = [
        { emoji: '👏', username: 'ali' },
        { emoji: '👏', username: 'ali' }
    ];
    assert.deepEqual(normalizeReactions(duplicateUsers), [
        { emoji: '👏', count: 2, users: ['ali'] }
    ]);
});
