// ===================================================================
// Google Docs export service.
//
// Flow:
//  1. getGoogleDocsOAuthUrl(userId) — generate consent URL
//  2. handleGoogleDocsCallback(code, userId) — exchange code → store tokens
//  3. exportToGoogleDocs({ output, meta, ... , userId }) — create Doc
//
// Required env vars:
//   GOOGLE_DOCS_CLIENT_ID
//   GOOGLE_DOCS_CLIENT_SECRET
//   GOOGLE_DOCS_REDIRECT_URI   e.g. https://api.example.com/auth/google-docs/callback
// ===================================================================

import { google } from "googleapis";
import { encrypt, decrypt } from "../utils/crypto.util.js";
import GoogleToken from "../models/GoogleToken.js";

// ── OAuth2 client factory ─────────────────────────────────────
function makeOAuth2Client() {
  const {
    GOOGLE_DOCS_CLIENT_ID,
    GOOGLE_DOCS_CLIENT_SECRET,
    GOOGLE_DOCS_REDIRECT_URI,
  } = process.env;
  if (
    !GOOGLE_DOCS_CLIENT_ID ||
    !GOOGLE_DOCS_CLIENT_SECRET ||
    !GOOGLE_DOCS_REDIRECT_URI
  ) {
    throw new Error(
      "Google Docs export requires GOOGLE_DOCS_CLIENT_ID, GOOGLE_DOCS_CLIENT_SECRET, " +
        "and GOOGLE_DOCS_REDIRECT_URI in the environment.",
    );
  }
  return new google.auth.OAuth2(
    GOOGLE_DOCS_CLIENT_ID,
    GOOGLE_DOCS_CLIENT_SECRET,
    GOOGLE_DOCS_REDIRECT_URI,
  );
}

const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

// ── Step 1: Generate OAuth URL ────────────────────────────────
export function getGoogleDocsOAuthUrl(userId) {
  const oauth2Client = makeOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // force refresh_token on every consent
    state: userId.toString(), // we recover userId in callback
  });
}

// ── Step 2: Exchange code → store tokens ─────────────────────
export async function handleGoogleDocsCallback(code, userId) {
  const oauth2Client = makeOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    // Can happen if user already granted and we didn't force re-consent.
    // Check if we already have a stored refresh token.
    const existing = await GoogleToken.findOne({ userId }).select(
      "+accessTokenEncrypted +refreshTokenEncrypted",
    );
    if (!existing) {
      throw new Error(
        "No refresh_token received and no prior token stored. " +
          "Please revoke app access in Google and reconnect.",
      );
    }
    // Just update the access token
    existing.accessTokenEncrypted = encrypt(tokens.access_token);
    existing.expiryDate = tokens.expiry_date ?? Date.now() + 3600 * 1000;
    await existing.save();
    return existing;
  }

  // Fetch user profile
  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data: profile } = await oauth2.userinfo.get();

  const doc = await GoogleToken.findOneAndUpdate(
    { userId },
    {
      accessTokenEncrypted: encrypt(tokens.access_token),
      refreshTokenEncrypted: encrypt(tokens.refresh_token),
      expiryDate: tokens.expiry_date ?? Date.now() + 3600 * 1000,
      scopes: tokens.scope ? tokens.scope.split(" ") : SCOPES,
      googleUserId: profile.id,
      googleEmail: profile.email,
      googleName: profile.name,
      connectedAt: new Date(),
    },
    { upsert: true, new: true },
  );
  return doc;
}

// ── Helpers ───────────────────────────────────────────────────

/** Load a user's GoogleToken and return an authenticated oauth2Client. */
async function getAuthenticatedClient(userId) {
  const tokenDoc = await GoogleToken.findOne({ userId }).select(
    "+accessTokenEncrypted +refreshTokenEncrypted",
  );
  if (!tokenDoc) {
    throw new Error("GOOGLE_NOT_CONNECTED");
  }

  const oauth2Client = makeOAuth2Client();
  oauth2Client.setCredentials({
    access_token: decrypt(tokenDoc.accessTokenEncrypted),
    refresh_token: decrypt(tokenDoc.refreshTokenEncrypted),
    expiry_date: tokenDoc.expiryDate,
  });

  // Persist refreshed tokens so we don't lose the new access token
  oauth2Client.on("tokens", async (newTokens) => {
    const update = {
      expiryDate: newTokens.expiry_date ?? Date.now() + 3600 * 1000,
    };
    if (newTokens.access_token) {
      update.accessTokenEncrypted = encrypt(newTokens.access_token);
    }
    if (newTokens.refresh_token) {
      update.refreshTokenEncrypted = encrypt(newTokens.refresh_token);
    }
    await GoogleToken.findOneAndUpdate({ userId }, update).catch(console.error);
  });

  return oauth2Client;
}

/**
 * Convert documentation output into Google Docs requests.
 * A Google Docs batchUpdate accepts an array of requests; we build
 * headings + body text from each section's markdown (stripped of
 * the heaviest markdown syntax for readability).
 */
function buildDocRequests(output, meta, stats, securityScore) {
  const requests = [];
  let idx = 1; // insertText index accumulator (1-based, after title)

  const sections = [
    { key: "readme", title: "README" },
    { key: "api", title: "API Reference" },
    { key: "schema", title: "Schema Documentation" },
    { key: "internal", title: "Internal Notes" },
    { key: "security", title: "Security Report" },
  ];

  for (const { key, title } of sections) {
    const content = output[key] || output[`${key}Markdown`] || "";
    if (!content) continue;

    // Section heading
    const headingText = `${title}\n`;
    requests.push({
      insertText: { location: { index: idx }, text: headingText },
    });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: idx, endIndex: idx + headingText.length - 1 },
        paragraphStyle: { namedStyleType: "HEADING_1" },
        fields: "namedStyleType",
      },
    });
    idx += headingText.length;

    // Strip heavy markdown (we keep the text readable without heavy formatting)
    const stripped = content
      .replace(/^#{1,6}\s+/gm, "") // headings
      .replace(/\*\*(.+?)\*\*/g, "$1") // bold
      .replace(/\*(.+?)\*/g, "$1") // italic
      .replace(/`{3}[\s\S]*?`{3}/g, "") // code blocks (drop for brevity)
      .replace(/`(.+?)`/g, "$1") // inline code
      .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links → text
      .trim();

    const bodyText = stripped + "\n\n";
    requests.push({
      insertText: { location: { index: idx }, text: bodyText },
    });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: idx, endIndex: idx + bodyText.length },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
    idx += bodyText.length;
  }

  // Metadata footer
  const repoName = meta?.name || "Unknown Repo";
  const generatedAt = new Date().toUTCString();
  const footerText = `\nGenerated by Docnine\nRepository: ${repoName}\nDate: ${generatedAt}\n`;
  requests.push({
    insertText: { location: { index: idx }, text: footerText },
  });

  return requests;
}

// ── Step 3: Export to Google Docs ─────────────────────────────
export async function exportToGoogleDocs({
  output,
  meta,
  stats,
  securityScore,
  userId,
}) {
  const auth = await getAuthenticatedClient(userId);
  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  const repoName = meta?.name || "Untitled Documentation";
  const docTitle = `${repoName} — Docnine Documentation`;

  // 1. Create an empty Google Doc
  const { data: created } = await docs.documents.create({
    requestBody: { title: docTitle },
  });
  const documentId = created.documentId;

  // 2. Build content requests and batch-insert
  const requests = buildDocRequests(output, meta, stats, securityScore);
  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });
  }

  // 3. Return shareable URL
  const docUrl = `https://docs.google.com/document/d/${documentId}/edit`;
  return { documentId, documentUrl: docUrl, title: docTitle };
}

// ── Utility: check if a user has connected Google Drive ───────
export async function getGoogleDocsConnectionStatus(userId) {
  const token = await GoogleToken.findOne({ userId });
  if (!token) return { connected: false };
  return {
    connected: true,
    email: token.googleEmail,
    name: token.googleName,
    connectedAt: token.connectedAt,
  };
}

// ── Disconnect ────────────────────────────────────────────────
export async function disconnectGoogleDocs(userId) {
  await GoogleToken.deleteOne({ userId });
}
