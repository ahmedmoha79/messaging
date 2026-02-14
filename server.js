const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();
const fetch = require('node-fetch');

const app = express();
const port = parseInt(process.env.PORT, 10) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Supabase Client Configuration
// NOTE: Kept fallback values to avoid disrupting the currently live deployment behavior.
const supabaseUrl = process.env.SUPABASE_URL || 'https://twsqvdxhsfvdibhpfvqr.supabase.co';
const supabaseKey =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3c3F2ZHhoc2Z2ZGliaHBmdnFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDAxNDA2MzUsImV4cCI6MjA1NTcxNjYzNX0.EVjqobvn9fAd4djsBfg1zOlA2CVSeYukmsc_DMhT1b4';
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      'X-Client-Info': 'messaging-api/2.0',
    },
  },
});

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CORS Configuration (supports one or many origins via comma-separated env var)
const configuredOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (configuredOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

const globalRequestStore = new Map();
const authRequestStore = new Map();

function checkRateLimit(store, key, windowMs, maxRequests) {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { limited: false };
  }

  entry.count += 1;
  if (entry.count > maxRequests) {
    return { limited: true, retryAfter: Math.ceil((windowMs - (now - entry.windowStart)) / 1000) };
  }
  return { limited: false };
}

app.use((req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const result = checkRateLimit(globalRequestStore, key, 60 * 1000, 300);
  if (result.limited) {
    res.setHeader('Retry-After', String(result.retryAfter));
    return res.status(429).json({ error: 'Too many requests', details: 'Please retry in one minute' });
  }
  return next();
});

// Middleware
app.use(express.static(__dirname, { etag: true, maxAge: isProd ? '1h' : 0 }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

function getErrorDetails(error) {
  return isProd ? undefined : error?.message;
}

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { latitude: lat, longitude: lng };
}

async function authenticateUser(req, res, next) {
  try {
    const cookieToken = String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('access_token='))
      ?.slice('access_token='.length);

    const token = req.headers.authorization?.split(' ')[1] || cookieToken;
    if (!token) {
      return res.status(401).json({
        error: 'Authentication required',
        redirect: '/login.html',
      });
    }

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        error: 'Invalid or expired session',
        redirect: '/login.html',
      });
    }

    req.user = user;
    return next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({
      error: 'Authentication error',
      details: getErrorDetails(error),
    });
  }
}

// Routes
app.get('/', (req, res) => res.sendFile(`${__dirname}/login.html`));

// Login Endpoint
app.post('/auth/login', (req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const result = checkRateLimit(authRequestStore, key, 15 * 60 * 1000, 20);
  if (result.limited) {
    res.setHeader('Retry-After', String(result.retryAfter));
    return res.status(429).json({ error: 'Too many authentication attempts', details: 'Retry later' });
  }
  return next();
}, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        error: 'Missing credentials',
        details: 'Both email and password are required',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail.includes('@') || normalizedEmail.length > 320 || password.length > 256) {
      return res.status(400).json({
        error: 'Invalid credentials format',
      });
    }

    const userAgent = req.headers['user-agent'] || '';
    const deviceType = /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent) ? 'mobile' : 'desktop';

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (error) {
      return res.status(401).json({
        error: 'Authentication failed',
        details: getErrorDetails(error),
      });
    }

    // Get or create user profile with device context
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    let hydratedProfile = profile;
    if (profileError) {
      const { data: insertedProfile, error: createError } = await supabase
        .from('users')
        .insert([
          {
            id: data.user.id,
            email: data.user.email,
            name: data.user.email.split('@')[0],
            status: 'online',
            lastonline: new Date().toISOString(),
            device_type: deviceType,
          },
        ])
        .select('*')
        .single();

      if (createError) throw createError;
      hydratedProfile = insertedProfile;
    } else {
      // Update device type if changed
      await supabase
        .from('users')
        .update({
          device_type: deviceType,
          lastonline: new Date().toISOString(),
          status: 'online',
        })
        .eq('id', data.user.id);
    }

    // Set secure HTTP-only cookie
    res.cookie('access_token', data.session.access_token, {
      httpOnly: true,
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'strict',
      path: '/',
    });

    return res.json({
      session: data.session,
      user: hydratedProfile || {
        id: data.user.id,
        email: data.user.email,
        name: data.user.email.split('@')[0],
        status: 'online',
        device_type: deviceType,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      error: 'Server error during login',
      details: getErrorDetails(error),
    });
  }
});

app.get('/api/users', authenticateUser, async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select(`
        id,
        email,
        name,
        lastonline,
        status,
        device_type,
        user_locations:user_locations(
          latitude,
          longitude,
          last_updated,
          device_context
        )
      `)
      .order('lastonline', { ascending: false });

    if (error) throw error;

    const processedUsers = users.map((user) => {
      const lastOnline = user.lastonline ? new Date(user.lastonline) : null;
      const isOnline = user.status === 'online' && lastOnline && Date.now() - lastOnline.getTime() < 300000;

      const latestLocation = user.user_locations?.[0];
      const batteryLevel = latestLocation?.device_context?.battery_level;

      return {
        ...user,
        status: isOnline ? 'online' : 'offline',
        last_seen: lastOnline ? formatLastOnline(lastOnline) : 'Never',
        battery_level: batteryLevel,
        battery_status: batteryLevel ? getBatteryStatus(batteryLevel) : null,
        location: latestLocation
          ? {
              latitude: latestLocation.latitude,
              longitude: latestLocation.longitude,
              last_updated: latestLocation.last_updated,
            }
          : null,
      };
    });

    return res.json(processedUsers);
  } catch (error) {
    console.error('Users error:', error);
    return res.status(500).json({
      error: 'Failed to fetch users',
      details: getErrorDetails(error),
    });
  }
});

function formatLastOnline(date) {
  const diff = (Date.now() - date.getTime()) / 60000;
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${Math.floor(diff)}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

function getBatteryStatus(level) {
  if (level > 70) return 'high';
  if (level > 30) return 'medium';
  return 'low';
}

app.get('/api/messages/:partnerId', authenticateUser, async (req, res) => {
  try {
    const currentUser = req.user.id;
    const partnerId = String(req.params.partnerId || '').trim();

    if (!partnerId) {
      return res.status(400).json({ error: 'partnerId is required' });
    }

    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .or(
        `and(sender_id.eq.${currentUser},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${currentUser})`
      )
      .order('created_at', { ascending: true });

    if (error) throw error;

    if (messages.length > 0) {
      const unreadMessageIds = messages
        .filter((msg) => msg.receiver_id === currentUser && !msg.is_read)
        .map((msg) => msg.id);

      if (unreadMessageIds.length > 0) {
        await supabase
          .from('messages')
          .update({
            is_read: true,
            read_at: new Date().toISOString(),
          })
          .in('id', unreadMessageIds);
      }
    }

    return res.json(messages);
  } catch (error) {
    console.error('Messages error:', error);
    return res.status(500).json({
      error: 'Failed to load messages',
      details: getErrorDetails(error),
    });
  }
});

app.post('/api/messages', authenticateUser, async (req, res) => {
  try {
    const { receiver_id, content, audio_url, audio_duration, audio_waveform, message_type } = req.body;
    if (!receiver_id || (!content && !audio_url)) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'Both receiver_id and content (or audio_url) are required',
      });
    }

    const safeContent = typeof content === 'string' ? content.slice(0, 4000) : content;

    const { data: message, error } = await supabase
      .from('messages')
      .insert([
        {
          sender_id: req.user.id,
          receiver_id,
          content: safeContent || 'Audio message',
          is_read: false,
          device_type: req.user.device_type || 'desktop',
          audio_url,
          audio_duration,
          audio_waveform,
          message_type: message_type || (audio_url ? 'audio' : 'text'),
        },
      ])
      .select()
      .single();

    if (error) throw error;

    await supabase
      .from('users')
      .update({
        lastonline: new Date().toISOString(),
        status: 'online',
      })
      .eq('id', req.user.id);

    await supabase.channel('notifications').send({
      type: 'broadcast',
      event: 'new_message',
      payload: {
        message_id: message.id,
        type: message.message_type,
        sender_id: req.user.id,
        receiver_id,
        scheduled_at: new Date().toISOString(),
        content: safeContent || 'Audio message',
      },
    });

    return res.json(message);
  } catch (error) {
    console.error('Send error:', error);
    return res.status(500).json({
      error: 'Message send failed',
      details: getErrorDetails(error),
    });
  }
});

app.post('/api/locations', authenticateUser, async (req, res) => {
  try {
    const { latitude, longitude, accuracy, battery_level } = req.body;

    const coords = parseCoordinates(latitude, longitude);
    if (!coords) {
      return res.status(400).json({
        error: 'Invalid location data',
        details: 'Valid latitude/longitude are required',
      });
    }

    const safeBattery = Number.isFinite(Number(battery_level))
      ? Math.max(0, Math.min(100, Number(battery_level)))
      : null;

    const { data: location, error } = await supabase
      .from('user_locations')
      .upsert({
        user_id: req.user.id,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
        last_updated: new Date().toISOString(),
        device_context: {
          is_mobile: req.user.device_type === 'mobile',
          battery_level: safeBattery,
          device_type: req.user.device_type || 'desktop',
        },
      })
      .select()
      .single();

    if (error) throw error;

    await supabase
      .from('users')
      .update({
        lastonline: new Date().toISOString(),
        status: 'online',
      })
      .eq('id', req.user.id);

    return res.json(location);
  } catch (error) {
    console.error('Location save error:', error);
    return res.status(500).json({
      error: 'Failed to save location',
      details: getErrorDetails(error),
    });
  }
});

app.get('/api/locations/history/:userId', authenticateUser, async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const limit = parsePositiveInt(req.query.limit, 20, 100);
    const page = parsePositiveInt(req.query.page, 1, 10000);
    const offset = (page - 1) * limit;

    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Unauthorized access',
        details: 'You can only view your own location history',
      });
    }

    const { data: locations, error } = await supabase
      .from('user_locations')
      .select('*')
      .eq('user_id', userId)
      .order('last_updated', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const { count, error: countError } = await supabase
      .from('user_locations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (countError) throw countError;

    return res.json({
      data: locations,
      pagination: {
        total: count,
        page,
        per_page: limit,
        total_pages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    console.error('Location history error:', error);
    return res.status(500).json({
      error: 'Failed to fetch location history',
      details: getErrorDetails(error),
    });
  }
});

app.post('/api/route/optimize', authenticateUser, async (req, res) => {
  try {
    const waypoints = Array.isArray(req.body?.waypoints) ? req.body.waypoints : [];

    if (waypoints.length < 2 || waypoints.length > 100) {
      return res.status(400).json({
        error: 'Invalid route request',
        details: 'Provide between 2 and 100 waypoints',
      });
    }

    const validWaypoints = waypoints
      .map((wp) => {
        const coords = parseCoordinates(wp.latitude, wp.longitude);
        return coords ? { ...wp, ...coords } : null;
      })
      .filter(Boolean);

    if (validWaypoints.length < 2) {
      return res.status(400).json({
        error: 'Invalid coordinates',
        details: 'Provide valid latitude/longitude pairs',
      });
    }

    const optimizedRoute = calculateOptimizedRoute(validWaypoints);
    return res.json(optimizedRoute);
  } catch (error) {
    console.error('Route optimization error:', error);
    return res.status(500).json({
      error: 'Failed to optimize route',
      details: getErrorDetails(error),
    });
  }
});

function calculateOptimizedRoute(waypoints) {
  const coordinates = waypoints.map((wp) => ({
    latitude: wp.latitude,
    longitude: wp.longitude,
  }));

  let totalDistance = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    totalDistance += haversineDistance(coordinates[i - 1], coordinates[i]);
  }

  return {
    coordinates,
    waypoints: [...waypoints],
    total_distance: totalDistance,
    estimated_time: totalDistance * 1.2,
    waypoint_count: waypoints.length,
  };
}

function haversineDistance(coord1, coord2) {
  const R = 6371;
  const dLat = toRad(coord2.latitude - coord1.latitude);
  const dLon = toRad(coord2.longitude - coord1.longitude);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(coord1.latitude)) * Math.cos(toRad(coord2.latitude)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

app.get('/api/heatmap', authenticateUser, async (req, res) => {
  try {
    const hours = parsePositiveInt(req.query.hours, 24, 24 * 30);
    const timeThreshold = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const { data: locations, error } = await supabase
      .from('user_locations')
      .select('latitude, longitude, last_updated, user_id, device_context')
      .gt('last_updated', timeThreshold);

    if (error) throw error;

    const heatmapData = locations.map((loc) => ({
      lat: loc.latitude,
      lng: loc.longitude,
      weight: 1,
      user_id: loc.user_id,
      battery: loc.device_context?.battery_level,
      timestamp: loc.last_updated,
    }));

    return res.json(heatmapData);
  } catch (error) {
    console.error('Heatmap error:', error);
    return res.status(500).json({
      error: 'Failed to generate heatmap',
      details: getErrorDetails(error),
    });
  }
});

app.get('/api/battery', authenticateUser, async (req, res) => {
  try {
    const { data: locations, error } = await supabase
      .from('user_locations')
      .select('user_id, device_context')
      .order('last_updated', { ascending: false });

    if (error) throw error;

    const batteryStatus = {};
    locations.forEach((loc) => {
      if (loc.device_context?.battery_level && !batteryStatus[loc.user_id]) {
        batteryStatus[loc.user_id] = {
          level: loc.device_context.battery_level,
          status: getBatteryStatus(loc.device_context.battery_level),
          is_charging: loc.device_context.is_charging || false,
        };
      }
    });

    return res.json(batteryStatus);
  } catch (error) {
    console.error('Battery status error:', error);
    return res.status(500).json({
      error: 'Failed to fetch battery status',
      details: getErrorDetails(error),
    });
  }
});

app.get('/health', (req, res) => {
  try {
    return res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      ...(isProd ? {} : { memory: process.memoryUsage() }),
    });
  } catch (error) {
    console.error('Health check error:', error);
    return res.status(500).json({
      status: 'unhealthy',
      error: getErrorDetails(error),
      timestamp: new Date().toISOString(),
    });
  }
});

// Background ping service (prevents Render free-tier idling when configured)
const pingInterval = 14 * 60 * 1000;

function resolveKeepAliveUrl() {
  const explicitUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL;
  if (explicitUrl) return explicitUrl.replace(/\/$/, '');

  // Render often exposes hostname separately; build URL if present.
  const renderHostname = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (renderHostname) return `https://${renderHostname}`;

  // Safe fallback for this live app to preserve previous behavior.
  return 'https://messaging-app.onrender.com';
}

const pingUrl = resolveKeepAliveUrl();

function pingServer() {
  fetch(`${pingUrl}/health`, {
    method: 'GET',
    headers: { 'User-Agent': 'messaging-keepalive/1.0' },
  })
    .then((response) => {
      if (!response.ok) {
        console.error('Keep-alive health check failed:', response.status);
      }
    })
    .catch((error) => {
      console.error('Keep-alive ping failed:', error.message || error);
    });
}

const pingTimer = setInterval(pingServer, pingInterval);
pingTimer.unref();

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  return res.status(500).json({
    error: 'Internal server error',
    details: getErrorDetails(err),
  });
});

app.use((req, res) => {
  return res.status(404).json({
    error: 'Endpoint not found',
    available_endpoints: [
      '/auth/login',
      '/api/users',
      '/api/messages/:partnerId',
      '/api/locations',
      '/api/locations/history/:userId',
      '/api/route/optimize',
      '/api/heatmap',
      '/api/battery',
      '/health',
    ],
  });
});

let httpServer;

const startServer = async () => {
  try {
    // Verify Supabase connectivity without requiring specific schema fields.
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) {
      console.error('Supabase connection test failed:', error);
      process.exit(1);
    }
    console.log('Supabase connection verified');

    httpServer = app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`Health check available at http://localhost:${port}/health`);
      console.log(`Keep-alive enabled: pinging ${pingUrl}/health every ${pingInterval / 60000} minutes`);
      pingServer();
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
};

function shutdown(signal) {
  console.log(`Received ${signal}. Gracefully shutting down...`);
  clearInterval(pingTimer);

  if (httpServer) {
    httpServer.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();
