const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const User = sequelize.define('User', {
    username: {
        type: DataTypes.STRING(50),
        primaryKey: true
    },
    password: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    date_joined: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'users',
    timestamps: false
});

module.exports = User;