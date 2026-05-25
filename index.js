import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";
import express from "express";
import qrcode from "qrcode";
import pino from "pino";

const app = express();
app.use(express.json());

const BOT_SECRET = process.env.BOT_SECRET;
const PORT = process.env.PORT || 3001;

let sock = null;
let isReady = false;
let qrSvg = null;

// ── Conexão com WhatsApp ────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const logger = pino({ level: "silent" });

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: Browsers.ubuntu("Chrome"),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrSvg = await qrcode.toString(qr, { type: "svg" });
      isReady = false;
      console.log("📱 QR Code gerado → acesse /qr no navegador");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      isReady = false;

      if (code !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconectando em 5s...");
        setTimeout(startBot, 5000);
      } else {
        console.log("🚪 Desconectado (logout). Reiniciando para novo QR...");
        qrSvg = null;
        setTimeout(startBot, 1000);
      }
    }

    if (connection === "open") {
      isReady = true;
      qrSvg = null;
      console.log("✅ WhatsApp conectado!");
    }
  });
}

startBot().catch(console.error);

// ── Auth middleware ─────────────────────────────────────────────────────────
const requireSecret = (req, res, next) => {
  if (!BOT_SECRET) return next(); // sem secret = desenvolvimento local
  const token = (req.headers["authorization"] || "").replace("Bearer ", "");
  if (token !== BOT_SECRET) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
};

// ── Rotas ───────────────────────────────────────────────────────────────────

// Health check (UptimeRobot pinga aqui a cada 5 min)
app.get("/health", (_req, res) => {
  res.json({ ok: true, connected: isReady, ts: Date.now() });
});

// Página do QR Code (embutida no admin via iframe)
app.get("/qr", (_req, res) => {
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  if (isReady) {
    return res.send(`<!DOCTYPE html>
<html>
<body style="background:#111;color:#4ade80;font-family:monospace;padding:60px;text-align:center">
  <h1 style="font-size:60px">✅</h1>
  <h2>WhatsApp Conectado!</h2>
  <p style="color:#aaa">O bot está funcionando e enviará mensagens automaticamente.</p>
</body>
</html>`);
  }

  if (!qrSvg) {
    return res.send(`<!DOCTYPE html>
<html>
<body style="background:#111;color:#fff;font-family:monospace;padding:60px;text-align:center">
  <h2>⏳ Aguardando QR Code...</h2>
  <p style="color:#aaa">O bot está iniciando. Recarregando em 3 segundos...</p>
  <script>setTimeout(()=>location.reload(), 3000)</script>
</body>
</html>`);
  }

  res.send(`<!DOCTYPE html>
<html>
<body style="background:#fff;padding:40px;text-align:center;font-family:sans-serif">
  <h2>📱 Escaneie com o WhatsApp</h2>
  <p><b>WhatsApp → Dispositivos conectados → Conectar dispositivo</b></p>
  <div style="display:inline-block;padding:16px;border:2px solid #ddd;border-radius:12px;margin:16px 0">
    ${qrSvg}
  </div>
  <p style="color:#999;font-size:13px">A página recarrega automaticamente após a conexão.</p>
  <script>setTimeout(()=>location.reload(), 30000)</script>
</body>
</html>`);
});

// Enviar mensagem (chamado pelo Vercel quando pedido é feito)
app.post("/send", requireSecret, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: "phone e message são obrigatórios." });
  }

  if (!isReady) {
    return res.status(503).json({ error: "WhatsApp não conectado." });
  }

  try {
    const number = String(phone).replace(/\D/g, "");
    const jid = (number.startsWith("55") ? number : `55${number}`) + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Mensagem enviada para ${number}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao enviar:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🤖 Bot rodando na porta ${PORT}`);
  console.log(`📱 Acesse /qr para conectar o WhatsApp`);
});
