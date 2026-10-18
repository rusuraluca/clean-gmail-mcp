import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveGoogleTokenFile(): string {
  if (process.env.GOOGLE_TOKEN_FILE) return path.resolve(process.env.GOOGLE_TOKEN_FILE);
  return path.join(packageRoot, ".tokens", "google-token.json");
}

function readStoredRefreshToken(): string | undefined {
  const file = resolveGoogleTokenFile();
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { refresh_token?: string };
    return data.refresh_token;
  } catch {
    return undefined;
  }
}

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function getGoogleCredentials(): GoogleCredentials {
  const missing: string[] = [];
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? readStoredRefreshToken();

  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!refreshToken) missing.push("GOOGLE_REFRESH_TOKEN (or run: npm run auth:google)");

  if (missing.length > 0) {
    throw new Error(
      `Gmail is not configured. Missing: ${missing.join(", ")}. ` +
        `Copy .env.example to .env and see the README "Google setup" section.`,
    );
  }

  return { clientId, clientSecret, refreshToken } as GoogleCredentials;
}

export function getSlackToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "Slack is not configured. Missing: SLACK_BOT_TOKEN. " +
        `Copy .env.example to .env and see the README "Slack setup" section.`,
    );
  }
  return token;
}

export function getDefaultSlackChannel(): string | undefined {
  return process.env.SLACK_DEFAULT_CHANNEL || undefined;
}

export function getCalendarTimezone(): string {
  return process.env.CALENDAR_TIMEZONE || "Europe/London";
}
