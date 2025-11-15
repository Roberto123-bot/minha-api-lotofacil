require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("ERRO: DATABASE_URL não encontrada.");
  process.exit(1);
}
const pool = new Pool({
  connectionString: connectionString,
});

// --- LÓGICA DE NEGÓCIO (Baseada no seu script) ---

// URL da API OFICIAL DA CAIXA
const API_CAIXA_URL =
  "https://servicebus2.caixa.gov.br/portaldeloterias/api/lotofacil";

// 🔹 Função para normalizar os dados (igual ao seu script)
function normalizarConcurso(apiData) {
  return {
    concurso: apiData.numero,
    data: apiData.dataApuracao,
    // Mudança: o seu script antigo salvava um array, nosso banco salva uma string
    dezenas: apiData.listaDezenas.join(" "),
  };
}

// 🔹 Função para buscar o último salvo (agora no Postgres)
async function getMyLatestConcurso() {
  try {
    const { rows } = await pool.query(
      "SELECT concurso FROM resultados ORDER BY concurso DESC LIMIT 1"
    );
    if (rows.length > 0) {
      return rows[0].concurso; // ex: 3537
    } else {
      return 0;
    }
  } catch (error) {
    console.error("Erro ao buscar último concurso do DB:", error.message);
    return 0; // Retorna 0 em caso de erro para tentar sincronizar do zero
  }
}

// 🔹 Função para salvar no Postgres
async function salvarResultado(dados) {
  const { concurso, data, dezenas } = dados;
  const [dia, mes, ano] = data.split("/");
  const dataFormatada = `${ano}-${mes}-${dia}`;

  const query = `
        INSERT INTO resultados (concurso, data, dezenas)
        VALUES ($1, $2, $3)
        ON CONFLICT (concurso) DO NOTHING;
    `;
  // Usamos ON CONFLICT para ser seguro, mesmo que a lógica principal já evite duplicatas
  await pool.query(query, [concurso, dataFormatada, dezenas]);
}

// --- ENDPOINTS DA API ---

// Endpoint do Frontend (continua igual)
app.get("/api/resultados", async (req, res) => {
  // ... (Este código não muda)
  const limit = parseInt(req.query.limit) || 10;
  try {
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

// Endpoint do Worker (AGORA USANDO A LÓGICA DO SEU SCRIPT ANTIGO)
app.all("/api/worker/run", async (req, res) => {
  console.log("Worker /api/worker/run chamado...");
  const logs = [];

  try {
    // 1 - Descobrir último concurso salvo
    const ultimoNumero = await getMyLatestConcurso();
    console.log("Último salvo no banco:", ultimoNumero);
    logs.push(`Último salvo no banco: ${ultimoNumero}`);

    // 2 - Buscar último concurso na API da Caixa
    const { data: ultimoApi } = await axios.get(API_CAIXA_URL); // Busca o último
    const ultimoApiNumero = Number(ultimoApi.numero);
    console.log("Último disponível na API:", ultimoApiNumero);
    logs.push(`Último disponível na API: ${ultimoApiNumero}`);

    // 3 - Se já está atualizado, encerrar
    if (ultimoNumero >= ultimoApiNumero) {
      console.log("Banco já está atualizado.");
      logs.push("Banco já está atualizado.");
      return res
        .status(200)
        .json({ message: "Banco já está atualizado.", logs });
    }

    // 4 - Buscar concursos faltantes
    // (Loop do seu script, de ultimoNumero + 1 até ultimoApiNumero)
    console.log(
      `Iniciando backfill de ${ultimoNumero + 1} até ${ultimoApiNumero}`
    );

    for (let i = ultimoNumero + 1; i <= ultimoApiNumero; i++) {
      try {
        let doc;
        if (i === ultimoApiNumero) {
          // Otimização: já temos o último, não busca de novo
          doc = normalizarConcurso(ultimoApi);
        } else {
          // Busca os concursos do meio
          const { data } = await axios.get(`${API_CAIXA_URL}/${i}`);
          doc = normalizarConcurso(data);
        }

        await salvarResultado(doc);
        const logMsg = `✅ Concurso ${i} salvo com sucesso!`;
        console.log(logMsg);
        logs.push(logMsg);
      } catch (err) {
        // Se a API da Caixa falhar em um concurso do meio (raro), nós pulamos
        const logMsg = `⚠️ Erro ao salvar concurso ${i}: ${err.message}`;
        console.error(logMsg);
        logs.push(logMsg);
      }
    }

    console.log("Sincronização concluída.");
    res.status(200).json({ message: "Sincronização concluída.", logs });
  } catch (error) {
    console.error("Erro na sincronização:", error.message);
    res
      .status(500)
      .json({ message: "Erro na sincronização", error: error.message });
  }
});

// Rota Raiz (continua igual)
app.get("/", (req, res) => {
  res.send("API da Lotofácil (PostgreSQL + Express) está no ar.");
});

// Inicia o servidor (continua igual)
app.listen(port, () => {
  console.log(`API da Lotofácil rodando na porta ${port}`);
});
