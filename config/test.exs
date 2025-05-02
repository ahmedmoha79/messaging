import Config

# Configure your database
config :messaging, Messaging.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  database: "messaging_test#{System.get_env("MIX_TEST_PARTITION")}",
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: 10

# Configure Supabase for testing
config :messaging, Messaging.Supabase,
  url: "http://localhost:54321",
  key: "test-supabase-key"

# Configure Redis for testing
config :messaging, :redis,
  host: "localhost",
  port: 6379,
  database: 1

# Configure Phoenix
config :messaging, MessagingWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  server: false

# Configure Elixir Logger
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime 