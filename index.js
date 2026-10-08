require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const { Client: BotClient, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const os = require('os');

// ==========================================
// FIREBASE REALTIME DB (REST API)
// ==========================================
const FIREBASE_DB_URL = 'https://ihemopromote-default-rtdb.asia-southeast1.firebasedatabase.app';

async function firebaseGet(refPath) {
  try {
    const res = await fetch(`${FIREBASE_DB_URL}/${refPath}.json`);
    return await res.json();
  } catch (e) {
    console.error(`[FIREBASE] GET ${refPath} error:`, e.message);
    return null;
  }
}

async function firebaseSet(refPath, data) {
  try {
    await fetch(`${FIREBASE_DB_URL}/${refPath}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (e) {
    console.error(`[FIREBASE] SET ${refPath} error:`, e.message);
  }
}

async function firebasePush(refPath, data) {
  try {
    await fetch(`${FIREBASE_DB_URL}/${refPath}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (e) {
    console.error(`[FIREBASE] PUSH ${refPath} error:`, e.message);
  }
}

// ==========================================
// CONFIG & STATE
// ==========================================
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function saveConfigLocal() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function saveConfig() {
  saveConfigLocal();
  await firebaseSet('config', config);
}

// Load config from Firebase on startup (merge with local)
async function loadConfigFromFirebase() {
  const fbConfig = await firebaseGet('config');
  if (fbConfig && typeof fbConfig === 'object') {
    config = { ...config, ...fbConfig };
    saveConfigLocal();
    console.log('[FIREBASE] Config loaded from Firebase');
  } else {
    // First run — push local config to Firebase
    await firebaseSet('config', config);
    console.log('[FIREBASE] Initial config pushed to Firebase');
  }
}

const startTime = Date.now();
const activityLog = [];
const MAX_LOG = 200;

function addLog(type, status, message) {
  const entry = {
    timestamp: new Date().toLocaleTimeString('id-ID', { hour12: false }),
    isoTime: new Date().toISOString(),
    type,
    status,
    message,
  };
  activityLog.unshift(entry);
  if (activityLog.length > MAX_LOG) activityLog.pop();
  console.log(`[${entry.type}] [${entry.status}] ${entry.message}`);

  // Also push to Firebase (fire and forget)
  firebasePush('logs', entry);
}

// ==========================================
// 1. SELF-BOT SETUP
// ==========================================
const selfBot = new Client({ checkUpdate: false });

let selfBotStatus = { online: false, tag: null, id: null, ping: 0, guilds: 0 };
let cronJobs = [];

function setupCronJobs() {
  cronJobs.forEach(j => j.stop());
  cronJobs = [];

  config.scheduledMessages.forEach(schedule => {
    if (!schedule.enabled) return;
    const job = cron.schedule(schedule.cronExpression, async () => {
      try {
        const channel = await selfBot.channels.fetch(schedule.channelId);
        if (channel) {
          await channel.send(schedule.message);
          addLog('SCHEDULED-MSG', 'SUCCESS', `Pesan terkirim ke Channel ID ${schedule.channelId}`);
        }
      } catch (error) {
        addLog('SCHEDULED-MSG', 'ERROR', `Gagal kirim ke ${schedule.channelId}: ${error.message}`);
      }
    });
    cronJobs.push(job);
    addLog('CRON', 'SETUP', `Cron job aktif untuk channel ${schedule.channelId} [${schedule.cronExpression}]`);
  });
}

selfBot.on('ready', async () => {
  selfBotStatus = {
    online: true,
    tag: selfBot.user.tag,
    id: selfBot.user.id,
    ping: selfBot.ws.ping,
    guilds: selfBot.guilds.cache.size,
    avatar: selfBot.user.displayAvatarURL({ size: 128 }),
  };
  addLog('SELF-BOT', 'ONLINE', `Login sebagai ${selfBot.user.tag} (${selfBot.user.id})`);

  // Save selfbot status to Firebase
  firebaseSet('status/selfBot', selfBotStatus);

  setupCronJobs();
});

selfBot.on('messageCreate', async (message) => {
  if (message.author.id === selfBot.user.id) return;

  if (message.channel.type === 'DM' && config.autoReply.enabled) {
    try {
      await message.reply(config.autoReply.template);
      addLog('AUTO-REPLY', 'SUCCESS', `Balas DM dari ${message.author.tag}: "${message.content.substring(0, 60)}"`);
    } catch (error) {
      addLog('AUTO-REPLY', 'ERROR', `Gagal balas ${message.author.tag}: ${error.message}`);
    }
  }
});

// Update ping periodically & sync to Firebase
setInterval(() => {
  if (selfBot.ws && selfBot.ws.ping) {
    selfBotStatus.ping = selfBot.ws.ping;
    selfBotStatus.guilds = selfBot.guilds.cache.size;
  }
  // Periodic status sync to Firebase
  firebaseSet('status/selfBot', selfBotStatus);
  firebaseSet('status/uptime', {
    startTime: new Date(startTime).toISOString(),
    uptimeMs: Date.now() - startTime,
  });
}, 30000);

// ==========================================
// 2. NORMAL BOT APP SETUP (Notifications)
// ==========================================
const appBot = new BotClient({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let appBotStatus = { online: false, tag: null, id: null };

appBot.once('clientReady', () => {
  appBotStatus = {
    online: true,
    tag: appBot.user.tag,
    id: appBot.user.id,
    avatar: appBot.user.displayAvatarURL({ size: 128 }),
  };
  addLog('APP-BOT', 'ONLINE', `Login sebagai ${appBot.user.tag}`);
  firebaseSet('status/appBot', appBotStatus);
});

// ==========================================
// 3. EXPRESS DASHBOARD & API
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

// --- Serve Dashboard ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- API: Get guilds and channels from self-bot ---
app.get('/api/guilds', (req, res) => {
  if (!selfBotStatus.online) {
    return res.json([]);
  }
  try {
    const guilds = selfBot.guilds.cache.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL({ size: 32 }),
      channels: g.channels.cache
        .filter(ch => ch.type === 'GUILD_TEXT' || ch.type === 0)
        .map(ch => ({ id: ch.id, name: ch.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })).sort((a, b) => a.name.localeCompare(b.name));
    res.json(guilds);
  } catch (e) {
    res.json([]);
  }
});

// --- API: Get full status ---
app.get('/api/status', (req, res) => {
  const uptimeMs = Date.now() - startTime;
  const days = Math.floor(uptimeMs / 86400000);
  const hours = Math.floor((uptimeMs % 86400000) / 3600000);
  const minutes = Math.floor((uptimeMs % 3600000) / 60000);

  const memUsage = process.memoryUsage();
  const cpus = os.cpus();

  res.json({
    selfBot: selfBotStatus,
    appBot: appBotStatus,
    uptime: { days, hours, minutes, raw: uptimeMs },
    memory: {
      rss: (memUsage.rss / 1024 / 1024).toFixed(1),
      heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(1),
      heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(1),
    },
    system: {
      platform: os.platform(),
      nodeVersion: process.version,
      cpuCores: cpus.length,
    },
    config: config,
    firebase: { url: FIREBASE_DB_URL, connected: true },
  });
});

// --- API: Get activity log ---
app.get('/api/logs', (req, res) => {
  res.json(activityLog);
});

// --- API: Get logs from Firebase ---
app.get('/api/firebase/logs', async (req, res) => {
  const logs = await firebaseGet('logs');
  if (!logs) return res.json([]);
  // Firebase stores as object, convert to array
  const arr = Object.values(logs).reverse();
  res.json(arr);
});

// --- API: Update scheduled messages ---
app.post('/api/config/scheduled', async (req, res) => {
  const { scheduledMessages } = req.body;
  if (!Array.isArray(scheduledMessages)) {
    return res.status(400).json({ error: 'scheduledMessages must be an array' });
  }
  config.scheduledMessages = scheduledMessages;
  await saveConfig();
  setupCronJobs();
  addLog('CONFIG', 'UPDATED', `Scheduled messages diperbarui (${scheduledMessages.length} entries)`);
  res.json({ success: true });
});

// --- API: Update auto-reply ---
app.post('/api/config/autoreply', async (req, res) => {
  const { enabled, template } = req.body;
  config.autoReply = { enabled: !!enabled, template: template || '' };
  await saveConfig();
  addLog('CONFIG', 'UPDATED', `Auto-reply ${enabled ? 'diaktifkan' : 'dinonaktifkan'}`);
  res.json({ success: true });
});

// --- API: Update bot app notification channel ---
app.post('/api/config/botapp', async (req, res) => {
  const { notificationChannelId } = req.body;
  if (!notificationChannelId) {
    return res.status(400).json({ error: 'notificationChannelId required' });
  }
  config.botApp.notificationChannelId = notificationChannelId;
  await saveConfig();
  addLog('CONFIG', 'UPDATED', `Bot App notification channel diubah ke ${notificationChannelId}`);
  res.json({ success: true });
});

// --- API: Send notification from web input ---
app.post('/api/notify', async (req, res) => {
  const { inputData } = req.body;
  if (!inputData) {
    return res.status(400).json({ error: 'Missing inputData' });
  }

  if (!appBotStatus.online) {
    return res.status(503).json({ error: 'App Bot is not online' });
  }

  try {
    const channel = await appBot.channels.fetch(config.botApp.notificationChannelId);
    if (channel) {
      await channel.send(`**Notifikasi Web Input:**\n\`\`\`\n${inputData}\n\`\`\``);
      addLog('WEB-NOTIFY', 'SUCCESS', `Input terkirim ke channel ${config.botApp.notificationChannelId}`);

      // Also save the web input to Firebase
      await firebasePush('webInputs', {
        inputData,
        sentAt: new Date().toISOString(),
        channelId: config.botApp.notificationChannelId,
      });

      res.json({ success: true, message: 'Notification sent!' });
    } else {
      res.status(404).json({ error: 'Notification channel not found' });
    }
  } catch (error) {
    addLog('WEB-NOTIFY', 'ERROR', error.message);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// --- API: Get web inputs history from Firebase ---
app.get('/api/firebase/inputs', async (req, res) => {
  const inputs = await firebaseGet('webInputs');
  if (!inputs) return res.json([]);
  const arr = Object.entries(inputs).map(([key, val]) => ({ id: key, ...val })).reverse();
  res.json(arr);
});

// ==========================================
// STARTUP
// ==========================================
async function boot() {
  // Load config from Firebase
  await loadConfigFromFirebase();

  // Start Express
  app.listen(PORT, () => {
    console.log(`[WEB-SERVER] Dashboard running at http://localhost:${PORT}`);
    addLog('SYSTEM', 'STARTED', `Web server listening on port ${PORT}`);
  });

  // Login Self-Bot
  selfBot.login(process.env.DISCORD_TOKEN).catch(err => {
    addLog('SELF-BOT', 'ERROR', `Login gagal: ${err.message}`);
  });

  // Login App Bot
  if (process.env.BOT_APP_TOKEN && process.env.BOT_APP_TOKEN !== 'YOUR_NORMAL_BOT_TOKEN') {
    appBot.login(process.env.BOT_APP_TOKEN).catch(err => {
      addLog('APP-BOT', 'ERROR', `Login gagal: ${err.message}`);
    });
  } else {
    addLog('APP-BOT', 'WARNING', 'BOT_APP_TOKEN belum diatur, bot app tidak dijalankan.');
  }
}

boot();
