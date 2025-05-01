-- First, fix any existing negative values
UPDATE public.user_stats 
SET followers_count = 0 
WHERE followers_count < 0;

UPDATE public.user_stats 
SET following_count = 0 
WHERE following_count < 0;

-- Drop existing functions if they exist
DROP FUNCTION IF EXISTS public.increment_followers_count;
DROP FUNCTION IF EXISTS public.increment_following_count;

-- Create function to increment followers count
CREATE OR REPLACE FUNCTION public.increment_followers_count(in_amount INTEGER, in_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    current_count INTEGER;
BEGIN
    -- First ensure the user has a stats record
    INSERT INTO public.user_stats (user_id, followers_count)
    VALUES (in_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    
    -- Get current count
    SELECT followers_count INTO current_count
    FROM public.user_stats
    WHERE user_id = in_user_id;
    
    -- Update the count, ensuring it never goes below 0
    UPDATE public.user_stats
    SET followers_count = CASE 
        WHEN current_count + in_amount < 0 THEN 0
        ELSE current_count + in_amount
    END,
    last_updated = NOW()
    WHERE user_id = in_user_id;
END;
$$;

-- Create function to increment following count
CREATE OR REPLACE FUNCTION public.increment_following_count(in_amount INTEGER, in_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    current_count INTEGER;
BEGIN
    -- First ensure the user has a stats record
    INSERT INTO public.user_stats (user_id, following_count)
    VALUES (in_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    
    -- Get current count
    SELECT following_count INTO current_count
    FROM public.user_stats
    WHERE user_id = in_user_id;
    
    -- Update the count, ensuring it never goes below 0
    UPDATE public.user_stats
    SET following_count = CASE 
        WHEN current_count + in_amount < 0 THEN 0
        ELSE current_count + in_amount
    END,
    last_updated = NOW()
    WHERE user_id = in_user_id;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.increment_followers_count TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_following_count TO authenticated; 