defmodule MessagingWeb.UserChannel do
  use Phoenix.Channel
  require Logger

  alias Messaging.Presence

  @impl true
  def join("user:" <> user_id, _payload, socket) do
    if authorized?(socket, user_id) do
      send(self(), :after_join)
      {:ok, socket}
    else
      {:error, %{reason: "unauthorized"}}
    end
  end

  @impl true
  def handle_info(:after_join, socket) do
    push(socket, "presence_state", Presence.list(socket))
    {:ok, _} = Presence.track_user(
      self(),
      "user:#{socket.assigns.user_id}",
      socket.assigns.user_id,
      %{
        online_at: System.system_time(:second)
      }
    )
    {:noreply, socket}
  end

  @impl true
  def handle_in("follow", %{"user_id" => following_id}, socket) do
    case Messaging.Supabase.toggle_follow(socket.assigns.user_id, following_id) do
      {:ok, _} ->
        broadcast_follow_event(socket, following_id, "followed")
        {:reply, {:ok, %{}}, socket}
      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  @impl true
  def handle_in("unfollow", %{"user_id" => following_id}, socket) do
    case Messaging.Supabase.toggle_follow(socket.assigns.user_id, following_id) do
      {:ok, _} ->
        broadcast_follow_event(socket, following_id, "unfollowed")
        {:reply, {:ok, %{}}, socket}
      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  @impl true
  def handle_in("update_status", %{"status" => status}, socket) do
    case Messaging.Supabase.update_user(socket.assigns.user_id, %{status: status}) do
      {:ok, _} ->
        broadcast_status_update(socket, status)
        {:reply, {:ok, %{}}, socket}
      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  defp authorized?(socket, user_id) do
    socket.assigns.user_id == user_id
  end

  defp broadcast_follow_event(socket, following_id, action) do
    broadcast!(socket, "follow_update", %{
      user_id: socket.assigns.user_id,
      following_id: following_id,
      action: action
    })
  end

  defp broadcast_status_update(socket, status) do
    broadcast!(socket, "status_update", %{
      user_id: socket.assigns.user_id,
      status: status
    })
  end
end 