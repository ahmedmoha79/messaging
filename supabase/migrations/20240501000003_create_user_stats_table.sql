-- Drop existing table if it exists
DROP TABLE IF EXISTS public.user_stats CASCADE;

-- Create user_stats table
CREATE TABLE public.user_stats (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    followers_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    messages_count INTEGER DEFAULT 0,
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.user_stats ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Public stats are viewable by everyone" ON public.user_stats;
DROP POLICY IF EXISTS "Users can update their own stats" ON public.user_stats;

-- Policy for public read access to user stats
CREATE POLICY "Public stats are viewable by everyone"
ON public.user_stats FOR SELECT
USING (true);

-- Policy for users to update their own stats
CREATE POLICY "Users can update their own stats"
ON public.user_stats FOR UPDATE
USING (auth.uid() = user_id);

-- Grant necessary permissions
GRANT ALL ON public.user_stats TO authenticated;
GRANT SELECT ON public.user_stats TO anon;

-- Create trigger to update last_updated timestamp
CREATE OR REPLACE FUNCTION update_stats_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_updated = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_stats_timestamp
    BEFORE UPDATE ON public.user_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_stats_timestamp(); 