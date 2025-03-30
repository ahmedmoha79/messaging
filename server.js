const express = require('express');
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
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Changed to service key
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

// Helper Functions
function calculateUserStatus(lastonline) {
  const last = new Date(lastonline);
  const diff = (Date.now() - last.getTime()) / 1000;
  return diff < 300 ? 'online' : 'offline';
}

// Server Initialization
app.listen(port, () => console.log(`Server running on port ${port}`));