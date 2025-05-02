defmodule Messaging.Presence do
  use Phoenix.Presence,
    otp_app: :messaging,
    pubsub_server: Messaging.PubSub

  require Logger

  def track_user(pid, topic, user_id, meta \\ %{}) do
    track(pid, topic, user_id, Map.merge(%{
      online_at: System.system_time(:second),
      last_seen: System.system_time(:second)
    }, meta))
  end

  def update_user(pid, topic, user_id, meta) do
    update(pid, topic, user_id, meta)
  end

  def list_users(topic) do
    list(topic)
  end

  def handle_metas(topic, %{joins: joins, leaves: leaves}, presences) do
    for {user_id, presence} <- joins do
      broadcast_user_joined(topic, user_id, presence)
      update_user_status(user_id, "online")
    end

    for {user_id, presence} <- leaves do
      broadcast_user_left(topic, user_id, presence)
      update_user_status(user_id, "offline")
    end

    {:ok, presences}
  end

  defp broadcast_user_joined(topic, user_id, presence) do
    Phoenix.PubSub.broadcast(
      Messaging.PubSub,
      topic,
      {:user_joined, user_id, presence}
    )
  end

  defp broadcast_user_left(topic, user_id, presence) do
    Phoenix.PubSub.broadcast(
      Messaging.PubSub,
      topic,
      {:user_left, user_id, presence}
    )
  end

  defp update_user_status(user_id, status) do
    # Update user status in Supabase
    Messaging.Supabase.update_user(user_id, %{status: status})
  end
end 