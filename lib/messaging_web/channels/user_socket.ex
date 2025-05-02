defmodule MessagingWeb.UserSocket do
  use Phoenix.Socket
  require Logger

  channel "user:*", MessagingWeb.UserChannel
  channel "presence:*", MessagingWeb.PresenceChannel

  @impl true
  def connect(%{"token" => token}, socket, _connect_info) do
    case verify_token(token) do
      {:ok, user_id} ->
        socket = assign(socket, :user_id, user_id)
        {:ok, socket}
      {:error, reason} ->
        Logger.error("Failed to verify token: #{reason}")
        :error
    end
  end

  def connect(_params, _socket, _connect_info) do
    :error
  end

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user_id}"

  defp verify_token(token) do
    # Implement JWT verification
    # Return {:ok, user_id} or {:error, reason}
  end
end 