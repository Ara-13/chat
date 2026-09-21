const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const Chat = sequelize.define('Chat', {
    id: {
        type: DataTypes.CHAR(24),
        primaryKey: true
    },
    name: {
        type: DataTypes.TEXT,
        allowNull: false
    }
}, {
    tableName: 'chats',
    timestamps: false
});

module.exports = Chat;