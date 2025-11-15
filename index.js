require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg"); // Importa o 'Pool' do 'pg'
const cors = require("cors"); // <-- 1. ADICIONE ESTA LINHA

const app = express();
const port = process.env.PORT || 3000;

app.use(cors()); // <-- 2. ADICIONE ESTA LINHA (permite todas as origens)

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("ERRO: DATABASE_URL não encontrada. Verifique seu .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: connectionString,
});

// --- LÓGICA DE NEGÓCIO (Reutilizada) ---
const API_LOTOFACIL_URL = "https://api.guidi.dev.br/loteria/lotofacil/ultimo";

async function buscarResultadoOficial() {
  console.log("Buscando resultado oficial da Lotofácil na API...");
  try {
    const response = await axios.get(API_LOTOFACIL_URL);
    const apiData = response.data;
    const dadosObtidos = {
      concurso: apiData.numero,
      data: apiData.dataApuracao,
      dezenas: apiData.listaDezenas.join(" "),
    };
    console.log(`Resultado obtido OK (Concurso ${dadosObtidos.concurso})!`);
    return dadosObtidos;
  } catch (error) {
    console.error("Erro ao buscar dados da API oficial:", error.message);
    return null;
  }
}

async function salvarResultado(dados) {
  const { concurso, data, dezenas } = dados;

  const [dia, mes, ano] = data.split("/");
  // Ajuste para o Neon entender a data
  const dataFormatada = `${ano}-${mes}-${dia}`;

  // Query SQL para inserir ou não fazer nada se o concurso já existir
  const query = `
        INSERT INTO resultados (concurso, data, dezenas)
        VALUES ($1, $2, $3)
        ON CONFLICT (concurso) DO NOTHING
        RETURNING *;
    `;

  try {
    const res = await pool.query(query, [concurso, dataFormatada, dezenas]);
    if (res.rowCount > 0) {
      console.log(`Sucesso! Concurso ${concurso} salvo no banco.`);
      return `Sucesso! Concurso ${concurso} salvo no banco.`;
    } else {
      console.log(`Concurso ${concurso} já existe no banco. Pulando.`);
      return `Concurso ${concurso} já existe no banco.`;
    }
  } catch (error) {
    console.error("Erro ao salvar no PostgreSQL:", error.message);
    return "Erro ao salvar no PostgreSQL.";
  }
}

// --- ENDPOINTS DA API ---

// 1. Endpoint para o Frontend (Vercel)
app.get("/api/resultados", async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;

  try {
    // Query SQL para buscar os últimos resultados
    const query = `
            SELECT concurso, data, dezenas 
            FROM resultados
            ORDER BY concurso DESC
            LIMIT $1;
        `;
    const { rows } = await pool.query(query, [limit]);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao buscar resultados" });
  }
});

// 2. Endpoint para o Worker (Cron Job)
app.post("/api/worker/run", async (req, res) => {
  console.log("Worker /api/worker/run chamado...");
  const dados = await buscarResultadoOficial();
  let message = "Falha ao obter dados da API.";

  if (dados) {
    message = await salvarResultado(dados);
  }
  res.status(200).json({ message: message });
});

// Rota Raiz
app.get("/", (req, res) => {
  res.send("API da Lotofácil (PostgreSQL + Express) está no ar.");
});

// Inicia o servidor
app.listen(port, () => {
  console.log(`API da Lotofácil rodando na porta ${port}`);
});
