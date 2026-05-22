// Game Configuration
const CONFIG = {
    GRAVITY: 0.6,
    JUMP_POWER: -10,  // Balanced jump height
    JUMP_HOLD_GRAVITY: 0.25,  // Reduced gravity while holding jump
    MAX_JUMP_HOLD_TIME: 12,  // Frames you can hold jump for higher jump
    MOVE_SPEED: 5,
    ACCELERATION: 0.5,
    FRICTION: 0.85,
    MAX_FALL_SPEED: 15,
    PLAYER_SIZE: 40,
    ENEMY_SIZE: 35,
    COIN_SIZE: 25,
    BLOCK_SIZE: 40,
    WORLD_WIDTH: 3000,  // Large scrollable world
    WORLD_HEIGHT: 600,  // Fixed world height
};

// Game State
const gameState = {
    running: false,
    score: 0,
    coins: 0,
    lives: 3,
    level: 1,
    keys: {},
    touchControls: { left: false, right: false, jump: false },
    camera: { x: 0, y: 0 },
    screenShake: { intensity: 0, duration: 0 },
};

// Multiplayer Color Palettes
const PLAYER_COLORS = [
    { name: 'red', shirt: '#E52521', overalls: '#0066CC', skin: '#FFDBAC' },      // Classic Mario
    { name: 'green', shirt: '#3FBF3F', overalls: '#0066CC', skin: '#FFDBAC' },    // Luigi
    { name: 'blue', shirt: '#4A90E2', overalls: '#1A4D8F', skin: '#FFDBAC' },     // Blue Mario
    { name: 'yellow', shirt: '#FFD93D', overalls: '#E68A00', skin: '#FFDBAC' },   // Wario
    { name: 'purple', shirt: '#9B59B6', overalls: '#4A235A', skin: '#FFDBAC' },   // Waluigi
    { name: 'pink', shirt: '#FF69B4', overalls: '#C71585', skin: '#FFDBAC' },     // Pink
    { name: 'orange', shirt: '#FF8C00', overalls: '#8B4513', skin: '#FFDBAC' },   // Orange
    { name: 'cyan', shirt: '#00CED1', overalls: '#008B8B', skin: '#FFDBAC' },     // Cyan
];

// Multiplayer State
const multiplayerState = {
    playerId: null,
    playerName: null,
    playerColor: null,
    remotePlayers: new Map(),
    lastSyncTime: 0,
    syncInterval: 150, // Reduced to ~7 updates per second, rely on interpolation
    heartbeatInterval: 5000, // Send heartbeat every 5 seconds if idle
    lastHeartbeatTime: 0,
    lastCleanupTime: 0,
    cleanupInterval: 30000, // Run cleanup every 30 seconds
    connected: false,
    playerRef: null,
    playersRef: null,
    coinsRef: null,
    leaderboardRef: null,
    enemiesRef: null,
    portalRef: null,
    hitsRef: null, // For PvP hit messages
    lastProcessedHit: null, // Track last hit to prevent duplicates
    isSpawnMaster: false, // True if this client controls enemy spawning
    // Track last synced values to avoid redundant updates
    lastSyncedState: {
        x: null,
        y: null,
        direction: null,
        health: null,
        invulnerable: null,
        outOfLives: null,
        score: null,
    },
};

// Firebase Multiplayer Manager
class MultiplayerManager {
    constructor() {
        this.db = typeof firebase !== 'undefined' ? firebase.database() : null;
        if (!this.db) {
            console.warn('Firebase not initialized - multiplayer disabled');
        }
    }

    async connect(playerName) {
        if (!this.db) return false;

        try {
            // Generate unique player ID
            multiplayerState.playerId = this.db.ref().child('players').push().key;
            multiplayerState.playerName = playerName || 'Anonymous';

            // Assign color based on player ID hash
            const colorIndex = Math.abs(this.hashCode(multiplayerState.playerId)) % PLAYER_COLORS.length;
            multiplayerState.playerColor = PLAYER_COLORS[colorIndex];

            // Set up Firebase references
            multiplayerState.playersRef = this.db.ref('players');
            multiplayerState.playerRef = multiplayerState.playersRef.child(multiplayerState.playerId);
            multiplayerState.coinsRef = this.db.ref('coins');
            multiplayerState.leaderboardRef = this.db.ref('leaderboard');
            multiplayerState.enemiesRef = this.db.ref('enemies');
            multiplayerState.portalRef = this.db.ref('portals');
            multiplayerState.hitsRef = this.db.ref('hits');

            // Initialize player data
            await multiplayerState.playerRef.set({
                name: multiplayerState.playerName,
                color: multiplayerState.playerColor.name,
                score: 0,
                x: 100,
                y: 300,
                direction: 1,
                health: 2, // Start with 2 health (big Mario)
                timestamp: firebase.database.ServerValue.TIMESTAMP,
            });

            // Set up disconnect cleanup
            multiplayerState.playerRef.onDisconnect().remove();

            // Listen for other players
            this.listenForPlayers();

            // Listen for coin state
            this.listenForCoins();

            // Clear any locally spawned enemies before syncing with Firebase
            enemies.length = 0;

            // Listen for enemy state
            this.listenForEnemies();

            // Listen for incoming PvP hits
            this.listenForHits();

            // Update leaderboard
            this.updateLeaderboard();

            multiplayerState.connected = true;
            console.log('Connected to multiplayer as:', multiplayerState.playerName);
            return true;
        } catch (error) {
            console.error('Failed to connect to multiplayer:', error);
            return false;
        }
    }

    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash = hash & hash;
        }
        return hash;
    }

    listenForPlayers() {
        multiplayerState.playersRef.on('value', (snapshot) => {
            const players = snapshot.val();
            if (!players) return;

            Object.entries(players).forEach(([id, data]) => {
                if (id !== multiplayerState.playerId) {
                    const existingPlayer = multiplayerState.remotePlayers.get(id);

                    if (existingPlayer) {
                        // Update target position for interpolation
                        existingPlayer.targetX = data.x || 0;
                        existingPlayer.targetY = data.y || 0;
                        existingPlayer.direction = data.direction || 1;
                        existingPlayer.score = data.score || 0;
                        existingPlayer.health = data.health || 2;
                        existingPlayer.invulnerable = data.invulnerable || false;
                        existingPlayer.outOfLives = data.outOfLives || false;
                        existingPlayer.timestamp = data.timestamp || Date.now();
                    } else {
                        // New player - initialize with current position
                        multiplayerState.remotePlayers.set(id, {
                            name: data.name || 'Unknown Player',
                            color: PLAYER_COLORS.find(c => c.name === data.color) || PLAYER_COLORS[0],
                            x: data.x || 0,
                            y: data.y || 0,
                            targetX: data.x || 0,
                            targetY: data.y || 0,
                            direction: data.direction || 1,
                            score: data.score || 0,
                            health: data.health || 2,
                            invulnerable: data.invulnerable || false,
                            outOfLives: data.outOfLives || false,
                            timestamp: data.timestamp || Date.now(),
                        });
                    }
                }
            });

            // Remove disconnected players
            const playerIds = new Set(Object.keys(players));
            for (const [id] of multiplayerState.remotePlayers) {
                if (!playerIds.has(id)) {
                    multiplayerState.remotePlayers.delete(id);
                }
            }

            // Determine spawn master with AFK detection
            // Normally: player with lowest ID alphabetically
            // BUT: if that player is AFK (no updates for 15+ seconds), active players can claim the role
            const allPlayerIds = Array.from(playerIds).sort();
            const nominalSpawnMasterId = allPlayerIds[0];
            const nominalSpawnMaster = players[nominalSpawnMasterId];
            const now = Date.now();
            const spawnMasterInactivityThreshold = 15000; // 15 seconds

            // Check if the nominal Spawn Master is inactive
            const spawnMasterLastUpdate = nominalSpawnMaster?.timestamp || 0;
            const spawnMasterInactive = (now - spawnMasterLastUpdate) > spawnMasterInactivityThreshold;

            let actualSpawnMasterId;
            if (spawnMasterInactive) {
                // Nominal Spawn Master is AFK/abandoned - find the most recently active player to take over
                // This ensures an active player becomes Spawn Master, not another AFK player
                let mostRecentPlayerId = nominalSpawnMasterId;
                let mostRecentTimestamp = 0;

                for (const [id, data] of Object.entries(players)) {
                    const timestamp = data.timestamp || 0;
                    if (timestamp > mostRecentTimestamp) {
                        mostRecentTimestamp = timestamp;
                        mostRecentPlayerId = id;
                    }
                }
                actualSpawnMasterId = mostRecentPlayerId;
            } else {
                // Nominal Spawn Master is active - use them
                actualSpawnMasterId = nominalSpawnMasterId;
            }

            const wasSpawnMaster = multiplayerState.isSpawnMaster;
            multiplayerState.isSpawnMaster = (actualSpawnMasterId === multiplayerState.playerId);

            // Log spawn master changes
            if (multiplayerState.isSpawnMaster && !wasSpawnMaster) {
                if (spawnMasterInactive && nominalSpawnMasterId !== multiplayerState.playerId) {
                    console.log('🎮 Previous spawn master is AFK - you are now the spawn master (controlling enemy spawns and cleanup)');
                } else {
                    console.log('🎮 You are now the spawn master - controlling enemy spawns and cleanup');
                }
            } else if (!multiplayerState.isSpawnMaster && wasSpawnMaster) {
                console.log('🎮 Spawn master role transferred to another player');
            }

            // Spawn master cleans up inactive players
            if (multiplayerState.isSpawnMaster) {
                this.cleanupInactivePlayers(players);
            }

            // Update leaderboard display
            this.updateLeaderboardUI();
        });
    }

    async cleanupInactivePlayers(players) {
        if (!multiplayerState.isSpawnMaster) return;

        const now = Date.now();

        // Throttle cleanup - only run every 30 seconds
        if (now - multiplayerState.lastCleanupTime < multiplayerState.cleanupInterval) {
            return;
        }

        multiplayerState.lastCleanupTime = now;
        const inactivityThreshold = 10000; // 10 seconds of inactivity (reduced from 60s to handle abandoned players faster)

        for (const [playerId, playerData] of Object.entries(players)) {
            // Skip our own player
            if (playerId === multiplayerState.playerId) continue;

            const lastUpdate = playerData.timestamp || 0;
            const timeSinceUpdate = now - lastUpdate;

            // If player hasn't updated in 10 seconds, remove them
            if (timeSinceUpdate > inactivityThreshold) {
                console.log(`🧹 Cleaning up inactive player: ${playerData.name} (inactive for ${Math.round(timeSinceUpdate / 1000)}s)`);

                try {
                    // Remove player from players list
                    await multiplayerState.playersRef.child(playerId).remove();

                    // Remove player from leaderboard
                    await multiplayerState.leaderboardRef.child(playerId).remove();
                } catch (error) {
                    console.error('Failed to cleanup inactive player:', error);
                }
            }
        }
    }

    listenForCoins() {
        multiplayerState.coinsRef.on('value', (snapshot) => {
            const coinData = snapshot.val();
            if (!coinData) return;

            // Update coin collected states
            coins.forEach((coin, index) => {
                const coinKey = `coin_${index}`;
                if (coinData[coinKey]) {
                    coin.collected = true;
                    coin.respawnTime = coinData[coinKey].respawnTime;
                }
            });
        });
    }

    listenForEnemies() {
        // Listen for new enemies being added
        multiplayerState.enemiesRef.on('child_added', (snapshot) => {
            const data = snapshot.val();
            const id = snapshot.key;

            // Check if we already have this enemy
            const existing = enemies.find(e => e.id === id);
            if (existing) return;

            // Create new enemy based on type
            let enemy;
            if (data.type === 'jumping') {
                enemy = new JumpingEnemy(data.x, data.y, id);
            } else if (data.type === 'turtle') {
                enemy = new TurtleEnemy(data.x, data.y, id);
            } else {
                enemy = new Enemy(data.x, data.y, id);
            }

            enemy.velocityX = data.velocityX || (data.type === 'turtle' ? -1 : -2);
            enemy.alive = data.alive !== false;
            enemies.push(enemy);
        });

        // Listen for enemy updates
        multiplayerState.enemiesRef.on('child_changed', (snapshot) => {
            const data = snapshot.val();
            const id = snapshot.key;

            const enemy = enemies.find(e => e.id === id);
            if (!enemy) return;

            // Update position and state (with interpolation target)
            enemy.x = data.x;
            enemy.y = data.y;
            enemy.velocityX = data.velocityX || enemy.velocityX;
            enemy.alive = data.alive !== false;
        });

        // Listen for enemies being removed
        multiplayerState.enemiesRef.on('child_removed', (snapshot) => {
            const id = snapshot.key;
            const index = enemies.findIndex(e => e.id === id);
            if (index !== -1) {
                enemies.splice(index, 1);
            }
        });
    }

    listenForHits() {
        // Listen for incoming PvP hit claims directed at us
        const myHitsRef = multiplayerState.hitsRef.child(multiplayerState.playerId);

        myHitsRef.on('child_added', (snapshot) => {
            const hitData = snapshot.val();
            const hitId = snapshot.key;

            // Prevent processing the same hit twice
            if (multiplayerState.lastProcessedHit === hitId) return;
            multiplayerState.lastProcessedHit = hitId;

            // Validate hit data structure
            if (!hitData || !hitData.attackerId || !hitData.timestamp) {
                console.warn('Invalid hit data received:', hitData);
                snapshot.ref.remove();
                return;
            }

            // Check if hit claim is recent (within last 2 seconds)
            const hitAge = Date.now() - hitData.timestamp;
            if (hitAge > 2000 || hitAge < 0) {
                console.warn('Hit claim is too old or in the future, ignoring');
                snapshot.ref.remove();
                return;
            }

            // Validate that the attacker exists
            const attacker = multiplayerState.remotePlayers.get(hitData.attackerId);
            if (!attacker) {
                console.warn('Hit from unknown player:', hitData.attackerId);
                snapshot.ref.remove();
                return;
            }

            // CONSENSUS VALIDATION: Check if we agree with the attacker's claim
            // 1. Position validation: Were we near the claimed position?
            const ourActualX = player.x;
            const ourActualY = player.y;
            const claimedVictimX = hitData.victimX;
            const claimedVictimY = hitData.victimY;

            // Allow for some tolerance due to network lag (30 pixels)
            const positionTolerance = 30;
            const positionDiffX = Math.abs(ourActualX - claimedVictimX);
            const positionDiffY = Math.abs(ourActualY - claimedVictimY);

            if (positionDiffX > positionTolerance || positionDiffY > positionTolerance) {
                console.warn(`Position mismatch - claimed: (${claimedVictimX}, ${claimedVictimY}), actual: (${ourActualX}, ${ourActualY})`);
                snapshot.ref.remove();
                return;
            }

            // 2. Geometry validation: Was attacker above us (valid stomp)?
            const attackerY = hitData.attackerY;
            if (attackerY >= ourActualY) {
                console.warn('Invalid stomp geometry - attacker was not above victim');
                snapshot.ref.remove();
                return;
            }

            // 3. Check if we're already invulnerable (can't be hit)
            if (player.invulnerable) {
                console.log('Hit claim rejected - we are invulnerable');
                snapshot.ref.remove();
                return;
            }

            // 4. Check if we're already dead
            if (player.outOfLives) {
                console.log('Hit claim rejected - we are already dead');
                snapshot.ref.remove();
                return;
            }

            // CONSENSUS REACHED! Both parties agree on the hit
            console.log(`✅ Consensus: Valid hit from ${hitData.attackerName}`);
            player.hit(true); // Apply damage to ourselves

            // Clean up the hit message
            snapshot.ref.remove();
        });
    }

    // Interpolate remote player positions for smooth movement
    interpolateRemotePlayers() {
        multiplayerState.remotePlayers.forEach((playerData) => {
            // Smooth interpolation - move 20% of the way to target each frame
            const lerpFactor = 0.2;
            playerData.x += (playerData.targetX - playerData.x) * lerpFactor;
            playerData.y += (playerData.targetY - playerData.y) * lerpFactor;
        });
    }

    async syncPlayerPosition(x, y, direction, health, invulnerable, outOfLives) {
        if (!multiplayerState.connected || !multiplayerState.playerRef) return;

        const now = Date.now();
        const timeSinceLastSync = now - multiplayerState.lastSyncTime;
        const timeSinceHeartbeat = now - multiplayerState.lastHeartbeatTime;

        // Check if any values have changed (with 2 pixel tolerance for position)
        const last = multiplayerState.lastSyncedState;
        const roundedX = Math.round(x);
        const roundedY = Math.round(y);
        const hasChanged =
            Math.abs(roundedX - (last.x || 0)) > 2 ||
            Math.abs(roundedY - (last.y || 0)) > 2 ||
            direction !== last.direction ||
            health !== last.health ||
            invulnerable !== last.invulnerable ||
            outOfLives !== last.outOfLives ||
            gameState.score !== last.score;

        // Sync if: values changed OR it's time for heartbeat
        const shouldSync = hasChanged || timeSinceHeartbeat >= multiplayerState.heartbeatInterval;

        // Throttle to prevent too frequent updates
        if (timeSinceLastSync < multiplayerState.syncInterval) return;

        if (!shouldSync) return;

        multiplayerState.lastSyncTime = now;
        if (!hasChanged) {
            multiplayerState.lastHeartbeatTime = now; // This was a heartbeat
        }

        try {
            await multiplayerState.playerRef.update({
                x: roundedX,
                y: roundedY,
                direction,
                score: gameState.score,
                health: health || 2,
                invulnerable: invulnerable || false,
                outOfLives: outOfLives || false,
                timestamp: firebase.database.ServerValue.TIMESTAMP,
            });

            // Update last synced state
            last.x = roundedX;
            last.y = roundedY;
            last.direction = direction;
            last.health = health;
            last.invulnerable = invulnerable;
            last.outOfLives = outOfLives;
            last.score = gameState.score;
        } catch (error) {
            console.error('Failed to sync position:', error);
        }
    }

    async syncEnemyState(enemy) {
        if (!multiplayerState.connected || !enemy.id) return;

        const now = Date.now();
        // Throttle to ~10 updates per second
        if (now - enemy.lastSyncTime < 100) return;
        enemy.lastSyncTime = now;

        const enemyRef = multiplayerState.enemiesRef.child(enemy.id);

        try {
            await enemyRef.update({
                x: Math.round(enemy.x),
                y: Math.round(enemy.y),
                velocityX: enemy.velocityX,
                alive: enemy.alive,
                timestamp: firebase.database.ServerValue.TIMESTAMP,
            });
        } catch (error) {
            console.error('Failed to sync enemy:', error);
        }
    }

    async sendHitClaim(victimId, attackerX, attackerY, victimX, victimY) {
        if (!multiplayerState.connected) return;

        try {
            // Send hit claim to victim's hits inbox
            const hitRef = multiplayerState.hitsRef.child(victimId).push();
            await hitRef.set({
                attackerId: multiplayerState.playerId,
                attackerName: multiplayerState.playerName,
                attackerX: Math.round(attackerX),
                attackerY: Math.round(attackerY),
                victimX: Math.round(victimX),
                victimY: Math.round(victimY),
                timestamp: Date.now(),
            });
        } catch (error) {
            console.error('Failed to send hit claim:', error);
        }
    }

    async spawnEnemy(portalX, portalY, type) {
        if (!multiplayerState.connected) return null;

        try {
            const enemyRef = multiplayerState.enemiesRef.push();
            await enemyRef.set({
                x: Math.round(portalX),
                y: Math.round(portalY),
                velocityX: type === 'turtle' ? -1 : -2,
                alive: true,
                type: type, // 'normal', 'jumping', or 'turtle'
                spawnedBy: multiplayerState.playerId,
                spawnedAt: Date.now(),
                timestamp: firebase.database.ServerValue.TIMESTAMP,
            });
            return enemyRef.key;
        } catch (error) {
            console.error('Failed to spawn enemy:', error);
            return null;
        }
    }

    async removeEnemy(enemyId) {
        if (!multiplayerState.connected || !enemyId) return;

        try {
            await multiplayerState.enemiesRef.child(enemyId).remove();
        } catch (error) {
            console.error('Failed to remove enemy:', error);
        }
    }

    async collectCoin(coinIndex) {
        if (!multiplayerState.connected) return;

        const coinKey = `coin_${coinIndex}`;
        const coinRef = multiplayerState.coinsRef.child(coinKey);

        try {
            // Use transaction to prevent race conditions
            const result = await coinRef.transaction((current) => {
                if (current === null || current.collected === false) {
                    return {
                        collected: true,
                        collectedBy: multiplayerState.playerId,
                        collectedAt: Date.now(),
                        respawnTime: Date.now() + 10000, // 10 seconds
                    };
                }
                return undefined; // Abort - coin already collected
            });

            return result.committed;
        } catch (error) {
            console.error('Failed to collect coin:', error);
            return false;
        }
    }

    async updateLeaderboard() {
        if (!multiplayerState.connected) return;

        try {
            await multiplayerState.leaderboardRef.child(multiplayerState.playerId).set({
                name: multiplayerState.playerName,
                score: gameState.score,
                timestamp: firebase.database.ServerValue.TIMESTAMP,
            });

            // Update all-time leaderboard if score is high enough
            this.updateAllTimeLeaderboard(multiplayerState.playerName, gameState.score);
        } catch (error) {
            console.error('Failed to update leaderboard:', error);
        }
    }

    async updateAllTimeLeaderboard(playerName, score) {
        if (!this.db) return;

        try {
            const allTimeRef = this.db.ref('allTimeLeaderboard');

            // Use transaction to ensure atomic update
            await allTimeRef.transaction((currentData) => {
                if (!currentData) {
                    currentData = {};
                }

                // Find if player already exists
                let existingKey = null;
                let existingScore = 0;

                Object.entries(currentData).forEach(([key, data]) => {
                    if (data.name === playerName) {
                        existingKey = key;
                        existingScore = data.score || 0;
                    }
                });

                // Update if new score is higher
                if (!existingKey || score > existingScore) {
                    const key = existingKey || this.db.ref().child('allTimeLeaderboard').push().key;
                    currentData[key] = {
                        name: playerName,
                        score: score,
                        timestamp: Date.now(),
                    };
                }

                return currentData;
            });
        } catch (error) {
            console.error('Failed to update all-time leaderboard:', error);
        }
    }

    loadAllTimeLeaderboard() {
        if (!this.db) return;

        const allTimeRef = this.db.ref('allTimeLeaderboard');
        allTimeRef.orderByChild('score').limitToLast(10).on('value', (snapshot) => {
            const allTimeList = document.getElementById('all-time-list');
            if (!allTimeList) return;

            const data = snapshot.val();
            if (!data) {
                allTimeList.innerHTML = '<div class="all-time-entry"><span class="name">No scores yet!</span></div>';
                return;
            }

            // Convert to array and sort by score descending
            const entries = Object.values(data).sort((a, b) => b.score - a.score).slice(0, 10);

            // Render top 10
            allTimeList.innerHTML = entries.map((entry, index) => `
                <div class="all-time-entry">
                    <span class="rank">${this.getRankEmoji(index + 1)}</span>
                    <span class="name">${entry.name}</span>
                    <span class="score">${entry.score}</span>
                </div>
            `).join('');
        });
    }

    getRankEmoji(rank) {
        const emojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        return emojis[rank - 1] || `#${rank}`;
    }

    updateLeaderboardUI() {
        const leaderboardList = document.getElementById('leaderboard-list');
        if (!leaderboardList) return;

        // Combine current player with remote players
        const allPlayers = [
            {
                id: multiplayerState.playerId,
                name: multiplayerState.playerName,
                score: gameState.score,
                isYou: true,
            },
            ...Array.from(multiplayerState.remotePlayers.entries()).map(([id, data]) => ({
                id,
                name: data.name,
                score: data.score,
                isYou: false,
            }))
        ];

        // Sort by score descending
        allPlayers.sort((a, b) => b.score - a.score);

        // Take top 5
        const top5 = allPlayers.slice(0, 5);

        // Render leaderboard
        leaderboardList.innerHTML = top5.map((player, index) => `
            <div class="leaderboard-entry ${player.isYou ? 'you' : ''}">
                <span class="rank">#${index + 1}</span>
                <span class="name">${player.name}${player.isYou ? ' (You)' : ''}</span>
                <span class="score">${player.score}</span>
            </div>
        `).join('');

        // Show leaderboard if we have players
        const leaderboard = document.getElementById('leaderboard');
        if (leaderboard && allPlayers.length > 0) {
            leaderboard.classList.remove('hidden');
        }
    }

    async respawnPlayer() {
        if (!multiplayerState.connected) return;

        // Apply 20% score penalty
        const penalty = Math.floor(gameState.score * 0.2);
        gameState.score = Math.max(0, gameState.score - penalty);
        document.getElementById('score').textContent = gameState.score;

        // Update Firebase
        await this.updateLeaderboard();

        console.log(`Respawned with ${penalty} point penalty`);
    }

    disconnect() {
        if (multiplayerState.playerRef) {
            multiplayerState.playerRef.remove();
        }
        if (multiplayerState.playersRef) {
            multiplayerState.playersRef.off();
        }
        if (multiplayerState.coinsRef) {
            multiplayerState.coinsRef.off();
        }
        multiplayerState.connected = false;
    }
}

// Create multiplayer manager instance
const multiplayer = new MultiplayerManager();

// Particle System
class Particle {
    constructor(x, y, vx, vy, color, size, lifetime) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.color = color;
        this.size = size;
        this.lifetime = lifetime;
        this.age = 0;
        this.alpha = 1;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vy += 0.3; // Gravity
        this.age++;
        this.alpha = 1 - (this.age / this.lifetime);
        return this.age < this.lifetime;
    }

    draw() {
        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        ctx.save();
        ctx.globalAlpha = this.alpha;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(screenX, screenY, this.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

let particles = [];

function createParticles(x, y, count, color) {
    for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count;
        const speed = 2 + Math.random() * 3;
        const vx = Math.cos(angle) * speed;
        const vy = Math.sin(angle) * speed - 2;
        const size = 2 + Math.random() * 3;
        particles.push(new Particle(x, y, vx, vy, color, size, 30));
    }
}

function createJumpDust(x, y) {
    for (let i = 0; i < 5; i++) {
        const vx = (Math.random() - 0.5) * 4;
        const vy = Math.random() * 2;
        particles.push(new Particle(x, y, vx, vy, '#E0E0E0', 3, 15));
    }
}

function updateParticles() {
    particles = particles.filter(p => p.update());
}

function drawParticles() {
    particles.forEach(p => p.draw());
}

function screenShake(intensity, duration) {
    gameState.screenShake.intensity = intensity;
    gameState.screenShake.duration = duration;
}

// Floating Text System (for combos and score popups)
class FloatingText {
    constructor(x, y, text, color, size = 20) {
        this.x = x;
        this.y = y;
        this.text = text;
        this.color = color;
        this.size = size;
        this.vy = -2; // Float upward
        this.lifetime = 60; // 1 second at 60fps
        this.age = 0;
        this.alpha = 1;
        this.scale = 0.5; // Start small
    }

    update() {
        this.y += this.vy;
        this.vy += 0.05; // Slight deceleration
        this.age++;

        // Scale animation: grow then fade
        if (this.age < 10) {
            this.scale += 0.1; // Grow to full size
        } else {
            this.alpha = 1 - ((this.age - 10) / (this.lifetime - 10));
        }

        return this.age < this.lifetime;
    }

    draw() {
        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        ctx.save();
        ctx.globalAlpha = this.alpha;
        ctx.font = `bold ${this.size * this.scale}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Outline for better visibility
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 3;
        ctx.strokeText(this.text, screenX, screenY);

        ctx.fillStyle = this.color;
        ctx.fillText(this.text, screenX, screenY);
        ctx.restore();
    }
}

let floatingTexts = [];

function createFloatingText(x, y, text, color, size = 20) {
    floatingTexts.push(new FloatingText(x, y, text, color, size));
}

function updateFloatingTexts() {
    floatingTexts = floatingTexts.filter(t => t.update());
}

function drawFloatingTexts() {
    floatingTexts.forEach(t => t.draw());
}

// Haptic Feedback System
const haptics = {
    supported: 'vibrate' in navigator,

    light: () => {
        if (haptics.supported) {
            navigator.vibrate(10);  // Very short, light tap
        }
    },

    medium: () => {
        if (haptics.supported) {
            navigator.vibrate(25);  // Medium tap
        }
    },

    heavy: () => {
        if (haptics.supported) {
            navigator.vibrate(50);  // Strong impact
        }
    },

    success: () => {
        if (haptics.supported) {
            navigator.vibrate([10, 30, 20]);  // Two quick taps
        }
    },

    error: () => {
        if (haptics.supported) {
            navigator.vibrate([30, 50, 30]);  // Buzz pattern
        }
    }
};

// Canvas Setup
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    const maxWidth = window.innerWidth;
    const maxHeight = window.innerHeight;
    const aspectRatio = 16 / 9;

    let width = maxWidth;
    let height = maxWidth / aspectRatio;

    if (height > maxHeight) {
        height = maxHeight;
        width = height * aspectRatio;
    }

    canvas.width = Math.min(800, width);
    canvas.height = Math.min(600, height);
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// Audio Setup
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

function playSound(frequency, duration, type = 'sine') {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = type;

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration);
}

const sounds = {
    jump: () => {
        playSound(400, 0.1, 'square');
        setTimeout(() => playSound(600, 0.1, 'square'), 50);
    },
    coin: () => {
        playSound(800, 0.1, 'sine');
        setTimeout(() => playSound(1000, 0.15, 'sine'), 50);
    },
    stomp: () => {
        playSound(200, 0.1, 'sawtooth');
    },
    powerUp: () => {
        playSound(500, 0.1);
        setTimeout(() => playSound(600, 0.1), 80);
        setTimeout(() => playSound(700, 0.1), 160);
        setTimeout(() => playSound(800, 0.2), 240);
    },
    die: () => {
        playSound(400, 0.1);
        setTimeout(() => playSound(350, 0.1), 100);
        setTimeout(() => playSound(300, 0.2), 200);
        setTimeout(() => playSound(200, 0.3), 300);
    },
};

// Player Class
class Player {
    constructor(x, y, colorPalette = null) {
        this.x = x;
        this.y = y;
        this.width = CONFIG.PLAYER_SIZE;
        this.height = CONFIG.PLAYER_SIZE;
        this.velocityX = 0;
        this.velocityY = 0;
        this.onGround = false;
        this.wasOnGround = false;
        this.direction = 1;
        this.jumpCount = 0;
        this.invulnerable = false;
        this.isJumping = false;
        this.jumpTime = 0;
        this.colorPalette = colorPalette || PLAYER_COLORS[0]; // Default to red Mario
        this.health = 2; // 2 = big, 1 = small
        this.outOfLives = false;
        this.respawnCountdown = 0;
        this.hasUsedContinue = false;
        this.combo = 0; // Combo counter for consecutive kills
        this.maxCombo = 10; // Cap at 10x multiplier
        this.deathX = 0; // Store death position for grave marker
        this.deathY = 0;
    }

    update() {
        // Don't update if out of lives (paused for decision)
        if (this.outOfLives) return;

        // Horizontal movement with momentum
        if (gameState.keys['ArrowLeft'] || gameState.touchControls.left) {
            this.velocityX -= CONFIG.ACCELERATION;
            if (this.velocityX < -CONFIG.MOVE_SPEED) {
                this.velocityX = -CONFIG.MOVE_SPEED;
            }
            this.direction = -1;
        } else if (gameState.keys['ArrowRight'] || gameState.touchControls.right) {
            this.velocityX += CONFIG.ACCELERATION;
            if (this.velocityX > CONFIG.MOVE_SPEED) {
                this.velocityX = CONFIG.MOVE_SPEED;
            }
            this.direction = 1;
        } else {
            // Apply friction when no input
            this.velocityX *= CONFIG.FRICTION;
            // Stop completely if moving very slowly
            if (Math.abs(this.velocityX) < 0.1) {
                this.velocityX = 0;
            }
        }

        // Jumping - check if button is pressed
        const jumpPressed = gameState.keys['ArrowUp'] || gameState.keys[' '] || gameState.touchControls.jump;

        // Start jump
        if (jumpPressed && this.onGround && !this.isJumping) {
            this.velocityY = CONFIG.JUMP_POWER;
            this.onGround = false;
            this.isJumping = true;
            this.jumpTime = 0;
            sounds.jump();
            createJumpDust(this.x + this.width / 2, this.y + this.height);
            haptics.light();  // Light haptic on jump
        }

        // Variable jump height - hold button for higher jump
        if (this.isJumping && jumpPressed && this.velocityY < 0 && this.jumpTime < CONFIG.MAX_JUMP_HOLD_TIME) {
            // Apply reduced gravity while holding jump button
            this.velocityY += CONFIG.JUMP_HOLD_GRAVITY;
            this.jumpTime++;
        } else {
            // Apply normal gravity
            this.velocityY += CONFIG.GRAVITY;
            if (this.onGround) {
                this.isJumping = false;
                this.jumpTime = 0;
            }
        }

        // Cap fall speed
        if (this.velocityY > CONFIG.MAX_FALL_SPEED) {
            this.velocityY = CONFIG.MAX_FALL_SPEED;
        }

        // Update position
        this.x += this.velocityX;
        this.y += this.velocityY;

        // Keep player in world bounds
        if (this.x < 0) this.x = 0;
        if (this.x + this.width > CONFIG.WORLD_WIDTH) this.x = CONFIG.WORLD_WIDTH - this.width;

        // Store previous ground state
        this.wasOnGround = this.onGround;

        // Reset onGround flag
        this.onGround = false;

        // Ground collision
        const groundY = CONFIG.WORLD_HEIGHT - 50;
        if (this.y + this.height >= groundY) {
            this.y = groundY - this.height;
            this.velocityY = 0;
            this.onGround = true;
        }

        // Platform collisions (with edge margin for realistic physics)
        platforms.forEach(platform => {
            if (this.checkCollision(platform)) {
                if (this.velocityY > 0 && this.y + this.height - this.velocityY <= platform.y) {
                    // Calculate horizontal overlap
                    const overlapLeft = (this.x + this.width) - platform.x;
                    const overlapRight = (platform.x + platform.width) - this.x;
                    const minHorizontalOverlap = Math.min(overlapLeft, overlapRight);

                    // Require at least 8 pixels of overlap to stand on platform
                    if (minHorizontalOverlap >= 8) {
                        this.y = platform.y - this.height;
                        this.velocityY = 0;
                        this.onGround = true;
                    }
                }
            }
        });

        // Portal (pipe) collisions - solid obstacles
        portals.forEach(portal => {
            if (portal.checkCollision(this)) {
                // Calculate overlap on each axis
                const overlapLeft = (this.x + this.width) - portal.x;
                const overlapRight = (portal.x + portal.width) - this.x;
                const overlapTop = (this.y + this.height) - portal.y;
                const overlapBottom = (portal.y + portal.height) - this.y;

                // Find the smallest overlap
                const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

                // Push player out on the side with smallest overlap
                if (minOverlap === overlapTop && this.velocityY > 0) {
                    // Landing on top of portal
                    this.y = portal.y - this.height;
                    this.velocityY = 0;
                    this.onGround = true;
                } else if (minOverlap === overlapBottom && this.velocityY < 0) {
                    // Hitting portal from below
                    this.y = portal.y + portal.height;
                    this.velocityY = 0;
                } else if (minOverlap === overlapLeft) {
                    // Hitting from left
                    this.x = portal.x - this.width;
                    this.velocityX = 0;
                } else if (minOverlap === overlapRight) {
                    // Hitting from right
                    this.x = portal.x + portal.width;
                    this.velocityX = 0;
                }
            }
        });

        // Detect landing - trigger haptic when transitioning from air to ground
        if (this.onGround && !this.wasOnGround) {
            haptics.medium();  // Medium haptic on landing

            // Reset combo when landing
            if (this.combo > 0) {
                this.combo = 0;
            }
        }

        // Check for PvP collisions
        this.checkRemotePlayerCollisions();

        // Update camera to follow player
        updateCamera();
    }

    checkCollision(obj) {
        return this.x < obj.x + obj.width &&
               this.x + this.width > obj.x &&
               this.y < obj.y + obj.height &&
               this.y + this.height > obj.y;
    }

    draw() {
        ctx.save();

        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        // Scale based on health (small Mario = 0.75x size)
        const scale = this.health > 1 ? 1.0 : 0.75;
        const scaledWidth = this.width * scale;
        const scaledHeight = this.height * scale;
        // Adjust Y position so small Mario stands on ground properly
        const yOffset = this.health > 1 ? 0 : (this.height - scaledHeight);

        // Blinking effect when invulnerable
        if (this.invulnerable && Math.floor(Date.now() / 100) % 2 === 0) {
            ctx.globalAlpha = 0.5;
        }

        // Shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.beginPath();
        ctx.ellipse(screenX + scaledWidth / 2, screenY + yOffset + scaledHeight + 5, scaledWidth / 2.5, 5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Body (shirt) - use color palette
        ctx.fillStyle = this.colorPalette.shirt;
        ctx.beginPath();
        ctx.roundRect(screenX + 5 * scale, screenY + yOffset + 20 * scale, scaledWidth - 10 * scale, scaledHeight - 30 * scale, 5 * scale);
        ctx.fill();

        // Overalls - use color palette
        ctx.fillStyle = this.colorPalette.overalls;
        ctx.fillRect(screenX + 8 * scale, screenY + yOffset + 25 * scale, scaledWidth - 16 * scale, scaledHeight - 35 * scale);

        // Head (skin color) - use color palette
        ctx.fillStyle = this.colorPalette.skin;
        ctx.beginPath();
        ctx.arc(screenX + scaledWidth / 2, screenY + yOffset + 12 * scale, 12 * scale, 0, Math.PI * 2);
        ctx.fill();

        // Hat - use color palette
        ctx.fillStyle = this.colorPalette.shirt;
        ctx.beginPath();
        ctx.ellipse(screenX + scaledWidth / 2, screenY + yOffset + 8 * scale, 14 * scale, 8 * scale, 0, Math.PI, 2 * Math.PI);
        ctx.fill();
        ctx.fillRect(screenX + scaledWidth / 2 - 8 * scale, screenY + yOffset + 4 * scale, 16 * scale, 6 * scale);

        // Hat logo (M)
        ctx.fillStyle = 'white';
        ctx.font = `bold ${8 * scale}px Arial`;
        ctx.textAlign = 'center';
        ctx.fillText('M', screenX + scaledWidth / 2, screenY + yOffset + 9 * scale);

        // Eyes
        ctx.fillStyle = 'black';
        const eyeOffset = this.direction > 0 ? 2 * scale : -2 * scale;
        ctx.fillRect(screenX + scaledWidth / 2 - 3 * scale + eyeOffset, screenY + yOffset + 13 * scale, 2 * scale, 2 * scale);
        ctx.fillRect(screenX + scaledWidth / 2 + 3 * scale + eyeOffset, screenY + yOffset + 13 * scale, 2 * scale, 2 * scale);

        // Mustache
        ctx.fillStyle = '#5C3C1C';
        ctx.fillRect(screenX + scaledWidth / 2 - 6 * scale, screenY + yOffset + 17 * scale, 12 * scale, 3 * scale);

        // Buttons
        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.arc(screenX + scaledWidth / 2, screenY + yOffset + 30 * scale, 2 * scale, 0, Math.PI * 2);
        ctx.fill();

        // Shoes (brown)
        ctx.fillStyle = '#5C3C1C';
        ctx.fillRect(screenX + 5 * scale, screenY + yOffset + scaledHeight - 8 * scale, 12 * scale, 8 * scale);
        ctx.fillRect(screenX + scaledWidth - 17 * scale, screenY + yOffset + scaledHeight - 8 * scale, 12 * scale, 8 * scale);

        ctx.restore();
    }

    getRandomRespawnLocation() {
        // Try to find a safe platform to respawn on
        if (platforms.length > 0) {
            // Filter out platforms that are too high or too low
            const groundY = CONFIG.WORLD_HEIGHT - 50;
            const safePlatforms = platforms.filter(p => {
                const platformY = p.y;
                return platformY < groundY - 80 && platformY > 150; // Not too low, not too high
            });

            if (safePlatforms.length > 0) {
                // Pick a random safe platform
                const platform = safePlatforms[Math.floor(Math.random() * safePlatforms.length)];
                // Spawn in the middle of the platform
                return {
                    x: platform.x + platform.width / 2 - this.width / 2,
                    y: platform.y - this.height - 10 // Slightly above platform
                };
            }
        }

        // Fallback to start position if no platforms found
        return { x: 100, y: 100 };
    }

    hit(fromPlayer = false) {
        if (this.invulnerable) return;

        // Reset combo on taking damage
        this.combo = 0;

        // Health system: 2 = big, 1 = small
        if (this.health > 1) {
            // Take damage, shrink to small Mario
            this.health = 1;
            sounds.powerUp(); // Different sound for taking hit
            haptics.light();

            // Brief invulnerability
            this.invulnerable = true;
            // Immediately sync invulnerability state
            if (multiplayerState.connected) {
                multiplayer.syncPlayerPosition(this.x, this.y, this.direction, this.health, this.invulnerable, this.outOfLives);
            }

            setTimeout(() => {
                this.invulnerable = false;
                // Immediately sync when invulnerability ends
                if (multiplayerState.connected) {
                    multiplayer.syncPlayerPosition(this.x, this.y, this.direction, this.health, this.invulnerable, this.outOfLives);
                }
            }, 2000);

            // If hit by another player in PvP, they get points
            if (fromPlayer && multiplayerState.connected) {
                // Victim loses 100 points
                gameState.score = Math.max(0, gameState.score - 100);
                document.getElementById('score').textContent = gameState.score;
                multiplayer.updateLeaderboard();
            }

            return;
        }

        // Small Mario dies
        gameState.lives--;
        document.getElementById('lives').textContent = gameState.lives;
        sounds.die();
        haptics.error();

        // Check if out of lives
        if (gameState.lives <= 0) {
            if (multiplayerState.connected) {
                // Continuous gameplay - out of lives mode
                this.deathX = this.x;
                this.deathY = this.y;
                this.outOfLives = true;
                // Sync death state immediately so other players know not to collide
                multiplayer.syncPlayerPosition(this.x, this.y, this.direction, this.health, this.invulnerable, this.outOfLives);
                showOutOfLivesScreen();
            } else {
                // Single player - game over
                gameOver();
            }
        } else {
            // Respawn at random platform or start position
            const spawnPos = this.getRandomRespawnLocation();
            this.x = spawnPos.x;
            this.y = spawnPos.y;
            this.velocityX = 0;
            this.velocityY = 0;
            this.health = 2; // Respawn as big Mario

            // Apply death penalty (20% score reduction) in multiplayer
            if (multiplayerState.connected) {
                multiplayer.respawnPlayer();
            }

            this.invulnerable = true;
            // Immediately sync invulnerability state
            if (multiplayerState.connected) {
                multiplayer.syncPlayerPosition(this.x, this.y, this.direction, this.health, this.invulnerable, this.outOfLives);
            }

            setTimeout(() => {
                this.invulnerable = false;
                // Immediately sync when invulnerability ends
                if (multiplayerState.connected) {
                    multiplayer.syncPlayerPosition(this.x, this.y, this.direction, this.health, this.invulnerable, this.outOfLives);
                }
            }, 2000);
        }
    }

    // Check collision with remote players for PvP
    checkRemotePlayerCollisions() {
        if (!multiplayerState.connected) return;

        const now = Date.now();
        const afkThreshold = 10000; // 10 seconds - matches cleanup threshold

        multiplayerState.remotePlayers.forEach((remotePlayer, playerId) => {
            // Skip collision if remote player is dead or invulnerable
            if (remotePlayer.outOfLives || remotePlayer.invulnerable) return;

            // Skip collision if we are dead
            if (this.outOfLives) return;

            // Skip collision with AFK players (no timestamp updates for 10+ seconds)
            // This prevents farming abandoned players for points
            const timeSinceUpdate = now - (remotePlayer.timestamp || 0);
            if (timeSinceUpdate > afkThreshold) {
                // Player is AFK - skip collision (they'll be cleaned up soon)
                return;
            }

            const collision = this.x < remotePlayer.x + CONFIG.PLAYER_SIZE &&
                            this.x + this.width > remotePlayer.x &&
                            this.y < remotePlayer.y + CONFIG.PLAYER_SIZE &&
                            this.y + this.height > remotePlayer.y;

            if (collision) {
                // Check if remote player is stomping us from above
                // They must be above our center, and we must not be jumping upward into them
                if (remotePlayer.y < this.y + this.height / 2 && this.velocityY >= 0) {
                    // They stomped us!
                    // NOTE: Damage now handled by consensus system via listenForHits()
                    // The hit claim was already sent by the attacker and will be validated here
                    return; // Exit early to avoid other collision checks
                }
            }

            // Skip remaining collision checks if we are invulnerable - let us fall through others
            if (this.invulnerable) return;

            if (collision) {
                // Check if we're jumping on them (stomp) - ONLY way to deal damage
                // Invulnerable players cannot hurt others (extra safety check)
                if (this.velocityY > 0 && this.y < remotePlayer.y + CONFIG.PLAYER_SIZE / 2 && !this.invulnerable) {
                    // We stomped them! Send hit claim to victim for consensus validation
                    this.velocityY = -8; // Bounce (immediate feedback)

                    // Send hit claim to victim with position data for consensus
                    multiplayer.sendHitClaim(
                        playerId, // victim ID
                        this.x,   // our position (attacker)
                        this.y,
                        remotePlayer.x, // their position (victim)
                        remotePlayer.y
                    );

                    // Increment combo
                    this.combo = Math.min(this.combo + 1, this.maxCombo);

                    // Apply multiplier to score (optimistic - awarded immediately)
                    const baseScore = 200;
                    const multiplier = this.combo;
                    const scoreGained = baseScore * multiplier;
                    gameState.score += scoreGained;
                    document.getElementById('score').textContent = gameState.score;

                    // Show floating text with combo
                    const comboX = remotePlayer.x + CONFIG.PLAYER_SIZE / 2;
                    const comboY = remotePlayer.y;

                    if (multiplier > 1) {
                        const color = this.getComboColor(multiplier);
                        createFloatingText(comboX, comboY, `${multiplier}x COMBO!`, color, 24);
                    }
                    createFloatingText(comboX, comboY + 30, `+${scoreGained}`, '#FFD700', 20);

                    sounds.stomp();
                    haptics.success();
                    multiplayer.updateLeaderboard();
                } else {
                    // Solid collision - no damage, just block each other

                    // Calculate overlap on each axis
                    const overlapX = Math.min(
                        this.x + this.width - remotePlayer.x,
                        remotePlayer.x + CONFIG.PLAYER_SIZE - this.x
                    );
                    const overlapY = Math.min(
                        this.y + this.height - remotePlayer.y,
                        remotePlayer.y + CONFIG.PLAYER_SIZE - this.y
                    );

                    // Resolve collision on the axis with smallest overlap
                    if (overlapX < overlapY) {
                        // Horizontal collision - push apart horizontally
                        if (this.x < remotePlayer.x) {
                            // We're on the left, push left
                            this.x -= overlapX;
                        } else {
                            // We're on the right, push right
                            this.x += overlapX;
                        }
                        // Stop horizontal momentum when colliding
                        this.velocityX *= 0.5;
                    } else {
                        // Vertical collision
                        if (this.velocityY > 0 && this.y < remotePlayer.y) {
                            // We're falling onto them from above - land on top
                            this.y = remotePlayer.y - this.height;
                            this.velocityY = 0;
                            this.onGround = true;
                        } else if (this.velocityY < 0 && this.y > remotePlayer.y) {
                            // We're jumping up into them from below - bonk head
                            this.y = remotePlayer.y + CONFIG.PLAYER_SIZE;
                            this.velocityY = 0;
                        }
                    }
                }
            }
        });
    }

    getComboColor(combo) {
        // Color progression for combos
        if (combo >= 8) return '#FF00FF'; // Magenta for 8-10x
        if (combo >= 6) return '#FF0000'; // Red for 6-7x
        if (combo >= 4) return '#FF6600'; // Orange for 4-5x
        if (combo >= 2) return '#FFFF00'; // Yellow for 2-3x
        return '#FFFFFF'; // White for 1x
    }
}

// Function to draw grave marker at death position
function drawGraveMarker(x, y) {
    const screenX = x - gameState.camera.x;
    const screenY = y - gameState.camera.y;

    ctx.save();

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(screenX + 20, screenY + 45, 15, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Grave base (stone)
    ctx.fillStyle = '#666';
    ctx.fillRect(screenX + 5, screenY + 20, 30, 25);

    // Grave top (rounded)
    ctx.beginPath();
    ctx.arc(screenX + 20, screenY + 20, 15, Math.PI, 0, true);
    ctx.fill();

    // Cross on gravestone
    ctx.fillStyle = '#888';
    // Vertical bar
    ctx.fillRect(screenX + 17, screenY + 25, 6, 12);
    // Horizontal bar
    ctx.fillRect(screenX + 13, screenY + 29, 14, 6);

    // R.I.P. text
    ctx.fillStyle = '#999';
    ctx.font = 'bold 8px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('R.I.P.', screenX + 20, screenY + 15);

    ctx.restore();
}

// Function to draw remote players
function drawRemotePlayer(playerData) {
    const x = playerData.x;
    const y = playerData.y;
    const direction = playerData.direction;
    const name = playerData.name;
    const colorPalette = playerData.color;
    const width = CONFIG.PLAYER_SIZE;
    const height = CONFIG.PLAYER_SIZE;

    // If player is dead (out of lives), draw gravestone instead
    if (playerData.outOfLives) {
        drawGraveMarker(x, y);
        return;
    }

    const screenX = x - gameState.camera.x;
    const screenY = y - gameState.camera.y;

    // Check if player is AFK (no updates for 10+ seconds)
    const now = Date.now();
    const timeSinceUpdate = now - (playerData.timestamp || 0);
    const afkThreshold = 10000; // 10 seconds
    const isAFK = timeSinceUpdate > afkThreshold;

    ctx.save();

    // Make AFK players semi-transparent (ghosted)
    if (isAFK) {
        ctx.globalAlpha = 0.3;
    }

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.beginPath();
    ctx.ellipse(screenX + width / 2, screenY + height + 5, width / 2.5, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body (shirt)
    ctx.fillStyle = colorPalette.shirt;
    ctx.beginPath();
    ctx.roundRect(screenX + 5, screenY + 20, width - 10, height - 30, 5);
    ctx.fill();

    // Overalls
    ctx.fillStyle = colorPalette.overalls;
    ctx.fillRect(screenX + 8, screenY + 25, width - 16, height - 35);

    // Head
    ctx.fillStyle = colorPalette.skin;
    ctx.beginPath();
    ctx.arc(screenX + width / 2, screenY + 12, 12, 0, Math.PI * 2);
    ctx.fill();

    // Hat
    ctx.fillStyle = colorPalette.shirt;
    ctx.beginPath();
    ctx.ellipse(screenX + width / 2, screenY + 8, 14, 8, 0, Math.PI, 2 * Math.PI);
    ctx.fill();
    ctx.fillRect(screenX + width / 2 - 8, screenY + 4, 16, 6);

    // Hat logo
    ctx.fillStyle = 'white';
    ctx.font = 'bold 8px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('M', screenX + width / 2, screenY + 9);

    // Eyes
    ctx.fillStyle = 'black';
    const eyeOffset = direction > 0 ? 2 : -2;
    ctx.fillRect(screenX + width / 2 - 3 + eyeOffset, screenY + 13, 2, 2);
    ctx.fillRect(screenX + width / 2 + 3 + eyeOffset, screenY + 13, 2, 2);

    // Mustache
    ctx.fillStyle = '#5C3C1C';
    ctx.fillRect(screenX + width / 2 - 6, screenY + 17, 12, 3);

    // Buttons
    ctx.fillStyle = '#FFD700';
    ctx.beginPath();
    ctx.arc(screenX + width / 2, screenY + 30, 2, 0, Math.PI * 2);
    ctx.fill();

    // Shoes
    ctx.fillStyle = '#5C3C1C';
    ctx.fillRect(screenX + 5, screenY + height - 8, 12, 8);
    ctx.fillRect(screenX + width - 17, screenY + height - 8, 12, 8);

    // Player name label above character
    ctx.globalAlpha = 1.0; // Reset alpha for text (always visible)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(screenX + width / 2 - 30, screenY - 15, 60, 12);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(name, screenX + width / 2, screenY - 7);

    // AFK indicator
    if (isAFK) {
        ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
        ctx.fillRect(screenX + width / 2 - 15, screenY - 30, 30, 12);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 9px Arial';
        ctx.fillText('AFK', screenX + width / 2, screenY - 22);
    }

    ctx.restore();
}

// Enemy Class
class Enemy {
    constructor(x, y, id = null) {
        this.x = x;
        this.y = y;
        this.width = CONFIG.ENEMY_SIZE;
        this.height = CONFIG.ENEMY_SIZE;
        this.velocityX = -2;
        this.velocityY = 0;
        this.alive = true;
        this.onGround = false;
        this.id = id; // Unique Firebase ID
        this.lastSyncTime = 0;
    }

    update() {
        if (!this.alive) return;

        // Apply gravity
        this.velocityY += CONFIG.GRAVITY;
        if (this.velocityY > CONFIG.MAX_FALL_SPEED) {
            this.velocityY = CONFIG.MAX_FALL_SPEED;
        }

        // Horizontal movement
        this.x += this.velocityX;
        this.y += this.velocityY;

        // Reset onGround flag
        this.onGround = false;

        // World bounds - reverse direction at edges
        if (this.x < 0) {
            this.x = 0;
            this.velocityX *= -1;
        }
        if (this.x + this.width > CONFIG.WORLD_WIDTH) {
            this.x = CONFIG.WORLD_WIDTH - this.width;
            this.velocityX *= -1;
        }

        // Ground collision
        const groundY = CONFIG.WORLD_HEIGHT - 50;
        if (this.y + this.height >= groundY) {
            this.y = groundY - this.height;
            this.velocityY = 0;
            this.onGround = true;
        }

        // Platform collisions
        platforms.forEach(platform => {
            if (this.checkCollision(platform)) {
                // Landing on platform from above
                if (this.velocityY > 0 && this.y + this.height - this.velocityY <= platform.y) {
                    this.y = platform.y - this.height;
                    this.velocityY = 0;
                    this.onGround = true;
                }
                // Hitting platform from side - reverse direction
                else if (Math.abs(this.velocityY) < 2) {
                    this.velocityX *= -1;
                }
            }
        });

        // Portal (pipe) collisions - solid obstacles for enemies too
        portals.forEach(portal => {
            if (portal.checkCollision(this)) {
                // Calculate overlaps to determine collision direction
                const overlapLeft = (this.x + this.width) - portal.x;
                const overlapRight = (portal.x + portal.width) - this.x;
                const overlapTop = (this.y + this.height) - portal.y;
                const overlapBottom = (portal.y + portal.height) - this.y;

                // Find smallest overlap to determine collision side
                const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

                // Resolve collision on the side with smallest overlap
                if (minOverlap === overlapTop && this.velocityY > 0 && this.y + this.height - this.velocityY < portal.y) {
                    // Landing on top (only if was ABOVE portal before moving, not already on it)
                    this.y = portal.y - this.height;
                    this.velocityY = 0;
                    this.onGround = true;
                } else if (minOverlap === overlapBottom) {
                    // Hitting from below
                    this.y = portal.y + portal.height;
                    this.velocityY = 0;
                }
                // No side collisions - portals are spawn points, enemies walk through them
            }
        });

        // Reverse direction if at edge of platform
        if (this.onGround) {
            const checkX = this.velocityX > 0 ? this.x + this.width + 5 : this.x - 5;
            const checkY = this.y + this.height + 10;
            let onPlatform = false;

            // Check if there's ground ahead
            if (checkY >= groundY) {
                onPlatform = true;
            } else {
                platforms.forEach(platform => {
                    if (checkX >= platform.x && checkX <= platform.x + platform.width &&
                        checkY >= platform.y && checkY <= platform.y + platform.height) {
                        onPlatform = true;
                    }
                });
            }

            if (!onPlatform) {
                this.velocityX *= -1;
            }
        }

        // Check collision with player (skip if player is out of lives)
        if (this.alive && !player.outOfLives && player.checkCollision(this)) {
            // Check if player is stomping enemy (coming from above)
            if (player.velocityY > 0 && player.y < this.y + this.height / 2) {
                // Player jumped on enemy
                this.alive = false;
                player.velocityY = -8;

                // Increment combo
                player.combo = Math.min(player.combo + 1, player.maxCombo);

                // Apply multiplier to score
                const baseScore = 100;
                const multiplier = player.combo;
                const scoreGained = baseScore * multiplier;
                gameState.score += scoreGained;
                document.getElementById('score').textContent = gameState.score;

                // Show floating text with combo
                const comboX = this.x + this.width / 2;
                const comboY = this.y;

                if (multiplier > 1) {
                    const color = player.getComboColor(multiplier);
                    createFloatingText(comboX, comboY, `${multiplier}x COMBO!`, color, 24);
                }
                createFloatingText(comboX, comboY + 30, `+${scoreGained}`, '#FFD700', 20);

                sounds.stomp();
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 12, '#8B4513');
                screenShake(3, 10);
                haptics.heavy();  // Heavy haptic for stomping enemy

                // Update leaderboard and remove enemy from Firebase if in multiplayer
                if (multiplayerState.connected) {
                    multiplayer.updateLeaderboard();
                    if (this.id) {
                        multiplayer.removeEnemy(this.id);
                    }
                }
            } else if (this.velocityY < 0 && this.y > player.y + player.height / 2) {
                // Enemy hit player's feet from below while moving upward - kill enemy
                this.alive = false;

                // Increment combo
                player.combo = Math.min(player.combo + 1, player.maxCombo);

                // Apply multiplier to score
                const baseScore = 100;
                const multiplier = player.combo;
                const scoreGained = baseScore * multiplier;
                gameState.score += scoreGained;
                document.getElementById('score').textContent = gameState.score;

                // Show floating text with combo
                const comboX = this.x + this.width / 2;
                const comboY = this.y;

                if (multiplier > 1) {
                    const color = player.getComboColor(multiplier);
                    createFloatingText(comboX, comboY, `${multiplier}x COMBO!`, color, 24);
                }
                createFloatingText(comboX, comboY + 30, `+${scoreGained}`, '#FFD700', 20);

                sounds.stomp();
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 12, '#8B4513');
                screenShake(2, 8);
                haptics.medium();

                // Update leaderboard and remove enemy from Firebase if in multiplayer
                if (multiplayerState.connected) {
                    multiplayer.updateLeaderboard();
                    if (this.id) {
                        multiplayer.removeEnemy(this.id);
                    }
                }
            } else {
                // Enemy hit player from side - hurt player
                player.hit();
            }
        }

        // Sync enemy position to Firebase (throttled)
        if (this.alive && multiplayerState.connected && this.id) {
            multiplayer.syncEnemyState(this);
        }
    }

    checkCollision(obj) {
        return this.x < obj.x + obj.width &&
               this.x + this.width > obj.x &&
               this.y < obj.y + obj.height &&
               this.y + this.height > obj.y;
    }

    draw() {
        if (!this.alive) return;

        ctx.save();

        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        // Shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.beginPath();
        ctx.ellipse(screenX + this.width / 2, screenY + this.height + 3, this.width / 2.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Body (brown mushroom)
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2, screenY + this.height / 3, this.width / 2.2, 0, Math.PI, true);
        ctx.fill();

        ctx.fillStyle = '#D2691E';
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2, screenY + this.height / 3, this.width / 2.2, 0, Math.PI);
        ctx.fill();

        // Spots
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2 - 8, screenY + 8, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2 + 8, screenY + 8, 4, 0, Math.PI * 2);
        ctx.fill();

        // Stem
        ctx.fillStyle = '#FFE4B5';
        ctx.fillRect(screenX + this.width / 2 - 6, screenY + this.height / 3, 12, this.height / 1.5);

        // Eyes (angry)
        ctx.fillStyle = 'black';
        ctx.fillRect(screenX + this.width / 2 - 8, screenY + this.height / 2, 4, 4);
        ctx.fillRect(screenX + this.width / 2 + 4, screenY + this.height / 2, 4, 4);

        // Eyebrows (angry)
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(screenX + this.width / 2 - 10, screenY + this.height / 2 - 2);
        ctx.lineTo(screenX + this.width / 2 - 4, screenY + this.height / 2 - 1);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(screenX + this.width / 2 + 4, screenY + this.height / 2 - 1);
        ctx.lineTo(screenX + this.width / 2 + 10, screenY + this.height / 2 - 2);
        ctx.stroke();

        // Feet
        ctx.fillStyle = '#8B4513';
        ctx.fillRect(screenX + this.width / 2 - 10, screenY + this.height - 6, 7, 6);
        ctx.fillRect(screenX + this.width / 2 + 3, screenY + this.height - 6, 7, 6);

        ctx.restore();
    }
}

// Jumping Enemy Class
class JumpingEnemy extends Enemy {
    constructor(x, y, id = null) {
        super(x, y, id);
        this.jumpCooldown = 0;
        this.jumpInterval = 60 + Math.random() * 60; // Jump every 60-120 frames
        this.color = '#FF6B6B'; // Red color to distinguish from regular enemies
    }

    update() {
        if (!this.alive) {
            // Respawn only in single player (in multiplayer, portals handle spawning)
            if (!multiplayerState.connected && this.respawnTime && Date.now() >= this.respawnTime) {
                this.alive = true;
                this.respawnTime = null;
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 15, this.color);
            }
            return;
        }

        // Apply gravity
        this.velocityY += CONFIG.GRAVITY;
        if (this.velocityY > CONFIG.MAX_FALL_SPEED) {
            this.velocityY = CONFIG.MAX_FALL_SPEED;
        }

        // Horizontal movement
        this.x += this.velocityX;
        this.y += this.velocityY;

        // Reset onGround flag
        this.onGround = false;

        // World bounds
        if (this.x < 0) {
            this.x = 0;
            this.velocityX *= -1;
        }
        if (this.x + this.width > CONFIG.WORLD_WIDTH) {
            this.x = CONFIG.WORLD_WIDTH - this.width;
            this.velocityX *= -1;
        }

        // Ground collision
        const groundY = CONFIG.WORLD_HEIGHT - 50;
        if (this.y + this.height >= groundY) {
            this.y = groundY - this.height;
            this.velocityY = 0;
            this.onGround = true;
        }

        // Platform collisions
        platforms.forEach(platform => {
            if (this.checkCollision(platform)) {
                if (this.velocityY > 0 && this.y + this.height - this.velocityY <= platform.y) {
                    this.y = platform.y - this.height;
                    this.velocityY = 0;
                    this.onGround = true;
                } else if (Math.abs(this.velocityY) < 2) {
                    this.velocityX *= -1;
                }
            }
        });

        // Portal (pipe) collisions - solid obstacles for enemies too
        portals.forEach(portal => {
            if (portal.checkCollision(this)) {
                // Calculate overlaps to determine collision direction
                const overlapLeft = (this.x + this.width) - portal.x;
                const overlapRight = (portal.x + portal.width) - this.x;
                const overlapTop = (this.y + this.height) - portal.y;
                const overlapBottom = (portal.y + portal.height) - this.y;

                // Find smallest overlap to determine collision side
                const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

                // Resolve collision on the side with smallest overlap
                if (minOverlap === overlapTop && this.velocityY > 0 && this.y + this.height - this.velocityY < portal.y) {
                    // Landing on top (only if was ABOVE portal before moving, not already on it)
                    this.y = portal.y - this.height;
                    this.velocityY = 0;
                    this.onGround = true;
                } else if (minOverlap === overlapBottom) {
                    // Hitting from below
                    this.y = portal.y + portal.height;
                    this.velocityY = 0;
                }
                // No side collisions - portals are spawn points, enemies walk through them
            }
        });

        // Jumping behavior
        if (this.onGround) {
            this.jumpCooldown--;
            if (this.jumpCooldown <= 0) {
                // Jump! (reduced height so players can't farm points by standing on platforms)
                this.velocityY = -7;
                this.jumpCooldown = this.jumpInterval;
                createParticles(this.x + this.width / 2, this.y + this.height, 5, this.color);
            }
        }

        // Check collision with player (skip if player is out of lives)
        if (this.alive && !player.outOfLives && player.checkCollision(this)) {
            if (player.velocityY > 0 && player.y < this.y + this.height / 2) {
                // Player stomped enemy
                this.alive = false;
                this.respawnTime = Date.now() + 5000; // Respawn in 5 seconds
                player.velocityY = -9; // Slightly higher bounce for jumping enemy

                // Increment combo
                player.combo = Math.min(player.combo + 1, player.maxCombo);

                // Apply multiplier to score (jumping enemies worth more)
                const baseScore = 150;
                const multiplier = player.combo;
                const scoreGained = baseScore * multiplier;
                gameState.score += scoreGained;
                document.getElementById('score').textContent = gameState.score;

                // Show floating text with combo
                const comboX = this.x + this.width / 2;
                const comboY = this.y;

                if (multiplier > 1) {
                    const color = player.getComboColor(multiplier);
                    createFloatingText(comboX, comboY, `${multiplier}x COMBO!`, color, 24);
                }
                createFloatingText(comboX, comboY + 30, `+${scoreGained}`, '#FFD700', 20);

                sounds.stomp();
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 15, this.color);
                screenShake(4, 12);
                haptics.heavy();

                // Sync to Firebase if connected - remove enemy
                if (multiplayerState.connected) {
                    multiplayer.updateLeaderboard();
                    if (this.id) {
                        multiplayer.removeEnemy(this.id);
                    }
                }
            } else if (this.velocityY < 0 && this.y > player.y + player.height / 2) {
                // Enemy hit player's feet from below while moving upward - kill enemy
                this.alive = false;
                this.respawnTime = Date.now() + 5000; // Respawn in 5 seconds

                // Increment combo
                player.combo = Math.min(player.combo + 1, player.maxCombo);

                // Apply multiplier to score (jumping enemies worth more)
                const baseScore = 150;
                const multiplier = player.combo;
                const scoreGained = baseScore * multiplier;
                gameState.score += scoreGained;
                document.getElementById('score').textContent = gameState.score;

                // Show floating text with combo
                const comboX = this.x + this.width / 2;
                const comboY = this.y;

                if (multiplier > 1) {
                    const color = player.getComboColor(multiplier);
                    createFloatingText(comboX, comboY, `${multiplier}x COMBO!`, color, 24);
                }
                createFloatingText(comboX, comboY + 30, `+${scoreGained}`, '#FFD700', 20);

                sounds.stomp();
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 15, this.color);
                screenShake(3, 10);
                haptics.medium();

                // Sync to Firebase if connected - remove enemy
                if (multiplayerState.connected) {
                    multiplayer.updateLeaderboard();
                    if (this.id) {
                        multiplayer.removeEnemy(this.id);
                    }
                }
            } else {
                player.hit();
            }
        }

        // Sync enemy position to Firebase (throttled)
        if (this.alive && multiplayerState.connected && this.id) {
            multiplayer.syncEnemyState(this);
        }
    }

    draw() {
        if (!this.alive) return;

        ctx.save();

        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        // Shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.beginPath();
        ctx.ellipse(screenX + this.width / 2, screenY + this.height + 3, this.width / 2.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Body (red mushroom with legs)
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2, screenY + this.height / 3, this.width / 2.2, 0, Math.PI, true);
        ctx.fill();

        ctx.fillStyle = '#FF8888';
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2, screenY + this.height / 3, this.width / 2.2, 0, Math.PI);
        ctx.fill();

        // Spots
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2 - 8, screenY + 8, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2 + 8, screenY + 8, 4, 0, Math.PI * 2);
        ctx.fill();

        // Stem (shorter for jumping enemy)
        ctx.fillStyle = '#FFE4B5';
        ctx.fillRect(screenX + this.width / 2 - 5, screenY + this.height / 3, 10, this.height / 2.5);

        // Eyes (wider)
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2 - 7, screenY + this.height / 2, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(screenX + this.width / 2 + 7, screenY + this.height / 2, 3, 0, Math.PI * 2);
        ctx.fill();

        // Spring legs (to show it jumps)
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(screenX + this.width / 2 - 8, screenY + this.height - 8);
        ctx.lineTo(screenX + this.width / 2 - 10, screenY + this.height - 4);
        ctx.lineTo(screenX + this.width / 2 - 8, screenY + this.height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(screenX + this.width / 2 + 8, screenY + this.height - 8);
        ctx.lineTo(screenX + this.width / 2 + 10, screenY + this.height - 4);
        ctx.lineTo(screenX + this.width / 2 + 8, screenY + this.height);
        ctx.stroke();

        ctx.restore();
    }
}

// Turtle Enemy Class (slow enemy with shell mechanics)
class TurtleEnemy extends Enemy {
    constructor(x, y, id = null) {
        super(x, y, id);
        this.velocityX = -1; // Extra slow movement
        this.color = '#228B22'; // Green turtle
        this.shellColor = '#006400'; // Dark green shell
        this.inShell = false; // Shell state
        this.shellTimer = 0; // Time before popping out of shell
        this.shellMaxTime = 180; // 3 seconds in shell before popping out
        this.animationFrame = 0; // For leg/arm animation
        this.kickVelocity = 8; // Speed when shell is kicked
        this.isShellSliding = false; // Is the shell sliding?
        this.shellSlideTimer = 0; // How long shell has been sliding
        this.shellMaxSlideTime = 300; // 5 seconds max slide time (at 60fps)
    }

    update() {
        if (!this.alive) {
            // Respawn only in single player (in multiplayer, portals handle spawning)
            if (!multiplayerState.connected && this.respawnTime && Date.now() >= this.respawnTime) {
                this.alive = true;
                this.inShell = false;
                this.isShellSliding = false;
                this.shellTimer = 0;
                this.shellSlideTimer = 0;
                this.velocityX = -1;
                this.respawnTime = null;
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 15, this.color);
            }
            return;
        }

        // Animation frame for leg movement
        if (!this.inShell) {
            this.animationFrame++;
        }

        // Track if we handled player collision this frame (to avoid double-processing)
        let playerCollisionHandled = false;

        // Shell behavior
        if (this.inShell) {
            this.shellTimer++;

            // Pop out of shell after timer
            if (this.shellTimer >= this.shellMaxTime && !this.isShellSliding) {
                this.inShell = false;
                this.shellTimer = 0;
                this.isShellSliding = false;
                this.shellSlideTimer = 0;
                this.velocityX = -1; // Reset to slow walking speed
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 8, this.color);
            }

            // Shell sliding - can damage player
            if (this.isShellSliding) {
                // Increment slide timer
                this.shellSlideTimer++;

                // Stop shell after max slide time
                if (this.shellSlideTimer >= this.shellMaxSlideTime) {
                    this.isShellSliding = false;
                    this.velocityX = 0;
                    this.shellSlideTimer = 0;
                    createParticles(this.x + this.width / 2, this.y + this.height / 2, 8, this.shellColor);
                    sounds.stomp();
                }

                // Check collision with player while sliding
                if (player.checkCollision(this) && !player.outOfLives) {
                    playerCollisionHandled = true; // Mark collision as handled
                    // Player can stomp the sliding shell to stop it
                    if (player.velocityY > 0 && player.y < this.y + this.height / 2) {
                        // Stop the shell
                        this.isShellSliding = false;
                        this.velocityX = 0;
                        this.shellSlideTimer = 0;
                        player.velocityY = -9;
                        sounds.stomp();
                        createParticles(this.x + this.width / 2, this.y + this.height / 2, 8, this.shellColor);
                        screenShake(3, 10);
                        haptics.medium();
                    } else {
                        // Shell hits player - deal damage
                        player.hit();
                    }
                }

                // Check collision with other enemies
                enemies.forEach(enemy => {
                    if (enemy !== this && enemy.alive && this.checkCollision(enemy)) {
                        // Shell kills other enemies
                        enemy.alive = false;
                        enemy.respawnTime = Date.now() + 5000;

                        // Award points
                        const baseScore = 100;
                        gameState.score += baseScore;
                        document.getElementById('score').textContent = gameState.score;
                        createFloatingText(enemy.x + enemy.width / 2, enemy.y, `+${baseScore}`, '#FFD700', 20);

                        sounds.stomp();
                        createParticles(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, 12, '#8B4513');
                        screenShake(2, 8);

                        // Sync to Firebase if connected
                        if (multiplayerState.connected && enemy.id) {
                            multiplayer.removeEnemy(enemy.id);
                        }
                    }
                });
            }
        }

        // Apply gravity
        this.velocityY += CONFIG.GRAVITY;
        if (this.velocityY > CONFIG.MAX_FALL_SPEED) {
            this.velocityY = CONFIG.MAX_FALL_SPEED;
        }

        // Horizontal movement
        this.x += this.velocityX;
        this.y += this.velocityY;

        // Reset onGround flag
        this.onGround = false;

        // World bounds
        if (this.x < 0) {
            this.x = 0;
            if (this.inShell) {
                this.velocityX *= -1;
            } else {
                this.velocityX = 1; // Walk right at slow speed
            }
        }
        if (this.x + this.width > CONFIG.WORLD_WIDTH) {
            this.x = CONFIG.WORLD_WIDTH - this.width;
            if (this.inShell) {
                this.velocityX *= -1;
            } else {
                this.velocityX = -1; // Walk left at slow speed
            }
        }

        // Ground collision
        const groundY = CONFIG.WORLD_HEIGHT - 50;
        if (this.y + this.height >= groundY) {
            this.y = groundY - this.height;
            this.velocityY = 0;
            this.onGround = true;
        }

        // Platform collisions
        platforms.forEach(platform => {
            if (this.checkCollision(platform)) {
                if (this.velocityY > 0 && this.y + this.height - this.velocityY <= platform.y) {
                    this.y = platform.y - this.height;
                    this.velocityY = 0;
                    this.onGround = true;
                } else if (Math.abs(this.velocityY) < 2) {
                    this.velocityX *= -1;
                }
            }
        });

        // Portal (pipe) collisions
        portals.forEach(portal => {
            if (portal.checkCollision(this)) {
                // Calculate overlaps to determine collision direction
                const overlapLeft = (this.x + this.width) - portal.x;
                const overlapRight = (portal.x + portal.width) - this.x;
                const overlapTop = (this.y + this.height) - portal.y;
                const overlapBottom = (portal.y + portal.height) - this.y;

                // Find smallest overlap to determine collision side
                const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

                // Resolve collision on the side with smallest overlap
                if (minOverlap === overlapTop && this.velocityY > 0 && this.y + this.height - this.velocityY < portal.y) {
                    // Landing on top (only if was ABOVE portal before moving, not already on it)
                    this.y = portal.y - this.height;
                    this.velocityY = 0;
                    this.onGround = true;
                } else if (minOverlap === overlapBottom) {
                    // Hitting from below
                    this.y = portal.y + portal.height;
                    this.velocityY = 0;
                }
                // No side collisions - portals are spawn points, enemies walk through them
            }
        });

        // Check collision with player (skip if player is out of lives or already handled)
        if (this.alive && !player.outOfLives && !playerCollisionHandled && player.checkCollision(this)) {
            if (player.velocityY > 0 && player.y < this.y + this.height / 2) {
                // Player stomped turtle
                if (!this.inShell) {
                    // First stomp - turtle goes into shell
                    this.inShell = true;
                    this.shellTimer = 0;
                    this.shellSlideTimer = 0;
                    this.velocityX = 0;
                    this.isShellSliding = false;
                    player.velocityY = -9;

                    sounds.stomp();
                    createParticles(this.x + this.width / 2, this.y + this.height / 2, 10, this.shellColor);
                    screenShake(3, 10);
                    haptics.medium();
                } else if (!this.isShellSliding) {
                    // Kick the shell!
                    this.isShellSliding = true;
                    this.shellSlideTimer = 0;
                    // Kick in direction player is facing
                    if (player.x < this.x) {
                        this.velocityX = this.kickVelocity;
                    } else {
                        this.velocityX = -this.kickVelocity;
                    }
                    player.velocityY = -9;

                    sounds.stomp();
                    createParticles(this.x + this.width / 2, this.y + this.height / 2, 10, this.shellColor);
                    screenShake(4, 12);
                    haptics.heavy();
                }
            } else if (!this.inShell) {
                // Turtle hits player while walking
                player.hit();
            } else if (this.inShell && !this.isShellSliding) {
                // Player touches stationary shell - kick it!
                this.isShellSliding = true;
                this.shellSlideTimer = 0;
                // Kick away from player
                if (player.x < this.x) {
                    this.velocityX = this.kickVelocity;
                } else {
                    this.velocityX = -this.kickVelocity;
                }

                sounds.stomp();
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 10, this.shellColor);
                screenShake(3, 10);
                haptics.medium();
            }
        }

        // Safety checks for velocity
        if (!this.inShell && Math.abs(this.velocityX) > 1) {
            // If somehow the turtle is out of shell but has high velocity, fix it
            this.velocityX = this.velocityX > 0 ? 1 : -1;
        } else if (this.inShell && !this.isShellSliding && this.velocityX !== 0) {
            // If in shell but not sliding, velocity should be 0 (stationary)
            this.velocityX = 0;
        }

        // Sync enemy position to Firebase (throttled)
        if (this.alive && multiplayerState.connected && this.id) {
            multiplayer.syncEnemyState(this);
        }
    }

    draw() {
        if (!this.alive) return;

        ctx.save();

        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        // Shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.beginPath();
        ctx.ellipse(screenX + this.width / 2, screenY + this.height + 3, this.width / 2.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        if (this.inShell) {
            // Draw shell only
            const shellHeight = this.height * 0.6;
            const shellY = screenY + this.height - shellHeight;

            // Shell body
            ctx.fillStyle = this.shellColor;
            ctx.beginPath();
            ctx.ellipse(screenX + this.width / 2, shellY + shellHeight / 2, this.width / 2.2, shellHeight / 2, 0, 0, Math.PI * 2);
            ctx.fill();

            // Shell pattern
            ctx.fillStyle = this.color;
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2;
                const px = screenX + this.width / 2 + Math.cos(angle) * 8;
                const py = shellY + shellHeight / 2 + Math.sin(angle) * 6;
                ctx.beginPath();
                ctx.arc(px, py, 3, 0, Math.PI * 2);
                ctx.fill();
            }

            // Shell highlight
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2 - 5, shellY + shellHeight / 3, 6, 0, Math.PI * 2);
            ctx.fill();

            // If sliding, add motion lines
            if (this.isShellSliding) {
                ctx.strokeStyle = 'rgba(100, 100, 100, 0.4)';
                ctx.lineWidth = 2;
                for (let i = 0; i < 3; i++) {
                    const offsetX = (this.velocityX > 0 ? -10 : 10) * (i + 1);
                    ctx.beginPath();
                    ctx.moveTo(screenX + this.width / 2 + offsetX, shellY + shellHeight / 2 - 5);
                    ctx.lineTo(screenX + this.width / 2 + offsetX, shellY + shellHeight / 2 + 5);
                    ctx.stroke();
                }
            }
        } else {
            // Draw full turtle with animated legs and arms

            // Calculate leg/arm positions based on animation frame
            const legSwing = Math.sin(this.animationFrame * 0.2) * 5;
            const armSwing = Math.cos(this.animationFrame * 0.2) * 4;

            // Shell on back
            ctx.fillStyle = this.shellColor;
            ctx.beginPath();
            ctx.ellipse(screenX + this.width / 2, screenY + this.height / 3, this.width / 2.5, this.height / 3, 0, 0, Math.PI * 2);
            ctx.fill();

            // Shell pattern
            ctx.fillStyle = this.color;
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2;
                const px = screenX + this.width / 2 + Math.cos(angle) * 8;
                const py = screenY + this.height / 3 + Math.sin(angle) * 6;
                ctx.beginPath();
                ctx.arc(px, py, 3, 0, Math.PI * 2);
                ctx.fill();
            }

            // Body/head
            ctx.fillStyle = '#90EE90'; // Light green body
            ctx.beginPath();
            ctx.ellipse(screenX + this.width / 2, screenY + this.height * 0.65, this.width / 3.5, this.height / 4, 0, 0, Math.PI * 2);
            ctx.fill();

            // Head
            ctx.fillStyle = '#90EE90';
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2, screenY + this.height * 0.55, this.width / 4.5, 0, Math.PI * 2);
            ctx.fill();

            // Eyes
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2 - 5, screenY + this.height * 0.52, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2 + 5, screenY + this.height * 0.52, 4, 0, Math.PI * 2);
            ctx.fill();

            // Pupils
            ctx.fillStyle = 'black';
            const pupilOffset = this.velocityX > 0 ? 1 : -1;
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2 - 5 + pupilOffset, screenY + this.height * 0.52, 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2 + 5 + pupilOffset, screenY + this.height * 0.52, 2, 0, Math.PI * 2);
            ctx.fill();

            // Mouth
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2, screenY + this.height * 0.57, 3, 0, Math.PI);
            ctx.stroke();

            // Animated legs
            ctx.fillStyle = '#90EE90';
            ctx.strokeStyle = '#228B22';
            ctx.lineWidth = 2;

            // Back leg
            ctx.beginPath();
            ctx.moveTo(screenX + this.width / 2 - 8, screenY + this.height * 0.7);
            ctx.lineTo(screenX + this.width / 2 - 12, screenY + this.height * 0.85 - legSwing);
            ctx.lineTo(screenX + this.width / 2 - 10, screenY + this.height - 2);
            ctx.stroke();

            // Front leg
            ctx.beginPath();
            ctx.moveTo(screenX + this.width / 2 + 8, screenY + this.height * 0.7);
            ctx.lineTo(screenX + this.width / 2 + 12, screenY + this.height * 0.85 + legSwing);
            ctx.lineTo(screenX + this.width / 2 + 10, screenY + this.height - 2);
            ctx.stroke();

            // Animated arms
            // Back arm
            ctx.beginPath();
            ctx.moveTo(screenX + this.width / 2 - 6, screenY + this.height * 0.62);
            ctx.lineTo(screenX + this.width / 2 - 10, screenY + this.height * 0.7 + armSwing);
            ctx.stroke();

            // Front arm
            ctx.beginPath();
            ctx.moveTo(screenX + this.width / 2 + 6, screenY + this.height * 0.62);
            ctx.lineTo(screenX + this.width / 2 + 10, screenY + this.height * 0.7 - armSwing);
            ctx.stroke();

            // Feet (small circles at end of legs)
            ctx.fillStyle = '#228B22';
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2 - 10, screenY + this.height - 2, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2 + 10, screenY + this.height - 2, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }
}

// Enemy Portal Class (spawns enemies)
class Portal {
    constructor(x, y, enemyType = 'normal') {
        this.x = x;
        this.y = y;
        this.width = 40;
        this.height = 60;
        this.enemyType = enemyType; // 'normal', 'jumping', or 'turtle'
        this.spawnCooldown = 180 + Math.random() * 180; // 3-6 seconds startup delay
        this.animation = 0;
        this.spawning = false; // Spawning animation state
        this.spawnProgress = 0; // 0 to 1
    }

    update() {
        this.animation += 0.1;

        // Update spawn animation
        if (this.spawning) {
            this.spawnProgress += 0.05;
            if (this.spawnProgress >= 1) {
                // Spawn complete - create enemy via Firebase
                // Spawn well above the pipe opening to avoid collision
                const spawnX = this.x + this.width / 2 - CONFIG.ENEMY_SIZE / 2;
                const spawnY = this.y - CONFIG.ENEMY_SIZE - 20; // 20 pixels clearance to prevent sticking

                if (multiplayerState.connected) {
                    // Spawn via Firebase
                    multiplayer.spawnEnemy(spawnX, spawnY, this.enemyType);
                } else {
                    // Single player - spawn locally
                    if (this.enemyType === 'jumping') {
                        enemies.push(new JumpingEnemy(spawnX, spawnY));
                    } else if (this.enemyType === 'turtle') {
                        enemies.push(new TurtleEnemy(spawnX, spawnY));
                    } else {
                        enemies.push(new Enemy(spawnX, spawnY));
                    }
                }

                createParticles(this.x + this.width / 2, this.y, 15, '#9B59B6');
                sounds.powerUp();
                this.spawning = false;
                this.spawnProgress = 0;
                this.spawnCooldown = 420 + Math.random() * 300; // 7-12 seconds between spawns
            }
            return;
        }

        this.spawnCooldown--;

        // Check if ready to start spawning
        // In multiplayer, only the spawn master spawns enemies
        // In single player, always spawn
        const canSpawn = !multiplayerState.connected || multiplayerState.isSpawnMaster;

        if (this.spawnCooldown <= 0 && canSpawn) {
            // Count total enemies of this type globally
            const totalEnemies = enemies.filter(e => {
                if (this.enemyType === 'jumping') {
                    return e instanceof JumpingEnemy && e.alive;
                } else if (this.enemyType === 'turtle') {
                    return e instanceof TurtleEnemy && e.alive;
                } else {
                    return !(e instanceof JumpingEnemy) && !(e instanceof TurtleEnemy) && e.alive;
                }
            }).length;

            // Limit total enemies per type (max 5 of each type globally)
            const maxEnemies = 5;
            if (totalEnemies < maxEnemies) {
                // Safety check: don't spawn if any player is too close (200 pixels)
                const safetyDistance = 200;
                let playerTooClose = false;

                // Check local player
                const distToPlayer = Math.sqrt(
                    Math.pow(player.x - this.x, 2) +
                    Math.pow(player.y - this.y, 2)
                );
                if (distToPlayer < safetyDistance) {
                    playerTooClose = true;
                }

                // Check remote players
                if (!playerTooClose && multiplayerState.connected) {
                    multiplayerState.remotePlayers.forEach((remotePlayer) => {
                        const dist = Math.sqrt(
                            Math.pow(remotePlayer.x - this.x, 2) +
                            Math.pow(remotePlayer.y - this.y, 2)
                        );
                        if (dist < safetyDistance) {
                            playerTooClose = true;
                        }
                    });
                }

                if (!playerTooClose) {
                    this.spawning = true;
                    this.spawnProgress = 0;
                } else {
                    // Player too close, check again in 1 second
                    this.spawnCooldown = 60;
                }
            } else {
                // Check again in 2 seconds
                this.spawnCooldown = 120;
            }
        }
    }

    checkCollision(obj) {
        return this.x < obj.x + obj.width &&
               this.x + this.width > obj.x &&
               this.y < obj.y + obj.height &&
               this.y + this.height > obj.y;
    }

    draw() {
        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        ctx.save();

        // Pipe body (green)
        ctx.fillStyle = '#2ECC40';
        ctx.fillRect(screenX, screenY, this.width, this.height);

        // Pipe rim at top
        ctx.fillStyle = '#01FF70';
        ctx.fillRect(screenX - 5, screenY - 5, this.width + 10, 10);

        // Pipe rim at bottom
        ctx.fillStyle = '#239B2E';
        ctx.fillRect(screenX - 3, screenY + this.height - 3, this.width + 6, 3);

        // Highlights on sides
        ctx.fillStyle = '#3D9970';
        ctx.fillRect(screenX + 5, screenY + 8, 3, this.height - 10);
        ctx.fillRect(screenX + this.width - 8, screenY + 8, 3, this.height - 10);

        // Dark opening at top (ellipse)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.beginPath();
        ctx.ellipse(screenX + this.width / 2, screenY, this.width / 2.5, 8, 0, 0, Math.PI * 2);
        ctx.fill();

        // Portal glow (pulsing) inside opening
        const glowIntensity = Math.sin(this.animation) * 0.3 + 0.5;
        ctx.fillStyle = `rgba(155, 89, 182, ${glowIntensity * 0.6})`;
        ctx.beginPath();
        ctx.ellipse(screenX + this.width / 2, screenY, this.width / 3, 6, 0, 0, Math.PI * 2);
        ctx.fill();

        // Spawning animation - enemy rising from pipe
        if (this.spawning && this.spawnProgress > 0) {
            ctx.save();
            const spawnY = screenY - (CONFIG.ENEMY_SIZE * this.spawnProgress);
            const alpha = this.spawnProgress;
            ctx.globalAlpha = alpha;

            // Draw emerging enemy preview
            const enemyColor = this.enemyType === 'jumping' ? '#FF6B6B' : '#8B4513';
            ctx.fillStyle = enemyColor;
            ctx.beginPath();
            ctx.arc(screenX + this.width / 2, spawnY, CONFIG.ENEMY_SIZE / 2, 0, Math.PI * 2);
            ctx.fill();

            // Spawn particles
            if (Math.random() < 0.3) {
                createParticles(screenX + this.width / 2 + gameState.camera.x, spawnY + gameState.camera.y, 1, '#9B59B6');
            }

            ctx.restore();
        }

        // Type indicator
        if (this.enemyType === 'jumping') {
            ctx.fillStyle = '#FF6B6B';
            ctx.font = 'bold 16px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('!', screenX + this.width / 2, screenY + this.height / 2);
        }

        ctx.restore();
    }
}

// Coin Class
class Coin {
    constructor(x, y, index) {
        this.x = x;
        this.y = y;
        this.width = CONFIG.COIN_SIZE;
        this.height = CONFIG.COIN_SIZE;
        this.collected = false;
        this.rotation = 0;
        this.respawnTime = null;
        this.index = index; // For Firebase identification
    }

    update() {
        this.rotation += 0.05;

        // Check if coin should respawn
        if (this.collected && this.respawnTime && Date.now() >= this.respawnTime) {
            this.collected = false;
            this.respawnTime = null;
            // Clear from Firebase
            if (multiplayerState.connected && multiplayerState.coinsRef) {
                multiplayerState.coinsRef.child(`coin_${this.index}`).remove();
            }
        }

        // Coin collection with multiplayer sync
        if (!this.collected && player.checkCollision(this)) {
            // Try to collect via Firebase (prevents race conditions)
            if (multiplayerState.connected) {
                multiplayer.collectCoin(this.index).then(success => {
                    if (success) {
                        // Successfully collected
                        this.collected = true;
                        gameState.coins++;
                        gameState.score += 50;
                        document.getElementById('coins').textContent = gameState.coins;
                        document.getElementById('score').textContent = gameState.score;
                        sounds.coin();
                        createParticles(this.x + this.width / 2, this.y + this.height / 2, 8, '#FFD700');
                        haptics.success();
                        // Update leaderboard
                        multiplayer.updateLeaderboard();
                    }
                });
            } else {
                // Single player mode
                this.collected = true;
                gameState.coins++;
                gameState.score += 50;
                document.getElementById('coins').textContent = gameState.coins;
                document.getElementById('score').textContent = gameState.score;
                sounds.coin();
                createParticles(this.x + this.width / 2, this.y + this.height / 2, 8, '#FFD700');
                haptics.success();
            }
        }
    }

    draw() {
        if (this.collected) return;

        ctx.save();

        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        ctx.translate(screenX + this.width / 2, screenY + this.height / 2);
        ctx.rotate(this.rotation);

        // Glow effect
        const glowSize = this.width / 2 + 5 + Math.sin(Date.now() / 200) * 3;
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, glowSize);
        gradient.addColorStop(0, 'rgba(255, 215, 0, 0.4)');
        gradient.addColorStop(1, 'rgba(255, 215, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, 0, glowSize, 0, Math.PI * 2);
        ctx.fill();

        // Coin
        const scale = Math.abs(Math.cos(this.rotation * 2)) * 0.5 + 0.5;
        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.ellipse(0, 0, this.width / 2 * scale, this.height / 2, 0, 0, Math.PI * 2);
        ctx.fill();

        // Inner circle
        ctx.fillStyle = '#FFA500';
        ctx.beginPath();
        ctx.ellipse(0, 0, this.width / 3 * scale, this.height / 3, 0, 0, Math.PI * 2);
        ctx.fill();

        // Symbol
        ctx.fillStyle = '#FFD700';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', 0, 0);

        ctx.restore();
    }
}

// Platform Class
class Platform {
    constructor(x, y, width, height) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
    }

    draw() {
        const screenX = this.x - gameState.camera.x;
        const screenY = this.y - gameState.camera.y;

        ctx.save();

        // Clip drawing to platform bounds
        ctx.beginPath();
        ctx.rect(screenX, screenY, this.width, this.height);
        ctx.clip();

        // Brick texture
        ctx.fillStyle = '#D2691E';
        ctx.fillRect(screenX, screenY, this.width, this.height);

        // Brick pattern
        ctx.strokeStyle = '#8B4513';
        ctx.lineWidth = 2;

        const brickWidth = CONFIG.BLOCK_SIZE;
        const brickHeight = CONFIG.BLOCK_SIZE / 2;

        for (let by = 0; by < this.height; by += brickHeight) {
            const offset = (by / brickHeight) % 2 === 0 ? 0 : brickWidth / 2;
            for (let bx = 0; bx < this.width; bx += brickWidth) {
                ctx.strokeRect(screenX + bx + offset, screenY + by, brickWidth, brickHeight);

                // Highlight
                ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
                ctx.fillRect(screenX + bx + offset + 2, screenY + by + 2, brickWidth - 4, 3);

                // Shadow
                ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
                ctx.fillRect(screenX + bx + offset + 2, screenY + by + brickHeight - 5, brickWidth - 4, 3);
            }
        }

        ctx.restore();
    }
}

// Game Objects
let player;
let enemies = [];
let coins = [];
let platforms = [];
let portals = [];

// Camera system
function updateCamera() {
    // Center camera on player
    gameState.camera.x = player.x - canvas.width / 2 + player.width / 2;
    gameState.camera.y = player.y - canvas.height / 2 + player.height / 2;

    // Keep camera within world bounds
    gameState.camera.x = Math.max(0, Math.min(gameState.camera.x, CONFIG.WORLD_WIDTH - canvas.width));
    gameState.camera.y = Math.max(0, Math.min(gameState.camera.y, CONFIG.WORLD_HEIGHT - canvas.height));

    // Apply screen shake
    if (gameState.screenShake.duration > 0) {
        const shake = gameState.screenShake.intensity;
        gameState.camera.x += (Math.random() - 0.5) * shake;
        gameState.camera.y += (Math.random() - 0.5) * shake;
        gameState.screenShake.duration--;
    }
}

function initLevel() {
    // Use multiplayer color if connected
    const playerColor = multiplayerState.connected ? multiplayerState.playerColor : PLAYER_COLORS[0];
    player = new Player(100, 100, playerColor);
    enemies = [];
    coins = [];
    platforms = [];
    portals = [];
    particles = [];
    gameState.camera = { x: 0, y: 0 };
    gameState.screenShake = { intensity: 0, duration: 0 };

    const groundY = CONFIG.WORLD_HEIGHT - 50;

    // Create a varied level with better jump distances and recovery platforms
    // Lower platforms - closer together for easier jumps
    platforms.push(new Platform(250, groundY - 100, 180, 20));
    platforms.push(new Platform(500, groundY - 110, 200, 20));
    platforms.push(new Platform(800, groundY - 120, 180, 20));
    platforms.push(new Platform(1050, groundY - 100, 200, 20));
    platforms.push(new Platform(1350, groundY - 130, 180, 20));
    platforms.push(new Platform(1600, groundY - 110, 200, 20));
    platforms.push(new Platform(1900, groundY - 140, 180, 20));
    platforms.push(new Platform(2150, groundY - 120, 200, 20));
    platforms.push(new Platform(2450, groundY - 100, 180, 20));
    platforms.push(new Platform(2750, groundY - 110, 150, 20));

    // Mid-level platforms - easier spacing
    platforms.push(new Platform(200, groundY - 220, 160, 20));
    platforms.push(new Platform(420, groundY - 240, 170, 20));
    platforms.push(new Platform(660, groundY - 260, 160, 20));
    platforms.push(new Platform(900, groundY - 250, 180, 20));
    platforms.push(new Platform(1160, groundY - 270, 170, 20));
    platforms.push(new Platform(1420, groundY - 280, 180, 20));
    platforms.push(new Platform(1680, groundY - 270, 170, 20));
    platforms.push(new Platform(1930, groundY - 260, 180, 20));
    platforms.push(new Platform(2190, groundY - 250, 170, 20));
    platforms.push(new Platform(2440, groundY - 270, 160, 20));

    // High platforms (for portrait mode) - with better spacing
    platforms.push(new Platform(350, groundY - 360, 150, 20));
    platforms.push(new Platform(570, groundY - 380, 160, 20));
    platforms.push(new Platform(800, groundY - 400, 170, 20));
    platforms.push(new Platform(1040, groundY - 390, 160, 20));
    platforms.push(new Platform(1270, groundY - 410, 170, 20));
    platforms.push(new Platform(1510, groundY - 420, 160, 20));
    platforms.push(new Platform(1750, groundY - 410, 170, 20));
    platforms.push(new Platform(1990, groundY - 390, 160, 20));
    platforms.push(new Platform(2220, groundY - 400, 170, 20));
    platforms.push(new Platform(2460, groundY - 380, 160, 20));

    // Recovery/safety platforms - help if you fall
    platforms.push(new Platform(140, groundY - 150, 80, 20));
    platforms.push(new Platform(620, groundY - 170, 80, 20));
    platforms.push(new Platform(1180, groundY - 160, 80, 20));
    platforms.push(new Platform(1740, groundY - 180, 80, 20));
    platforms.push(new Platform(2300, groundY - 170, 80, 20));

    // In multiplayer, don't create enemies directly - spawn master will handle via portals
    // In single player, create some initial enemies
    if (!multiplayerState.connected) {
        // Create enemies on various platforms
        enemies.push(new Enemy(300, groundY - 140));
        enemies.push(new Enemy(550, groundY - 150));
        enemies.push(new Enemy(850, groundY - 160));
        enemies.push(new Enemy(270, groundY - 260));
        enemies.push(new Enemy(500, groundY - 280));
        enemies.push(new Enemy(740, groundY - 300));
        enemies.push(new Enemy(1100, groundY - 140));
        enemies.push(new Enemy(1460, groundY - 320));
        enemies.push(new Enemy(1950, groundY - 160));
        enemies.push(new Enemy(2200, groundY - 160));

        // Add jumping enemies (more challenging)
        enemies.push(new JumpingEnemy(1200, groundY - 140));
        enemies.push(new JumpingEnemy(1650, groundY - 280));
        enemies.push(new JumpingEnemy(2350, groundY - 140));

        // Add turtle enemies (slow but with shell mechanics)
        enemies.push(new TurtleEnemy(700, groundY - 140));
        enemies.push(new TurtleEnemy(1000, groundY - 290));
        enemies.push(new TurtleEnemy(1800, groundY - 140));
        enemies.push(new TurtleEnemy(2500, groundY - 310));
    }

    // Add enemy spawn portals - 3 total for balanced gameplay
    // Distributed across the level for variety
    portals.push(new Portal(600, groundY - 60, 'normal'));      // Ground level - normal enemies
    portals.push(new Portal(2100, groundY - 60, 'turtle'));     // Ground level - turtles (moved to clear area)
    portals.push(new Portal(1800, groundY - 300, 'jumping'));   // Mid-level platform - jumping enemies

    // Create coins throughout the level at various heights
    let coinIndex = 0;
    for (let i = 0; i < 35; i++) {
        const x = 200 + i * 80;
        const heightVariation = Math.random() * 350 + 120;
        const y = groundY - heightVariation;
        coins.push(new Coin(x, y, coinIndex++));
    }

    // Trail of coins on high platforms
    for (let i = 0; i < 12; i++) {
        const x = 380 + i * 190;
        const y = groundY - 440;
        coins.push(new Coin(x, y, coinIndex++));
    }

    // Bonus coins between platforms
    for (let i = 0; i < 8; i++) {
        const x = 300 + i * 330;
        const y = groundY - 180;
        coins.push(new Coin(x, y, coinIndex++));
    }
}

// Game Loop
function gameLoop() {
    if (!gameState.running) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw background
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#87CEEB');
    gradient.addColorStop(1, '#E0F6FF');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw clouds
    drawClouds();

    // Draw ground with camera offset
    const groundY = CONFIG.WORLD_HEIGHT - 50;
    const groundScreenY = groundY - gameState.camera.y;
    const groundScreenX = -gameState.camera.x;

    ctx.fillStyle = '#8B4513';
    ctx.fillRect(groundScreenX, groundScreenY, CONFIG.WORLD_WIDTH, 50);
    ctx.fillStyle = '#228B22';
    ctx.fillRect(groundScreenX, groundScreenY - 5, CONFIG.WORLD_WIDTH, 5);

    // Grass details (only draw visible portion)
    ctx.strokeStyle = '#32CD32';
    ctx.lineWidth = 2;
    const startGrass = Math.floor(gameState.camera.x / 15) * 15;
    const endGrass = startGrass + canvas.width + 30;
    for (let i = startGrass; i < endGrass; i += 15) {
        const screenX = i - gameState.camera.x;
        ctx.beginPath();
        ctx.moveTo(screenX, groundScreenY - 5);
        ctx.lineTo(screenX + 3, groundScreenY - 10);
        ctx.lineTo(screenX + 6, groundScreenY - 5);
        ctx.stroke();
    }

    // Update and draw platforms
    platforms.forEach(platform => platform.draw());

    // Update and draw portals
    portals.forEach(portal => {
        portal.update();
        portal.draw();
    });

    // Update and draw coins
    coins.forEach(coin => {
        coin.update();
        coin.draw();
    });

    // Update and draw enemies
    enemies.forEach(enemy => {
        enemy.update();
        enemy.draw();
    });

    // Update and draw player
    player.update();
    player.draw();

    // Draw grave marker if player is out of lives
    if (player.outOfLives) {
        drawGraveMarker(player.deathX, player.deathY);
    }

    // Sync player position and health to Firebase (throttled)
    if (multiplayerState.connected) {
        multiplayer.syncPlayerPosition(player.x, player.y, player.direction, player.health, player.invulnerable, player.outOfLives);
    }

    // Interpolate remote player positions for smooth movement
    if (multiplayerState.connected) {
        multiplayer.interpolateRemotePlayers();
    }

    // Draw remote players
    if (multiplayerState.connected && multiplayerState.remotePlayers.size > 0) {
        multiplayerState.remotePlayers.forEach((playerData) => {
            drawRemotePlayer(playerData);
        });
    }

    // Update and draw particles
    updateParticles();
    drawParticles();

    // Update and draw floating texts (combos, scores)
    updateFloatingTexts();
    drawFloatingTexts();

    // Check win condition
    if (coins.every(coin => coin.collected)) {
        setTimeout(() => {
            gameState.level++;
            sounds.powerUp();
            alert(`Level ${gameState.level - 1} Complete!`);
            initLevel();
        }, 100);
    }

    requestAnimationFrame(gameLoop);
}

let cloudPositions = [];

function initClouds() {
    cloudPositions = [];
    for (let i = 0; i < 15; i++) {
        cloudPositions.push({
            x: Math.random() * CONFIG.WORLD_WIDTH,
            y: Math.random() * 250 + 20,
            scale: Math.random() * 0.5 + 0.5,
            speed: Math.random() * 0.1 + 0.05,
        });
    }
}

function drawClouds() {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    cloudPositions.forEach(cloud => {
        // Parallax effect - clouds move slower than camera
        const parallaxX = cloud.x - gameState.camera.x * 0.5;
        const parallaxY = cloud.y - gameState.camera.y * 0.3;

        // Only draw if visible on screen
        if (parallaxX > -100 && parallaxX < canvas.width + 100 &&
            parallaxY > -50 && parallaxY < canvas.height + 50) {
            ctx.save();
            ctx.translate(parallaxX, parallaxY);
            ctx.scale(cloud.scale, cloud.scale);

            ctx.beginPath();
            ctx.arc(0, 0, 20, 0, Math.PI * 2);
            ctx.arc(25, 0, 25, 0, Math.PI * 2);
            ctx.arc(50, 0, 20, 0, Math.PI * 2);
            ctx.arc(25, -10, 20, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        }

        cloud.x -= cloud.speed;
        if (cloud.x < -100) {
            cloud.x = CONFIG.WORLD_WIDTH + 50;
        }
    });
}

// Input Handlers
window.addEventListener('keydown', (e) => {
    gameState.keys[e.key] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
    }
    // Prevent Command/Ctrl + Arrow shortcuts that cause stuck keys
    if ((e.metaKey || e.ctrlKey) && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
    }
});

window.addEventListener('keyup', (e) => {
    gameState.keys[e.key] = false;
});

// Clear all keys when window loses focus (prevents stuck keys)
window.addEventListener('blur', () => {
    Object.keys(gameState.keys).forEach(key => {
        gameState.keys[key] = false;
    });
});

// Touch Controls - Position-based tracking
function setupTouchControls() {
    const leftBtn = document.getElementById('btn-left');
    const rightBtn = document.getElementById('btn-right');
    const jumpBtn = document.getElementById('btn-jump');
    const controlsContainer = document.getElementById('touch-controls');

    // Prevent context menu
    [leftBtn, rightBtn, jumpBtn].forEach(btn => {
        btn.addEventListener('contextmenu', e => e.preventDefault());
    });

    // Track which button a touch is currently over
    function getTouchedButton(touch) {
        const element = document.elementFromPoint(touch.clientX, touch.clientY);
        if (!element) return null;

        if (element === leftBtn || element.closest('#btn-left')) return 'left';
        if (element === rightBtn || element.closest('#btn-right')) return 'right';
        if (element === jumpBtn || element.closest('#btn-jump')) return 'jump';
        return null;
    }

    // Check if touch is on a game control button (not menu buttons)
    function isTouchOnControls(touch) {
        const element = document.elementFromPoint(touch.clientX, touch.clientY);
        if (!element) return false;

        // Don't interfere with menu buttons
        if (element.closest('.screen') || element.closest('.menu-btn')) {
            return false;
        }

        return element.closest('#touch-controls');
    }

    // Update control states based on all active touches
    function updateControls(touches) {
        // Reset all controls
        gameState.touchControls.left = false;
        gameState.touchControls.right = false;
        gameState.touchControls.jump = false;

        // Check each active touch and set corresponding control
        for (let i = 0; i < touches.length; i++) {
            const button = getTouchedButton(touches[i]);
            if (button === 'left') gameState.touchControls.left = true;
            if (button === 'right') gameState.touchControls.right = true;
            if (button === 'jump') gameState.touchControls.jump = true;
        }
    }

    // Handle touch events - only prevent default if touching game controls
    document.addEventListener('touchstart', (e) => {
        const touchingControls = Array.from(e.touches).some(touch => isTouchOnControls(touch));
        if (touchingControls) {
            e.preventDefault();
            updateControls(e.touches);
        }
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
        const touchingControls = Array.from(e.touches).some(touch => isTouchOnControls(touch));
        if (touchingControls) {
            e.preventDefault();
            updateControls(e.touches);
        }
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
        // Always update controls on touch end
        updateControls(e.touches);
    });

    document.addEventListener('touchcancel', (e) => {
        gameState.touchControls.left = false;
        gameState.touchControls.right = false;
        gameState.touchControls.jump = false;
    });

    // Mouse support for testing
    let mouseDown = false;

    leftBtn.addEventListener('mousedown', () => {
        mouseDown = true;
        gameState.touchControls.left = true;
    });
    leftBtn.addEventListener('mouseup', () => {
        mouseDown = false;
        gameState.touchControls.left = false;
    });
    leftBtn.addEventListener('mouseleave', () => {
        if (mouseDown) gameState.touchControls.left = false;
    });

    rightBtn.addEventListener('mousedown', () => {
        mouseDown = true;
        gameState.touchControls.right = true;
    });
    rightBtn.addEventListener('mouseup', () => {
        mouseDown = false;
        gameState.touchControls.right = false;
    });
    rightBtn.addEventListener('mouseleave', () => {
        if (mouseDown) gameState.touchControls.right = false;
    });

    jumpBtn.addEventListener('mousedown', () => {
        mouseDown = true;
        gameState.touchControls.jump = true;
    });
    jumpBtn.addEventListener('mouseup', () => {
        mouseDown = false;
        gameState.touchControls.jump = false;
    });
    jumpBtn.addEventListener('mouseleave', () => {
        if (mouseDown) gameState.touchControls.jump = false;
    });
}

// Game Controls
async function startGame() {
    try {
        console.log('startGame called');

        // Get player name from input
        const nameInput = document.getElementById('player-name');
        const playerName = nameInput.value.trim() || 'Player';

        // Connect to multiplayer
        if (multiplayer.db) {
            console.log('Connecting to multiplayer...');
            const connected = await multiplayer.connect(playerName);
            if (connected) {
                console.log('Multiplayer connected!');
            } else {
                console.warn('Failed to connect to multiplayer, continuing in single player mode');
            }
        }

        gameState.running = true;
        gameState.score = 0;
        gameState.coins = 0;
        gameState.lives = 3;
        gameState.level = 1;

        document.getElementById('score').textContent = '0';
        document.getElementById('coins').textContent = '0';
        document.getElementById('lives').textContent = '3';

        document.getElementById('start-screen').classList.add('hidden');
        document.getElementById('game-over-screen').classList.add('hidden');

        console.log('Initializing clouds...');
        initClouds();

        console.log('Initializing level...');
        initLevel();

        console.log('Starting game loop...');
        gameLoop();

        console.log('Game started successfully!');
    } catch (error) {
        console.error('Error starting game:', error);
        alert('Error starting game: ' + error.message);
    }
}

function gameOver() {
    gameState.running = false;
    document.getElementById('final-score').textContent = gameState.score;
    document.getElementById('game-over-screen').classList.remove('hidden');

    // Disconnect from multiplayer
    if (multiplayerState.connected) {
        multiplayer.disconnect();
    }

    // Hide leaderboard
    const leaderboard = document.getElementById('leaderboard');
    if (leaderboard) {
        leaderboard.classList.add('hidden');
    }
}

// Continuous gameplay - out of lives screen
let continueCountdownInterval = null;
let respawnCountdownInterval = null;

function showOutOfLivesScreen() {
    const outOfLivesScreen = document.getElementById('out-of-lives-screen');
    const continueBtn = document.getElementById('continue-btn');
    const continueHint = document.getElementById('continue-hint');
    const respawnCountdownEl = document.getElementById('respawn-countdown');
    const continueCountdownEl = document.getElementById('continue-countdown');

    outOfLivesScreen.classList.remove('hidden');

    // Check if continue was already used
    if (player.hasUsedContinue) {
        continueBtn.style.display = 'none';
        continueHint.style.display = 'none';
    } else {
        continueBtn.style.display = 'block';
        continueHint.style.display = 'block';
        continueBtn.disabled = false;

        // Start continue countdown (5 seconds)
        let continueTime = 5;
        continueCountdownEl.textContent = continueTime;

        if (continueCountdownInterval) clearInterval(continueCountdownInterval);
        continueCountdownInterval = setInterval(() => {
            continueTime--;
            continueCountdownEl.textContent = continueTime;

            if (continueTime <= 0) {
                clearInterval(continueCountdownInterval);
                continueBtn.disabled = true;
                continueBtn.textContent = 'Continue (Expired)';
            }
        }, 1000);
    }

    // Start respawn countdown (10 seconds)
    let respawnTime = 10;
    respawnCountdownEl.textContent = respawnTime;

    if (respawnCountdownInterval) clearInterval(respawnCountdownInterval);
    respawnCountdownInterval = setInterval(() => {
        respawnTime--;
        respawnCountdownEl.textContent = respawnTime;

        if (respawnTime <= 0) {
            clearInterval(respawnCountdownInterval);
            autoRejoin();
        }
    }, 1000);
}

function useContinue() {
    if (player.hasUsedContinue) return;

    player.hasUsedContinue = true;
    player.outOfLives = false;
    gameState.lives = 3;
    player.health = 2;
    document.getElementById('lives').textContent = gameState.lives;

    // Clear countdowns
    if (continueCountdownInterval) clearInterval(continueCountdownInterval);
    if (respawnCountdownInterval) clearInterval(respawnCountdownInterval);

    // Hide screen and resume
    document.getElementById('out-of-lives-screen').classList.add('hidden');

    // Respawn player at random platform
    const spawnPos = player.getRandomRespawnLocation();
    player.x = spawnPos.x;
    player.y = spawnPos.y;
    player.velocityX = 0;
    player.velocityY = 0;
    player.invulnerable = true;

    // Sync revival state immediately so other players can collide again
    if (multiplayerState.connected) {
        multiplayer.syncPlayerPosition(player.x, player.y, player.direction, player.health, player.invulnerable, player.outOfLives);
    }

    setTimeout(() => {
        player.invulnerable = false;
        if (multiplayerState.connected) {
            multiplayer.syncPlayerPosition(player.x, player.y, player.direction, player.health, player.invulnerable, player.outOfLives);
        }
    }, 3000);

    sounds.powerUp();
}

function restartFromZero() {
    // Reset score to 0
    gameState.score = 0;
    gameState.lives = 3;
    player.health = 2;
    player.hasUsedContinue = false;
    player.outOfLives = false;

    document.getElementById('score').textContent = '0';
    document.getElementById('lives').textContent = '3';

    // Clear countdowns
    if (continueCountdownInterval) clearInterval(continueCountdownInterval);
    if (respawnCountdownInterval) clearInterval(respawnCountdownInterval);

    // Hide screen and resume
    document.getElementById('out-of-lives-screen').classList.add('hidden');

    // Respawn player at random platform
    const spawnPos = player.getRandomRespawnLocation();
    player.x = spawnPos.x;
    player.y = spawnPos.y;
    player.velocityX = 0;
    player.velocityY = 0;
    player.invulnerable = true;

    // Sync revival state immediately so other players can collide again
    if (multiplayerState.connected) {
        multiplayer.syncPlayerPosition(player.x, player.y, player.direction, player.health, player.invulnerable, player.outOfLives);
    }

    setTimeout(() => {
        player.invulnerable = false;
        if (multiplayerState.connected) {
            multiplayer.syncPlayerPosition(player.x, player.y, player.direction, player.health, player.invulnerable, player.outOfLives);
        }
    }, 3000);

    // Update leaderboard
    if (multiplayerState.connected) {
        multiplayer.updateLeaderboard();
    }
}

function autoRejoin() {
    // Auto rejoin after countdown expires
    restartFromZero();
}

// UI Event Listeners
function handleStartGame(e) {
    e.preventDefault();
    e.stopPropagation();

    // Resume audio context on user interaction
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    console.log('Starting game...');
    startGame();
}

const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');

// Add both touch and click events for maximum compatibility
startBtn.addEventListener('touchend', handleStartGame);
startBtn.addEventListener('click', handleStartGame);

restartBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('Restarting game...');
    startGame();
});
restartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startGame();
});

// Continue and restart from zero buttons
const continueBtn = document.getElementById('continue-btn');
const restartFromZeroBtn = document.getElementById('restart-from-zero-btn');

continueBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only allow continue if button is not disabled
    if (!continueBtn.disabled) {
        useContinue();
    }
});

restartFromZeroBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    restartFromZero();
});

// Initialize
setupTouchControls();
initClouds();

// Load all-time leaderboard on page load
if (multiplayer.db) {
    multiplayer.loadAllTimeLeaderboard();
}

// Add CanvasRenderingContext2D.roundRect polyfill for older browsers
if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, width, height, radius) {
        if (width < 2 * radius) radius = width / 2;
        if (height < 2 * radius) radius = height / 2;
        this.beginPath();
        this.moveTo(x + radius, y);
        this.arcTo(x + width, y, x + width, y + height, radius);
        this.arcTo(x + width, y + height, x, y + height, radius);
        this.arcTo(x, y + height, x, y, radius);
        this.arcTo(x, y, x + width, y, radius);
        this.closePath();
        return this;
    };
}
