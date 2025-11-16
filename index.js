require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcryptjs"); // Para senhas
const jwt = require("jsonwebtoken"); // Para o token

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("ERRO: DATABASE_URL não encontrada.");
  process.exit(1);
}

// NOVO: Verificar o segredo do JWT
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.error("ERRO: JWT_SECRET não encontrado no .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: connectionString,
});

// ===================================
// === NOVAS ROTAS DE AUTENTICAÇÃO ===
// ===================================

// ROTA DE REGISTRO
app.post("/api/register", async (req, res) => {
  try {
    const { nome, email, senha } = req.body;

    // 1. Validar inputs (básico)
    if (!nome || !email || !senha) {
      return res
        .status(400)
        .json({ error: "Nome, email e senha são obrigatórios." });
    }

    // 2. Verificar se o usuário já existe
    const userExists = await pool.query(
      "SELECT * FROM usuarios WHERE email = $1",
      [email]
    );
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: "Este email já está cadastrado." });
    }

    // 3. Criptografar a senha (Hash)
    const salt = await bcrypt.genSalt(10); // "Tempero" para o hash
    const senha_hash = await bcrypt.hash(senha, salt);

    // 4. Salvar no banco
    const newUser = await pool.query(
      "INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id, email, nome",
      [nome, email, senha_hash]
    );

    // 5. Responder com sucesso
    res.status(201).json({
      id: newUser.rows[0].id,
      email: newUser.rows[0].email,
      nome: newUser.rows[0].nome,
    });
  } catch (error) {
    console.error("Erro no registro:", error.message);
    res.status(500).json({ error: "Erro interno do servidor." });
  }
});

// ROTA DE LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { email, senha } = req.body;

    // 1. Validar inputs
    if (!email || !senha) {
      return res.status(400).json({ error: "Email e senha são obrigatórios." });
    }

    // 2. Buscar o usuário no banco
    const userResult = await pool.query(
      "SELECT * FROM usuarios WHERE email = $1",
      [email]
    );

    // 3. Se o usuário NÃO for encontrado
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: "Email ou senha inválidos." }); // Mensagem genérica por segurança
    }
    const user = userResult.rows[0];

    // 4. Comparar a senha enviada com a senha "hash" do banco
    const senhaCorreta = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaCorreta) {
      return res.status(401).json({ error: "Email ou senha inválidos." });
    }

    // 5. Gerar o Token (O "crachá" de login)
    const token = jwt.sign(
      { id: user.id, email: user.email, nome: user.nome }, // O que vai dentro do crachá
      jwtSecret, // A chave secreta para assinar
      { expiresIn: "8h" } // Validade do crachá
    );

    // 6. Enviar o token para o front-end
    res.status(200).json({
      token: token,
      usuario: {
        id: user.id,
        email: user.email,
        nome: user.nome,
      },
    });
  } catch (error) {
    console.error("Erro no login:", error.message);
    res.status(500).json({ error: "Erro interno do servidor." });
  }
});

// ===================================
// === MIDDLEWARE DE AUTENTICAÇÃO ===
// ===================================
// (Este é o "Segurança" da porta)
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) {
    return res
      .status(401)
      .json({ error: "Acesso não autorizado. Token não fornecido." });
  }
  jwt.verify(token, jwtSecret, (err, usuario) => {
    if (err) {
      return res
        .status(403)
        .json({ error: "Acesso proibido. Token inválido." });
    }
    req.usuario = usuario;
    next();
  });
}

// ===================================
// === ROTAS DA LOTOFÁCIL (Resultados) ===
// ===================================
// (Suas funções e rotas de resultados continuam aqui... igual)
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
    const ultimoSalvo = await getUltimoSalvo();
    console.log("Último salvo no banco:", ultimoSalvo);
    const { data: ultimaApi } = await axios.get(
      "https://api.guidi.dev.br/loteria/lotofacil/ultimo"
    );
    const ultimoApiNumero = Number(ultimaApi.numero);
    console.log("Último disponível na API:", ultimoApiNumero);
    if (ultimoSalvo >= ultimoApiNumero) {
      console.log("Banco já está atualizado ✅");
      return {
        message: "Banco já está atualizado",
        concursosAdicionados: 0,
        ultimoConcurso: ultimoSalvo,
      };
    }
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

// Endpoint do Frontend (AGORA PROTEGIDO!)
app.get("/api/resultados", authMiddleware, async (req, res) => {
  console.log(
    `Usuário ${req.usuario.email} (ID: ${req.usuario.id}) está buscando resultados.`
  );
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

// ===================================
// === NOVAS ROTAS DE JOGOS SALVOS ===
// ===================================

// ROTA PARA SALVAR UM NOVO JOGO (A ROTA ANTIGA, AINDA ÚTIL)
app.post("/api/jogos/salvar", authMiddleware, async (req, res) => {
  const { dezenas } = req.body;
  const usuario_id = req.usuario.id;
  if (!dezenas || typeof dezenas !== "string") {
    return res.status(400).json({ error: "Formato de dezenas inválido." });
  }
  try {
    const query = `
      INSERT INTO jogos_salvos (dezenas, usuario_id)
      VALUES ($1, $2)
      RETURNING *; 
    `;
    const { rows } = await pool.query(query, [dezenas, usuario_id]);
    res.status(201).json(rows[0]); // Retorna o jogo que foi salvo
  } catch (error) {
    console.error("Erro ao salvar jogo:", error.message);
    res.status(500).json({ error: "Erro interno ao salvar o jogo." });
  }
});

// =======================================================
// === INÍCIO: NOVA ROTA PARA SALVAR EM LOTE (BULK)
// =======================================================
app.post("/api/jogos/salvar-lote", authMiddleware, async (req, res) => {
  const { jogos } = req.body; // Espera um array de strings, ex: ["01 02...", "03 04..."]
  const usuario_id = req.usuario.id;

  // Validação
  if (!Array.isArray(jogos) || jogos.length === 0) {
    return res.status(400).json({ error: "Formato de jogos inválido." });
  }

  // Query otimizada para PostgreSQL usando 'unnest'
  // Isso faz UMA SÓ operação no banco de dados para todos os jogos
  const query = `
    INSERT INTO jogos_salvos (dezenas, usuario_id)
    SELECT 
      dezenas_val, $2 
    FROM unnest($1::text[]) AS dezenas_val
    RETURNING id; 
  `;
  // $1::text[] -> Trata o primeiro parâmetro (jogos) como um array de texto
  // $2 -> O segundo parâmetro (usuario_id)

  try {
    // Passa o array de jogos [jogos] e o ID do usuário [usuario_id]
    const { rows } = await pool.query(query, [jogos, usuario_id]);

    res.status(201).json({
      message: `${rows.length} jogo(s) salvo(s) com sucesso.`,
      jogosSalvos: rows.length,
    });
  } catch (error) {
    console.error("Erro ao salvar jogos em lote:", error.message);
    res.status(500).json({ error: "Erro interno ao salvar os jogos." });
  }
});
// =======================================================
// === FIM: NOVA ROTA PARA SALVAR EM LOTE (BULK)
// =======================================================

// ROTA PARA BUSCAR OS JOGOS DO USUÁRIO
app.get("/api/jogos/meus-jogos", authMiddleware, async (req, res) => {
  const usuario_id = req.usuario.id;
  try {
    const query = `
      SELECT id, dezenas, data_criacao 
      FROM jogos_salvos
      WHERE usuario_id = $1
      ORDER BY data_criacao DESC; -- (Opcional: mostra os mais novos primeiro)
    `;
    const { rows } = await pool.query(query, [usuario_id]);
    res.status(200).json(rows); // Retorna a lista de jogos salvos
  } catch (error) {
    console.error("Erro ao buscar jogos:", error.message);
    res.status(500).json({ error: "Erro interno ao buscar seus jogos." });
  }
});

// === NOVA ROTA PARA DELETAR JOGOS ===
app.post("/api/jogos/delete", authMiddleware, async (req, res) => {
  const { ids } = req.body; // Espera um array de IDs, ex: [1, 2, 5]
  const usuario_id = req.usuario.id;

  // Validação
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "IDs de jogos inválidos." });
  }

  try {
    // Comando SQL para deletar MÚLTIPLOS IDs de uma vez
    // Ele só deleta os jogos ONDE o ID está na lista E o dono é o usuário logado
    const query = `
      DELETE FROM jogos_salvos
      WHERE id = ANY($1::int[]) AND usuario_id = $2;
    `;
    // $1::int[] informa ao PostgreSQL que $1 é um array de inteiros

    const result = await pool.query(query, [ids, usuario_id]);

    // O 'rowCount' informa quantas linhas foram de fato deletadas
    if (result.rowCount > 0) {
      res.status(200).json({
        message: `${result.rowCount} jogo(s) deletado(s) com sucesso.`,
      });
    } else {
      res.status(404).json({
        error: "Nenhum jogo encontrado para deletar (ou não pertencem a você).",
      });
    }
  } catch (error) {
    console.error("Erro ao deletar jogos:", error.message);
    res.status(500).json({ error: "Erro interno ao deletar jogos." });
  }
});

// ===================================
// === ROTAS FINAIS ===
// ===================================

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
