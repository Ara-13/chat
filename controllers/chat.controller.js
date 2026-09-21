const path = require('path');
const { Op, fn, col } = require('sequelize');
const { sequelize, Chat, ChatMember, Message, MessageSeen } = require('../models');
const { buildChatSummaries } = require('../utils/chatDashboard');
const { ensureChatAdmin, serializeMember } = require('../utils/chatPermissions');
const { createChatId, validateChatName } = require('../utils/chatCreation');
const { broadcastToRoom, disconnectUserFromRoom } = require('../ws/socket');

exports.dashboardPage = (_req, res) => {
    return res.sendFile(path.join(__dirname, '../public/index.html'));
};

exports.myChats = async (req, res) => {
    const username = req.user?.username;

    try {
        if (!username) return res.status(401).json({ message: 'Unauthorized' });

        const memberships = await ChatMember.findAll({
            where: { username },
            attributes: ['chat_id', 'joined_at'],
            raw: true
        });
        const chatIds = memberships.map(membership => membership.chat_id);
        if (!chatIds.length) return res.json({ chats: [] });

        const [chats, unreadMessages, latestActivity] = await Promise.all([
            Chat.findAll({
                where: { id: { [Op.in]: chatIds } },
                attributes: ['id', 'name'],
                raw: true
            }),
            Message.findAll({
                where: {
                    chat_id: { [Op.in]: chatIds },
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
                attributes: ['id', 'chat_id', 'content'],
                subQuery: false,
                raw: true
            }),
            Message.findAll({
                where: { chat_id: { [Op.in]: chatIds } },
                attributes: ['chat_id', [fn('MAX', col('created_at')), 'last_message_at']],
                group: ['chat_id'],
                raw: true
            })
        ]);

        return res.json({
            chats: buildChatSummaries({
                memberships,
                chats,
                unreadMessages,
                latestActivity,
                username
            })
        });
    } catch (error) {
        console.error('Dashboard chats error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

/**
 * POST /api/rooms
 * یک چت می‌سازد و سازنده را به‌عنوان مدیر به آن اضافه می‌کند.
 */
exports.createChat = async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ message: 'Unauthorized' });

    const validation = validateChatName(req.body?.name);
    if (validation.error) {
        return res.status(400).json({ message: validation.error });
    }

    try {
        const chat = await sequelize.transaction(async transaction => {
            const createdChat = await Chat.create({
                id: createChatId(),
                name: validation.value
            }, { transaction });

            await ChatMember.create({
                chat_id: createdChat.id,
                username,
                is_admin: true
            }, { transaction });

            return createdChat;
        });

        return res.status(201).json({
            success: true,
            chat: {
                id: chat.id,
                name: chat.name,
                is_admin: true
            }
        });
    } catch (error) {
        console.error('Create chat error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

/**
 * GET /rooms/join/:chat_id
 * فقط صفحه join را نمایش می‌دهد
 */
exports.joinPage = async (req, res) => {
    return res.sendFile(
        path.join(__dirname, '../public/join-chat.html')
    );
};

/**
 * POST /rooms/join/:chat_id
 * کاربر لاگین‌شده را عضو چت می‌کند
 */
exports.joinChat = async (req, res) => {
    const { chat_id } = req.params;
    const username = req.user?.username;

    try {
        if (!username) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const chat = await Chat.findByPk(chat_id, { attributes: ['id'] });
        if (!chat) {
            return res.status(404).json({ message: 'Chat not found' });
        }

        const existingMembers = await ChatMember.count({ where: { chat_id } });
        const [, created] = await ChatMember.findOrCreate({
            where: { chat_id, username },
            defaults: { chat_id, username, is_admin: existingMembers === 0 }
        });

        return res.status(created ? 201 : 200).json({
            success: true,
            already_member: !created
        });
    } catch (error) {
        console.error('Join chat error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

/**
 * GET /api/chats/:chat_id/info
 * اطلاعات چت + member بودن کاربر
 */
exports.chatInfo = async (req, res) => {
    const { chat_id } = req.params;
    const username = req.user?.username;

    try {
        if (!username) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const chat = await Chat.findByPk(chat_id, { attributes: ['id', 'name'] });
        if (!chat) {
            return res.status(404).json({ message: 'Chat not found' });
        }

        await ensureChatAdmin(chat_id);
        const members = await ChatMember.findAll({
            where: { chat_id },
            attributes: [
                'username', 'is_admin', 'can_send_messages', 'can_send_media'
            ],
            order: [['joined_at', 'ASC']],
            raw: true
        });
        const serializedMembers = members.map(serializeMember);
        const membership = serializedMembers.find(member => member.username === username);

        return res.json({
            id: chat.id,
            name: chat.name,
            members: serializedMembers,
            members_count: serializedMembers.length,
            is_member: Boolean(membership),
            current_member: membership || null
        });
    } catch (error) {
        console.error('Chat info error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

exports.updateMemberPermissions = async (req, res) => {
    const { chat_id: chatId, username } = req.params;
    const allowedFields = ['can_send_messages', 'can_send_media'];
    const updates = {};

    for (const field of allowedFields) {
        if (Object.hasOwn(req.body || {}, field)) {
            if (typeof req.body[field] !== 'boolean') {
                return res.status(400).json({ message: `${field} must be a boolean` });
            }
            updates[field] = req.body[field];
        }
    }
    if (!Object.keys(updates).length) {
        return res.status(400).json({ message: 'No valid permission was provided' });
    }

    try {
        const member = await ChatMember.findOne({ where: { chat_id: chatId, username } });
        if (!member) return res.status(404).json({ message: 'Member not found' });
        if (member.is_admin) {
            return res.status(400).json({ message: 'Admin permissions cannot be restricted' });
        }

        member.set(updates);
        await member.save();
        const data = serializeMember(member);
        broadcastToRoom(chatId, { event: 'member_permissions_updated', data });
        return res.json({ success: true, member: data });
    } catch (error) {
        console.error('Update member permissions error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

exports.removeMember = async (req, res) => {
    const { chat_id: chatId, username } = req.params;

    try {
        const member = await ChatMember.findOne({ where: { chat_id: chatId, username } });
        if (!member) return res.status(404).json({ message: 'Member not found' });
        if (member.is_admin) {
            return res.status(400).json({ message: 'An admin cannot be removed from the chat' });
        }

        await member.destroy();
        broadcastToRoom(chatId, {
            event: 'member_removed',
            data: { username, removedBy: req.user.username }
        });
        disconnectUserFromRoom(chatId, username, 4003, 'Removed by admin');
        return res.json({ success: true, username });
    } catch (error) {
        console.error('Remove chat member error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

/**
 * GET /rooms/:chat_id
 * اگر لاگین نبود → login
 * اگر عضو نبود → join
 * اگر عضو بود → chat.html
 */
exports.openChat = async (req, res) => {
    return res.sendFile(
        path.join(__dirname, '../public/chat.html')
    );
};
