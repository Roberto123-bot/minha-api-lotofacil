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

// Busca o último concurso salvo no banco
async function getUltimoSalvo() {
  try {
    const result = await pool.query(
      "SELECT concurso FROM resultados ORDER BY concurso DESC LIMIT 1"
    );
    if (result.rows.length > 0) {
      return result.rows[0].concurso;
    }
    return 0; // Banco vazio
  } catch (error) {
    console.error("Erro ao buscar último concurso:", error.message);
    return 0;
  }
}

// Normaliza os dados do concurso para o formato do banco
function normalizarConcurso(data) {
  const [dia, mes, ano] = data.dataApuracao.split("/");
  const dataFormatada = `${ano}-${mes}-${dia}`;

  return {
    concurso: data.numero,
    data: dataFormatada,
    dezenas: data.listaDezenas.join(" "),
  };
}

// Salva resultado no banco
async function salvarConcurso(doc) {
  const query = `
    INSERT INTO resultados (concurso, data, dezenas)
    VALUES ($1, $2, $3)
    ON CONFLICT (concurso) DO NOTHING
  `;
  try {
    await pool.query(query, [doc.concurso, doc.data, doc.dezenas]);
    console.log(`✅ Concurso ${doc.concurso} salvo com sucesso!`);
    return true;
  } catch (error) {
    console.error(`⚠️ Erro ao salvar concurso ${doc.concurso}:`, error.message);
    return false;
  }
}

// Função principal de sincronização
async function syncLotofacil() {
  try {
    // 1 - Descobrir último concurso salvo
    const ultimoSalvo = await getUltimoSalvo();
    console.log("Último salvo no banco:", ultimoSalvo);

    // 2 - Buscar último concurso na API
    const { data: ultimaApi } = await axios.get(
      "https://api.guidi.dev.br/loteria/lotofacil/ultimo"
    );
    const ultimoApiNumero = Number(ultimaApi.numero);
    console.log("Último disponível na API:", ultimoApiNumero);

    // 3 - Se já está atualizado, encerrar
    if (ultimoSalvo >= ultimoApiNumero) {
      console.log("Banco já está atualizado ✅");
      return {
        message: "Banco já está atualizado",
        concursosAdicionados: 0,
        ultimoConcurso: ultimoSalvo,
      };
    }

    // 4 - Buscar concursos faltantes
    let concursosAdicionados = 0;
    for (let i = ultimoSalvo + 1; i <= ultimoApiNumero; i++) {
      try {
        const { data } = await axios.get(
          `https://api.guidi.dev.br/loteria/lotofacil/${i}`
        );
        const doc = normalizarConcurso(data);
        const salvou = await salvarConcurso(doc);
        if (salvou) {
          concursosAdicionados++;
        }
      } catch (err) {
        console.error(`⚠️ Erro ao salvar concurso ${i}:`, err.message);
      }
    }

    console.log("Sincronização concluída 🚀");
    return {
      message: "Sincronização concluída com sucesso",
      concursosAdicionados: concursosAdicionados,
      ultimoConcurso: ultimoApiNumero,
    };
  } catch (error) {
    console.error("Erro na sincronização:", error.message);
    throw error;
  }
}

// --- ENDPOINTS DA API ---

// Endpoint do Frontend
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

// Endpoint do Worker
app.all("/api/worker/run", async (req, res) => {
  console.log("Worker /api/worker/run chamado...");
  try {
    const resultado = await syncLotofacil();
    res.status(200).json(resultado);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao executar sincronização",
      message: error.message,
    });
  }
});

// Rota Raiz
app.get("/", (req, res) => {
  res.send("API da Lotofácil (PostgreSQL + Express) está no ar.");
});

// Inicia o servidor
app.listen(port, () => {
  console.log(`API da Lotofácil rodando na porta ${port}`);
});
