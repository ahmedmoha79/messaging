const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require('dotenv').config();

// Initialize Express with advanced configurations
const app = express();
const port = process.env.PORT || 3000;

// ======================
// SECURITY MIDDLEWARE
// ======================

// Generate a nonce for CSP
const nonce = crypto.randomBytes(16).toString('base64');

// Enhanced CORS Configuration
const corsOptions = {
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  maxAge: 86400
};

// Security headers with nonce for CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", `'nonce-${nonce}'`, 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'https://ui-avatars.com'],
      connectSrc: ["'self'", process.env.SUPABASE_URL],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true }
}));

// Rate limiting configuration
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for'] || req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      requestId: req.id,
      retryAfter: req.rateLimit.resetTime
    });
  }
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);

// Compression middleware with advanced options
app.use(compression({
  level: 6,
  threshold: 10 * 1024, // Compress responses larger than 10KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// Request logging with morgan in production format
app.use(morgan('combined', {
  skip: (req, res) => process.env.NODE_ENV === 'test',
  stream: process.stderr
}));

// Enhanced JSON parsing with size limit
app.use(express.json({
  limit: '10kb',
  strict: true,
  type: 'application/json'
}));

// Static files with cache control
app.use(express.static(__dirname, {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Request ID middleware for tracing
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ======================
// SUPABASE CONFIGURATION
// ======================

// Supabase Client with enhanced configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

// Validate environment variables
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false, // We'll handle sessions manually
    autoRefreshToken: false,
    detectSessionInUrl: false
  },
  global: {
    headers: {
      'X-Application-Name': 'Logistics-Messaging-API'
    }
  }
});

// Connection health check
async function checkSupabaseConnection() {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .limit(1);
    
    if (error) throw error;
    console.log('Supabase connection established successfully');
  } catch (error) {
    console.error('Supabase connection error:', error);
    process.exit(1);
  }
}

// ======================
// AUTHENTICATION LAYER
// ======================

// JWT configuration
const JWT_CONFIG = {
  secret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  expiresIn: '1h',
  algorithm: 'HS256',
  issuer: 'logistics-messaging-api'
};

// Enhanced authentication middleware with caching
const authCache = new Map();
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ 
      error: 'Authentication required',
      code: 'AUTH_HEADER_MISSING'
    });
  }

  // Check cache first
  if (authCache.has(token)) {
    const cachedUser = authCache.get(token);
    if (cachedUser.expiresAt > Date.now()) {
      req.user = cachedUser.user;
      return next();
    }
    authCache.delete(token);
  }

  try {
    // Verify JWT if present
    if (token.length > 100) { // Simple heuristic to distinguish JWT from Supabase tokens
      const decoded = jwt.verify(token, JWT_CONFIG.secret, {
        algorithms: [JWT_CONFIG.algorithm],
        issuer: JWT_CONFIG.issuer
      });
      
      const { data: { user }, error } = await supabase.auth.getUser(decoded.sub);
      
      if (error || !user) {
        return res.status(401).json({ 
          error: 'Invalid authentication',
          code: 'INVALID_TOKEN'
        });
      }

      // Cache the authenticated user
      authCache.set(token, {
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        },
        expiresAt: Date.now() + (JWT_CONFIG.expiresIn * 1000)
      });

      req.user = user;
      return next();
    }

    // Fall back to Supabase token verification
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ 
        error: 'Invalid authentication',
        code: 'INVALID_TOKEN'
      });
    }

    // Cache the authenticated user
    authCache.set(token, {
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      },
      expiresAt: Date.now() + (30 * 60 * 1000) // 30 minutes cache
    });

    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ 
      error: 'Authentication failed',
      code: 'AUTH_FAILURE'
    });
  }
};

// ======================
// ROUTES
// ======================

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// Login endpoint with brute force protection
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login attempts per windowMs
  message: 'Too many login attempts, please try again later',
  skipSuccessfulRequests: true
});

app.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Input validation
    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Missing credentials',
        code: 'MISSING_CREDENTIALS'
      });
    }

    // Email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format',
        code: 'INVALID_EMAIL'
      });
    }

    // Password length validation
    if (password.length < 8) {
      return res.status(400).json({ 
        error: 'Password must be at least 8 characters',
        code: 'PASSWORD_TOO_SHORT'
      });
    }

    // Perform login
    const { data, error } = await supabase.auth.signInWithPassword({ 
      email, 
      password 
    });

    if (error) {
      // Obfuscate error messages for security
      return res.status(401).json({ 
        error: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS'
      });
    }

    // Get or create user profile with transaction
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (profileError) {
      const { error: createError } = await supabase
        .from('users')
        .insert([{
          id: data.user.id,
          email: data.user.email,
          name: data.user.email.split('@')[0],
          status: 'online',
          lastonline: new Date().toISOString(),
          role: 'user'
        }]);

      if (createError) throw createError;
    }

    // Generate JWT token
    const token = jwt.sign({
      sub: data.user.id,
      email: data.user.email,
      role: profile?.role || 'user'
    }, JWT_CONFIG.secret, {
      expiresIn: JWT_CONFIG.expiresIn,
      algorithm: JWT_CONFIG.algorithm,
      issuer: JWT_CONFIG.issuer,
      jwtid: uuidv4()
    });

    // Secure cookie settings
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000, // 1 hour
      domain: process.env.COOKIE_DOMAIN || undefined
    });

    // Return response
    res.json({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in
      },
      user: profile || {
        id: data.user.id,
        email: data.user.email,
        name: data.user.email.split('@')[0],
        status: 'online',
        role: 'user'
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Authentication failed',
      code: 'AUTH_FAILURE'
    });
  }
});

// User endpoints with caching
const userCache = new Map();
app.get('/api/users', authenticateUser, async (req, res) => {
  try {
    const cacheKey = `users-${req.user.id}`;
    
    // Check cache
    if (userCache.has(cacheKey)) {
      const cachedData = userCache.get(cacheKey);
      if (cachedData.expiresAt > Date.now()) {
        return res.json(cachedData.data);
      }
      userCache.delete(cacheKey);
    }

    // Fetch from database
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email, lastonline, status, role')
      .neq('id', req.user.id)
      .order('lastonline', { ascending: false });

    if (error) throw error;

    // Process data
    const processedUsers = users.map(user => ({
      ...user,
      status: calculateUserStatus(user.lastonline)
    }));

    // Cache the result
    userCache.set(cacheKey, {
      data: processedUsers,
      expiresAt: Date.now() + (5 * 60 * 1000) // 5 minutes cache
    });

    res.json(processedUsers);
  } catch (error) {
    console.error('Users error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch users',
      code: 'USER_FETCH_FAILED'
    });
  }
});

// Message endpoints with optimized queries
const messageCache = new Map();
app.get('/api/messages/:partnerId', authenticateUser, async (req, res) => {
  try {
    const { partnerId } = req.params;
    const cacheKey = `messages-${req.user.id}-${partnerId}`;
    
    // Validate partnerId
    if (!partnerId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(partnerId)) {
      return res.status(400).json({ 
        error: 'Invalid partner ID',
        code: 'INVALID_PARTNER_ID'
      });
    }

    // Check cache
    if (messageCache.has(cacheKey)) {
      const cachedData = messageCache.get(cacheKey);
      if (cachedData.expiresAt > Date.now()) {
        return res.json(cachedData.data);
      }
      messageCache.delete(cacheKey);
    }

    // Fetch messages with optimized query
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .or(`and(sender_id.eq.${req.user.id},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${req.user.id})`)
      .order('created_at', { ascending: true })
      .limit(100); // Limit to 100 most recent messages

    if (error) throw error;

    // Mark messages as read in background
    supabase
      .from('messages')
      .update({ is_read: true })
      .eq('receiver_id', req.user.id)
      .eq('sender_id', partnerId)
      .then(({ error: updateError }) => {
        if (updateError) console.error('Message read update error:', updateError);
      });

    // Cache the result
    messageCache.set(cacheKey, {
      data: messages,
      expiresAt: Date.now() + (1 * 60 * 1000) // 1 minute cache
    });

    res.json(messages);
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({ 
      error: 'Failed to load messages',
      code: 'MESSAGE_FETCH_FAILED'
    });
  }
});

// Message sending with rate limiting per user
const messageLimiter = new Map();
app.post('/api/messages', authenticateUser, async (req, res) => {
  try {
    const { receiver_id, content } = req.body;
    
    // Input validation
    if (!receiver_id || !content) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        code: 'MISSING_FIELDS'
      });
    }

    if (content.length > 1000) {
      return res.status(400).json({ 
        error: 'Message too long',
        code: 'MESSAGE_TOO_LONG'
      });
    }

    // Per-user rate limiting
    const userLimitKey = `user-${req.user.id}`;
    const now = Date.now();
    const windowSize = 60 * 1000; // 1 minute
    const maxMessages = 10; // Max 10 messages per minute

    if (!messageLimiter.has(userLimitKey)) {
      messageLimiter.set(userLimitKey, {
        count: 1,
        lastReset: now
      });
    } else {
      const userLimit = messageLimiter.get(userLimitKey);
      
      if (now - userLimit.lastReset > windowSize) {
        userLimit.count = 1;
        userLimit.lastReset = now;
      } else if (userLimit.count >= maxMessages) {
        return res.status(429).json({ 
          error: 'Too many messages',
          code: 'MESSAGE_LIMIT_EXCEEDED',
          retryAfter: windowSize - (now - userLimit.lastReset)
        });
      } else {
        userLimit.count += 1;
      }
    }

    // Insert message with transaction
    const { data: message, error } = await supabase
      .from('messages')
      .insert([{
        sender_id: req.user.id,
        receiver_id,
        content: content.trim(),
        is_read: false,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    // Update user status in background
    supabase
      .from('users')
      .update({ 
        lastonline: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', req.user.id)
      .then(({ error: updateError }) => {
        if (updateError) console.error('User status update error:', updateError);
      });

    // Invalidate caches
    messageCache.delete(`messages-${req.user.id}-${receiver_id}`);
    messageCache.delete(`messages-${receiver_id}-${req.user.id}`);

    res.status(201).json(message);
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ 
      error: 'Message send failed',
      code: 'MESSAGE_SEND_FAILED'
    });
  }
});

// ======================
// HELPER FUNCTIONS
// ======================

function calculateUserStatus(lastonline) {
  if (!lastonline) return 'offline';
  
  const last = new Date(lastonline);
  const diff = (Date.now() - last.getTime()) / 1000;
  
  if (diff < 60) return 'online'; // Online if active in last minute
  if (diff < 300) return 'away'; // Away if active in last 5 minutes
  return 'offline';
}

// ======================
// SERVER INITIALIZATION
// ======================

// Database connection check
checkSupabaseConnection().then(() => {
  // Start server
  const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Enhanced error handling
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});