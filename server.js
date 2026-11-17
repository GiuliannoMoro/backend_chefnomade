import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import cardapioRoutes from "./routes/cardapio.js";
import pedidosRoutes from "./routes/pedidos.js";
import adminRoutes from "./routes/admin.js";
import { rotaEventos } from "./eventos.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Caminhos resolvidos a partir desta pasta, para funcionar de qualquer diretório
const pastaBackend = path.dirname(fileURLToPath(import.meta.url));
const raizProjeto = path.join(pastaBackend, "..");

dotenv.config({ path: path.join(pastaBackend, ".env") });

const app = express();

// Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// O servidor nunca guarda sessão de usuário no cliente principal
const opcoesSupabase = { auth: { persistSession: false, autoRefreshToken: false } };
const criarClienteAuth = () => createClient(supabaseUrl, supabaseKey, opcoesSupabase);

let supabase = null;
if (!supabaseUrl || !supabaseKey) {
  console.error("SUPABASE_URL ou SUPABASE_KEY não definidos no .env");
} else {
  supabase = createClient(supabaseUrl, supabaseKey, opcoesSupabase);
}

// Middlewares
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json({ limit: "8mb" })); // folga para upload de imagem em base64

// Site do cliente e painel de administração
app.use(express.static(path.join(raizProjeto, "site_chefenomade")));
app.use("/admin", express.static(path.join(raizProjeto, "admin_chefenomade")));

// Health check
app.get("/api/status", (req, res) => {
  res.json({ status: "ok", mensagem: "API Chefe Nômade online" });
});

// Avisos em tempo real para o site (não depende do Supabase)
app.get("/api/eventos", rotaEventos);

// Rotas da API (precisam do Supabase configurado)
app.use("/api", (req, res, next) => {
  if (!supabase) {
    return res.status(503).json({ erro: "Banco de dados não configurado." });
  }
  next();
});
app.use("/api/admin", adminRoutes(supabase, criarClienteAuth));
app.use("/api", cardapioRoutes(supabase));
app.use("/api", pedidosRoutes(supabase));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Painel admin em   http://localhost:${PORT}/admin`);
});
