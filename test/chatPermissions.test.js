const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeMember } = require('../utils/chatPermissions');
const mediaPermissionMiddleware = require('../middlewares/mediaPermission.middleware');

test('serializeMember exposes admin and independent send permissions', () => {
    assert.deepEqual(serializeMember({
        username: 'sara',
        is_admin: 1,
        can_send_messages: 0,
        can_send_media: 1
    }), {
        username: 'sara',
        is_admin: true,
        can_send_messages: false,
        can_send_media: true
    });
});

test('media permission middleware rejects restricted members before upload', () => {
    const req = { chatMember: { can_send_media: false } };
    let response;
    const res = {
        status(status) {
            response = { status };
            return this;
        },
        json(body) {
            response.body = body;
            return this;
        }
    };
    let continued = false;

    mediaPermissionMiddleware(req, res, () => { continued = true; });

    assert.equal(continued, false);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'MEDIA_RESTRICTED');
});

test('media permission middleware allows members with access', () => {
    let continued = false;
    mediaPermissionMiddleware(
        { chatMember: { can_send_media: true } },
        {},
        () => { continued = true; }
    );
    assert.equal(continued, true);
});
