// logger.js
const winston = require('winston');
const fs = require('fs');

// Create logs directory if it doesn't exist
if (!fs.existsSync('./logs')) {
  fs.mkdirSync('./logs');
}

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'monad-mint-bot' },
  transports: [
    new winston.transports.File({ filename: './logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: './logs/combined.log' })
  ]
});

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Helper function to log actions with context
function logAction(action, data = {}) {
  logger.info({ action, ...data });
}

module.exports = {
  logger,
  logAction
};
