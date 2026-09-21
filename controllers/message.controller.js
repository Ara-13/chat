const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Message, MessageReaction, MessageSeen, ChatMember, sequelize } = require('../models');
const { serializeMessage } = require('../utils/messageFactory');
const { broadcastToRoom } = require('../ws/socket');

const MAX_MESSAGE_LENGTH = 10_000;
const execFileAsync = promisify(execFile);

exports.setMessagePin = async (req, res) => {
    const { chat_id: chatId, message_id: messageId } = req.params;
    const username = req.user.username;
    const pinned = req.body?.pinned;

    if (typeof pinned !== 'boolean') {
        return res.status(400).json({ message: 'pinned must be a boolean' });
    }

    try {
        const message = await Message.findOne({
            where: { id: messageId, chat_id: chatId }
        });

        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }

        const pinnedAt = pinned ? new Date() : null;
        const pinnedBy = pinned ? username : null;
        message.pinned_at = pinnedAt;
        message.pinned_by = pinnedBy;
        await message.save();

        const data = {
            messageId,
            isPinned: Boolean(pinnedAt),
            pinnedAt,
            pinnedBy,
            sender: message.sender_username,
            type: message.type,
            content: message.content,
            fileName: message.file_name
        };
        broadcastToRoom(chatId, { event: 'message_pin_updated', data });

        return res.json({ success: true, ...data });
    } catch (error) {
        console.error('Pin message error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

async function normalizeWebmAudio(file) {
    if (file.mimetype !== 'audio/webm' || path.extname(file.path).toLowerCase() !== '.webm') return;

    const normalizedPath = `${file.path}.normalized.webm`;
    try {
        await execFileAsync('ffmpeg', [
            '-v', 'error',
            '-y',
            '-i', file.path,
            '-c', 'copy',
            normalizedPath
        ]);
        await fs.rename(normalizedPath, file.path);
        file.size = (await fs.stat(file.path)).size;
    } catch (error) {
        await fs.unlink(normalizedPath).catch(() => {});
        console.warn('WebM normalization skipped:', error.message);
    }
}

exports.updateMessage = async (req, res) => {
    const { chat_id: chatId, message_id: messageId } = req.params;
    const username = req.user.username;

    try {
        if (typeof req.body.content !== 'string') {
            return res.status(400).json({ message: 'content must be a string' });
        }

        const content = req.body.content.trim();
        if (content.length > MAX_MESSAGE_LENGTH) {
            return res.status(413).json({ message: 'Message is too long' });
        }

        const message = await Message.findOne({
            where: { id: messageId, chat_id: chatId }
        });

        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }

        if (message.sender_username !== username) {
            return res.status(403).json({ message: 'You can only edit your own messages' });
        }

        if (!content && !message.file_path) {
            return res.status(400).json({ message: 'Message content cannot be empty' });
        }

        message.content = content || null;
        message.edited_at = new Date();
        await message.save();

        let reply = null;
        if (message.reply_to) {
            reply = await Message.findOne({
                where: { id: message.reply_to, chat_id: chatId }
            });
        }

        const currentReactions = await MessageReaction.findAll({
            where: { message_id: messageId },
            attributes: ['emoji', 'username', 'created_at'],
            order: [['created_at', 'ASC']],
            raw: true
        });

        const seenReceipts = await MessageSeen.findAll({
            where: { message_id: messageId },
            attributes: ['username', 'seen_at'],
            raw: true
        });

        const data = serializeMessage(
            message,
            reply,
            seenReceipts,
            currentReactions
        );
        broadcastToRoom(chatId, { event: 'message_updated', data });

        return res.json({ success: true, message: data });
    } catch (error) {
        console.error('Update message error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

exports.deleteMessage = async (req, res) => {
    const { chat_id: chatId, message_id: messageId } = req.params;
    const username = req.user.username;

    try {
        const message = await Message.findOne({
            where: { id: messageId, chat_id: chatId }
        });

        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }

        const membership = req.chatMember || await ChatMember.findOne({
            where: { chat_id: chatId, username },
            attributes: ['is_admin']
        });
        if (message.sender_username !== username && !membership?.is_admin) {
            return res.status(403).json({ message: 'Only admins can delete another member\'s message' });
        }

        await sequelize.transaction(async transaction => {
            await Message.update(
                { reply_to: null },
                {
                    where: {
                        chat_id: chatId,
                        reply_to: messageId
                    },
                    transaction
                }
            );
            await MessageReaction.destroy({
                where: { message_id: messageId },
                transaction
            });
            await MessageSeen.destroy({
                where: { message_id: messageId },
                transaction
            });
            await message.destroy({ transaction });
        });

        broadcastToRoom(chatId, {
            event: 'message_deleted',
            data: { id: messageId, chat_id: chatId }
        });

        return res.status(200).json({ success: true, id: messageId });
    } catch (error) {
        console.error('Delete message error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

exports.uploadFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'file is required' });
        }

        await normalizeWebmAudio(req.file);

        return res.status(201).json({
            file: {
                path: `/uploads/${req.file.filename}`,
                name: path.basename(req.file.originalname.replace(/\\/g, '/')).slice(0, 255),
                size: req.file.size,
                mime: req.file.mimetype || 'application/octet-stream'
            }
        });
    } catch (error) {
        console.error('Upload file error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};
