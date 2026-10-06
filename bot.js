import fs from 'fs'
import crypto from 'crypto'
import pino from 'pino'
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, update, set, remove, onValue } from 'firebase/database'
import { firebaseConfig, akun } from './config.js'

const db = getDatabase(initializeApp(firebaseConfig))
const R = p => ref(db, 'bot/' + p)
const setStatus = (state, extra = {}) =>
  update(R('status'), { state, pairingCode: null, pesan: null, ...extra, updatedAt: Date.now() })
const lapor = t => update(R('status'), { hasilTerakhir: t, updatedAt: Date.now() })

// ---------- Pengaturan & fitur (disinkron dari Firebase) ----------
let cfg = { aktif: true, namaAdmin: 'Admin', model: 'claude-haiku-4-5-20251001', menuJudul: 'Menu Bot', menuFooter: '' }
let fitur = {}
onValue(R('config'), s => { cfg = { ...cfg, ...(s.val() || {}) } })
onValue(R('fitur'), s => { fitur = s.val() || {} })

// ---------- API key Claude ----------
// Disimpan di file lokal secret.json (tidak ikut GitHub). Panel hanya menulis lalu bot menghapusnya dari Firebase.
const apiKey = () => {
  try { return JSON.parse(fs.readFileSync('secret.json')).apiKey } catch { return process.env.ANTHROPIC_API_KEY }
}
onValue(R('secret/apiKey'), async s => {
  if (!s.val()) return
  fs.writeFileSync('secret.json', JSON.stringify({ apiKey: s.val() }))
  await remove(R('secret/apiKey'))
  lapor('API key tersimpan di bot')
})

const tanyaClaude = (system, user, maxTokens = 600) => kirimClaude(system, [{ role: 'user', content: user }], maxTokens)
async function kirimClaude(system, messages, maxTokens = 600) {
  const key = apiKey()
  if (!key) throw new Error('API key belum diset (menu API di panel owner)')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages })
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error?.message || 'HTTP ' + r.status)
  return d.content.map(b => b.text || '').join('')
}

// ---------- WhatsApp ----------
let sock = null, phone = null, starting = false, wantRunning = false

async function startBot() {
  if (starting) return
  starting = true
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ['Ubuntu', 'Chrome', '1.0.0'] })
  sock.ev.on('creds.update', saveCreds)

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone)
        await setStatus('menunggu_pairing', { pairingCode: code })
      } catch (e) { await setStatus('error', { pesan: e.message }) }
    }, 3000)
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') await setStatus('terhubung')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      sock = null; starting = false
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync('auth', { recursive: true, force: true }); wantRunning = false
        await setStatus('logout')
      } else if (wantRunning) { await setStatus('menyambung_ulang'); startBot() }
      else await setStatus('berhenti')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m?.message || m.key.fromMe || !cfg.aktif) return   // bot "stop" = diam, sambungan tetap
    const teks = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim()
    const [kata, ...sisa] = teks.split(/\s+/)
    const k = (kata || '').toLowerCase()
    const balas = t => sock.sendMessage(m.key.remoteJid, { text: t })
    if (k === 'ping') return balas('pong')
    if (k === '.menu') {
      const daftar = Object.values(fitur).filter(f => f.aktif).map(f => `${f.trigger} - ${f.nama}`).join('\n') || '(belum ada fitur)'
      return balas(`${cfg.menuJudul}\n\n${daftar}\n\n${cfg.menuFooter}\nAdmin: ${cfg.namaAdmin}`.trim())
    }
    const f = Object.values(fitur).find(x => x.aktif && x.trigger === k)
    if (f) {
      try { await balas(await tanyaClaude(f.instruksi + '\nJawab singkat, cocok untuk chat WhatsApp.', sisa.join(' ') || '(tanpa masukan)')) }
      catch (e) { await balas('Fitur error: ' + e.message) }
    }
  })
}

// ---------- Perintah dari panel ----------
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')
const peran = key => key === akun.owner.hash ? 'owner' : key === akun.admin.hash ? 'admin' : null
const A = ['admin', 'owner'], O = ['owner']
const BOLEH = { login: A, chatFitur: A, botAktif: A, namaAdmin: A, start: O, stop: O, send: O, setConfig: O, fiturAktif: O, hapusFitur: O }

const riwayat = {}
const SYS_CHAT = 'Kamu membantu admin merancang fitur untuk bot WhatsApp lewat chat singkat dalam bahasa Indonesia. Satu fitur = pemicu (diawali titik, huruf kecil, contoh .terjemah) + instruksi untuk AI yang menjalankannya. Kalau permintaan kurang jelas, tanya satu hal saja. Kalau sudah jelas, rangkum fitur lalu minta persetujuan. Setelah pengguna setuju, akhiri balasan dengan satu baris tanpa pembatas kode: FITUR_JSON: {"nama":"nama singkat","trigger":".pemicu","instruksi":"instruksi sistem untuk AI"} dan jangan tulis FITUR_JSON sebelum pengguna setuju.'
async function simpanFitur(f) {
  if (!/^\.[a-z0-9_]{1,20}$/.test(f.trigger) || f.trigger === '.menu') throw new Error('Pemicu tidak valid: ' + f.trigger)
  if (Object.values(fitur).some(x => x.trigger === f.trigger)) throw new Error('Pemicu ' + f.trigger + ' sudah dipakai')
  await set(R('fitur/' + f.trigger.slice(1)), { nama: String(f.nama).slice(0, 40), trigger: f.trigger, instruksi: String(f.instruksi).slice(0, 1500), aktif: true, dibuat: Date.now() })
  lapor('Fitur ' + f.trigger + ' ditambahkan')
}
const aksi = {
  login: async (c, p) => set(R('auth/' + c.id), { ok: true, role: p, nama: p === 'owner' ? akun.owner.nama : cfg.namaAdmin }),
  botAktif: async c => { await update(R('config'), { aktif: !!c.aktif }); lapor(c.aktif ? 'Bot diaktifkan' : 'Bot dihentikan (sambungan tetap)') },
  namaAdmin: async c => { await update(R('config'), { namaAdmin: String(c.nama).slice(0, 30) }); lapor('Nama admin disimpan') },
  setConfig: async c => { await update(R('config'), c.data); lapor('Pengaturan disimpan') },
  fiturAktif: async c => { await update(R('fitur/' + c.kunci), { aktif: !!c.aktif }) },
  hapusFitur: async c => { await remove(R('fitur/' + c.kunci)); lapor('Fitur dihapus') },
  chatFitur: async c => {
    const h = riwayat[c.sid] = (riwayat[c.sid] || []).slice(-12)
    h.push({ role: 'user', content: String(c.pesan).slice(0, 1000) })
    const kirim = teks => set(R('chat/' + c.sid), { id: c.id, teks })
    let out
    try { out = await kirimClaude(SYS_CHAT, h, 800) } catch (e) { h.pop(); return kirim('Error: ' + e.message) }
    h.push({ role: 'assistant', content: out })
    let teks = out.replace(/FITUR_JSON:[\s\S]*/, '').trim()
    const m = out.match(/FITUR_JSON:\s*(\{[\s\S]*\})/)
    if (m) {
      try { await simpanFitur(JSON.parse(m[1])); teks += '\n\nFitur ditambahkan dan langsung aktif.'; riwayat[c.sid] = [] }
      catch (e) { teks += '\n\nGagal menambah fitur: ' + e.message }
    }
    await kirim(teks)
  },
  start: async c => {
    if (sock) return setStatus('terhubung')
    phone = String(c.phone || '').replace(/\D/g, '')
    if (!phone && !fs.existsSync('auth/creds.json')) return setStatus('error', { pesan: 'Nomor HP belum diisi' })
    wantRunning = true; await setStatus('memulai'); startBot()
  },
  stop: async () => { wantRunning = false; if (sock) sock.end(undefined); else await setStatus('berhenti') },
  send: async c => {
    if (!sock) return lapor('Gagal: bot belum tersambung')
    try {
      await sock.sendMessage(String(c.to).replace(/\D/g, '') + '@s.whatsapp.net', { text: String(c.text) })
      lapor('Terkirim ke ' + c.to)
    } catch (e) { lapor('Gagal: ' + e.message) }
  }
}

let pertama = true, idTerakhir = null
onValue(R('command'), async snap => {
  if (pertama) { pertama = false; return }
  const c = snap.val()
  if (!c || c.id === idTerakhir) return
  idTerakhir = c.id
  const p = peran(c.key)
  if (c.action === 'login' && !p) return set(R('auth/' + c.id), { ok: false })
  if (!p || !BOLEH[c.action]?.includes(p)) return lapor('Ditolak: tidak punya izin')
  try { await aksi[c.action](c, p) } catch (e) { lapor('Error: ' + e.message) }
})

if (fs.existsSync('auth/creds.json')) { wantRunning = true; startBot() } else setStatus('berhenti')
console.log('Bot siap, menunggu perintah dari panel...')
