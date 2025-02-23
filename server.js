import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import compression from 'compression';
import { PrismaClient } from '@prisma/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Enable gzip compression
app.use(compression());
app.use(express.json());

// CORS middleware for development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });
}

// Database connection management
let prisma = null;
let isConnected = false;
let connectionRetries = 0;
const MAX_RETRIES = process.env.DB_MAX_RETRIES ? parseInt(process.env.DB_MAX_RETRIES, 10) : 5;
const RETRY_DELAY = process.env.DB_RETRY_DELAY ? parseInt(process.env.DB_RETRY_DELAY, 10) : 5000;

const createPrismaClient = () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  return new PrismaClient();
};

const connectDB = async () => {
  if (isConnected) return true;

  try {
    if (prisma) {
      await prisma.$disconnect();
    }

    console.log('Creating new Prisma client...');
    prisma = createPrismaClient();
    
    console.log('Testing database connection...');
    await prisma.$connect();
    
    console.log('Database connection successful');
    isConnected = true;
    connectionRetries = 0;
    return true;
  } catch (error) {
    console.error('Database connection error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack
    });
    
    isConnected = false;
    prisma = null;

    if (connectionRetries < MAX_RETRIES) {
      connectionRetries++;
      console.log(`Retrying connection (${connectionRetries}/${MAX_RETRIES}) in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return connectDB();
    }
    return false;
  }
};

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: isConnected ? 'connected' : 'disconnected',
      environment: {
        nodeEnv: process.env.NODE_ENV,
        hasConnectionString: !!process.env.DATABASE_URL
      }
    };

    if (isConnected) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        health.database = 'connected';
      } catch (dbError) {
        console.error('Database health check failed:', dbError);
        health.database = 'error';
        health.databaseError = dbError.message;
        
        // Attempt to reconnect in the background
        connectDB().catch(error => {
          console.error('Reconnection attempt failed:', error);
        });
      }
    } else {
      // Attempt to connect if not connected
      const connected = await connectDB();
      health.database = connected ? 'connected' : 'disconnected';
    }

    const statusCode = health.database === 'connected' ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Serve static files from the Next.js build output
app.use(express.static(join(__dirname, '.next')));

// Handle API routes
app.use('/api', (req, res, next) => {
  if (!isConnected) {
    connectDB()
      .then(connected => {
        if (!connected) {
          return res.status(503).json({
            error: true,
            message: 'Database not connected'
          });
        }
        next();
      })
      .catch(next);
  } else {
    next();
  }
});

// Next.js request handler
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '.next/server/pages', req.path));
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  if (prisma) {
    try {
      await prisma.$disconnect();
      console.log('Database connection closed');
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Initialize server
const startServer = async () => {
  try {
    const server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check available at: http://localhost:${PORT}/api/health`);
      console.log('Environment:', {
        nodeEnv: process.env.NODE_ENV,
        hasConnectionString: !!process.env.DATABASE_URL
      });
    });

    const dbConnected = await connectDB();
    if (!dbConnected) {
      console.log('Server started but database connection failed');
    }

    return server;
  } catch (error) {
    console.error('Failed to start server:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
};

startServer();