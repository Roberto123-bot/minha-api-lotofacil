const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
// NOTA: Removemos o Nodemailer/Resend pois usaremos a API HTTP
require("dotenv").config();

// Carrega a pool de conexão
let pool;
try {
  pool = require("../server").pool;
} catch (err) {
  try {
    pool = require("../index").pool;
  } catch (err2) {
    console.error("❌ Erro ao importar pool do banco de dados");
  }
}

// Brevo API Host e Key (Lidos do .env)
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_API_KEY = process.env.EMAIL_PASS;
const EMAIL_USER = process.env.EMAIL_USER;

// ===================================
// === FUNÇÃO AUXILIAR: ENVIAR EMAIL VIA API (HTTPS)
// ===================================
async function sendEmailBrevo(toEmail, subject, htmlContent) {
  if (!BREVO_API_KEY) {
    throw new Error("Brevo API Key (EMAIL_PASS) não configurada.");
  }

  // A chave API do Brevo é usada no header 'api-key'
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "api-key": BREVO_API_KEY,
  };

  // Objeto de dados para a API V3 do Brevo
  const data = {
    sender: { email: EMAIL_USER, name: "Lotofácil App" },
    to: [{ email: toEmail }],
    subject: subject,
    htmlContent: htmlContent,
  };

  try {
    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(data),
    });

    if (response.status >= 400) {
      const errorData = await response.json().catch(() => ({}));
      const apiMessage =
        errorData.message || "Erro desconhecido na API do Brevo.";
      console.error("❌ Falha na API Brevo:", apiMessage);
      throw new Error(`Falha no Brevo API: ${apiMessage}`);
    }

    console.log(`✅ E-mail enviado com sucesso via Brevo API (HTTPS).`);
    return true;
  } catch (error) {
    throw new Error(`Erro de rede/API: ${error.message}`);
  }
}

// ===================================
// === ROTA: SOLICITAR REDEFINIÇÃO
// ===================================
router.post("/forgot-password", async (req, res) => {
  console.log("📥 POST /api/forgot-password");

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "E-mail é obrigatório." });
    } // 1. Verifica se o usuário existe

    const userResult = await pool.query(
      "SELECT id, nome, email FROM usuarios WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      console.log(`⚠️ E-mail não encontrado no banco: ${email}`);
      return res.status(200).json({
        message:
          "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.",
      });
    }

    const user = userResult.rows[0]; // Gera token único e seguro (32 bytes = 64 caracteres hex)

    const token = crypto.randomBytes(32).toString("hex");
    const expires_at = new Date(Date.now() + 3600000); // 1 hora // 2. Salva token no banco

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) 
        DO UPDATE SET token = $2, expires_at = $3`,
      [user.id, token, expires_at]
    );

    console.log(`✅ Token gerado e salvo no banco`); // Link de redefinição

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
    const resetLink = `${frontendUrl}/reset-password?token=${token}`;

    console.log(`🔗 Link de redefinição: ${resetLink}`); // 3. 🚨 NOVO: Envio via Brevo API (HTTPS)

    const emailHtml = `
      <p>Olá, ${user.nome}!</p>
      <p>Você solicitou a redefinição de senha da sua conta.</p>
      <p>Clique no botão abaixo para criar uma nova senha:</p>
      <div style="text-align:center; margin: 20px 0;">
      <a href="${resetLink}" style="display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
      🔓 Redefinir Senha
      </a>
      </div>
      <p>Este link é válido por 1 hora.</p>
      `;

    await sendEmailBrevo(
      email,
      "🔐 Redefinição de Senha - Lotofácil",
      emailHtml
    );
    // ----------------------------------------------------

    res.status(200).json({
      message:
        "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.",
    });
  } catch (error) {
    console.error("❌ Erro grave no forgot-password (API Brevo):", error);
    res.status(500).json({
      error: "Erro interno no servidor ao enviar o e-mail.",
      detalhes: error.message,
    });
  }
});

// ===================================
// === ROTA: REDEFINIR SENHA (Mantida)
// ===================================
router.post("/reset-password", async (req, res) => {
  console.log("📥 POST /api/reset-password");

  try {
    const { token, novaSenha } = req.body;

    if (!token || !novaSenha) {
      return res
        .status(400)
        .json({ error: "Token e nova senha são obrigatórios." });
    }

    if (novaSenha.length < 6) {
      return res
        .status(400)
        .json({ error: "A senha deve ter no mínimo 6 caracteres." });
    }

    console.log(`🔍 Verificando token: ${token.substring(0, 10)}...`); // Busca token válido

    const resetResult = await pool.query(
      `SELECT pr.*, u.email, u.nome 
        FROM password_reset_tokens pr
        JOIN usuarios u ON pr.user_id = u.id
        WHERE pr.token = $1 AND pr.expires_at > NOW()`,
      [token]
    );

    if (resetResult.rows.length === 0) {
      console.log(`❌ Token inválido ou expirado`);
      return res.status(400).json({
        error:
          "Token inválido ou expirado. Solicite um novo link de redefinição.",
      });
    }

    const reset = resetResult.rows[0];
    console.log(`✅ Token válido para usuário: ${reset.email}`); // Criptografa nova senha

    const salt = await bcrypt.genSalt(10);
    const senha_hash = await bcrypt.hash(novaSenha, salt); // Atualiza senha no banco

    await pool.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [
      senha_hash,
      reset.user_id,
    ]); // Remove token usado (evita reutilização)

    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [
      reset.user_id,
    ]);

    console.log(`✅ Senha redefinida com sucesso para: ${reset.email}`); // Envia e-mail de confirmação (via API Brevo, se possível)

    try {
      const subject = "✅ Senha Redefinida com Sucesso";
      const htmlContent = `<p>Olá, ${reset.nome}! Sua senha foi redefinida com sucesso.</p>`;
      await sendEmailBrevo(reset.email, subject, htmlContent);
    } catch (emailError) {
      console.error(
        "⚠️ Erro ao enviar e-mail de confirmação:",
        emailError.message
      );
    }

    res.status(200).json({
      message:
        "Senha redefinida com sucesso! Você já pode fazer login com a nova senha.",
    });
  } catch (error) {
    console.error("❌ Erro ao redefinir senha:", error);
    res.status(500).json({
      error: "Erro ao redefinir senha. Tente novamente.",
      detalhes: error.message,
    });
  }
});

module.exports = router;
