/**
 * General utility functions
 */

import type { MessagePart, SDKMessagePartInput, ToastMessage, OpenCodeClient } from '../types/index.js';

/**
 * Generate a model identifier key
 */
export function getModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

/**
 * Format a millisecond duration as a short human ETA (e.g. "45s", "3m", "2h").
 */
export function formatDuration(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/**
 * Generate a state identifier
 */
export function getStateKey(sessionID: string, messageID: string): string {
  return `${sessionID}:${messageID}`;
}

/**
 * Extract and validate message parts from a user message
 */
export function extractMessageParts(message: unknown): MessagePart[] {
  const msg = message as { info: { id: string; role: string }; parts: unknown[] };
  return msg.parts
    .filter((p: unknown) => {
      const part = p as Record<string, unknown>;
      return part.type === "text" || part.type === "file";
    })
    .map((p: unknown): MessagePart | null => {
      const part = p as Record<string, unknown>;
      if (part.type === "text") return { type: "text" as const, text: String(part.text) };
      if (part.type === "file") return { type: "file" as const, path: String(part.path), mediaType: String(part.mediaType) };
      return null;
    })
    .filter((p): p is MessagePart => p !== null);
}

/**
 * Convert internal MessagePart to SDK-compatible format
 */
export function convertPartsToSDKFormat(parts: MessagePart[]): SDKMessagePartInput[] {
  return parts.map((part): SDKMessagePartInput => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    // For file parts, we need to match the FilePartInput format
    // Using path as url since we're dealing with local files
    return {
      type: "file",
      url: part.path,
      mime: part.mediaType || "application/octet-stream",
    };
  });
}

/**
 * Safely show toast, falling back to console logging if TUI is missing or fails
 */
export const safeShowToast = async (client: OpenCodeClient, toast: ToastMessage) => {
  const title = toast?.body?.title || toast?.title || "Toast";
  const message = toast?.body?.message || toast?.message || "";
  const variant = toast?.body?.variant || toast?.variant || "info";

  const logToConsole = () => {
    if (variant === "error") {
      console.error(`[RateLimitFallback] ${title}: ${message}`);
    } else if (variant === "warning") {
      console.warn(`[RateLimitFallback] ${title}: ${message}`);
    } else {
      console.log(`[RateLimitFallback] ${title}: ${message}`);
    }
  };

  try {
    if (client.tui) {
      await client.tui.showToast(toast);
    } else {
      // TUI doesn't exist - log to console
      logToConsole();
    }
  } catch {
    // TUI exists but failed to show toast - log to console
    logToConsole();
  }
};
