defmodule Messaging.Supabase do
  use GenServer
  require Logger

  def start_link(_) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def init(_) do
    {:ok, %{}}
  end

  # Public API

  def get_user(user_id) do
    GenServer.call(__MODULE__, {:get_user, user_id})
  end

  def update_user(user_id, updates) do
    GenServer.call(__MODULE__, {:update_user, user_id, updates})
  end

  def get_followers(user_id) do
    GenServer.call(__MODULE__, {:get_followers, user_id})
  end

  def get_following(user_id) do
    GenServer.call(__MODULE__, {:get_following, user_id})
  end

  def toggle_follow(follower_id, following_id) do
    GenServer.call(__MODULE__, {:toggle_follow, follower_id, following_id})
  end

  # Callbacks

  def handle_call({:get_user, user_id}, _from, state) do
    case Cachex.get(:user_cache, "user:#{user_id}") do
      {:ok, nil} ->
        # Cache miss, fetch from Supabase
        result = fetch_user_from_supabase(user_id)
        {:reply, result, state}
      {:ok, user} ->
        # Cache hit
        {:reply, {:ok, user}, state}
    end
  end

  def handle_call({:update_user, user_id, updates}, _from, state) do
    result = update_user_in_supabase(user_id, updates)
    {:reply, result, state}
  end

  def handle_call({:get_followers, user_id}, _from, state) do
    case Cachex.get(:user_cache, "followers:#{user_id}") do
      {:ok, nil} ->
        result = fetch_followers_from_supabase(user_id)
        {:reply, result, state}
      {:ok, followers} ->
        {:reply, {:ok, followers}, state}
    end
  end

  def handle_call({:get_following, user_id}, _from, state) do
    case Cachex.get(:user_cache, "following:#{user_id}") do
      {:ok, nil} ->
        result = fetch_following_from_supabase(user_id)
        {:reply, result, state}
      {:ok, following} ->
        {:reply, {:ok, following}, state}
    end
  end

  def handle_call({:toggle_follow, follower_id, following_id}, _from, state) do
    result = toggle_follow_in_supabase(follower_id, following_id)
    {:reply, result, state}
  end

  # Private functions

  defp fetch_user_from_supabase(user_id) do
    # Implement Supabase API call
    # Cache the result
    # Return the user data
  end

  defp update_user_in_supabase(user_id, updates) do
    # Implement Supabase API call
    # Invalidate cache
    # Return the result
  end

  defp fetch_followers_from_supabase(user_id) do
    # Implement Supabase API call
    # Cache the result
    # Return the followers data
  end

  defp fetch_following_from_supabase(user_id) do
    # Implement Supabase API call
    # Cache the result
    # Return the following data
  end

  defp toggle_follow_in_supabase(follower_id, following_id) do
    # Implement Supabase API call
    # Invalidate relevant caches
    # Return the result
  end
end 