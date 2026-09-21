const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const ChatMember = sequelize.define('ChatMember', {
    chat_id: {
        type: DataTypes.STRING,
        primaryKey: true
    },
    username: {
        type: DataTypes.STRING,
        primaryKey: true
    },
    joined_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    },
    scroll_positions: {
        type: DataTypes.JSON,
        allowNull: true
    },
    is_admin: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    can_send_messages: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
    },
    can_send_media: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
    }
}, {
    tableName: 'chat_members',
    timestamps: false
});

module.exports = ChatMember;
