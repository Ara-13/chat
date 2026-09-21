const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const MessageSeen = sequelize.define('MessageSeen', {
    message_id: {
        type: DataTypes.CHAR(36),
        primaryKey: true
    },
    username: {
        type: DataTypes.STRING(50),
        primaryKey: true
    },
    seen_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'message_seen',
    timestamps: false,
    indexes: [
        { fields: ['username'] }
    ]
});

module.exports = MessageSeen;
