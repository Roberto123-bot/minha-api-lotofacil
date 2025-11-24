const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
// 🚨 MUDANÇA: Usaremos o Nodemailer para SMTP do Brevo
const nodemailer = require("nodemailer");
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

// ===================================
// === CONFIGURAÇÃO DO BREVO (SMTP)
// ===================================
// Cria o transporter Nodemailer com as credenciais do Brevo (lidas do .env)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST, // Ex: smtp-relay.brevo.com
  port: parseInt(process.env.EMAIL_PORT), // Ex: 587
  secure: false, // false para TLS na porta 587
  auth: {
    user: process.env.EMAIL_USER, // Login Brevo (Ex: 9c6c0001@smtp-brevo.com)
    pass: process.env.EMAIL_PASS, // Chave API / Senha SMTP do Brevo
  },
  tls: {
    // Opção recomendada para garantir a conexão TLS em hosts SMTP
    rejectUnauthorized: false,
  },
});

// Logs de configuração
console.log("\n📧 ===== CONFIGURAÇÃO DE E-MAIL (SMTP) =====");
console.log("  Serviço: Brevo (ex-Sendinblue) ✅");
console.log("  Host:", process.env.EMAIL_HOST);
console.log("  Porta:", process.env.EMAIL_PORT);
console.log("  Login:", process.env.EMAIL_USER);
console.log("  Frontend URL:", process.env.FRONTEND_URL || "NÃO CONFIGURADA");
console.log("========================================\n");

// ===================================
// === ROTA: SOLICITAR REDEFINIÇÃO
// ===================================
router.post("/forgot-password", async (req, res) => {
  console.log("📥 POST /api/forgot-password");

  try {
    const { email } = req.body; // Validação de e-mail

    if (!email) {
      return res.status(400).json({ error: "E-mail é obrigatório." });
    } // Verifica se o usuário existe

    const userResult = await pool.query(
      "SELECT id, nome, email FROM usuarios WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      // Por segurança, não revela se o e-mail existe ou não
      console.log(`⚠️ E-mail não encontrado no banco: ${email}`);
      return res.status(200).json({
        message:
          "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.",
      });
    }

    const user = userResult.rows[0];
    console.log(`✅ Usuário encontrado: ${user.nome} (${user.email})`); // Gera token único e seguro (32 bytes = 64 caracteres hex)

    const token = crypto.randomBytes(32).toString("hex");
    const expires_at = new Date(Date.now() + 3600000); // 1 hora // Salva token no banco (ON CONFLICT para garantir que só haja um token por usuário)

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

    console.log(`🔗 Link de redefinição: ${resetLink}`); // Configuração do e-mail

    // Brevo exige que o email FROM seja um domínio/email verificado. Usamos o EMAIL_USER
    const fromEmail = process.env.EMAIL_USER;
    const destinatario = email; // Enviando para o email do usuário

    console.log(
      `📤 Tentando enviar e-mail via Brevo SMTP para: ${destinatario}`
    );

    const mailOptions = {
      from: `Lotofácil <${fromEmail}>`,
      to: destinatario,
      // Reply-to pode ser seu email pessoal, se verificado
      reply_to: process.env.VERIFIED_EMAIL || fromEmail,
      subject: "🔐 Redefinição de Senha - Lotofácil",
      html: `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
      body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
      .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
      .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; }
      .content { padding: 40px 30px; }
      .button-container { text-align: center; margin: 30px 0; }
      .button { display: inline-block; padding: 15px 40px; background-color: #4CAF50; color: white !important; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px; }
      </style>
      </head>
      <body>
      <div class="container">
      <div class="header"><h1>🎰 Lotofácil</h1></div>
      <div class="content">
      <p>Olá, <strong>${user.nome}</strong>!</p>
      <p>Você solicitou a redefinição de senha da sua conta.</p>
      <p>Clique no botão abaixo para criar uma nova senha:</p>

      <div class="button-container">
      <a href="${resetLink}" class="button">🔓 Redefinir Senha</a>
      </div>
      </div>
      </div>
      </body>
      </html>
        `,
    };

    await transporter.sendMail(mailOptions); // 🚨 Usa o Nodemailer

    console.log(
      `✅ E-mail enviado com sucesso via Brevo SMTP para: ${destinatario}`
    );

    res.status(200).json({
      message:
        "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.",
    });
  } catch (error) {
    console.error("❌ Erro ao processar forgot-password (Brevo):", error);
    let errorMessage =
      "Erro no envio de e-mail. Verifique as credenciais SMTP do Brevo.";
    if (error.message?.includes("Invalid login") || error.code === "EAUTH") {
      errorMessage =
        "Erro de autenticação no Brevo. Verifique EMAIL_PASS (API Key).";
    }

    res.status(500).json({
      error: errorMessage,
      detalhes: error.message,
    });
  }
});

// ===================================
// === ROTA: REDEFINIR SENHA
// ===================================
router.post("/reset-password", async (req, res) => {
  console.log("📥 POST /api/reset-password");

  try {
    const { token, novaSenha } = req.body; // Validações

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

    console.log(`✅ Senha redefinida com sucesso para: ${reset.email}`); // Envia e-mail de confirmação (opcional)

    try {
      const fromEmail = process.env.EMAIL_USER;
      const mailOptions = {
        from: `Lotofácil <${fromEmail}>`,
        to: reset.email,
        reply_to: process.env.EMAIL_USER,
        subject: "✅ Senha Redefinida com Sucesso",
        html: `<p>Olá, ${reset.nome}! Sua senha foi redefinida com sucesso.</p>`,
      };
      await transporter.sendMail(mailOptions);
      console.log(`✅ E-mail de confirmação enviado para: ${reset.email}`);
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
