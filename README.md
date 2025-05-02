# Messaging Service

A high-performance real-time messaging service built with Elixir and Phoenix.

## Features

- Real-time presence tracking
- Follow/unfollow functionality
- User status updates
- Caching with Redis
- Integration with Supabase
- WebSocket support
- High concurrency handling

## Prerequisites

- Elixir 1.14 or later
- Erlang/OTP 25 or later
- PostgreSQL 13 or later
- Redis 6 or later
- Node.js 16 or later (for assets)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/messaging.git
cd messaging
```

2. Install dependencies:
```bash
mix deps.get
cd assets && npm install
```

3. Set up the database:
```bash
mix ecto.create
mix ecto.migrate
```

4. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

## Development

To start the development server:
```bash
mix phx.server
```

Visit `http://localhost:4000` in your browser.

## Testing

To run the test suite:
```bash
mix test
```

## Production Deployment

1. Set up the required environment variables:
```bash
export SECRET_KEY_BASE="your-secret-key-base"
export DATABASE_URL="your-database-url"
export SUPABASE_URL="your-supabase-url"
export SUPABASE_KEY="your-supabase-key"
export REDIS_HOST="your-redis-host"
export REDIS_PASSWORD="your-redis-password"
```

2. Build the release:
```bash
MIX_ENV=prod mix release
```

3. Start the release:
```bash
_build/prod/rel/messaging/bin/messaging start
```

## Architecture

The service is built with the following components:

- **Phoenix Channels**: Handle real-time WebSocket connections
- **Presence**: Track user presence and status
- **Cachex**: In-memory caching
- **Redis**: Distributed caching and pub/sub
- **Supabase**: User authentication and data storage

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
 
