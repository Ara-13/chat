const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const Message = sequelize.define('Message', {
    id: {
        type: DataTypes.CHAR(36),
        primaryKey: true
    },
    chat_id: {
        type: DataTypes.CHAR(24),
        allowNull: false
    },
    sender_username: {
        type: DataTypes.STRING(50),
        allowNull: false
    },
    type: {
        type: DataTypes.ENUM('text', 'file', 'music', 'voice'),
        allowNull: false
    },
    content: {
        type: DataTypes.TEXT
    },
    reply_to: {
        type: DataTypes.CHAR(36)
    },
    file_path: DataTypes.TEXT,
    file_name: DataTypes.TEXT,
    file_size: DataTypes.INTEGER,
    file_mime: DataTypes.STRING(100),
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    },
    edited_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    pinned_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    pinned_by: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    section: {
        // Deprecated compatibility column. All new messages belong to main;
        // older music/file rows are merged into the same public timeline.
        type: DataTypes.ENUM('main', 'music', 'file'),
        allowNull: false,
        defaultValue: 'main'
    }
}, {
    tableName: 'messages',
    timestamps: false,
    indexes: [
        {
            name: 'messages_chat_history',
            fields: ['chat_id', 'created_at', 'id']
        },
        {
            name: 'messages_chat_type_history',
            fields: ['chat_id', 'type', 'created_at', 'id']
        }
    ]
});

module.exports = Message;
