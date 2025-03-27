const express = require('express');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Serve static files
app.use(express.static('.'));
app.use(express.json());

// Authentication endpoint
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Validate input
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Attempt to sign in with Supabase
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });
        
        if (error) {
            console.error('Login error:', error);
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Verify user exists in users table
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('*')
            .eq('id', data.user.id)
            .single();

        if (userError) {
            console.error('User verification error:', userError);
            return res.status(500).json({ error: 'Error verifying user profile' });
        }

        // Return session data
        res.json({
            session: data.session,
            user: userData
        });
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Signup endpoint
app.post('/auth/signup', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password
        });
        
        if (authError) throw authError;

        // Create user profile
        const { error: profileError } = await supabase
            .from('users')
            .insert([
                {
                    id: authData.user.id,
                    name: name,
                    email: email,
                    status: 'online',
                    lastonline: new Date().toISOString()
                }
            ]);

        if (profileError) throw profileError;
        res.json(authData);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Get current user endpoint
app.get('/auth/user', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            throw new Error('No token provided');
        }

        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error) throw error;
        res.json(user);
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// Debug endpoint to check users
app.get('/debug/users', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*');
        
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Debug endpoint to check messages
app.get('/debug/messages', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('messages')
            .select('*');
        
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Debug endpoint to check specific user
app.get('/debug/user/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', req.params.id)
            .single();
        
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Debug endpoint to check messages between two users
app.get('/debug/messages/:senderId/:receiverId', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender_id.eq.${req.params.senderId},receiver_id.eq.${req.params.receiverId}),and(sender_id.eq.${req.params.receiverId},receiver_id.eq.${req.params.senderId})`)
            .order('created_at', { ascending: true });
        
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test message sending endpoint
app.post('/debug/send-message', async (req, res) => {
    try {
        const { sender_id, receiver_id, content } = req.body;
        const { data, error } = await supabase
            .from('messages')
            .insert([
                {
                    sender_id,
                    receiver_id,
                    content,
                    is_read: false
                }
            ])
            .select();
        
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 