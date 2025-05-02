defmodule Messaging.SupabaseTest do
  use Messaging.DataCase, async: true
  alias Messaging.Supabase

  describe "get_user/1" do
    test "returns user data when user exists" do
      user_id = "test-user-id"
      expected_user = %{id: user_id, name: "Test User"}
      
      assert {:ok, ^expected_user} = Supabase.get_user(user_id)
    end

    test "returns error when user does not exist" do
      user_id = "non-existent-user"
      
      assert {:error, _reason} = Supabase.get_user(user_id)
    end
  end

  describe "update_user/2" do
    test "updates user data successfully" do
      user_id = "test-user-id"
      updates = %{name: "Updated Name"}
      
      assert {:ok, _user} = Supabase.update_user(user_id, updates)
    end

    test "returns error when update fails" do
      user_id = "non-existent-user"
      updates = %{name: "Updated Name"}
      
      assert {:error, _reason} = Supabase.update_user(user_id, updates)
    end
  end

  describe "get_followers/1" do
    test "returns list of followers" do
      user_id = "test-user-id"
      expected_followers = [%{id: "follower-1"}, %{id: "follower-2"}]
      
      assert {:ok, ^expected_followers} = Supabase.get_followers(user_id)
    end

    test "returns empty list when user has no followers" do
      user_id = "user-with-no-followers"
      
      assert {:ok, []} = Supabase.get_followers(user_id)
    end
  end

  describe "get_following/1" do
    test "returns list of following" do
      user_id = "test-user-id"
      expected_following = [%{id: "following-1"}, %{id: "following-2"}]
      
      assert {:ok, ^expected_following} = Supabase.get_following(user_id)
    end

    test "returns empty list when user is not following anyone" do
      user_id = "user-not-following"
      
      assert {:ok, []} = Supabase.get_following(user_id)
    end
  end

  describe "toggle_follow/2" do
    test "follows user successfully" do
      follower_id = "test-follower"
      following_id = "test-following"
      
      assert {:ok, _result} = Supabase.toggle_follow(follower_id, following_id)
    end

    test "unfollows user successfully" do
      follower_id = "test-follower"
      following_id = "test-following"
      
      assert {:ok, _result} = Supabase.toggle_follow(follower_id, following_id)
    end

    test "returns error when operation fails" do
      follower_id = "invalid-follower"
      following_id = "invalid-following"
      
      assert {:error, _reason} = Supabase.toggle_follow(follower_id, following_id)
    end
  end
end 