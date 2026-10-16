import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

const expoHost = Constants.expoConfig?.hostUri
  ? new URL(`http://${Constants.expoConfig.hostUri}`).hostname
  : null;

const defaultHost =
  Platform.OS === 'android' && !Device.isDevice
    ? '10.0.2.2'
    : expoHost ?? '10.0.2.2';
const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '');
const apiOrigin = (configuredApiUrl ?? `http://${defaultHost}:5248`).replace(/\/api$/i, '');

export const API_URL = `${apiOrigin}/api`;
