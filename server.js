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
app.use(express.static(__dirname));
app.use(express.json());

// Root route - serve login.html
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

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
            password,
            options: {
                redirectTo: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/message.html`
            }
        });
        
        if (error) {
            console.error('Login error:', error);
            if (error.message.includes('captcha')) {
                return res.status(401).json({ error: 'Please try logging in again. If the issue persists, contact support.' });
            }
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
            // If user doesn't exist in users table, create them
            if (userError.code === 'PGRST116') {
                const { error: insertError } = await supabase
                    .from('users')
                    .insert([
                        {
                            id: data.user.id,
                            name: data.user.email.split('@')[0],
                            email: data.user.email,
                            status: 'online',
                            lastonline: new Date().toISOString()
                        }
                    ]);
                
                if (insertError) {
                    console.error('User creation error:', insertError);
                    return res.status(500).json({ error: 'Error creating user profile' });
                }
                
                // Return session data with new user
                return res.json({
                    session: data.session,
                    user: {
                        id: data.user.id,
                        name: data.user.email.split('@')[0],
                        email: data.user.email,
                        status: 'online'
                    }
                });
            }
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
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Verify user is authenticated
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError) {
            return res.status(401).json({ error: 'Invalid authentication' });
        }

        // Get all users
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .order('lastonline', { ascending: false });
        
        if (error) {
            console.error('Users fetch error:', error);
            return res.status(500).json({ error: 'Failed to fetch users' });
        }

        // Process user status
        const now = new Date();
        const processedUsers = users.map(user => {
            const lastOnline = new Date(user.lastonline);
            const diffMinutes = Math.floor((now - lastOnline) / 60000);
            
            // Update status based on last online time
            if (diffMinutes > 5) {
                return {
                    ...user,
                    status: 'offline'
                };
            }
            return user;
        });

        res.json(processedUsers);
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal server error' });
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

// Test message sending endpoint
app.post('/debug/send-message', async (req, res) => {
    try {
        const { sender_id, receiver_id, content } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        
        console.log('Received message request:', {
            sender_id,
            receiver_id,
            content,
            hasToken: !!token
        });
        
        // Validate input
        if (!sender_id || !receiver_id || !content) {
            console.error('Missing required fields:', { sender_id, receiver_id, content });
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Verify sender is authenticated
        if (!token) {
            console.error('No authentication token provided');
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Verify sender matches token
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError) {
            console.error('Auth error:', userError);
            return res.status(401).json({ error: 'Invalid authentication' });
        }

        if (user.id !== sender_id) {
            console.error('Sender ID mismatch:', { tokenUserId: user.id, sender_id });
            return res.status(403).json({ error: 'Unauthorized' });
        }

        // Insert message into database
        console.log('Inserting message into database...');
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
        
        if (error) {
            console.error('Message insert error:', error);
            return res.status(500).json({ error: error.message });
        }

        console.log('Message sent successfully:', data[0]);
        res.json(data[0]);
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get messages between two users
app.get('/debug/messages/:senderId/:receiverId', async (req, res) => {
    try {
        const { senderId, receiverId } = req.params;
        const token = req.headers.authorization?.split(' ')[1];
        
        console.log('Fetching messages:', {
            senderId,
            receiverId,
            hasToken: !!token
        });

        // Verify authentication
        if (!token) {
            console.error('No authentication token provided');
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Verify user is authorized to view these messages
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError) {
            console.error('Auth error:', userError);
            return res.status(401).json({ error: 'Invalid authentication' });
        }

        if (user.id !== senderId && user.id !== receiverId) {
            console.error('User not authorized to view these messages');
            return res.status(403).json({ error: 'Unauthorized' });
        }
        
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`)
            .order('created_at', { ascending: true });
        
        if (error) {
            console.error('Message fetch error:', error);
            return res.status(500).json({ error: error.message });
        }

        console.log('Messages fetched successfully:', data.length);
        res.json(data);
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update user status endpoint
app.post('/debug/update-status', async (req, res) => {
    try {
        const { userId } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Verify user is authorized
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || user.id !== userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        // Update user status
        const { error: updateError } = await supabase
            .from('users')
            .update({
                status: 'online',
                lastonline: new Date().toISOString()
            })
            .eq('id', userId);

        if (updateError) {
            console.error('Status update error:', updateError);
            return res.status(500).json({ error: 'Failed to update status' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 