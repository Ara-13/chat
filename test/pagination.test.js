const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { _pagination, _presence } = require('../ws/socket');

test('history cursor uses timestamp and id as a stable tie-breaker', () => {
    const where = _pagination.buildHistoryWhere('chat-id', {
        createdAt: '2026-01-01T00:00:00.000Z',
        id: 'message-id'
    });

    assert.equal(where.chat_id, 'chat-id');
    assert.equal(where[Op.or].length, 2);
    assert.equal(where[Op.or][0].created_at[Op.lt].toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(where[Op.or][1].id[Op.lt], 'message-id');
});

test('history filters operate on message type in the single main timeline', () => {
    assert.equal(_pagination.buildHistoryWhere('chat-id', null, 'music').type, 'music');
    assert.equal(_pagination.buildHistoryWhere('chat-id', null, 'file').type, 'file');
    assert.throws(
        () => _pagination.buildHistoryWhere('chat-id', null, 'unknown'),
        error => error.code === 'INVALID_FILTER'
    );
});

test('history rejects malformed cursors', () => {
    assert.throws(
        () => _pagination.buildHistoryWhere('chat-id', { createdAt: 'bad', id: 'message-id' }),
        error => error.code === 'INVALID_CURSOR'
    );
});

test('online presence counts unique users with open WebSocket connections', () => {
    const clients = new Set([
        { readyState: 1, user: { username: 'ali' } },
        { readyState: 1, user: { username: 'ali' } },
        { readyState: 1, user: { username: 'sara' } },
        { readyState: 3, user: { username: 'mina' } },
        { readyState: 1, user: null }
    ]);

    assert.deepEqual(_presence.getOnlineMembers(clients), ['ali', 'sara']);
});
