const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");

// Carrega a pool de conexão
let pool;
try {
  pool = require("../server").pool;
} catch (err) {
  pool = require("../index").pool;
}

// ===================================
// === CONFIGURAÇÃO DO RESEND
// ===================================
const resend = new Resend(process.env.RESEND_API_KEY);

console.log("📧 Configuração de E-mail:");
console.log(
  "   Método:",
  process.env.RESEND_API_KEY ? "Resend API" : "SMTP Gmail"
);
console.log(
  "   Resend API:",
  process.env.RESEND_API_KEY ? "✅ Configurada" : "❌ Faltando"
);
console.log("   Email de Teste (TO):", process.env.VERIFIED_EMAIL); // Novo Log

// ===================================
// === ROTA: SOLICITAR REDEFINIÇÃO
// ===================================
router.post("/forgot-password", async (req, res) => {
  console.log("📥 POST /api/forgot-password");

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: "E-mail é obrigatório.",
      });
    } // Verifica se o usuário existe

    const userResult = await pool.query(
      "SELECT id, nome, email FROM usuarios WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      console.log(`⚠️ E-mail não encontrado: ${email}`);
      return res.status(200).json({
        message:
          "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.",
      });
    }

    const user = userResult.rows[0]; // Gera token único e seguro

    const token = crypto.randomBytes(32).toString("hex");
    const expires_at = new Date(Date.now() + 3600000); // 1 hora // Salva token no banco (ON CONFLICT para garantir que só haja um token por usuário)

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) 
        DO UPDATE SET token = $2, expires_at = $3`,
      [user.id, token, expires_at]
    ); // Link de redefinição

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    console.log(`🔗 Link de redefinição gerado: ${resetLink}`); // E-mail de destino (usa o e-mail verificado para contornar a restrição do Resend)

    const destinatario = process.env.VERIFIED_EMAIL;
    const fromEmail = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

    console.log(`📤 Tentando enviar e-mail para (TESTE): ${destinatario}`);

    const { data, error } = await resend.emails.send({
      from: `Lotofácil <${fromEmail}>`,
      to: [destinatario], // 🚨 ENVIANDO PARA O E-MAIL VERIFICADO!
      reply_to: "robertosantosloteria@gmail.com",
      subject: "🔐 Redefinição de Senha - Lotofácil (TESTE)",
      html: `
      <!DOCTYPE html>
      <html>
      <head>
      <meta charset="UTF-8">
      <style>/* ... style ommited ... */</style>
      </head>
      <body>
      <div class="container">
      <div class="header">
      <h1>🎰 Lotofácil</h1>
      <p>Redefinição de Senha</p>
      </div>
      <div class="content">
      <p>Olá, <strong>${user.nome}</strong>!</p>
      <p><strong>NOTA: Este e-mail é um teste.</strong> A redefinição foi solicitada para <strong>${email}</strong>.</p>
      <p>Clique no botão abaixo para criar a nova senha:</p>

      <center>
      <a href="${resetLink}" class="button">🔓 Redefinir Senha</a>
      </center>

      <div class="footer">
      <p>Link direto: <p style="word-break: break-all; color: #667eea;">${resetLink}</p>
      </div>
      </div>
      </div>
      </body>
      </html>
      `,
    });

    if (error) {
      console.error("❌ FALHA CRÍTICA NO RESEND:", error);
      throw new Error(error.message); // Lança o erro para o catch
    }

    console.log(`✅ E-mail enviado com sucesso! ID: ${data.id}`);

    res.status(200).json({
      message:
        "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.",
    });
  } catch (error) {
    console.error("❌ Erro ao processar forgot-password:", error);
    res.status(500).json({
      error: "Erro ao processar solicitação. Verifique se o e-mail existe.",
      detalhes: error.message,
    });
  }
});

// ... (código restante da rota /reset-password)

router.post("/reset-password", async (req, res) => {
  console.log("📥 POST /api/reset-password");

  try {
    const { token, novaSenha } = req.body;

    if (!token || !novaSenha) {
      return res.status(400).json({
        error: "Token e nova senha são obrigatórios.",
      });
    }

    if (novaSenha.length < 6) {
      return res.status(400).json({
        error: "A senha deve ter no mínimo 6 caracteres.",
      });
    } // Busca token válido

    const resetResult = await pool.query(
      `SELECT pr.*, u.email, u.nome 
        FROM password_reset_tokens pr
        JOIN usuarios u ON pr.user_id = u.id
        WHERE pr.token = $1 AND pr.expires_at > NOW()`,
      [token]
    );

    if (resetResult.rows.length === 0) {
      console.log(`❌ Token inválido ou expirado: ${token}`);
      return res.status(400).json({
        error:
          "Token inválido ou expirado. Solicite um novo link de redefinição.",
      });
    }

    const reset = resetResult.rows[0]; // Criptografa nova senha

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
      const fromEmail =
        process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

      await resend.emails.send({
        from: `Lotofácil <${fromEmail}>`,
        to: [reset.email],
        reply_to: "robertosantosloteria@gmail.com",
        subject: "✅ Senha Redefinida com Sucesso",
        html: `<!-- ... html de confirmação ... -->`,
      });
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
