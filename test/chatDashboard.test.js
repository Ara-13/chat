const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChatSummaries } = require('../utils/chatDashboard');

test('dashboard summaries count unread messages and unread mentions per chat', () => {
    const chats = buildChatSummaries({
        username: 'ali',
        memberships: [
            { chat_id: 'first', joined_at: '2026-01-01T00:00:00.000Z' },
            { chat_id: 'second', joined_at: '2026-01-02T00:00:00.000Z' }
        ],
        chats: [
            { id: 'first', name: 'گروه اول' },
            { id: 'second', name: 'گروه دوم' }
        ],
        unreadMessages: [
            { id: '1', chat_id: 'first', content: 'سلام @ali' },
            { id: '2', chat_id: 'first', content: 'پیام عادی' },
            { id: '3', chat_id: 'second', content: 'سلام @alireza' }
        ],
        latestActivity: [
            { chat_id: 'first', last_message_at: '2026-01-04T00:00:00.000Z' },
            { chat_id: 'second', last_message_at: '2026-01-03T00:00:00.000Z' }
        ]
    });

    assert.deepEqual(chats.map(chat => chat.id), ['first', 'second']);
    assert.equal(chats[0].unreadCount, 2);
    assert.equal(chats[0].mentionCount, 1);
    assert.equal(chats[1].unreadCount, 1);
    assert.equal(chats[1].mentionCount, 0);
});

test('dashboard summaries include empty chats and fall back to join date sorting', () => {
    const chats = buildChatSummaries({
        username: 'ali',
        memberships: [
            { chat_id: 'old', joined_at: '2026-01-01T00:00:00.000Z' },
            { chat_id: 'new', joined_at: '2026-02-01T00:00:00.000Z' }
        ],
        chats: [
            { id: 'old', name: 'قدیمی' },
            { id: 'new', name: 'جدید' }
        ]
    });

    assert.deepEqual(chats.map(chat => chat.id), ['new', 'old']);
    assert.equal(chats[0].unreadCount, 0);
    assert.equal(chats[0].mentionCount, 0);
});
