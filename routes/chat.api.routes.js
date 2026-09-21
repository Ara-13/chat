const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const chatMemberMiddleware = require('../middlewares/chatMember.middleware');
const chatAdminMiddleware = require('../middlewares/chatAdmin.middleware');
const chatController = require('../controllers/chat.controller');
const messageController = require('../controllers/message.controller');
const uploadRoutes = require('./upload');

router.get('/', authMiddleware, chatController.myChats);
router.post('/', authMiddleware, chatController.createChat);
router.get('/:chat_id/info', authMiddleware, chatController.chatInfo);
router.patch(
    '/:chat_id/members/:username/permissions',
    authMiddleware,
    chatMemberMiddleware,
    chatAdminMiddleware,
    chatController.updateMemberPermissions
);
router.delete(
    '/:chat_id/members/:username',
    authMiddleware,
    chatMemberMiddleware,
    chatAdminMiddleware,
    chatController.removeMember
);
router.patch(
    '/:chat_id/messages/:message_id/pin',
    authMiddleware,
    chatMemberMiddleware,
    messageController.setMessagePin
);
router.patch(
    '/:chat_id/messages/:message_id',
    authMiddleware,
    chatMemberMiddleware,
    messageController.updateMessage
);
router.delete(
    '/:chat_id/messages/:message_id',
    authMiddleware,
    chatMemberMiddleware,
    messageController.deleteMessage
);
router.use(
    '/:chat_id',
    authMiddleware,
    chatMemberMiddleware,
    uploadRoutes
);

module.exports = router;
