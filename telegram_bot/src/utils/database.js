const { PrismaClient } = require('@prisma/client');
const logger = require('./logger');

const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('error', (e) => {
  logger.error('Prisma Error:', e);
});

prisma.$on('warn', (e) => {
  logger.warn('Prisma Warning:', e);
});

if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (e) => {
    logger.debug(`Query: ${e.query}`);
    logger.debug(`Duration: ${e.duration}ms`);
  });
}

async function connectDatabase() {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');
    return true;
  } catch (error) {
    logger.error('Failed to connect to database:', error);
    throw error;
  }
}

async function disconnectDatabase() {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}

module.exports = {
  prisma,
  connectDatabase,
  disconnectDatabase,
};
