const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('xlsx');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TOKEN = process.env.TELEGRAM_TOKEN || 'IL_TUO_TOKEN';
const OPENAI_KEY = process.env.OPENAI_KEY || '';
const RENDER_URL = process.env.RENDER_URL || '';
const DB_FILE = path.join(__dirname, 'registro_km.json');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('OK')).listen(PORT);

if (RENDER_URL) setInterval(() => axios.get(RENDER_URL).catch(() => {}), 14 * 60 * 1000);

function loadDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { return []; } }
function saveDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }

const sessions = {};
const bot = new TelegramBot(TOKEN, { polling: true });

const STEPS = [
  { key: 'data', ask: '📅 *Data uscita* (es. 13/05/2026) o /oggi' },
  { key: 'conducente', ask: '👤 *Nome conducente:*' },
  { key: 'motivo', ask: '📋 *Motivo utilizzo:*' },
  { key: 'km_inizio', ask: '🔢 *Km iniziali:*' },
  { key: 'km_fine', ask: '🔢 *Km finali:*' }
];

bot.onText(/\/nuova/, (msg) => {
  sessions[msg.chat.id] = { step: 0, data: {} };
  bot.sendMessage(msg.chat.id, STEPS[0].ask, { parse_mode: 'Markdown' });
});

console.log('Bot avviato!');
