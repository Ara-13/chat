const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const MessageReaction = sequelize.define('MessageReaction', {
    message_id: {
        type: DataTypes.CHAR(36),
        primaryKey: true,
        allowNull: false
    },
    username: {
        type: DataTypes.STRING(50),
        primaryKey: true,
        allowNull: false
    },
    emoji: {
        type: DataTypes.STRING(100),
        allowNull: false
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'message_reactions',
    timestamps: false,
    indexes: [
        {
            name: 'reactions_message_idx',
            fields: ['message_id']
        },
        {
            name: 'reactions_user_idx',
            fields: ['username']
        }
    ]
});

module.exports = MessageReaction;
