const expressconst express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// CORS Configuration
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
  credentials: true
}));

// Supabase Client Configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(express.static(__dirname));
app.use(express.json());

// Authentication Middleware
const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid authentication' });

    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Routes
app.get('/', (req, res) => res.sendFile(__dirname + '/login.html'));

// Enhanced Login Endpoint
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });

    // Get or create user profile
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
          lastonline: new Date().toISOString()
        }]);

      if (createError) throw createError;
    }

    return res.json({
      session: data.session,
      user: profile || {
        id: data.user.id,
        email: data.user.email,
        name: data.user.email.split('@')[0],
        status: 'online'
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// User Management Endpoints
app.get('/api/users', authenticateUser, async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .order('lastonline', { ascending: false });

    if (error) throw error;

    const processedUsers = users.map(user => ({
      ...user,
      status: calculateUserStatus(user.lastonline)
    }));

    res.json(processedUsers);
  } catch (error) {
    console.error('Users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Message Endpoints
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

    // Mark messages as read
    await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('receiver_id', currentUser)
      .eq('sender_id', partnerId);

    res.json(messages);
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/messages', authenticateUser, async (req, res) => {
  try {
    const { receiver_id, content } = req.body;
    if (!receiver_id || !content) return res.status(400).json({ error: 'Missing required fields' });

    const { data: message, error } = await supabase
      .from('messages')
      .insert([{
        sender_id: req.user.id,
        receiver_id,
        content,
        is_read: false
      }])
      .select()
      .single();

    if (error) throw error;

    // Update user status
    await supabase
      .from('users')
      .update({ lastonline: new Date().toISOString() })
      .eq('id', req.user.id);

    res.json(message);
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ error: 'Message send failed' });
  }
});

// GPS Location Endpoints
app.post('/api/gps', authenticateUser, async (req, res) => {
  try {
    const { latitude, longitude, device_id } = req.body;
    
    if (!latitude || !longitude || !device_id) {
      return res.status(400).json({ error: 'Missing required location data' });
    }

    const { data: location, error } = await supabase
      .from('gps_locations')
      .insert([{
        user_id: req.user.id,
        device_id,
        latitude,
        longitude
      }])
      .select()
      .single();

    if (error) throw error;

    res.json(location);
  } catch (error) {
    console.error('GPS save error:', error);
    res.status(500).json({ error: 'Failed to save location' });
  }
});

app.get('/api/gps/latest', authenticateUser, async (req, res) => {
  try {
    const { data: location, error } = await supabase
      .from('gps_locations')
      .select('*')
      .eq('user_id', req.user.id)
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;

    if (!location) {
      return res.status(404).json({ error: 'No location data found' });
    }

    res.json(location);
  } catch (error) {
    console.error('GPS fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch location' });
  }
});

app.get('/api/gps/history/:userId', authenticateUser, async (req, res) => {
  try {
    const userId = req.params.userId;
    const limit = parseInt(req.query.limit) || 10;

    // Verify user has permission to view this data
    if (req.user.id !== userId) {
      return res.status(403).json({ error: 'Unauthorized access' });
    }

    const { data: locations, error } = await supabase
      .from('gps_locations')
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json(locations);
  } catch (error) {
    console.error('GPS history error:', error);
    res.status(500).json({ error: 'Failed to fetch location history' });
  }
});

// Route Endpoints
app.post('/api/route', authenticateUser, async (req, res) => {
  try {
    const { start, end } = req.body;
    
    if (!start || !start.latitude || !start.longitude || 
        !end || !end.latitude || !end.longitude) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    // In a real implementation, you would call your routing API here
    // This is a placeholder for the actual routing service integration
    const routeData = {
      coordinates: [
        { latitude: start.latitude, longitude: start.longitude },
        { latitude: end.latitude, longitude: end.longitude }
      ],
      distance: calculateDistance(start, end),
      duration: calculateDuration(start, end)
    };

    res.json(routeData);
  } catch (error) {
    console.error('Route error:', error);
    res.status(500).json({ error: 'Failed to calculate route' });
  }
});

// Helper Functions
function calculateUserStatus(lastonline) {
  const last = new Date(lastonline);
  const diff = (Date.now() - last.getTime()) / 1000;
  return diff < 300 ? 'online' : 'offline';
}

function calculateDistance(start, end) {
  // Haversine formula implementation
  const R = 6371; // Earth radius in km
  const dLat = toRad(end.latitude - start.latitude);
  const dLon = toRad(end.longitude - start.longitude);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(start.latitude)) * Math.cos(toRad(end.latitude)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in km
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

function calculateDuration(start, end) {
  // Simple estimation - 1 minute per km at 60km/h
  const distance = calculateDistance(start, end);
  return Math.round(distance * 60); // Duration in minutes
}

// Server Initialization
app.listen(port, () => console.log(`Server running on port ${port}`));