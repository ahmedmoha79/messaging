const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// CORS Configuration
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Supabase Client Configuration
const supabaseUrl = process.env.SUPABASE_URL || "https://twsqvdxhsfvdibhpfvqr.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3c3F2ZHhoc2Z2ZGliaHBmdnFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDAxNDA2MzUsImV4cCI6MjA1NTcxNjYzNX0.EVjqobvn9fAd4djsBfg1zOlA2CVSeYukmsc_DMhT1b4";
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(express.static(__dirname));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enhanced Authentication Middleware
const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.access_token;
    if (!token) {
      return res.status(401).json({ 
        error: 'Authentication required',
        redirect: '/login.html'
      });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ 
        error: 'Invalid or expired session',
        redirect: '/login.html'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ 
      error: 'Authentication error',
      details: error.message 
    });
  }
};

// Routes
app.get('/', (req, res) => res.sendFile(__dirname + '/login.html'));

// Enhanced Login Endpoint with Device Detection
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Missing credentials',
        details: 'Both email and password are required'
      });
    }

    const userAgent = req.headers['user-agent'];
    let deviceType = 'desktop';
    if (/Mobile|Android|iPhone|iPad|iPod/i.test(userAgent)) {
      deviceType = 'mobile';
    }

    const { data, error } = await supabase.auth.signInWithPassword({ 
      email, 
      password 
    });

    if (error) {
      return res.status(401).json({ 
        error: 'Authentication failed',
        details: error.message 
      });
    }

    // Get or create user profile with device context
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
          device_type: deviceType
        }]);

      if (createError) throw createError;
    } else {
      // Update device type if changed
      await supabase
        .from('users')
        .update({ 
          device_type: deviceType,
          lastonline: new Date().toISOString(),
          status: 'online'
        })
        .eq('id', data.user.id);
    }

    // Set secure HTTP-only cookie
    res.cookie('access_token', data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'strict'
    });

    return res.json({
      session: data.session,
      user: profile || {
        id: data.user.id,
        email: data.user.email,
        name: data.user.email.split('@')[0],
        status: 'online',
        device_type: deviceType
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Server error during login',
      details: error.message 
    });
  }
});

// Enhanced User Management Endpoints
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

    // Process users with location and battery data
    const processedUsers = users.map(user => {
      const lastOnline = user.lastonline ? new Date(user.lastonline) : null;
      const isOnline = user.status === 'online' && lastOnline && 
        (Date.now() - lastOnline.getTime()) < 300000;
      
      const latestLocation = user.user_locations?.[0];
      const batteryLevel = latestLocation?.device_context?.battery_level;
      
      return {
        ...user,
        status: isOnline ? 'online' : 'offline',
        last_seen: lastOnline ? formatLastOnline(lastOnline) : 'Never',
        battery_level: batteryLevel,
        battery_status: batteryLevel ? getBatteryStatus(batteryLevel) : null,
        location: latestLocation ? {
          latitude: latestLocation.latitude,
          longitude: latestLocation.longitude,
          last_updated: latestLocation.last_updated
        } : null
      };
    });

    res.json(processedUsers);
  } catch (error) {
    console.error('Users error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch users',
      details: error.message 
    });
  }
});

// Helper functions for formatting
function formatLastOnline(date) {
  const diff = (Date.now() - date.getTime()) / 60000;
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${Math.floor(diff)}m ago`;
  if (diff < 1440) return `${Math.floor(diff/60)}h ago`;
  return `${Math.floor(diff/1440)}d ago`;
}

function getBatteryStatus(level) {
  if (level > 70) return 'high';
  if (level > 30) return 'medium';
  return 'low';
}

// Enhanced Message Endpoints with Read Receipts
app.get('/api/messages/:partnerId', authenticateUser, async (req, res) => {
  try {
    const currentUser = req.user.id;
    const partnerId = req.params.partnerId;

    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .or(`and(sender_id.eq.${currentUser},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${currentUser})`)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Mark messages as read in bulk for better performance
    if (messages.length > 0) {
      const unreadMessages = messages.filter(
        msg => msg.receiver_id === currentUser && !msg.is_read
      );

      if (unreadMessages.length > 0) {
        await supabase
          .from('messages')
          .update({ 
            is_read: true,
            read_at: new Date().toISOString()
          })
          .in('id', unreadMessages.map(msg => msg.id));
      }
    }

    res.json(messages);
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({ 
      error: 'Failed to load messages',
      details: error.message 
    });
  }
});

// Enhanced Message Sending with Typing Indicators
app.post('/api/messages', authenticateUser, async (req, res) => {
  try {
    const { receiver_id, content } = req.body;
    if (!receiver_id || !content) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'Both receiver_id and content are required'
      });
    }

    const { data: message, error } = await supabase
      .from('messages')
      .insert([{
        sender_id: req.user.id,
        receiver_id,
        content,
        is_read: false,
        device_type: req.user.device_type || 'desktop'
      }])
      .select()
      .single();

    if (error) throw error;

    // Update user's last activity
    await supabase
      .from('users')
      .update({ 
        lastonline: new Date().toISOString(),
        status: 'online'
      })
      .eq('id', req.user.id);

    // Broadcast message notification via Supabase Realtime
    await supabase
      .channel('notifications')
      .send({
        type: 'broadcast',
        event: 'new_message',
        payload: {
          message_id: message.id,
          sender_id: req.user.id,
          receiver_id,
          content: content.length > 100 ? content.substring(0, 100) + '...' : content
        }
      });

    res.json(message);
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ 
      error: 'Message send failed',
      details: error.message 
    });
  }
});

// Enhanced Location Endpoints with Battery Tracking
app.post('/api/locations', authenticateUser, async (req, res) => {
  try {
    const { latitude, longitude, accuracy, battery_level } = req.body;
    
    if (!latitude || !longitude) {
      return res.status(400).json({ 
        error: 'Missing required location data',
        details: 'Both latitude and longitude are required'
      });
    }

    const { data: location, error } = await supabase
      .from('user_locations')
      .upsert({
        user_id: req.user.id,
        latitude,
        longitude,
        accuracy: accuracy || null,
        last_updated: new Date().toISOString(),
        device_context: {
          is_mobile: req.user.device_type === 'mobile',
          battery_level: battery_level || null,
          device_type: req.user.device_type || 'desktop'
        }
      })
      .select()
      .single();

    if (error) throw error;

    // Update user's last online status
    await supabase
      .from('users')
      .update({ 
        lastonline: new Date().toISOString(),
        status: 'online'
      })
      .eq('id', req.user.id);

    res.json(location);
  } catch (error) {
    console.error('Location save error:', error);
    res.status(500).json({ 
      error: 'Failed to save location',
      details: error.message 
    });
  }
});

// Enhanced Location History with Pagination
app.get('/api/locations/history/:userId', authenticateUser, async (req, res) => {
  try {
    const userId = req.params.userId;
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    // Verify user has permission to view this data
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ 
        error: 'Unauthorized access',
        details: 'You can only view your own location history'
      });
    }

    const { data: locations, error } = await supabase
      .from('user_locations')
      .select('*')
      .eq('user_id', userId)
      .order('last_updated', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('user_locations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    res.json({
      data: locations,
      pagination: {
        total: count,
        page,
        per_page: limit,
        total_pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Location history error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch location history',
      details: error.message 
    });
  }
});

// New Route Optimization Endpoint
app.post('/api/route/optimize', authenticateUser, async (req, res) => {
  try {
    const { waypoints } = req.body;
    
    if (!waypoints || waypoints.length < 2) {
      return res.status(400).json({ 
        error: 'Invalid route request',
        details: 'At least 2 waypoints are required'
      });
    }

    // Validate waypoints
    const validWaypoints = waypoints.filter(wp => 
      wp.latitude && wp.longitude &&
      !isNaN(wp.latitude) && !isNaN(wp.longitude)
    );

    if (validWaypoints.length < 2) {
      return res.status(400).json({ 
        error: 'Invalid coordinates',
        details: 'Provide valid latitude/longitude pairs'
      });
    }

    // Calculate route (in a real app, integrate with Mapbox/Google Maps)
    const optimizedRoute = calculateOptimizedRoute(validWaypoints);

    res.json(optimizedRoute);
  } catch (error) {
    console.error('Route optimization error:', error);
    res.status(500).json({ 
      error: 'Failed to optimize route',
      details: error.message 
    });
  }
});

// Helper function for route calculation
function calculateOptimizedRoute(waypoints) {
  // Simple implementation - in reality, use a proper routing algorithm
  const coordinates = waypoints.map(wp => ({
    latitude: wp.latitude,
    longitude: wp.longitude
  }));

  let totalDistance = 0;
  for (let i = 1; i < coordinates.length; i++) {
    totalDistance += haversineDistance(coordinates[i-1], coordinates[i]);
  }

  return {
    coordinates,
    waypoints: [...waypoints], // Would be sorted optimally in real implementation
    total_distance: totalDistance,
    estimated_time: totalDistance * 1.2, // Simple estimation (minutes)
    waypoint_count: waypoints.length
  };
}

// Haversine distance calculation
function haversineDistance(coord1, coord2) {
  const R = 6371; // Earth radius in km
  const dLat = toRad(coord2.latitude - coord1.latitude);
  const dLon = toRad(coord2.longitude - coord1.longitude);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(coord1.latitude)) * Math.cos(toRad(coord2.latitude)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

// New Heatmap Data Endpoint
app.get('/api/heatmap', authenticateUser, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const timeThreshold = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const { data: locations, error } = await supabase
      .from('user_locations')
      .select('latitude, longitude, last_updated, user_id, device_context')
      .gt('last_updated', timeThreshold);

    if (error) throw error;

    // Process into heatmap format
    const heatmapData = locations.map(loc => ({
      lat: loc.latitude,
      lng: loc.longitude,
      weight: 1,
      user_id: loc.user_id,
      battery: loc.device_context?.battery_level,
      timestamp: loc.last_updated
    }));

    res.json(heatmapData);
  } catch (error) {
    console.error('Heatmap error:', error);
    res.status(500).json({ 
      error: 'Failed to generate heatmap',
      details: error.message 
    });
  }
});

// New Battery Status Endpoint
app.get('/api/battery', authenticateUser, async (req, res) => {
  try {
    const { data: locations, error } = await supabase
      .from('user_locations')
      .select('user_id, device_context')
      .order('last_updated', { ascending: false });

    if (error) throw error;

    // Get latest battery status for each user
    const batteryStatus = {};
    locations.forEach(loc => {
      if (loc.device_context?.battery_level && !batteryStatus[loc.user_id]) {
        batteryStatus[loc.user_id] = {
          level: loc.device_context.battery_level,
          status: getBatteryStatus(loc.device_context.battery_level),
          is_charging: loc.device_context.is_charging || false
        };
      }
    });

    res.json(batteryStatus);
  } catch (error) {
    console.error('Battery status error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch battery status',
      details: error.message 
    });
  }
});

// Enhanced Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    available_endpoints: [
      '/auth/login',
      '/api/users',
      '/api/messages/:partnerId',
      '/api/locations',
      '/api/locations/history/:userId',
      '/api/route/optimize',
      '/api/heatmap',
      '/api/battery'
    ]
  });
});

// Server Initialization
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Supabase connected to: ${supabaseUrl}`);
});