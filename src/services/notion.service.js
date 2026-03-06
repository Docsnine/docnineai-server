// ===================================================================
// Per-user Notion integration settings
//
// Handles saving, reading, and removing users' Notion API keys and
// parent page IDs. The API key is AES-256-GCM encrypted at rest.
// ===================================================================

import { NotionSettings } from "../models/NotionSettings.js";
import { encrypt, decrypt } from "../utils/crypto.util.js";

/**
 * Save (or update) a user's Notion connection.
 * Encrypts the API key before persisting.
 *
 * @param {{ userId: string, apiKey: string, parentPageId: string, workspaceName?: string }} opts
 * @returns {Promise<{ connected: boolean, parentPageId: string, workspaceName: string|null, connectedAt: Date }>}
 */
export async function saveNotionSettings({
  userId,
  apiKey,
  parentPageId,
  workspaceName = null,
}) {
  const apiKeyEncrypted = encrypt(apiKey.trim());

  const doc = await NotionSettings.findOneAndUpdate(
    { userId },
    {
      apiKeyEncrypted,
      parentPageId: parentPageId.trim(),
      workspaceName: workspaceName ?? null,
      connectedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return {
    connected: true,
    parentPageId: doc.parentPageId,
    workspaceName: doc.workspaceName,
    connectedAt: doc.connectedAt,
  };
}

/**
 * Return public connection status (no decrypted key).
 *
 * @param {string} userId
 * @returns {Promise<{ connected: boolean, parentPageId?: string, workspaceName?: string|null, connectedAt?: Date }>}
 */
export async function getNotionStatus(userId) {
  const doc = await NotionSettings.findOne({ userId });
  if (!doc) return { connected: false };

  return {
    connected: true,
    parentPageId: doc.parentPageId,
    workspaceName: doc.workspaceName,
    connectedAt: doc.connectedAt,
  };
}

/**
 * Retrieve and decrypt the Notion API key for use in export service.
 * Throws if the user has no Notion connection.
 *
 * @param {string} userId
 * @returns {Promise<{ apiKey: string, parentPageId: string }>}
 */
export async function getDecryptedNotionSettings(userId) {
  const doc = await NotionSettings.findOne({ userId }).select(
    "+apiKeyEncrypted",
  );
  if (!doc) throw new Error("NOTION_NOT_CONNECTED");

  return {
    apiKey: decrypt(doc.apiKeyEncrypted),
    parentPageId: doc.parentPageId,
  };
}

/**
 * Remove a user's Notion connection.
 *
 * @param {string} userId
 */
export async function disconnectNotion(userId) {
  await NotionSettings.deleteOne({ userId });
}
