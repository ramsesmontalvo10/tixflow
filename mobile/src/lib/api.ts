import * as SecureStore from 'expo-secure-store';

export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:5248'
).replace(/\/$/, '');

export const ACCESS_TOKEN_KEY = 'ticketing.accessToken';

export async function getAccessToken() {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}
