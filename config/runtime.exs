import Config

if config_env() == :prod do
  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  config :messaging, MessagingWeb.Endpoint,
    http: [
      # Enable IPv6 and bind on all interfaces.
      # Set it to  {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
      ip: {0, 0, 0, 0, 0, 0, 0, 0},
      port: String.to_integer(System.get_env("PORT", "4000")),
      transport_options: [socket_opts: [:inet6]]
    ],
    secret_key_base: secret_key_base

  # Configure your database
  config :messaging, Messaging.Repo,
    url: System.get_env("DATABASE_URL"),
    pool_size: String.to_integer(System.get_env("POOL_SIZE", "10")),
    ssl: true

  # Configure Supabase
  config :messaging, Messaging.Supabase,
    url: System.get_env("SUPABASE_URL"),
    key: System.get_env("SUPABASE_KEY")

  # Configure Redis
  config :messaging, :redis,
    host: System.get_env("REDIS_HOST", "localhost"),
    port: String.to_integer(System.get_env("REDIS_PORT", "6379")),
    database: String.to_integer(System.get_env("REDIS_DB", "0")),
    password: System.get_env("REDIS_PASSWORD")
end 