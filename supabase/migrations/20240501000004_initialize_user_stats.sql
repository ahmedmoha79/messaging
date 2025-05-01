-- Function to initialize stats for a user
CREATE OR REPLACE FUNCTION initialize_user_stats(in_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Insert initial stats if they don't exist
    INSERT INTO public.user_stats (user_id, followers_count, following_count, messages_count)
    VALUES (
        in_user_id,
        (SELECT COUNT(*) FROM public.follows WHERE following_id = in_user_id),
        (SELECT COUNT(*) FROM public.follows WHERE follower_id = in_user_id),
        (SELECT COUNT(*) FROM public.messages WHERE sender_id = in_user_id OR receiver_id = in_user_id)
    )
    ON CONFLICT (user_id) DO NOTHING;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.initialize_user_stats TO authenticated;

-- Initialize stats for all existing users
DO $$
DECLARE
    user_record RECORD;
BEGIN
    FOR user_record IN SELECT id FROM auth.users
    LOOP
        PERFORM initialize_user_stats(user_record.id);
    END LOOP;
END $$; 