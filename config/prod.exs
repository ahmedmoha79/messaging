import Config

# Configure your database
config :messaging, Messaging.Repo,
  username: System.get_env("DB_USER", "postgres"),
  password: System.get_env("DB_PASSWORD", "postgres"),
  hostname: System.get_env("DB_HOST", "localhost"),
  database: System.get_env("DB_NAME", "messaging_prod"),
  pool_size: String.to_integer(System.get_env("POOL_SIZE", "10")),
  ssl: true

# Configure Supabase for production
config :messaging, Messaging.Supabase,
  url: System.get_env("SUPABASE_URL"),
  key: System.get_env("SUPABASE_KEY")

# Configure Redis for production
config :messaging, :redis,
  host: System.get_env("REDIS_HOST", "localhost"),
  port: String.to_integer(System.get_env("REDIS_PORT", "6379")),
  database: String.to_integer(System.get_env("REDIS_DB", "0")),
  password: System.get_env("REDIS_PASSWORD")

# Configure Phoenix
config :messaging, MessagingWeb.Endpoint,
  http: [
    ip: {0, 0, 0, 0, 0, 0, 0, 0},
    port: String.to_integer(System.get_env("PORT", "4000")),
    transport_options: [socket_opts: [:inet6]]
  ],
  url: [host: System.get_env("HOST", "example.com"), port: 443],
  secret_key_base: System.get_env("SECRET_KEY_BASE"),
  server: true

# Configure Elixir Logger
config :logger, level: :info

# Configure Cachex
config :cachex,
  default_ttl: :timer.hours(1),
  stats: true,
  fallback: false

# Configure Phoenix
config :phoenix, :serve_endpoints, true 