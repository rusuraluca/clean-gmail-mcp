import { google } from "googleapis";
import { getGoogleCredentials } from "./config.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export function createOAuthClient(): OAuth2Client {
  const { clientId, clientSecret, refreshToken } = getGoogleCredentials();
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
