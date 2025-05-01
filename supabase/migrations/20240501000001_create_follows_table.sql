-- Drop existing table if it exists
DROP TABLE IF EXISTS public.follows CASCADE;

-- Create follows table
CREATE TABLE public.follows (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    follower_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
);

-- Enable Row Level Security
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view their follows" ON public.follows;
DROP POLICY IF EXISTS "Users can insert their own follows" ON public.follows;
DROP POLICY IF EXISTS "Users can delete their own follows" ON public.follows;

-- Policy for users to view their follows
CREATE POLICY "Users can view their follows"
ON public.follows FOR SELECT
USING (auth.uid() = follower_id OR auth.uid() = following_id);

-- Policy for users to insert their own follows
CREATE POLICY "Users can insert their own follows"
ON public.follows FOR INSERT
WITH CHECK (auth.uid() = follower_id);

-- Policy for users to delete their own follows
CREATE POLICY "Users can delete their own follows"
ON public.follows FOR DELETE
USING (auth.uid() = follower_id);

-- Grant necessary permissions
GRANT ALL ON public.follows TO authenticated;
GRANT SELECT ON public.follows TO anon; 