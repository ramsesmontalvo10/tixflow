import * as SecureStore from 'expo-secure-store';
import { API_URL } from '@/config/api';

export const API_BASE_URL = API_URL.replace(/\/api$/, '');

export const ACCESS_TOKEN_KEY = 'ticketing.accessToken';

export async function getAccessToken() {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}
