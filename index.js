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

// --- LÓGICA DE NEGÓCIO ---

// URL base da API
const API_LOTOFACIL_BASE_URL =
  "https://api.guidi.dev.br/loteria/lotofacil/ultimo";

// Busca um concurso ESPECÍFICO (por número)
async function buscarConcursoEspecifico(numero) {
  console.log(`Buscando concurso: ${numero}...`);
  try {
    const response = await axios.get(`${API_LOTOFACIL_BASE_URL}/${numero}`);
    const apiData = response.data;

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
    // Se der 404 (Não encontrado), a API está nos dizendo que o concurso não existe.
    if (error.response && error.response.status === 404) {
      console.log(`Concurso ${numero} não encontrado (404).`);
      return null; // Isso é o que esperamos quando chegarmos ao fim.
    }
    console.error(`Erro ao buscar concurso ${numero}:`, error.message);
    return null; // Trata outros erros
  }
}

// Pega o último concurso salvo no NOSSO banco
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

// Salva o resultado no nosso banco
async function salvarResultado(dados) {
  const { concurso, data, dezenas } = dados;
  const [dia, mes, ano] = data.split("/");
  const dataFormatada = `${ano}-${mes}-${dia}`;

  const query = `
        INSERT INTO resultados (concurso, data, dezenas)
        VALUES ($1, $2, $3)
        ON CONFLICT (concurso) DO NOTHING
    `;
  try {
    await pool.query(query, [concurso, dataFormatada, dezenas]);
    return `Sucesso! Concurso ${concurso} salvo.`;
  } catch (error) {
    return `Erro ao salvar concurso ${concurso}: ${error.message}`;
  }
}

// --- ENDPOINTS DA API ---

// Endpoint do Frontend (continua igual)
app.get("/api/resultados", async (req, res) => {
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

// Endpoint do Worker (LÓGICA DE PREENCHIMENTO CONTÍNUO)
app.all("/api/worker/run", async (req, res) => {
  console.log("Worker /api/worker/run chamado...");

  let meuUltimoConcurso = await getMyLatestConcurso(); // ex: 3537
  const logs = [];

  // Loop infinito seguro (máximo de 10 concursos por vez para evitar loops)
  for (let i = 0; i < 10; i++) {
    let proximoConcursoNum = meuUltimoConcurso + 1; // ex: 3538

    const dadosDoConcurso = await buscarConcursoEspecifico(proximoConcursoNum);

    // Se a API retornar 'null' (404), significa que estamos atualizados.
    if (!dadosDoConcurso) {
      const message = `Banco de dados está atualizado. (Verificou ${proximoConcursoNum} e não foi encontrado).`;
      console.log(message);
      logs.push(message);
      break; // Sai do loop
    }

    // Se o concurso foi encontrado, salvamos
    const logMessage = await salvarResultado(dadosDoConcurso);
    console.log(logMessage);
    logs.push(logMessage);

    // Atualiza nosso número de controle para o próximo loop
    meuUltimoConcurso = proximoConcursoNum;
  }

  if (logs.length === 0) {
    logs.push("Nenhuma ação necessária.");
  }

  console.log("Worker finalizado.");
  res.status(200).json({ message: "Worker executado.", logs: logs });
});

// Rota Raiz (continua igual)
app.get("/", (req, res) => {
  res.send("API da Lotofácil (PostgreSQL + Express) está no ar.");
});

// Inicia o servidor (continua igual)
app.listen(port, () => {
  console.log(`API da Lotofácil rodando na porta ${port}`);
});
