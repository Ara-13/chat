const User = require('./Users');
const Chat = require('./Chat');
const Message = require('./Message');
const ChatMember = require('./ChatMember');
const MessageSeen = require('./MessageSeen');
const MessageReaction = require('./MessageReaction');
const sequelize = require('../db/sequelize');


// message ↔ user
Message.belongsTo(User, {
    foreignKey: 'sender_username',
    targetKey: 'username'
});

User.hasMany(Message, {
    foreignKey: 'sender_username'
});

// message ↔ chat
Message.belongsTo(Chat, {
    foreignKey: 'chat_id'
});

Chat.hasMany(Message, {
    foreignKey: 'chat_id'
});

// chat ↔ members (many-to-many via ChatMember)
Chat.belongsToMany(User, {
    through: ChatMember,
    foreignKey: 'chat_id',
    otherKey: 'username'
});

User.belongsToMany(Chat, {
    through: ChatMember,
    foreignKey: 'username',
    otherKey: 'chat_id'
});

// reply (self reference)
Message.belongsTo(Message, {
    as: 'reply',
    foreignKey: 'reply_to'
});

Message.hasMany(MessageSeen, {
    as: 'seenReceipts',
    foreignKey: 'message_id',
    onDelete: 'CASCADE'
});

MessageSeen.belongsTo(Message, {
    foreignKey: 'message_id',
    onDelete: 'CASCADE'
});

MessageSeen.belongsTo(User, {
    foreignKey: 'username',
    targetKey: 'username',
    onDelete: 'CASCADE'
});

// message ↔ reactions
Message.hasMany(MessageReaction, {
    as: 'reactions',
    foreignKey: 'message_id',
    onDelete: 'CASCADE'
});

MessageReaction.belongsTo(Message, {
    foreignKey: 'message_id',
    onDelete: 'CASCADE'
});

MessageReaction.belongsTo(User, {
    foreignKey: 'username',
    targetKey: 'username',
    onDelete: 'CASCADE'
});

module.exports = {
    sequelize,
    User,
    Chat,
    Message,
    ChatMember,
    MessageSeen,
    MessageReaction
};
