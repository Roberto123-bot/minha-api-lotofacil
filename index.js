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
const API_LOTOFACIL_BASE_URL =
  "https://api.guidi.dev.br/loteria/lotofacil/ultimo";

// NOVA FUNÇÃO: Busca um concurso específico (ou 'ultimo')
async function buscarConcursoEspecifico(numero) {
  console.log(`Buscando concurso: ${numero}...`);
  try {
    const response = await axios.get(`${API_LOTOFACIL_BASE_URL}/${numero}`);
    const apiData = response.data;

    // Verifica se a API retornou dados válidos
    if (!apiData || !apiData.numero) {
      throw new Error("API retornou dados inválidos.");
    }

    const dadosObtidos = {
      concurso: apiData.numero,
      data: apiData.dataApuracao,
      dezenas: apiData.listaDezenas.join(" "),
    };
    return dadosObtidos;
  } catch (error) {
    console.error(`Erro ao buscar concurso ${numero}:`, error.message);
    return null;
  }
}

// NOVA FUNÇÃO: Pega o último concurso salvo no NOSSO banco
async function getMyLatestConcurso() {
  try {
    const { rows } = await pool.query(
      "SELECT concurso FROM resultados ORDER BY concurso DESC LIMIT 1"
    );
    if (rows.length > 0) {
      return rows[0].concurso; // ex: 3537
    } else {
      return 0; // Se o banco estiver vazio
    }
  } catch (error) {
    console.error("Erro ao buscar último concurso do DB:", error.message);
    return 0;
  }
}

// FUNÇÃO DE SALVAR (Otimizada)
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
      return `Sucesso! Concurso ${concurso} salvo.`;
    } else {
      return `Concurso ${concurso} já existia. Pulando.`;
    }
  } catch (error) {
    return `Erro ao salvar concurso ${concurso}: ${error.message}`;
  }
}

// --- ENDPOINTS DA API ---

// 1. Endpoint para o Frontend (Vercel)
app.get("/api/resultados", async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  // ... (código existente, não muda)
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

// Endpoint do Worker (AGORA COM LÓGICA DE BACKFILL)
app.all("/api/worker/run", async (req, res) => {
  console.log("Worker /api/worker/run chamado...");

  // 1. Pega o último resultado da API
  const ultimoConcursoOficial = await buscarConcursoEspecifico("ultimo");
  if (!ultimoConcursoOficial) {
    return res
      .status(500)
      .json({ message: "Falha ao buscar último concurso da API." });
  }

  const apiLatestNum = ultimoConcursoOficial.concurso; // ex: 3539

  // 2. Pega o nosso último resultado
  const myLatestNum = await getMyLatestConcurso(); // ex: 3537

  // 3. Verifica se há concursos faltando
  if (myLatestNum >= apiLatestNum) {
    const message = "Banco de dados já está atualizado.";
    console.log(message);
    return res.status(200).json({ message: message });
  }

  // 4. Se houver, preenche a lacuna (o backfill)
  // ex: Loop de (3537 + 1) até 3539
  const logs = [];
  console.log(
    `Iniciando backfill do concurso ${myLatestNum + 1} até ${apiLatestNum}...`
  );

  for (let i = myLatestNum + 1; i <= apiLatestNum; i++) {
    let dadosDoConcurso;
    if (i === apiLatestNum) {
      // Otimização: Já temos os dados do último, não precisa buscar de novo
      dadosDoConcurso = ultimoConcursoOficial;
    } else {
      // Busca os concursos faltando (ex: 3538)
      dadosDoConcurso = await buscarConcursoEspecifico(i);
    }

    if (dadosDoConcurso) {
      const logMessage = await salvarResultado(dadosDoConcurso);
      console.log(logMessage);
      logs.push(logMessage);
    } else {
      const logMessage = `Falha ao processar concurso ${i}.`;
      console.log(logMessage);
      logs.push(logMessage);
    }
  }

  console.log("Backfill completo.");
  res
    .status(200)
    .json({ message: "Worker executado com sucesso.", logs: logs });
});

// Rota Raiz
app.get("/", (req, res) => {
  res.send("API da Lotofácil (PostgreSQL + Express) está no ar.");
});

// Inicia o servidor
app.listen(port, () => {
  console.log(`API da Lotofácil rodando na porta ${port}`);
});
