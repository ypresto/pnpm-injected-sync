# pnpm-injected-sync

Sync PNPM injected dependencies in your workspace with file watching support.

This is a CLI wrapper for pnpm's official [`@pnpm/workspace.injected-deps-syncer`](https://www.npmjs.com/package/@pnpm/workspace.injected-deps-syncer) package.

## Installation

```bash
npm install -g pnpm-injected-sync
# or
pnpm add -g pnpm-injected-sync
```

## Commands

| Command | Purpose | Use Case |
|---------|---------|----------|
| `sync` | One-time sync | Build scripts, CI/CD pipelines |
| `watch` | Continuous watching | Standalone development watching |
| `run <cmd>` | Wrap command with auto-syncing | Development servers (vite, webpack, etc.) |

## Usage Examples

### One-time Sync

Sync all injected dependencies once and exit:

```bash
pnpm-injected-sync sync
```

### Watch Mode

Watch for changes and sync continuously:

```bash
pnpm-injected-sync watch
```

### Run with Auto-sync

Run a command with automatic dependency syncing. Multiple processes share a single watcher:

```bash
pnpm-injected-sync run vite
pnpm-injected-sync run "npm run dev"
```

## Integration with package.json

```json
{
  "scripts": {
    "dev": "pnpm-injected-sync run vite",
    "build": "pnpm-injected-sync sync && vite build",
    "watch": "pnpm-injected-sync watch"
  }
}
```

## Environment Variables

### `PNPM_INJECTED_SYNC_DISABLE`

Set to a truthy value to disable all syncing functionality. Useful for CI environments or when you want to temporarily disable syncing.

Accepted truthy values: `true`, `1`, `yes`, `on` (case-insensitive)

## Features

- 🔄 **Automatic synchronization** of PNPM injected dependencies
- 👀 **File watching** with debounced updates (100ms)
- 🚀 **Shared watcher** for multiple processes to reduce resource usage
- 🔧 **Automatic failover** - clients promote to watcher when master process exits
- 📦 **Process wrapping** with proper signal forwarding and exit code preservation
- 🛠️ **One-time sync** for build scripts and CI/CD
- 🎯 **Workspace detection** automatically finds your PNPM workspace root

## How It Works

1. **Workspace Detection**: Automatically finds your PNPM workspace by looking for `pnpm-workspace.yaml`
2. **Dependency Discovery**: Reads injected dependencies from `.pnpm-state.yaml`
3. **Synchronization**: Uses PNPM's official syncer to update dependencies
4. **File Watching**: Monitors changes in source packages and syncs automatically

### Shared Watcher Mode (`run` command)

When using `pnpm-injected-sync run`:
- First process becomes the watcher
- Additional processes register as clients
- Watcher continues until all client processes exit
- Proper signal forwarding (Ctrl+C works correctly)
- Exit codes are preserved from child processes

## Requirements

- PNPM workspace with injected dependencies
- Node.js 14+

## License

ISC
