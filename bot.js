const TelegramBot = require('node-telegram-bot-api');
const XLSX        = require('xlsx');
const axios       = require('axios');
const FormData    = require('form-data');
const fs          = require('fs');
const path        = require('path');
const http        = require('http');

const TOKEN      = process.env.TELEGRAM_TOKEN || 'IL_TUO_TOKEN';
const OPENAI_KEY = process.env.OPENAI_KEY     || '';
const RENDER_URL = process.env.RENDER_URL     || '';
const DB_FILE    = path.join(__dirname, 'registro_km.json');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot Registro Km - OK')).listen(PORT, () =>
  console.log('Keep-alive server avviato su porta ' + PORT)
);

if (RENDER_URL) {
  setInterval(() => {
    axios.get(RENDER_URL).catch(() => {});
  }, 14 * 60 * 1000);
}

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { return []; }
}
function saveDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }

const sessions = {};
const bot = new TelegramBot(TOKEN, { polling: true });

const STEPS = [
  { key: 'data',         ask: '📅 *Data uscita* (es. 13/05/2026) oppure /oggi\n_Puoi anche mandare un vocale_ 🎤' },
  { key: 'conducente',   ask: '👤 *Nome e cognome conducente:*' },
  { key: 'matricola',    ask: '🪪 *Matricola conducente* (o /salta):' },
  { key: 'motivo',       ask: '📋 *Motivo utilizzo veicolo:*\n_(es. Ispezione stabilimento)_' },
  { key: 'partenza',     ask: '📍 *Luogo di partenza* (o /salta):' },
  { key: 'arrivo',       ask: '📍 *Luogo di arrivo* (o /salta):' },
  { key: 'ora_partenza', ask: '🕐 *Ora partenza* es. 08:30 (o /salta):' },
  { key: 'ora_arrivo',   ask: '🕐 *Ora arrivo* es. 12:45 (o /salta):' },
  { key: 'km_inizio',    ask: '🔢 *Km iniziali* (contachilometri):' },
  { key: 'km_fine',      ask: '🔢 *Km finali* (contachilometri):' },
  { key: 'rif_km',       ask: '⛽ *Km al rifornimento* (o /salta):' },
  { key: 'rif_litri',    ask: '⛽ *Litri riforniti* (o /salta):' },
  { key: 'rif_euro',     ask: '⛽ *Euro carburante* (o /salta):' },
  { key: 'note',         ask: '📝 *Note aggiuntive* (o /salta):' },
];

function todayIT() {
  const d = new Date();
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}

function monthName(n) {
  return ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
          'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'][n];
}

function fmtRecord(r) {
  const kmp = parseInt(r.km_fine||0) - parseInt(r.km_inizio||0);
  let m = '✅ *Uscita registrata!*\n\n📅 ' + r.data + ' | 👤 ' + r.conducente;
  if (r.matricola) m += ' (' + r.matricola + ')';
  m += '\n📋 ' + r.motivo + '\n';
  if (r.partenza || r.arrivo) m += '📍 ' + (r.partenza||'—') + ' → ' + (r.arrivo||'—') + '\n';
  if (r.ora_partenza) m += '🕐 ' + r.ora_partenza + ' → ' + (r.ora_arrivo||'—') + '\n';
  m += '🔢 ' + r.km_inizio + ' → ' + r.km_fine + ' = *' + kmp + ' km percorsi*\n';
  if (r.rif_litri) m += '⛽ ' + r.rif_litri + 'L | €' + (r.rif_euro||'?') + '\n';
  if (r.note) m += '📝 ' + r.note;
  return m;
}

async function transcribeVoice(chatId, fileId) {
  if (!OPENAI_KEY) {
    bot.sendMessage(chatId, '⚠️ Riconoscimento vocale non attivo. Scrivi il testo manualmente.');
    return null;
  }
  try {
    await bot.sendMessage(chatId, '🎤 _Trascrizione in corso..._', { parse_mode: 'Markdown' });
    const info = await bot.getFile(fileId);
    const url  = 'https://api.telegram.org/file/bot' + TOKEN + '/' + info.file_path;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    const tmp  = path.join(__dirname, 'v_' + Date.now() + '.oga');
    fs.writeFileSync(tmp, resp.data);
    const form = new FormData();
    form.append('file', fs.createReadStream(tmp), { filename: 'voice.oga', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'it');
    const r = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), 'Authorization': 'Bearer ' + OPENAI_KEY }
    });
    fs.unlinkSync(tmp);
    return r.data.text.trim();
  } catch(e) {
    bot.sendMessage(chatId, '❌ Errore trascrizione. Scrivi il testo manualmente.');
    return null;
  }
}

function processValue(chatId, session, value) {
  const step = STEPS[session.step];
  if (step.key === 'data') {
    if (/oggi|today/i.test(value)) {
      session.data.data = todayIT();
    } else if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(value)) {
      session.data.data = value.replace(/-/g, '/');
    } else {
      bot.sendMessage(chatId, '⚠️ Usa il formato DD/MM/YYYY oppure scrivi /oggi');
      return false;
    }
  } else if (step.key === 'km_inizio' || step.key === 'km_fine') {
    const num = parseInt(value.replace(/\D/g, ''));
    if (isNaN(num)) {
      bot.sendMessage(chatId, '⚠️ Non ho trovato un numero valido. Riprova.');
      return false;
    }
    if (step.key === 'km_fine' && num < parseInt(session.data.km_inizio)) {
      bot.sendMessage(chatId, '⚠️ Km finali (' + num + ') minori dei km iniziali (' + session.data.km_inizio + '). Riprova:');
      return false;
    }
    session.data[step.key] = String(num);
  } else {
    const isSkip = /^(salta|skip|no|niente|nessun[ao]?|—|-)$/i.test(value.trim()) || value === '/salta';
    session.data[step.key] = isSkip ? '' : value;
  }
  return true;
}

function nextStep(chatId, session) {
  session.step++;
  if (session.step >= STEPS.length) {
    const db  = loadDB();
    const rec = { id: Date.now(), ...session.data };
    db.push(rec);
    saveDB(db);
    delete sessions[chatId];
    bot.sendMessage(chatId, fmtRecord(rec), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '➕ Nuova uscita',   callback_data: 'nuova' },
        { text: '📊 Riepilogo mese', callback_data: 'riepilogo' }
      ]]}
    });
  } else {
    bot.sendMessage(chatId, STEPS[session.step].ask, { parse_mode: 'Markdown' });
  }
}

bot.onText(/\/(start|help)/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '🚗 *Registro Chilometrico*\n\n' +
    'Puoi rispondere sia *scrivendo* che con un *messaggio vocale* 🎤\n\n' +
    '/nuova – Registra nuova uscita\n' +
    '/ultime – Ultime 5 uscite\n' +
    '/riepilogo – Riepilogo mese corrente\n' +
    '/export – Genera Excel del mese\n' +
    '/annulla – Annulla inserimento',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/nuova/, (msg) => {
  sessions[msg.chat.id] = { step: 0, data: {} };
  bot.sendMessage(msg.chat.id, STEPS[0].ask, { parse_mode: 'Markdown' });
});

bot.onText(/\/annulla/, (msg) => {
  delete sessions[msg.chat.id];
  bot.sendMessage(msg.chat.id, '❌ Inserimento annullato.');
});

bot.onText(/\/ultime/, (msg) => {
  const db = loadDB();
  if (!db.length) { bot.sendMessage(msg.chat.id, 'Nessuna uscita registrata.'); return; }
  const ultime = db.slice(-5).reverse();
  let t = '📋 *Ultime ' + ultime.length + ' uscite:*\n\n';
  ultime.forEach((r, i) => {
    const kmp = parseInt(r.km_fine||0) - parseInt(r.km_inizio||0);
    t += (i+1) + '. ' + r.data + ' – ' + r.conducente + ' – *' + kmp + 'km*\n';
  });
  bot.sendMessage(msg.chat.id, t, { parse_mode: 'Markdown' });
});

bot.onText(/\/riepilogo/, (msg) => {
  const db  = loadDB();
  const now = new Date();
  const mm  = String(now.getMonth()+1).padStart(2,'0');
  const yy  = String(now.getFullYear());
  const rows = db.filter(r => {
    const p = r.data && r.data.split('/');
    return p && p[1] === mm && p[2] === yy;
  });
  if (!rows.length) {
    bot.sendMessage(msg.chat.id, 'Nessuna uscita per ' + monthName(now.getMonth()) + ' ' + yy + '.');
    return;
  }
  const totKm  = rows.reduce((a,r) => a + (parseInt(r.km_fine||0)) - (parseInt(r.km_inizio||0)), 0);
  const totLit = rows.reduce((a,r) => a + (parseFloat(r.rif_litri)||0), 0);
  const totEur = rows.reduce((a,r) => a + (parseFloat(r.rif_euro)||0), 0);
  let t = '📊 *Riepilogo ' + monthName(now.getMonth()) + ' ' + yy + '*\n\n';
  t += '🔢 Km totali: *' + totKm + ' km*\n🚗 Uscite: *' + rows.length + '*\n⛽ Litri: *' + totLit.toFixed(1) + ' L*\n💶 Carburante: *€' + totEur.toFixed(2) + '*\n\n';
  rows.forEach((r, i) => {
    const kmp = parseInt(r.km_fine||0) - parseInt(r.km_inizio||0);
    t += (i+1) + '. ' + r.data + ' – ' + r.conducente + ' – ' + kmp + 'km\n';
  });
  bot.sendMessage(msg.chat.id, t, { parse_mode: 'Markdown' });
});

bot.onText(/\/export/, (msg) => {
  const chatId = msg.chat.id;
  const db     = loadDB();
  const now    = new Date();
  const mm     = String(now.getMonth()+1).padStart(2,'0');
  const yy     = String(now.getFullYear());
  const rows   = db.filter(r => {
    const p = r.data && r.data.split('/');
    return p && p[1] === mm && p[2] === yy;
  }).sort((a, b) => {
    const pa = a.data.split('/'), pb = b.data.split('/');
    return new Date(pa[2], pa[1]-1, pa[0]) - new Date(pb[2], pb[1]-1, pb[0]);
  });
  if (!rows.length) {
    bot.sendMessage(chatId, 'Nessuna uscita per ' + monthName(now.getMonth()) + ' ' + yy + '.');
    return;
  }
  const wb  = XLSX.utils.book_new();
  const hdr = ['DATA','MOTIVO UTILIZZO','CONDUCENTE','MATRICOLA','LUOGO PARTENZA','LUOGO ARRIVO',
               'ORA PARTENZA','ORA ARRIVO','KM INIZIALI','KM FINALI','KM PERCORSI',
               'KM RIFORNIMENTO','LITRI','EURO','NOTE'];
  const data = [
    ['REGISTRO CHILOMETRICO – ' + monthName(now.getMonth()).toUpperCase() + ' ' + yy],
    [],
    hdr
  ];
  rows.forEach(r => data.push([
    r.data, r.motivo, r.conducente, r.matricola||'',
    r.partenza||'', r.arrivo||'',
    r.ora_partenza||'', r.ora_arrivo||'',
    parseInt(r.km_inizio)||'', parseInt(r.km_fine)||'',
    (parseInt(r.km_fine)||0) - (parseInt(r.km_inizio)||0),
    r.rif_km||'', r.rif_litri||'', r.rif_euro||'', r.note||''
  ]));
  const d1 = 4, d2 = 3 + rows.length;
  data.push([]);
  data.push(['TOTALI','','','','','','','','','',
    { f: 'SUM(K'+d1+':K'+d2+')' }, '',
    { f: 'SUM(M'+d1+':M'+d2+')' },
    { f: 'SUM(N'+d1+':N'+d2+')' }, ''
  ]);
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols']   = [{wch:12},{wch:35},{wch:25},{wch:10},{wch:22},{wch:22},
                   {wch:10},{wch:10},{wch:12},{wch:12},{wch:12},{wch:12},{wch:8},{wch:8},{wch:25}];
  ws['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:14} }];
  XLSX.utils.book_append_sheet(wb, ws, 'Registro');
  const fname = 'registro_' + monthName(now.getMonth()) + '_' + yy + '.xlsx';
  XLSX.writeFile(wb, fname);
  bot.sendDocument(chatId, fname, {}, {
    filename: fname,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }).then(() => { try { fs.unlinkSync(fname); } catch(e) {} });
  bot.sendMessage(chatId, '📎 Excel *' + monthName(now.getMonth()) + ' ' + yy + '* generato – ' + rows.length + ' uscite!', { parse_mode: 'Markdown' });
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith('/')) return;
  const s = sessions[chatId];
  if (!s) return;
  if (processValue(chatId, s, msg.text.trim())) nextStep(chatId, s);
});

bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const s = sessions[chatId];
  if (!s) {
    bot.sendMessage(chatId, '💡 Usa /nuova per iniziare, poi potrai rispondere con la voce!');
    return;
  }
  const testo = await transcribeVoice(chatId, msg.voice.file_id);
  if (!testo) return;
  bot.sendMessage(chatId, '🎤 Ho capito: _"' + testo + '"_', { parse_mode: 'Markdown' });
  if (processValue(chatId, s, testo)) nextStep(chatId, s);
});

bot.on('callback_query', (q) => {
  bot.answerCallbackQuery(q.id);
  const chatId = q.message.chat.id;
  if (q.data === 'nuova') {
    sessions[chatId] = { step: 0, data: {} };
    bot.sendMessage(chatId, STEPS[0].ask, { parse_mode: 'Markdown' });
  }
  if (q.data === 'riepilogo') {
    bot.emit('message', { chat: { id: chatId }, text: '/riepilogo' });
  }
});

console.log('🚗 Bot Registro Km avviato con supporto vocale!');
