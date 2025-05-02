import Config

# Configure your database
config :messaging, Messaging.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  database: "messaging_dev",
  stacktrace: true,
  show_sensitive_data_on_connection_error: true,
  pool_size: 10

# Configure Supabase for development
config :messaging, Messaging.Supabase,
  url: "http://localhost:54321",
  key: "your-supabase-anon-key"

# Configure Redis for development
config :messaging, :redis,
  host: "localhost",
  port: 6379,
  database: 0

# Configure Phoenix
config :messaging, MessagingWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4000],
  check_origin: false,
  code_reloader: true,
  debug_errors: true,
  secret_key_base: "your-secret-key-base",
  watchers: [
    esbuild: {Esbuild, :install_and_run, [:default, ~w(--sourcemap=inline --watch)]},
    tailwind: {Tailwind, :install_and_run, [:default, ~w(--watch)]}
  ]

# Configure Elixir Logger
config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Set a higher stacktrace during development
config :phoenix, :stacktrace_depth, 20

# Initialize plugs at runtime for faster development compilation
config :phoenix, :plug_init_mode, :runtime 