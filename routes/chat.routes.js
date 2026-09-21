const express = require('express');
const path = require('path');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const chatController = require('../controllers/chat.controller');

// صفحات HTML (بدون authMiddleware)
router.get('/join/:chat_id', chatController.joinPage);
router.get('/:chat_id', chatController.openChat);

// عملیات join (API-like → نیازمند auth)
router.post('/join/:chat_id', authMiddleware, chatController.joinChat);

module.exports = router;