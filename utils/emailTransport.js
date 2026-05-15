const nodemailer = require("nodemailer");

const EMAIL_USER = (process.env.EMAIL_USER || "").trim();
const EMAIL_PASS = (process.env.EMAIL_PASS || "").replace(/\s+/g, "").trim();
const DEFAULT_FROM = "SmritiCare <noreply@smriticare.app>";
const EMAIL_FROM = (process.env.EMAIL_FROM || (EMAIL_USER && EMAIL_USER.toLowerCase() !== "apikey" ? `SmritiCare <${EMAIL_USER}>` : DEFAULT_FROM)).trim();
const SMTP_HOST = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === "true" ? true : process.env.SMTP_SECURE === "false" ? false : SMTP_PORT === 465;
const SMTP_REQUIRE_TLS = process.env.SMTP_REQUIRE_TLS === "true" ? true : process.env.SMTP_REQUIRE_TLS === "false" ? false : !SMTP_SECURE;

const emailConfigured = Boolean(EMAIL_USER && EMAIL_PASS && SMTP_HOST && SMTP_PORT);

const transporter = emailConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      requireTLS: SMTP_REQUIRE_TLS,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      logger: true,
      debug: true,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      }
    })
  : null;

module.exports = {
  transporter,
  EMAIL_FROM,
  emailConfigured
};
