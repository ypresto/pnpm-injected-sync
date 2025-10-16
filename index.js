#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { readModulesManifest } from '@pnpm/modules-yaml';
import { syncInjectedDeps } from '@pnpm/workspace.injected-deps-syncer';
function isSyncDisabled() {
    const value = process.env.PNPM_INJECTED_SYNC_DISABLED;
    if (!value)
        return false;
    const normalized = value.toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}
async function findWorkspaceRoot(startDir) {
    let currentDir = startDir;
    while (currentDir !== path.dirname(currentDir)) {
        const pnpmWorkspaceFile = path.join(currentDir, 'pnpm-workspace.yaml');
        const nodeModulesDir = path.join(currentDir, 'node_modules');
        if (fs.existsSync(pnpmWorkspaceFile) && fs.existsSync(nodeModulesDir)) {
            return currentDir;
        }
        currentDir = path.dirname(currentDir);
    }
    return null;
}
async function readPackageJson(dir) {
    try {
        const packageJsonPath = path.join(dir, 'package.json');
        const content = await fs.promises.readFile(packageJsonPath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
async function getInjectedDepsDirs(workspaceDir) {
    const modulesDir = path.join(workspaceDir, 'node_modules');
    const modules = await readModulesManifest(modulesDir);
    if (!modules?.injectedDeps) {
        return [];
    }
    return Object.keys(modules.injectedDeps).map(relPath => path.resolve(workspaceDir, relPath));
}
async function syncDeps(pkgDir, workspaceDir) {
    if (isSyncDisabled()) {
        return;
    }
    const packageJson = await readPackageJson(pkgDir);
    const pkgName = packageJson?.name;
    const pkgRootDir = path.relative(workspaceDir, pkgDir);
    console.log(`[sync] Syncing ${pkgName || pkgRootDir}...`);
    try {
        await syncInjectedDeps({
            pkgName,
            pkgRootDir,
            workspaceDir
        });
        console.log(`[sync] ✓ Synced ${pkgName || pkgRootDir}`);
    }
    catch (error) {
        console.error(`[sync] ✗ Failed to sync ${pkgName || pkgRootDir}:`, error);
    }
}
function setupWatcher(pkgDir, workspaceDir, state) {
    if (state.watchers.has(pkgDir)) {
        return;
    }
    console.log(`[sync] Watching ${path.relative(workspaceDir, pkgDir)}...`);
    const watcher = fs.watch(pkgDir, { recursive: true }, (eventType, filename) => {
        if (!filename)
            return;
        const timerId = `${pkgDir}:${filename}`;
        if (state.debounceTimers.has(timerId)) {
            clearTimeout(state.debounceTimers.get(timerId));
        }
        const timer = setTimeout(async () => {
            state.debounceTimers.delete(timerId);
            console.log(`[sync] File ${eventType}: ${path.join(path.relative(workspaceDir, pkgDir), filename)}`);
            await syncDeps(pkgDir, workspaceDir);
        }, 100);
        state.debounceTimers.set(timerId, timer);
    });
    state.watchers.set(pkgDir, watcher);
}
async function runSyncCommand() {
    if (isSyncDisabled()) {
        console.log('Sync disabled via PNPM_INJECTED_SYNC_DISABLED');
        return;
    }
    const cwd = process.cwd();
    const workspaceDir = await findWorkspaceRoot(cwd);
    if (!workspaceDir) {
        console.error('No pnpm workspace found. Please run this from within a pnpm workspace.');
        process.exit(1);
    }
    console.log(`Found workspace at: ${workspaceDir}`);
    const injectedDepsDirs = await getInjectedDepsDirs(workspaceDir);
    if (injectedDepsDirs.length === 0) {
        console.log('No injected dependencies found.');
        return;
    }
    console.log(`Found ${injectedDepsDirs.length} injected dependencies:`);
    for (const dir of injectedDepsDirs) {
        console.log(`  - ${path.relative(workspaceDir, dir)}`);
    }
    console.log('\nSyncing...');
    for (const pkgDir of injectedDepsDirs) {
        await syncDeps(pkgDir, workspaceDir);
    }
    console.log('\nSync complete!');
}
async function runWatchCommand() {
    if (isSyncDisabled()) {
        console.log('Watch disabled via PNPM_INJECTED_SYNC_DISABLED');
        return;
    }
    const cwd = process.cwd();
    const workspaceDir = await findWorkspaceRoot(cwd);
    if (!workspaceDir) {
        console.error('No pnpm workspace found. Please run this from within a pnpm workspace.');
        process.exit(1);
    }
    console.log(`Found workspace at: ${workspaceDir}`);
    const injectedDepsDirs = await getInjectedDepsDirs(workspaceDir);
    if (injectedDepsDirs.length === 0) {
        console.log('No injected dependencies found. Nothing to watch.');
        return;
    }
    console.log(`Found ${injectedDepsDirs.length} injected dependencies:`);
    for (const dir of injectedDepsDirs) {
        console.log(`  - ${path.relative(workspaceDir, dir)}`);
    }
    const state = {
        watchers: new Map(),
        debounceTimers: new Map()
    };
    console.log('\nPerforming initial sync...');
    for (const pkgDir of injectedDepsDirs) {
        await syncDeps(pkgDir, workspaceDir);
    }
    console.log('\nSetting up file watchers...');
    for (const pkgDir of injectedDepsDirs) {
        setupWatcher(pkgDir, workspaceDir, state);
    }
    console.log(`\nWatching for changes... (Press Ctrl+C to stop)`);
    process.on('SIGINT', () => {
        console.log('\nShutting down watchers...');
        for (const timer of state.debounceTimers.values()) {
            clearTimeout(timer);
        }
        for (const watcher of state.watchers.values()) {
            watcher.close();
        }
        console.log('Goodbye!');
        process.exit(0);
    });
}
async function acquireLock(lockFile, pid) {
    try {
        await fs.promises.writeFile(lockFile, JSON.stringify({ pid, timestamp: Date.now() }), { flag: 'wx' });
        return true;
    }
    catch (err) {
        if (err.code === 'EEXIST') {
            return false;
        }
        throw err;
    }
}
async function tryPromoteToWatcher(lockFile, pid) {
    try {
        // Check if lock file exists and if the watcher is still running
        const lockData = await fs.promises.readFile(lockFile, 'utf-8');
        const { pid: watcherPid } = JSON.parse(lockData);
        // If watcher is still running, we can't promote
        if (isProcessRunning(watcherPid)) {
            return false;
        }
        // Watcher is dead, try to clean up its lock and acquire it
        await fs.promises.unlink(lockFile);
        return await acquireLock(lockFile, pid);
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            // Lock file doesn't exist, try to acquire
            return await acquireLock(lockFile, pid);
        }
        return false;
    }
}
async function registerClient(lockFile, pid) {
    const clientFile = `${lockFile}.clients`;
    let clients = [];
    try {
        const data = await fs.promises.readFile(clientFile, 'utf-8');
        clients = JSON.parse(data);
    }
    catch {
        // File doesn't exist or is invalid, start fresh
    }
    if (!clients.includes(pid)) {
        clients.push(pid);
        await fs.promises.writeFile(clientFile, JSON.stringify(clients));
    }
}
async function unregisterClient(lockFile, pid) {
    const clientFile = `${lockFile}.clients`;
    let clients = [];
    try {
        const data = await fs.promises.readFile(clientFile, 'utf-8');
        clients = JSON.parse(data);
    }
    catch {
        return [];
    }
    clients = clients.filter(p => p !== pid);
    if (clients.length > 0) {
        await fs.promises.writeFile(clientFile, JSON.stringify(clients));
    }
    else {
        try {
            await fs.promises.unlink(clientFile);
        }
        catch { }
    }
    return clients;
}
function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function cleanupStaleClients(lockFile) {
    const clientFile = `${lockFile}.clients`;
    let clients = [];
    try {
        const data = await fs.promises.readFile(clientFile, 'utf-8');
        clients = JSON.parse(data);
    }
    catch {
        return [];
    }
    const aliveClients = clients.filter(isProcessRunning);
    if (aliveClients.length !== clients.length) {
        if (aliveClients.length > 0) {
            await fs.promises.writeFile(clientFile, JSON.stringify(aliveClients));
        }
        else {
            try {
                await fs.promises.unlink(clientFile);
            }
            catch { }
        }
    }
    return aliveClients;
}
async function startWatcherMode(workspaceDir, lockFile, pid, getChildExited) {
    console.log(`[sync] Starting watcher process (PID: ${pid})`);
    const injectedDepsDirs = await getInjectedDepsDirs(workspaceDir);
    if (injectedDepsDirs.length === 0) {
        console.log('[sync] No injected dependencies found.');
        await fs.promises.unlink(lockFile);
        throw new Error('No injected dependencies found');
    }
    console.log(`[sync] Found ${injectedDepsDirs.length} injected dependencies`);
    const state = {
        watchers: new Map(),
        debounceTimers: new Map(),
        clients: new Set([pid]),
        lockFile
    };
    // Register ourselves as a client too
    await registerClient(lockFile, pid);
    // Initial sync
    for (const pkgDir of injectedDepsDirs) {
        await syncDeps(pkgDir, workspaceDir);
    }
    // Setup watchers
    for (const pkgDir of injectedDepsDirs) {
        setupWatcher(pkgDir, workspaceDir, state);
    }
    console.log('[sync] Watcher running in background');
    // Periodically check if any clients are still alive
    state.checkInterval = setInterval(async () => {
        const aliveClients = await cleanupStaleClients(lockFile);
        // Don't exit if we still have a child process running
        if (!getChildExited()) {
            return;
        }
        if (aliveClients.length === 0 && state) {
            console.log('[sync] No clients remaining, shutting down watcher...');
            if (state.checkInterval)
                clearInterval(state.checkInterval);
            for (const timer of state.debounceTimers.values()) {
                clearTimeout(timer);
            }
            for (const watcher of state.watchers.values()) {
                watcher.close();
            }
            try {
                await fs.promises.unlink(lockFile);
                const clientFile = `${lockFile}.clients`;
                await fs.promises.unlink(clientFile);
            }
            catch { }
            process.exit(0);
        }
    }, 5000);
    return state;
}
async function runCommand(args) {
    const cwd = process.cwd();
    const workspaceDir = await findWorkspaceRoot(cwd);
    if (!workspaceDir) {
        console.error('[sync] No pnpm workspace found. Please run this from within a pnpm workspace.');
        process.exit(1);
    }
    const lockFile = path.join(workspaceDir, '.pnpm-injected-sync.lock');
    const pid = process.pid;
    // Track child process state globally for the watcher
    let childExited = false;
    // Try to acquire lock (become the watcher)
    let isWatcher = false;
    let state = null;
    let promotionCheckInterval = null;
    // Skip watcher setup if syncing is disabled
    if (!isSyncDisabled()) {
        isWatcher = await acquireLock(lockFile, pid);
        if (isWatcher) {
            try {
                state = await startWatcherMode(workspaceDir, lockFile, pid, () => childExited);
            }
            catch (error) {
                // If we can't start watcher mode, we'll just be a client
                isWatcher = false;
            }
        }
        if (!isWatcher) {
            // Register as a client and set up promotion monitoring
            console.log(`[sync] Connecting to existing watcher (PID: ${pid})`);
            await registerClient(lockFile, pid);
            // Periodically check if we can be promoted to watcher
            promotionCheckInterval = setInterval(async () => {
                const canPromote = await tryPromoteToWatcher(lockFile, pid);
                if (canPromote) {
                    console.log(`[sync] Promoted to watcher (PID: ${pid})`);
                    isWatcher = true;
                    if (promotionCheckInterval) {
                        clearInterval(promotionCheckInterval);
                        promotionCheckInterval = null;
                    }
                    try {
                        state = await startWatcherMode(workspaceDir, lockFile, pid, () => childExited);
                    }
                    catch (error) {
                        console.error('[sync] Failed to start watcher after promotion:', error);
                    }
                }
            }, 2000); // Check every 2 seconds
        }
    }
    else {
        console.log('[sync] Sync disabled via PNPM_INJECTED_SYNC_DISABLED');
    }
    // Spawn the child process
    const fullCommand = args.join(' ');
    console.log(`[sync] Running: ${fullCommand}`);
    // Always use shell to handle complex commands and PATH resolution
    const child = spawn(fullCommand, [], {
        stdio: 'inherit',
        shell: true,
        // Ensure the child process is not detached
        detached: false
    });
    // Track if we're already exiting
    let isExiting = false;
    let childExitCode = null;
    // Handle child process errors
    child.on('error', (err) => {
        console.error(`[sync] Failed to start child process:`, err);
        process.exit(1);
    });
    // Handle child process exit
    child.on('exit', async (code, signal) => {
        childExitCode = code;
        childExited = true;
        if (isExiting) {
            // If we're already exiting due to a signal, just exit with child's code
            process.exit(code || 0);
            return;
        }
        isExiting = true;
        console.log(`[sync] Child process exited with code ${code} and signal ${signal}`);
        // Clean up promotion check interval
        if (promotionCheckInterval) {
            clearInterval(promotionCheckInterval);
            promotionCheckInterval = null;
        }
        // Unregister this client
        const remainingClients = await unregisterClient(lockFile, pid);
        if (isWatcher && state) {
            // If we're the watcher, clean up
            if (state.checkInterval)
                clearInterval(state.checkInterval);
            for (const timer of state.debounceTimers.values()) {
                clearTimeout(timer);
            }
            for (const watcher of state.watchers.values()) {
                watcher.close();
            }
            try {
                await fs.promises.unlink(lockFile);
                const clientFile = `${lockFile}.clients`;
                await fs.promises.unlink(clientFile);
            }
            catch { }
        }
        else if (remainingClients.length === 0) {
            console.log('[sync] Last client exiting');
        }
        process.exit(code || 0);
    });
    // Forward signals to child
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    signals.forEach(signal => {
        process.on(signal, async () => {
            if (isExiting)
                return;
            isExiting = true;
            console.log(`[sync] Received ${signal}, forwarding to child...`);
            // Forward signal to child
            child.kill(signal);
            // Clean up promotion check interval
            if (promotionCheckInterval) {
                clearInterval(promotionCheckInterval);
                promotionCheckInterval = null;
            }
            // Clean up if we're the watcher
            if (isWatcher && state) {
                if (state.checkInterval)
                    clearInterval(state.checkInterval);
                for (const timer of state.debounceTimers.values()) {
                    clearTimeout(timer);
                }
                for (const watcher of state.watchers.values()) {
                    watcher.close();
                }
                try {
                    await fs.promises.unlink(lockFile);
                    const clientFile = `${lockFile}.clients`;
                    await fs.promises.unlink(clientFile);
                }
                catch { }
            }
            else {
                // Unregister as client
                await unregisterClient(lockFile, pid);
            }
            // Don't exit immediately - let the child exit first and we'll exit in the 'exit' handler
            // But set a timeout to force exit if child doesn't exit
            setTimeout(() => {
                console.log('[sync] Force exit after signal');
                // Exit with child's code if available, otherwise signal exit code (128 + signal number)
                // SIGINT = 2, SIGTERM = 15, SIGHUP = 1
                const signalExitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
                process.exit(childExitCode ?? signalExitCode);
            }, 5000);
        });
    });
    // Keep the process alive while child is running
    // This is important because spawn might return before the child is fully set up
    const keepAlive = setInterval(() => {
        // Just keep the event loop alive
    }, 1000);
    // Clean up the keep-alive when child exits
    child.on('exit', () => {
        clearInterval(keepAlive);
    });
}
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    switch (command) {
        case 'sync':
            await runSyncCommand();
            break;
        case 'watch':
            await runWatchCommand();
            break;
        case 'run':
            if (args.length < 2) {
                console.error('Usage: pnpm-injected-sync run <command> [args...]');
                process.exit(1);
            }
            await runCommand(args.slice(1));
            break;
        case 'help':
        case '--help':
        case '-h':
            console.log(`
pnpm-injected-sync - Sync PNPM injected dependencies

Commands:
  sync               Sync injected dependencies once and exit
  watch              Watch and sync injected dependencies continuously
  run <command>      Run a command with automatic dependency syncing
  help               Show this help message

Examples:
  # One-time sync
  pnpm-injected-sync sync

  # Continuous watching
  pnpm-injected-sync watch

  # Run with automatic syncing (recommended for dev scripts)
  pnpm-injected-sync run vite
  pnpm-injected-sync run "npm run dev"

  # Use in package.json scripts
  "scripts": {
    "dev": "pnpm-injected-sync run vite",
    "build": "pnpm-injected-sync sync && vite build"
  }

The 'run' command will:
- Start or connect to a shared watcher process
- Execute your command
- Keep watching until all commands exit
`);
            break;
        default:
            if (command) {
                console.error(`Unknown command: ${command}`);
            }
            console.error('Usage: pnpm-injected-sync <command>');
            console.error('Run "pnpm-injected-sync help" for more information');
            process.exit(1);
    }
}
main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map