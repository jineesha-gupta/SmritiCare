const axios = require("axios");

const SENDGRID_API_KEY = (process.env.EMAIL_PASS || "").trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || "SmritiCare <noreply@smriticare.app>").trim();

const emailConfigured = Boolean(SENDGRID_API_KEY);

/**
 * SendGrid Web API v3 - uses HTTPS (won't be blocked by Render)
 * Replaces nodemailer SMTP transport.
 */
const transporter = {
  async sendMail({ to, subject, html, text }) {
    if (!SENDGRID_API_KEY) {
      throw new Error("SendGrid API key not configured");
    }

    // Parse EMAIL_FROM to extract name and address
    let fromEmail = "noreply@smriticare.app";
    let fromName = "SmritiCare";

    const fromMatch = EMAIL_FROM.match(/^(.+?)\s*<(.+?)>$/) || EMAIL_FROM.match(/^(.+?)$/);
    if (fromMatch && fromMatch[2]) {
      fromName = fromMatch[1].trim();
      fromEmail = fromMatch[2].trim();
    } else if (fromMatch && fromMatch[1]) {
      fromEmail = fromMatch[1].trim();
    }

    const payload = {
      personalizations: [
        {
          to: [{ email: to }],
          subject
        }
      ],
      from: {
        email: fromEmail,
        name: fromName
      },
      content: [
        {
          type: "text/html",
          value: html || text || ""
        }
      ]
    };

    try {
      const response = await axios.post("https://api.sendgrid.com/v3/mail/send", payload, {
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true, messageId: response.headers["x-message-id"] };
      } else {
        throw new Error(`SendGrid API error: ${response.status}`);
      }
    } catch (err) {
      console.error("SendGrid Web API error:", {
        message: err.message,
        status: err.response?.status,
        data: err.response?.data
      });
      throw err;
    }
  },

  async verify() {
    if (!SENDGRID_API_KEY) {
      throw new Error("SendGrid API key not configured");
    }
    return true; // Basic verification; SendGrid API calls will fail if key is invalid
  }
};

module.exports = {
  transporter,
  EMAIL_FROM,
  emailConfigured
};
