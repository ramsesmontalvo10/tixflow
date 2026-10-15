import Constants from 'expo-constants';

const developmentHost = Constants.expoConfig?.hostUri
  ? new URL(`http://${Constants.expoConfig.hostUri}`).hostname
  : '10.0.2.2';

export const API_URL = `http://${developmentHost}:5248/api`;
