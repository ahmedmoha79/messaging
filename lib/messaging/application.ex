defmodule Messaging.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      # Start the Telemetry supervisor
      MessagingWeb.Telemetry,
      # Start the PubSub system
      {Phoenix.PubSub, name: Messaging.PubSub},
      # Start the Endpoint (http/https)
      MessagingWeb.Endpoint,
      # Start the Presence tracker
      Messaging.Presence,
      # Start the Cache
      {Cachex, name: :user_cache},
      # Start the Redis connection
      {Redix, name: :redix, host: "localhost", port: 6379},
      # Start the Supabase client
      {Messaging.Supabase, []}
    ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Messaging.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    MessagingWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end 