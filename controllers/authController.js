const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const User = require("../models/User");
const PatientProfile = require("../models/PatientProfile");
const CaregiverProfile = require("../models/CaregiverProfile");
const InviteCode = require("../models/InviteCode");
const { Resend } = require("resend");
const { getAuthUrl, exchangeCodeForTokens } = require("../utils/googleCalendar");
const {
  EMAIL_LOGO_CID,
  getEmailLogoAttachment,
  escapeHtml,
  buildEmailLayout
} = require("../utils/emailTheme");

const EMAIL_USER = (process.env.EMAIL_USER || "").trim();
// Gmail app passwords are often copied as "abcd efgh ijkl mnop".
// SMTP expects the raw 16-character value, so remove whitespace.
const EMAIL_PASS = (process.env.EMAIL_PASS || "").replace(/\s+/g, "").trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || `SmritiCare <${EMAIL_USER || "onboarding@resend.dev"}>`).trim();
const SMTP_HOST = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = (process.env.RESEND_FROM || "SmritiCare <onboarding@resend.dev>").trim();
const IS_PRODUCTION = process.env.NODE_ENV === "production";

let smtpTransporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS
    }
  });
}

/* RESEND SETUP */
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function isResendTestSender() {
  return /onboarding@resend\.dev/i.test(RESEND_FROM);
}

function assertEmailProviderReady() {
  if (smtpTransporter) return;

  if (!resend) {
    throw new Error("No email provider configured. Set EMAIL_USER/EMAIL_PASS or RESEND_API_KEY/RESEND_FROM.");
  }

  if (IS_PRODUCTION && isResendTestSender()) {
    throw new Error(
      "Resend is using onboarding@resend.dev. Verify a domain in Resend and set RESEND_FROM, or configure Gmail SMTP."
    );
  }
}

function hasResendProvider() {
  return Boolean(resend);
}

async function sendWithResend({ to, subject, html }) {
  if (!resend) {
    throw new Error("Resend API key is not configured");
  }

  if (IS_PRODUCTION && isResendTestSender()) {
    throw new Error("Resend production sending requires a verified RESEND_FROM sender");
  }

  await resend.emails.send({
    from: RESEND_FROM,
    to,
    subject,
    html
  });
}

const DEFAULT_SITE_URL = `http://localhost:${process.env.PORT || 3000}`;
const SITE_URL = (process.env.APP_BASE_URL || process.env.APP_URL || DEFAULT_SITE_URL).trim();

function buildCodeEmailTemplate({ title, subtitle, code, note, logoSrc }) {
  const safeCode = escapeHtml(code);
  const safeNote = escapeHtml(note);
  const bodyHtml = `
    <table role="presentation" style="width: 100%; border-collapse: collapse; margin-top: 24px;">
      <tr>
        <td style="padding: 0;">
          <div class="email-soft-card" style="background: linear-gradient(180deg, #ffffff 0%, #eff4ff 100%); border: 1px solid #d6e1fb; border-radius: 26px; text-align: center; padding: 24px 18px;">
            <p class="email-label" style="margin: 0 0 10px; color: #6d7ca1; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 800;">One-time code</p>
            <p class="email-strong" style="margin: 0; color: #171b33; font-size: 42px; line-height: 1; letter-spacing: 0.26em; font-weight: 800;">${safeCode}</p>
            <p class="email-meta" style="margin: 12px 0 0; color: #7b89a5; font-size: 13px; line-height: 1.6;">Valid for 5 minutes</p>
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding: 14px 0 0;">
          <div class="email-soft-card" style="background: rgba(255, 255, 255, 0.82); border: 1px solid #e4eaf8; border-radius: 22px; padding: 16px 18px;">
            <p class="email-copy" style="margin: 0; color: #55617f; font-size: 14px; line-height: 1.7;">
              Enter this code in the open SmritiCare window to continue securely.
            </p>
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding: 14px 0 0;">
          <div class="email-note" style="background: #f4f7ff; border: 1px solid #d8e4ff; border-left: 4px solid #88c7ff; border-radius: 20px; padding: 14px 16px;">
            <p class="email-copy" style="margin: 0; color: #55617f; font-size: 14px; line-height: 1.7;">
              ${safeNote}
            </p>
          </div>
        </td>
      </tr>
    </table>
  `;

  return buildEmailLayout({
    title,
    previewText: `${title} - ${code}`,
    badge: "Secure Access",
    eyebrow: "Verification code",
    intro: subtitle,
    bodyHtml,
    ctaLabel: "Open SmritiCare",
    ctaHref: SITE_URL,
    footerText: "You received this secure account email from SmritiCare.",
    footerMeta: "Please do not reply to this automated message.",
    logoSrc
  });
}

async function sendEmailFallback({ to, subject, html, text }) {
  if (!smtpTransporter) {
    throw new Error("SMTP email fallback is not configured");
  }

  await smtpTransporter.sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    text: text || html.replace(/<[^>]+>/g, " "),
    html
  });
}

async function sendOTP(email, otp) {
  assertEmailProviderReady();

  const title = "Email Verification";
  const subtitle = "Use the OTP below to verify your SmritiCare account and continue setup.";
  const note = "If you did not request this, please ignore this email.";
  const htmlContent = buildCodeEmailTemplate({ title, subtitle, code: otp, note, logoSrc: null });

  // SMTP first — works with ANY recipient, no domain restrictions
  if (smtpTransporter) {
    try {
      await sendEmailFallback({
        to: email,
        subject: "SmritiCare - Email Verification",
        html: htmlContent
      });
      console.log(` OTP sent to ${email} via SMTP`);
      return;
    } catch (smtpErr) {
      if (!hasResendProvider()) {
        console.error(" SMTP failed and Resend is not configured:", smtpErr.message);
        throw smtpErr;
      }
      console.error(" SMTP failed, trying Resend:", smtpErr.message);
    }
  }

  // Resend fallback — only reaches here if SMTP not configured or failed
  // NOTE: without a verified domain, Resend only delivers to your own account email
  try {
    await sendWithResend({
      to: email,
      subject: "SmritiCare - Email Verification",
      html: htmlContent
    });
    console.log(` OTP sent to ${email} via Resend`);
  } catch (err) {
    console.error(" Failed to send OTP email via Resend:", err);
    throw new Error("Failed to send verification email");
  }
}

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendPasswordResetCode(email, otp) {
  assertEmailProviderReady();

  const title = "Password Reset Code";
  const subtitle = "Use this OTP to securely reset your SmritiCare password.";
  const note = "If you did not request a password reset, you can ignore this email.";
  const htmlContent = buildCodeEmailTemplate({ title, subtitle, code: otp, note, logoSrc: null });

  // SMTP first — works with ANY recipient, no domain restrictions
  if (smtpTransporter) {
    try {
      await sendEmailFallback({
        to: email,
        subject: "SmritiCare - Password Reset Code",
        html: htmlContent
      });
      console.log(` Password reset code sent to ${email} via SMTP`);
      return;
    } catch (smtpErr) {
      if (!hasResendProvider()) {
        console.error(" SMTP failed and Resend is not configured:", smtpErr.message);
        throw smtpErr;
      }
      console.error(" SMTP failed, trying Resend:", smtpErr.message);
    }
  }

  // Resend fallback
  try {
    await sendWithResend({
      to: email,
      subject: "SmritiCare - Password Reset Code",
      html: htmlContent
    });
    console.log(` Password reset code sent to ${email} via Resend`);
  } catch (err) {
    console.error(" Failed to send password reset email via Resend:", err);
    throw new Error("Failed to send reset code");
  }
}

/* INPUT VALIDATION */
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePassword(password) {
  // At least 6 characters, 1 uppercase, 1 number, 1 special char
  if (password.length < 6) return { valid: false, message: "Password must be at least 6 characters" };
  if (!/[A-Z]/.test(password)) return { valid: false, message: "Password must contain an uppercase letter" };
  if (!/[0-9]/.test(password)) return { valid: false, message: "Password must contain a number" };
  if (!/[@$!%*?&#]/.test(password)) return { valid: false, message: "Password must contain a special character (@$!%*?&#)" };
  return { valid: true };
}

/* SIGNUP */
exports.signup = async (req, res) => {
  try {
    let { name, email, password, role } = req.body;

    // Validate inputs
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "All fields are required" });
    }

    name = name.trim();
    email = email.toLowerCase().trim();

    if (!validateEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.message });
    }

    if (!["patient", "caregiver"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    // Check if user already exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: "Email already registered" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Generate OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    // Create user
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role,
      isEmailVerified: false,
      otp: {
        code: otp,
        expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
      }
    });

    console.log(` User created: ${email} (${role})`);

    // Create role-specific profile
    if (role === "patient") {
      await PatientProfile.create({ userId: user._id });

      // Generate unique invite code
      let code;
      let isUnique = false;
      while (!isUnique) {
        code = "PAT-" + Math.floor(1000 + Math.random() * 9000);
        const existing = await InviteCode.findOne({ code });
        if (!existing) isUnique = true;
      }

      await InviteCode.create({
        code,
        patientId: user._id,
        used: false,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 7 days
      });

      console.log(` Patient profile created with invite code: ${code}`);
    } else {
      await CaregiverProfile.create({ userId: user._id });
      console.log(` Caregiver profile created`);
    }

    // Send OTP email
    try {
      await sendOTP(email, otp);
    } catch (emailErr) {
      console.error("Signup OTP email failed:", emailErr.message || emailErr);
      // Delete user and related data if email fails
      await User.findByIdAndDelete(user._id);
      if (role === "patient") {
        await PatientProfile.deleteOne({ userId: user._id });
        await InviteCode.deleteOne({ patientId: user._id });
      } else {
        await CaregiverProfile.deleteOne({ userId: user._id });
      }
      return res.status(500).json({ error: "Failed to send verification email. Please try again." });
    }

    // Store user ID in temporary session.
    // IMPORTANT: Use the callback form of session.save() so the HTTP response
    // is only sent AFTER the session document is confirmed written to MongoDB.
    // Using `await session.save()` can return before the MongoStore flush
    // completes — the browser's next request then arrives with no session cookie
    // data, causing the /auth/verify-otp route to redirect back to signup.
    req.session.tempUser = user._id.toString();
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("Session save error (signup):", saveErr);
        return res.status(500).json({ error: "Session error. Please try again." });
      }
      console.log(`Session saved for signup: tempUser = ${req.session.tempUser}`);
      return res.json({
        success: true,
        redirect: "/auth/verify-otp",
        message: "OTP sent to your email"
      });
    });

  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed. Please try again." });
  }
};

/* VERIFY OTP */
exports.verifyOTP = async (req, res) => {
  try {
    const { otp } = req.body;

    // Validate input
    if (!otp) {
      return res.status(400).json({ error: "OTP is required" });
    }

    // Check temporary session
    if (!req.session.tempUser) {
      return res.status(400).json({ error: "Session expired. Please sign up again." });
    }

    // Find user
    const user = await User.findById(req.session.tempUser);
    if (!user) {
      delete req.session.tempUser;
      return res.status(400).json({ error: "User not found. Please sign up again." });
    }

    // Check if already verified
    if (user.isEmailVerified) {
      delete req.session.tempUser;
      return res.status(400).json({ error: "Email already verified. Please log in." });
    }

    // Validate OTP
    if (!user.otp || !user.otp.code) {
      return res.status(400).json({ error: "No OTP found. Please request a new one." });
    }

    if (user.otp.code !== String(otp).trim()) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    if (user.otp.expiresAt < Date.now()) {
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    // Mark as verified
    user.isEmailVerified = true;
    user.otp = undefined;
    await user.save();

    console.log(` Email verified for ${user.email}`);

    // Swap temp session for a real user session in one atomic write.
    // Both changes (set user, delete tempUser) go into the same save call.
    req.session.user = {
      id: user._id.toString(),
      role: user.role,
      linked: user.linked || false,
      name: user.name,
      email: user.email
    };
    delete req.session.tempUser;

    const redirect = user.role === "patient"
      ? "/patient/welcome"
      : "/caregiver/link";

    // Callback form: response only sent after MongoDB confirms the write.
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("Session save error (verifyOTP):", saveErr);
        return res.status(500).json({ error: "Session error. Please try again." });
      }
      return res.json({
        success: true,
        redirect,
        message: "Email verified successfully"
      });
    });

  } catch (err) {
    console.error("OTP verification error:", err);
    res.status(500).json({ error: "Verification failed. Please try again." });
  }
};

/* LOGIN */
exports.login = async (req, res) => {
  try {
    let { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    email = email.toLowerCase().trim();

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Check if email is verified
    if (!user.isEmailVerified) {
      return res.status(403).json({
        error: "Please verify your email first",
        needsVerification: true
      });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    console.log(` User logged in: ${email}`);

    // Build session data
    const sessionData = {
      id: user._id.toString(),
      role: user.role,
      linked: user.linked || false,
      name: user.name,
      email: user.email
    };

    // For caregivers, include patientId if linked
    if (user.role === "caregiver" && user.linkedUser) {
      sessionData.patientId = user.linkedUser.toString();
    }

    req.session.user = sessionData;

    // Determine redirect before the save callback (no async needed here)
    let redirect;
    if (user.role === "patient") {
      redirect = user.linked ? "/patient/dashboard" : "/patient/welcome";
    } else {
      redirect = user.linked ? "/caregiver/dashboard" : "/caregiver/link";
    }

    // Callback form: dashboard redirect only sent after session is confirmed written.
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("Session save error (login):", saveErr);
        return res.status(500).json({ error: "Session error. Please try again." });
      }
      return res.json({
        success: true,
        redirect,
        message: "Login successful"
      });
    });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
};

/* LOGOUT */
exports.logout = (req, res) => {
  const userEmail = req.session.user?.email;

  req.session.destroy((err) => {
    if (err) {
      console.error("Session destroy error:", err);
      return res.status(500).send("Logout failed");
    }

    console.log(` User logged out: ${userEmail || "unknown"}`);
    res.clearCookie("smriticare.sid");
    res.redirect("/auth/login");
  });
};

/* RESEND OTP */
exports.resendOTP = async (req, res) => {
  try {
    // Check temporary session
    if (!req.session.tempUser) {
      return res.status(400).json({ error: "Session expired. Please sign up again." });
    }

    // Find user
    const user = await User.findById(req.session.tempUser);
    if (!user) {
      delete req.session.tempUser;
      return res.status(400).json({ error: "User not found. Please sign up again." });
    }

    // Check if already verified
    if (user.isEmailVerified) {
      delete req.session.tempUser;
      return res.status(400).json({ error: "Email already verified. Please log in." });
    }

    // Generate new OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    user.otp = {
      code: otp,
      expiresAt: Date.now() + 5 * 60 * 1000
    };
    await user.save();

    // Send OTP
    try {
      await sendOTP(user.email, otp);
      console.log(` OTP resent to ${user.email}`);
    } catch (emailErr) {
      console.error("Resend OTP email failed:", emailErr.message || emailErr);
      return res.status(500).json({ error: "Failed to send email. Please try again." });
    }

    res.json({
      success: true,
      message: "New OTP sent to your email"
    });

  } catch (err) {
    console.error("Resend OTP error:", err);
    res.status(500).json({ error: "Failed to resend OTP. Please try again." });
  }
};

/* GOOGLE CALENDAR - Redirect to Google consent screen */
exports.connectGoogleCalendar = (req, res) => {
  if (!req.session.user) return res.redirect("/auth/login");
  const url = getAuthUrl(req.session.user.id);
  res.redirect(url);
};

/* GOOGLE CALENDAR - Google redirects back here after user approves */
exports.googleCalendarCallback = async (req, res) => {
  try {
    // Use userId from SESSION (where user is logged in), not from URL state
    if (!req.session.user || !req.session.user.id) {
      console.error("[AUTH] No session user found in callback");
      return res.redirect("/auth/login?error=session_expired");
    }

    const userId = req.session.user.id;
    const { code, state } = req.query;

    if (!code) {
      return res.redirect("/caregiver/reminders?calendarError=true");
    }

    console.log("[AUTH] Processing calendar callback");
    console.log("  User ID from session:", userId);
    console.log("  Has authorization code:", !!code);

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);

    if (!tokens || !tokens.refresh_token) {
      console.error("[AUTH] Failed to get tokens or refresh_token");
      return res.redirect("/caregiver/reminders?calendarError=true");
    }

    // Save tokens using the CORRECT userId from session
    await User.findByIdAndUpdate(userId, {
      googleTokens: {
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date:   tokens.expiry_date,
        token_type:    tokens.token_type,
        scope:         tokens.scope
      },
      googleCalendarConnected: true,
      googleTokensExpired: false
    });

    console.log("[AUTH] Google Calendar connected successfully for user:", userId);

    // Update session with calendar status — use callback form for consistency
    if (req.session.user && req.session.user.id === userId) {
      req.session.user.googleCalendarConnected = true;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("[AUTH] Session save error (googleCalendarCallback):", saveErr);
          // Non-fatal: calendar is already saved in DB, still redirect successfully
        }
        res.redirect("/caregiver/reminders?calendarConnected=true");
      });
    } else {
      res.redirect("/caregiver/reminders?calendarConnected=true");
    }

  } catch (err) {
    console.error("[AUTH] Google Calendar callback error:", err.message);
    res.redirect("/caregiver/reminders?calendarError=true");
  }
};

/* GOOGLE CALENDAR - Return connection status for logged-in user */
exports.googleCalendarStatus = async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await User.findById(req.session.user.id).select("googleCalendarConnected");
    res.json({ googleCalendarConnected: user?.googleCalendarConnected || false });

  } catch (err) {
    console.error("Google Calendar status error:", err);
    res.status(500).json({ error: "Failed to check status" });
  }
};

/* FORGOT PASSWORD - SEND RESET CODE */
exports.requestPasswordReset = async (req, res) => {
  try {
    let { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    email = email.toLowerCase().trim();

    if (!validateEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "No account found with this email" });
    }

    if (!user.isEmailVerified) {
      return res.status(400).json({ error: "Please verify your email first" });
    }

    const otp = generateOTP();
    user.otp = {
      code: otp,
      expiresAt: Date.now() + 5 * 60 * 1000
    };
    await user.save();

    await sendPasswordResetCode(user.email, otp);

    // Store reset session — callback form so response is sent only after write.
    req.session.passwordReset = {
      userId: user._id.toString(),
      verified: false
    };
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("Session save error (requestPasswordReset):", saveErr);
        return res.status(500).json({ error: "Session error. Please try again." });
      }
      return res.json({
        success: true,
        message: "Reset code sent to your email"
      });
    });

  } catch (err) {
    console.error("Password reset request error:", err);
    return res.status(500).json({ error: "Failed to send reset code. Please try again." });
  }
};

/* FORGOT PASSWORD - VERIFY CODE */
exports.verifyPasswordResetCode = async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Reset code is required" });
    }

    const resetSession = req.session.passwordReset;
    if (!resetSession || !resetSession.userId) {
      return res.status(400).json({ error: "Reset session expired. Request a new code." });
    }

    const user = await User.findById(resetSession.userId);
    if (!user) {
      delete req.session.passwordReset;
      req.session.save(() => {}); // best-effort clean up, no need to wait
      return res.status(400).json({ error: "User not found. Request a new code." });
    }

    if (!user.otp || !user.otp.code) {
      return res.status(400).json({ error: "No reset code found. Request a new code." });
    }

    if (user.otp.code !== String(code).trim()) {
      return res.status(400).json({ error: "Invalid reset code" });
    }

    if (user.otp.expiresAt < Date.now()) {
      return res.status(400).json({ error: "Reset code has expired. Request a new code." });
    }

    // Mark reset session as verified — callback form.
    req.session.passwordReset.verified = true;
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("Session save error (verifyPasswordResetCode):", saveErr);
        return res.status(500).json({ error: "Session error. Please try again." });
      }
      return res.json({
        success: true,
        message: "Code verified. You can now set a new password.",
        redirect: "/auth/forgot-password/new-password"
      });
    });

  } catch (err) {
    console.error("Password reset code verification error:", err);
    return res.status(500).json({ error: "Failed to verify reset code. Please try again." });
  }
};

/* FORGOT PASSWORD - RESEND CODE */
exports.resendPasswordResetCode = async (req, res) => {
  try {
    const resetSession = req.session.passwordReset;
    if (!resetSession || !resetSession.userId) {
      return res.status(400).json({ error: "Reset session expired. Request a new code." });
    }

    const user = await User.findById(resetSession.userId);
    if (!user) {
      delete req.session.passwordReset;
      req.session.save(() => {}); // best-effort clean up
      return res.status(400).json({ error: "User not found. Request a new code." });
    }

    const otp = generateOTP();
    user.otp = {
      code: otp,
      expiresAt: Date.now() + 5 * 60 * 1000
    };
    await user.save();

    await sendPasswordResetCode(user.email, otp);

    // Reset verified flag — callback form.
    req.session.passwordReset.verified = false;
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("Session save error (resendPasswordResetCode):", saveErr);
        return res.status(500).json({ error: "Session error. Please try again." });
      }
      return res.json({
        success: true,
        message: "New reset code sent to your email"
      });
    });

  } catch (err) {
    console.error("Password reset resend error:", err);
    return res.status(500).json({ error: "Failed to resend reset code. Please try again." });
  }
};

/* FORGOT PASSWORD - SET NEW PASSWORD */
exports.resetPassword = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: "New password is required" });
    }

    const resetSession = req.session.passwordReset;
    if (!resetSession || !resetSession.userId) {
      return res.status(400).json({ error: "Reset session expired. Request a new code." });
    }

    if (!resetSession.verified) {
      return res.status(400).json({ error: "Please verify the reset code first" });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.message });
    }

    const user = await User.findById(resetSession.userId);
    if (!user) {
      delete req.session.passwordReset;
      req.session.save(() => {}); // best-effort clean up
      return res.status(400).json({ error: "User not found. Request a new code." });
    }

    const isSameAsCurrent = await bcrypt.compare(password, user.password);
    if (isSameAsCurrent) {
      return res.status(400).json({ error: "New password must be different from the current password" });
    }

    user.password = await bcrypt.hash(password, 12);
    user.otp = undefined;
    await user.save();

    // Clear reset session — callback form.
    delete req.session.passwordReset;
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("Session save error (resetPassword):", saveErr);
        // Non-fatal: password is already changed in DB, still return success.
      }
      return res.json({
        success: true,
        message: "Password reset successful. Please log in."
      });
    });

  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Failed to reset password. Please try again." });
  }
};
